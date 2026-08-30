import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  initializeCompetitionSecret,
  putCompetitionSecret,
} from './competition-secret.mjs';

test('init creates one dedicated config without returning or printing its token', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'competition-secret-'));
  try {
    const configPath = path.join(root, 'competition.json');
    const result = initializeCompetitionSecret({
      configPath,
      apiUrl: 'https://api.test/',
      randomBytes: () => Buffer.alloc(48, 7),
    });
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.equal(config.api_url, 'https://api.test');
    assert.equal(config.competition_ingest_token.length, 64);
    assert.doesNotMatch(JSON.stringify(result), new RegExp(config.competition_ingest_token, 'u'));
    assert.throws(() => initializeCompetitionSecret({
      configPath,
      apiUrl: 'https://api.test',
    }), /refusing to overwrite/u);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('put passes the stored token only through stdin and returns a fingerprint', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'competition-secret-put-'));
  try {
    const configPath = path.join(root, 'competition.json');
    initializeCompetitionSecret({
      configPath,
      apiUrl: 'https://api.test',
      randomBytes: () => Buffer.alloc(48, 9),
    });
    const token = JSON.parse(fs.readFileSync(configPath, 'utf8')).competition_ingest_token;
    let invocation;
    const result = putCompetitionSecret({
      configPath,
      workerConfig: path.join(root, 'wrangler.toml'),
      spawnSyncImpl: (command, args, options) => {
        invocation = { command, args, options };
        return { status: 0, stdout: '', stderr: '' };
      },
    });
    assert.deepEqual(invocation.args.slice(0, 4), ['wrangler', 'secret', 'put', 'COMPETITION_INGEST_TOKEN']);
    assert.equal(invocation.options.input, `${token}\n`);
    assert.doesNotMatch(JSON.stringify(result), new RegExp(token, 'u'));
    assert.equal(result.configured, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
