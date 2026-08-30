import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT_FILE = fileURLToPath(import.meta.url);
const SECRET_NAME = 'COMPETITION_INGEST_TOKEN';

function fail(message) {
  throw new Error(message);
}

function parseArgs(argv) {
  const command = argv[0];
  if (!['init', 'put'].includes(command)) fail('usage: competition-secret.mjs <init|put> --config <path> [options]');
  const options = { command };
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!['--config', '--api-url', '--worker-config'].includes(argument)) fail(`unknown argument: ${argument}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) fail(`${argument} requires a value`);
    index += 1;
    if (argument === '--config') options.configPath = value;
    else if (argument === '--api-url') options.apiUrl = value;
    else options.workerConfig = value;
  }
  if (!options.configPath) fail('--config is required');
  if (command === 'init' && !options.apiUrl) fail('--api-url is required for init');
  if (command === 'put' && !options.workerConfig) fail('--worker-config is required for put');
  return options;
}

function normalizedApiUrl(value) {
  let url;
  try { url = new URL(value); } catch { fail('--api-url must be a valid HTTPS URL'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    fail('--api-url must be a valid HTTPS URL');
  }
  return url.href.replace(/\/+$/u, '');
}

function readSecretConfig(configPath, fsImpl) {
  let config;
  try { config = JSON.parse(fsImpl.readFileSync(path.resolve(configPath), 'utf8').replace(/^\uFEFF/u, '')); }
  catch { fail('competition secret config is missing or invalid'); }
  if (!config || typeof config !== 'object' || Array.isArray(config)
    || Object.keys(config).some((key) => !['api_url', 'competition_ingest_token'].includes(key))
    || typeof config.competition_ingest_token !== 'string'
    || config.competition_ingest_token.length < 43) {
    fail('competition secret config is invalid');
  }
  normalizedApiUrl(config.api_url);
  return config;
}

function fingerprint(token) {
  return crypto.createHash('sha256').update(token).digest('hex').slice(0, 12);
}

export function initializeCompetitionSecret({ configPath, apiUrl, fsImpl = fs, randomBytes = crypto.randomBytes }) {
  const file = path.resolve(configPath);
  const token = randomBytes(48).toString('base64url');
  const config = {
    api_url: normalizedApiUrl(apiUrl),
    competition_ingest_token: token,
  };
  let handle;
  try {
    handle = fsImpl.openSync(file, 'wx', 0o600);
    fsImpl.writeFileSync(handle, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8' });
  } catch (error) {
    if (error?.code === 'EEXIST') fail('competition secret config already exists; refusing to overwrite it');
    throw error;
  } finally {
    if (handle !== undefined) fsImpl.closeSync(handle);
  }
  try { fsImpl.chmodSync(file, 0o600); } catch { /* Windows ACLs remain inherited from the private config directory. */ }
  return {
    ok: true,
    initialized: true,
    config_path: file,
    secret_name: SECRET_NAME,
    token_sha256_12: fingerprint(token),
  };
}

export function putCompetitionSecret({
  configPath,
  workerConfig,
  fsImpl = fs,
  spawnSyncImpl = spawnSync,
  cwd = process.cwd(),
}) {
  const config = readSecretConfig(configPath, fsImpl);
  const executable = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  const workerFile = path.resolve(workerConfig);
  const result = spawnSyncImpl(executable, [
    'wrangler', 'secret', 'put', SECRET_NAME, '--config', workerFile,
  ], {
    cwd,
    input: `${config.competition_ingest_token}\n`,
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (result.error || result.status !== 0) fail('wrangler could not set the competition ingest secret');
  return {
    ok: true,
    configured: true,
    secret_name: SECRET_NAME,
    worker_config: workerFile,
    token_sha256_12: fingerprint(config.competition_ingest_token),
  };
}

export function runCompetitionSecret(argv, options = {}) {
  const parsed = parseArgs(argv);
  if (parsed.command === 'init') return initializeCompetitionSecret({
    configPath: parsed.configPath,
    apiUrl: parsed.apiUrl,
    fsImpl: options.fsImpl,
    randomBytes: options.randomBytes,
  });
  return putCompetitionSecret({
    configPath: parsed.configPath,
    workerConfig: parsed.workerConfig,
    fsImpl: options.fsImpl,
    spawnSyncImpl: options.spawnSyncImpl,
    cwd: options.cwd,
  });
}

function main() {
  try {
    process.stdout.write(`${JSON.stringify(runCompetitionSecret(process.argv.slice(2)))}\n`);
  } catch (error) {
    process.stderr.write(`[competition-secret] ${error?.message || 'unexpected failure'}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_FILE) main();
