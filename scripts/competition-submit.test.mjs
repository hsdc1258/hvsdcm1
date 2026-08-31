import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { competitionActionSha256 } from './competition-report.mjs';
import {
  CompetitionSubmissionError,
  claimCompetitionSubmissionJob,
  readCompetitionSubmissionConfig,
  runCompetitionSubmissionCli,
  runCompetitionSubmissionOnce,
  updateCompetitionSubmissionJobState,
} from './competition-submit.mjs';

const TOKEN = 'Ab3_-xY9'.repeat(8);
const NOW = '2026-08-31T12:00:00.000Z';
const SUBMISSION_URL = 'https://submit.organizer.example/apply';

function actionManifest() {
  return {
    version: 1,
    organizer: 'Example Organizer',
    contest_id: 'contest',
    category: 'image',
    submission_url: SUBMISSION_URL,
    submission_host: 'submit.organizer.example',
    fee: { required: false, amount_minor: 0, currency: 'NONE' },
    rights_class: 'limited_license',
    consent_text_sha256: ['1'.repeat(64)],
    artifact_sha256: ['2'.repeat(64)],
    payload_sha256: '3'.repeat(64),
  };
}

const ACTION = competitionActionSha256(actionManifest());

function withConfig(t, {
  actions = {}, token = TOKEN,
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'competition-submit-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configPath = path.join(root, 'submission.json');
  fs.writeFileSync(configPath, JSON.stringify({
    api_url: 'https://api.test/',
    competition_submission_token: token,
    actions,
  }));
  return configPath;
}

function job(overrides = {}) {
  return {
    job_id: 'competition-final-contest-image',
    request_id: 'competition-final-contest-image',
    action_sha256: ACTION,
    contest_id: 'contest',
    category: 'image',
    official_url: 'https://organizer.example/rules',
    submission_url: SUBMISSION_URL,
    action_manifest: actionManifest(),
    approval_expires_at: '2099-08-31T12:10:00.000Z',
    status: 'claimed',
    queued_at: NOW,
    claimed_at: NOW,
    started_at: null,
    completed_at: null,
    result_code: null,
    receipt_reference: null,
    lease_id: 'lease-123',
    lease_until: '2026-08-31T12:05:00.000Z',
    ...overrides,
  };
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('submission client treats an empty claim as idle and never returns the token', async (t) => {
  const configPath = withConfig(t);
  let request;
  const result = await runCompetitionSubmissionOnce({
    configPath,
    fetchImpl: async (url, options) => {
      request = { url, options };
      return jsonResponse({ job: null });
    },
  });
  assert.deepEqual(result, { ok: true, status: 'idle' });
  assert.equal(request.url, 'https://api.test/api/competitions/submissions/claim');
  assert.equal(request.options.headers.authorization, `Bearer ${TOKEN}`);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(TOKEN, 'u'));
});

test('exported claim and state helpers carry the dedicated token and strict lease body', async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    if (url.endsWith('/claim')) return jsonResponse({ job: job() });
    return jsonResponse({ job: job({ status: 'running', started_at: NOW }), replayed: false });
  };
  const claimed = await claimCompetitionSubmissionJob({
    apiUrl: 'https://api.test', token: TOKEN, fetchImpl,
  });
  const running = await updateCompetitionSubmissionJobState({
    apiUrl: 'https://api.test', token: TOKEN, fetchImpl,
    jobId: claimed.job_id,
    state: { state: 'running', lease_id: claimed.lease_id },
  });
  assert.equal(running.status, 'running');
  assert.deepEqual(requests.map((entry) => entry.url), [
    'https://api.test/api/competitions/submissions/claim',
    'https://api.test/api/competitions/submissions/competition-final-contest-image/state',
  ]);
  assert.ok(requests.every((entry) => entry.options.headers.authorization === `Bearer ${TOKEN}`));
  assert.deepEqual(JSON.parse(requests[1].options.body), {
    state: 'running', lease_id: 'lease-123',
  });
});

