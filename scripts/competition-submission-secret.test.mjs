import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  initializeCompetitionSubmissionSecret,
  putCompetitionSubmissionSecret,
} from './competition-submission-secret.mjs';

test('submission secret init creates an outside-Git client config without returning its token', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'competition-submission-secret-'));
  try {
    const configPath = path.join(root, 'submission.json');
    const result = initializeCompetitionSubmissionSecret({
      configPath,
      apiUrl: 'https://api.test/',
      randomBytes: () => Buffer.alloc(48, 5),
    });
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.equal(config.api_url, 'https://api.test');
    assert.equal(config.competition_submission_token.length, 64);
    assert.deepEqual(config.actions, {});
    assert.doesNotMatch(JSON.stringify(result), new RegExp(config.competition_submission_token, 'u'));
    assert.throws(() => initializeCompetitionSubmissionSecret({
      configPath, apiUrl: 'https://api.test',
    }), /refusing to overwrite/u);
    assert.throws(() => initializeCompetitionSubmissionSecret({
      configPath: path.join(process.cwd(), 'private-submission.json'),
      apiUrl: 'https://api.test',
    }), /outside Git/u);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('submission secret put passes the token only through wrangler stdin', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'competition-submission-secret-put-'));
  try {
    const configPath = path.join(root, 'submission.json');
    initializeCompetitionSubmissionSecret({
      configPath,
      apiUrl: 'https://api.test',
      randomBytes: () => Buffer.alloc(48, 6),
    });
    const token = JSON.parse(fs.readFileSync(configPath, 'utf8')).competition_submission_token;
    let invocation;
    const result = putCompetitionSubmissionSecret({
      configPath,
      workerConfig: path.join(root, 'wrangler.toml'),
      spawnSyncImpl: (command, args, options) => {
        invocation = { command, args, options };
        return { status: 0, stdout: '', stderr: '' };
      },
    });
    assert.deepEqual(invocation.args.slice(0, 4), [
      'wrangler', 'secret', 'put', 'COMPETITION_SUBMISSION_TOKEN',
    ]);
    assert.equal(invocation.options.input, `${token}\n`);
    assert.doesNotMatch(JSON.stringify({ command: invocation.command, args: invocation.args, result }), new RegExp(token, 'u'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
