import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  CompetitionSubmissionError,
  readCompetitionSubmissionConfig,
  runCompetitionSubmissionOnce,
} from './competition-submit.mjs';

const TOKEN = 's'.repeat(64);
const ACTION = 'a'.repeat(64);
const NOW = '2026-08-31T12:00:00.000Z';

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
    official_url: 'https://organizer.example/submit',
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

test('submission client records running before one adapter call and reports a bounded receipt', async (t) => {
  const configPath = withConfig(t, {
    actions: {
      [ACTION]: {
        request_id: 'competition-final-contest-image',
        official_url: 'https://organizer.example/submit',
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
        official_url: 'https://organizer.example/submit',
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

test('generic and mismatched organizer configurations fail closed without entering running', async (t) => {
  for (const [name, actions, expected] of [
    ['missing', {}, 'private_config_missing'],
    ['mismatch', {
      [ACTION]: {
        request_id: 'competition-final-contest-image',
        official_url: 'https://other.example/submit',
        adapter: 'organizer_example_v1',
      },
    }, 'destination_mismatch'],
    ['unsupported', {
      [ACTION]: {
        request_id: 'competition-final-contest-image',
        official_url: 'https://organizer.example/submit',
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
      assert.doesNotMatch(error.message, new RegExp(TOKEN, 'u'));
      assert.match(error.message, /\[redacted\]/u);
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
      fetchImpl: async () => new Response('x'.repeat(64_001), { status: 200 }),
    }),
    (error) => error instanceof CompetitionSubmissionError && error.code === 'invalid_response',
  );
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
        official_url: 'https://organizer.example/submit',
        adapter: 'organizer_example_v1',
        answers: ['forbidden'],
      },
    },
  }));
  assert.throws(
    () => readCompetitionSubmissionConfig(unsafe),
    (error) => error instanceof CompetitionSubmissionError && error.code === 'invalid_config',
  );
  assert.throws(
    () => readCompetitionSubmissionConfig(path.join(process.cwd(), 'private-submission.json')),
    (error) => error instanceof CompetitionSubmissionError && error.code === 'invalid_config',
  );
});