test('submission client records running before one adapter call and reports a bounded receipt', async (t) => {
  const configPath = withConfig(t, {
    actions: {
      [ACTION]: {
        request_id: 'competition-final-contest-image',
        official_url: 'https://organizer.example/rules',
        submission_url: SUBMISSION_URL,
        adapter: 'organizer_example_v1',
      },
    },
  });
  const requests = [];
  let adapterCalls = 0;
  const result = await runCompetitionSubmissionOnce({
    configPath,
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      if (url.endsWith('/claim')) return jsonResponse({ job: job() });
      const body = JSON.parse(options.body);
      if (body.state === 'running') {
        return jsonResponse({
          job: job({ status: 'running', started_at: NOW }), replayed: false,
        });
      }
      return jsonResponse({
        job: job({
          status: 'succeeded', started_at: NOW, completed_at: NOW,
          lease_until: null, result_code: 'submitted', receipt_reference: 'CONFIRM-123',
        }),
        replayed: false,
      });
    },
    executeAction: async ({ job: claimed, action, signal }) => {
      adapterCalls += 1;
      assert.equal(claimed.action_sha256, ACTION);
      assert.equal(action.adapter, 'organizer_example_v1');
      assert.equal(signal.aborted, false);
      return { state: 'succeeded', result_code: 'submitted', receipt_reference: 'CONFIRM-123' };
    },
  });
  assert.equal(adapterCalls, 1);
  assert.deepEqual(requests.slice(1).map((entry) => JSON.parse(entry.options.body).state), [
    'running', 'succeeded',
  ]);
  assert.deepEqual(result, {
    ok: true,
    job_id: 'competition-final-contest-image',
    status: 'succeeded',
    result_code: 'submitted',
    receipt_reference: 'CONFIRM-123',
  });
  assert.doesNotMatch(JSON.stringify({ result, requests: requests.map((entry) => entry.url) }), new RegExp(TOKEN, 'u'));
});

test('adapter timeout becomes terminal submission_unknown without a second external call', async (t) => {
  const configPath = withConfig(t, {
    actions: {
      [ACTION]: {
        request_id: 'competition-final-contest-image',
        official_url: 'https://organizer.example/rules',
        submission_url: SUBMISSION_URL,
        adapter: 'organizer_example_v1',
      },
    },
  });
  let adapterCalls = 0;
  const states = [];
  const result = await runCompetitionSubmissionOnce({
    configPath,
    executionTimeoutMs: 5,
    fetchImpl: async (url, options) => {
      if (url.endsWith('/claim')) return jsonResponse({ job: job() });
      const body = JSON.parse(options.body);
      states.push(body.state);
      if (body.state === 'running') {
        return jsonResponse({ job: job({ status: 'running', started_at: NOW }), replayed: false });
      }
      return jsonResponse({
        job: job({
          status: 'submission_unknown', started_at: NOW, completed_at: NOW,
          lease_until: null, result_code: 'timeout_after_send',
        }),
        replayed: false,
      });
    },
    executeAction: async ({ signal }) => {
      adapterCalls += 1;
      return new Promise((resolve) => {
        signal.addEventListener('abort', () => resolve({
          state: 'submission_unknown', result_code: 'timeout_after_send',
        }), { once: true });
      });
    },
  });
  assert.equal(adapterCalls, 1);
  assert.deepEqual(states, ['running', 'submission_unknown']);
  assert.equal(result.status, 'submission_unknown');
  assert.equal(result.result_code, 'timeout_after_send');
});

test('approval expiry is checked at claim handling, before running and immediately before adapter call', async (t) => {
  const configPath = withConfig(t, {
    actions: {
      [ACTION]: {
        request_id: 'competition-final-contest-image',
        official_url: 'https://organizer.example/rules',
        submission_url: SUBMISSION_URL,
        adapter: 'organizer_example_v1',
      },
    },
  });
  const expiry = Date.parse('2026-08-31T12:00:01.000Z');
  for (const [name, clock, expectedStates] of [
    ['expired claim', [expiry], ['blocked']],
    ['expires before running', [expiry - 1, expiry], ['blocked']],
    ['expires before adapter', [expiry - 1, expiry - 1, expiry], ['running', 'blocked']],
  ]) {
    await t.test(name, async () => {
      const ticks = [...clock];
      const states = [];
      let adapterCalls = 0;
      const result = await runCompetitionSubmissionOnce({
        configPath,
        now: () => ticks.shift() ?? expiry,
        fetchImpl: async (url, options) => {
          if (url.endsWith('/claim')) {
            return jsonResponse({ job: job({
              approval_expires_at: '2026-08-31T12:00:01.000Z',
            }) });
          }
          const body = JSON.parse(options.body);
          states.push(body.state);
          if (body.state === 'running') {
            return jsonResponse({
              job: job({
                approval_expires_at: '2026-08-31T12:00:01.000Z',
                status: 'running', started_at: NOW,
              }),
              replayed: false,
            });
          }
          return jsonResponse({
            job: job({
              approval_expires_at: '2026-08-31T12:00:01.000Z',
              status: 'blocked', started_at: states.includes('running') ? NOW : null,
              completed_at: NOW, lease_until: null, result_code: 'approval_expired',
            }),
            replayed: false,
          });
        },
        executeAction: async () => {
          adapterCalls += 1;
          return { state: 'succeeded', result_code: 'submitted' };
        },
      });
      assert.deepEqual(states, expectedStates);
      assert.equal(adapterCalls, 0);
      assert.equal(result.status, 'blocked');
      assert.equal(result.result_code, 'approval_expired');
    });
  }
});

test('generic and mismatched organizer configurations fail closed without entering running', async (t) => {
  for (const [name, actions, expected] of [
    ['missing', {}, 'private_config_missing'],
    ['mismatch', {
      [ACTION]: {
        request_id: 'competition-final-contest-image',
        official_url: 'https://organizer.example/rules',
        submission_url: 'https://other.example/submit',
        adapter: 'organizer_example_v1',
      },
    }, 'destination_mismatch'],
    ['unsupported', {
      [ACTION]: {
        request_id: 'competition-final-contest-image',
        official_url: 'https://organizer.example/rules',
        submission_url: SUBMISSION_URL,
        adapter: 'unsupported',
      },
    }, 'unsupported_organizer_flow'],
  ]) {
    await t.test(name, async (subtest) => {
      const configPath = withConfig(subtest, { actions });
      const states = [];
      let adapterCalls = 0;
      const result = await runCompetitionSubmissionOnce({
        configPath,
        fetchImpl: async (url, options) => {
          if (url.endsWith('/claim')) return jsonResponse({ job: job() });
          const body = JSON.parse(options.body);
          states.push(body.state);
          return jsonResponse({
            job: job({
              status: 'blocked', completed_at: NOW, lease_until: null,
              result_code: expected,
            }),
            replayed: false,
          });
        },
        executeAction: async () => { adapterCalls += 1; },
      });
      assert.deepEqual(states, ['blocked']);
      assert.equal(adapterCalls, 0);
      assert.equal(result.status, 'blocked');
      assert.equal(result.result_code, expected);
    });
  }
});

test('client redacts a token from rejection text and rejects malformed or oversized acknowledgements', async (t) => {
  const configPath = withConfig(t);
  await assert.rejects(
    runCompetitionSubmissionOnce({
      configPath,
      fetchImpl: async () => new Response(`failed with ${TOKEN}`, { status: 500 }),
    }),
    (error) => {
      assert.ok(error instanceof CompetitionSubmissionError);
      assert.equal(error.code, 'api_rejected');
      assert.equal(error.message, 'competition submission API rejected the request (HTTP 500)');
      assert.doesNotMatch(error.message, /failed with/u);
      assert.doesNotMatch(error.message, new RegExp(TOKEN, 'u'));
      return true;
    },
  );
  await assert.rejects(
    runCompetitionSubmissionOnce({
      configPath,
      fetchImpl: async () => jsonResponse({ job: { unexpected: true } }),
    }),
    (error) => error instanceof CompetitionSubmissionError && error.code === 'invalid_response',
  );
  await assert.rejects(
    runCompetitionSubmissionOnce({
      configPath,
      fetchImpl: async () => jsonResponse({
        job: job({ status: 'claimed', result_code: 'submitted' }),
      }),
    }),
    (error) => error instanceof CompetitionSubmissionError && error.code === 'invalid_response',
  );
  await assert.rejects(
    runCompetitionSubmissionOnce({
      configPath,
      fetchImpl: async () => jsonResponse({
        job: job({ action_manifest: { ...actionManifest(), rights_class: 'ownership_transfer' } }),
      }),
    }),
    (error) => error instanceof CompetitionSubmissionError && error.code === 'invalid_response',
  );
  await assert.rejects(
    runCompetitionSubmissionOnce({
      configPath,
      fetchImpl: async () => new Response('x'.repeat(64_001), { status: 200 }),
    }),
    (error) => error instanceof CompetitionSubmissionError && error.code === 'invalid_response',
  );
});

test('rejected response bodies never reach helper errors or CLI stderr in reversible token forms', async (t) => {
  const configPath = withConfig(t);
  const fullyEncoded = [...Buffer.from(TOKEN, 'utf8')]
    .map((byte) => `%${byte.toString(16).padStart(2, '0')}`)
    .join('');
  const mixedEncoded = [...TOKEN]
    .map((character, index) => (index % 2 === 0
      ? character : `%${character.charCodeAt(0).toString(16).padStart(2, '0')}`))
    .join('');
  const repeatedlyEncoded = encodeURIComponent(fullyEncoded);
  const credentialForms = [
    TOKEN, fullyEncoded, fullyEncoded.toUpperCase(), mixedEncoded, repeatedlyEncoded,
  ];
  const assertCredentialAbsent = (value) => {
    const retained = String(value);
    for (const form of credentialForms) assert.equal(retained.includes(form), false, form);
    let decoded = retained;
    for (let pass = 0; pass < 4; pass += 1) {
      try { decoded = decodeURIComponent(decoded); } catch { break; }
      assert.equal(decoded.includes(TOKEN), false, `decoded pass ${pass + 1}`);
    }
  };
  const rejected = (body, status = 401) => async () => new Response(
    `organizer reflected ${body} and this text must also be omitted`, { status },
  );

  for (const [index, reflected] of credentialForms.entries()) {
    for (const helper of [
      () => claimCompetitionSubmissionJob({
        apiUrl: 'https://api.test', token: TOKEN, fetchImpl: rejected(reflected),
      }),
      () => updateCompetitionSubmissionJobState({
        apiUrl: 'https://api.test', token: TOKEN, fetchImpl: rejected(reflected, 403),
        jobId: 'competition-final-contest-image',
        state: { state: 'running', lease_id: 'lease-123' },
      }),
    ]) {
      let retainedError;
      await assert.rejects(helper(), (error) => {
        retainedError = error;
        return error instanceof CompetitionSubmissionError && error.code === 'api_rejected';
      });
      assertCredentialAbsent(retainedError.message);
      assert.doesNotMatch(retainedError.message, /organizer reflected|must also be omitted/u);
    }

    let stderr = '';
    let stdout = '';
    const exitCode = await runCompetitionSubmissionCli(['--config', configPath], {
      runOnce: (options) => runCompetitionSubmissionOnce({
        ...options,
        fetchImpl: rejected(reflected, index % 2 === 0 ? 401 : 422),
      }),
      stderr: { write(chunk) { stderr += String(chunk); } },
      stdout: { write(chunk) { stdout += String(chunk); } },
    });
    assert.equal(exitCode, 1);
    assert.equal(stdout, '');
    assert.match(stderr, /^\[competition-submit\] api_rejected: competition submission API rejected the request \(HTTP (?:401|422)\)\n$/u);
    assertCredentialAbsent(stderr);
    assert.doesNotMatch(stderr, /organizer reflected|must also be omitted/u);
  }
});

test('request timeout is bounded and private config rejects unknown sensitive-shaped fields', async (t) => {
  const configPath = withConfig(t);
  await assert.rejects(
    runCompetitionSubmissionOnce({
      configPath,
      requestTimeoutMs: 5,
      fetchImpl: async (_url, options) => new Promise((resolve, reject) => {
        void resolve;
        options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      }),
    }),
    (error) => error instanceof CompetitionSubmissionError && error.code === 'request_timeout',
  );

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'competition-submit-private-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const unsafe = path.join(root, 'unsafe.json');
  fs.writeFileSync(unsafe, JSON.stringify({
    api_url: 'https://api.test',
    competition_submission_token: TOKEN,
    actions: {
      [ACTION]: {
        request_id: 'competition-final-contest-image',
        official_url: 'https://organizer.example/rules',
        submission_url: SUBMISSION_URL,
        adapter: 'organizer_example_v1',
        answers: ['forbidden'],
      },
    },
  }));
  assert.throws(
    () => readCompetitionSubmissionConfig(unsafe),
    (error) => error instanceof CompetitionSubmissionError && error.code === 'invalid_config',
  );
  for (const submissionUrl of [
    'https://localhost./apply',
    'https://submit.organizer.example/apply?token=privatevalue123',
    'https://submit.organizer.example/apply?contact=owner%40example.com',
  ]) {
    fs.writeFileSync(unsafe, JSON.stringify({
      api_url: 'https://api.test',
      competition_submission_token: TOKEN,
      actions: {
        [ACTION]: {
          request_id: 'competition-final-contest-image',
          official_url: 'https://organizer.example/rules',
          submission_url: submissionUrl,
          adapter: 'organizer_example_v1',
        },
      },
    }));
    assert.throws(
      () => readCompetitionSubmissionConfig(unsafe),
      (error) => error instanceof CompetitionSubmissionError && error.code === 'invalid_config',
      submissionUrl,
    );
  }
  assert.throws(
    () => readCompetitionSubmissionConfig(path.join(process.cwd(), 'private-submission.json')),
    (error) => error instanceof CompetitionSubmissionError && error.code === 'invalid_config',
  );
});
