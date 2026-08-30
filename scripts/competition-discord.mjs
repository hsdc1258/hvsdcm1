import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireCompetitionDistinctPaths } from './competition-paths.mjs';

const SCRIPT_FILE = fileURLToPath(import.meta.url);
const API_BASE = 'https://discord.com/api/v10';
const DEFAULT_DISCORD_TIMEOUT_MS = 15_000;
const DISCORD_LOCK_STALE_MS = 120_000;
const DISCORD_LOCK_WAIT_MS = 30_000;
export const RESULT_CHANNEL_NAME = '공모전-지원-결과';
export const RESULT_TOPIC_MARKER = 'codex:competition-results:v1';
const RESULT_KINDS = new Set(['discovery_complete', 'submission_complete', 'approval_required']);
const PRIVATE_TEXT = /(?:[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|(?:\+?82[- .]?)?0\d{1,2}[-. ]?\d{3,4}[-. ]?\d{4}|\d{6}[- ]?[1-8]\d{6}|(?:bearer\s+[A-Z0-9._~+/-]{8,})|(?:access[_. -]?token|refresh[_. -]?token|api[_. -]?key|client[_. -]?secret|private[_. -]?key|signing[_. -]?key|applicant(?:[_. -]?name)?|지원자|신청자|성명|token|secret|password|authorization|session|cookie|credential|signature|address|email|phone|생년월일|주민등록|주소|전화번호|연락처|이메일)\s*[:=])/iu;
const LABELED_PRIVATE_TEXT = /(?:(?:지원자|신청자)\s+(?!(?:누구나|모두|전원)(?:\s|$))[가-힣]{2,4}(?:의|님|씨)|(?:성명|주소|address)\s+(?!(?:미정|없음)(?:\s|$))\S+)/iu;
const STANDALONE_CREDENTIAL = /(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|npm_[A-Za-z0-9]{20,}|sk-(?:proj-)?[A-Za-z0-9_-]{20,}|sk_(?:live|test)_[A-Za-z0-9]{16,}|xox[baprs]-[A-Za-z0-9-]{20,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|mfa\.[A-Za-z0-9_-]{20,}|[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{20,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/u;
const RAW_MARKUP = /(?:<\/?[A-Za-z][^>]*>|<!--|<!DOCTYPE)/iu;

function privacyFold(value) {
  return String(value).normalize('NFKD').replace(/[\p{M}\p{Cf}]/gu, '').normalize('NFKC');
}

function discordMessageContainsPrivateData(value, secrets = []) {
  let decoded = String(value).normalize('NFKC');
  for (let pass = 0; pass < 8; pass += 1) {
    const forms = new Set([decoded, privacyFold(decoded)]);
    for (const form of forms) {
      if (PRIVATE_TEXT.test(form) || LABELED_PRIVATE_TEXT.test(form)
        || STANDALONE_CREDENTIAL.test(form) || RAW_MARKUP.test(form)) return true;
      for (const secret of secrets) {
        const normalizedSecret = String(secret || '').normalize('NFKC');
        if (normalizedSecret && (form.includes(normalizedSecret)
          || privacyFold(form).includes(privacyFold(normalizedSecret)))) return true;
      }
    }
    if (!/%[0-9A-F]{2}/iu.test(decoded)) return false;
    let next;
    try { next = decodeURIComponent(decoded).normalize('NFKC'); }
    catch { return true; }
    if (next === decoded) return false;
    decoded = next;
  }
  return true;
}

function parseEnvFile(file, fsImpl = fs) {
  const values = {};
  const content = fsImpl.readFileSync(path.resolve(file), 'utf8').replace(/^\uFEFF/u, '');
  for (const rawLine of content.split(/\r?\n/gu)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  const token = values.DISCORD_TOKEN?.trim();
  const guildId = values.DISCORD_GUILD_ID?.trim();
  if (!token || !/^\d{10,30}$/u.test(guildId || '')) {
    throw new Error('Discord bot token or guild boundary is missing');
  }
  return { token, guildId };
}

async function discordRequest(fetchImpl, token, apiPath, options = {}) {
  const timeoutMs = Number(options.timeoutMs || DEFAULT_DISCORD_TIMEOUT_MS);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
    throw new Error('Discord timeout must be between 1 and 30000 milliseconds');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const aborted = new Promise((_, reject) => {
    controller.signal.addEventListener('abort', () => {
      reject(new DOMException('The operation was aborted', 'AbortError'));
    }, { once: true });
  });
  try {
    const response = await Promise.race([fetchImpl(API_BASE + apiPath, {
      method: options.method || 'GET',
      signal: controller.signal,
      headers: {
        authorization: 'Bot ' + token,
        'content-type': 'application/json',
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    }), aborted]);
    if (!response.ok) {
      throw new Error('Discord request failed with HTTP ' + response.status);
    }
    return response.status === 204
      ? null
      : await Promise.race([response.json(), aborted]);
  } catch (error) {
    if (error?.name === 'AbortError' || controller.signal.aborted) {
      throw new Error('Discord request timed out');
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function atomicWriteJson(file, value, fsImpl = fs) {
  const fullPath = path.resolve(file);
  fsImpl.mkdirSync(path.dirname(fullPath), { recursive: true });
  const temporary = fullPath + '.' + process.pid + '.tmp';
  fsImpl.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', {
    encoding: 'utf8',
    mode: 0o600,
  });
  fsImpl.renameSync(temporary, fullPath);
}

function resultChannels(channels) {
  return channels.filter((channel) => channel.type === 0 && channel.topic === RESULT_TOPIC_MARKER);
}

function validateLiveChannel(channel, guildId, categoryId) {
  if (!channel || channel.type !== 0 || channel.guild_id !== guildId
    || channel.topic !== RESULT_TOPIC_MARKER || channel.name !== RESULT_CHANNEL_NAME
    || channel.parent_id !== categoryId) {
    throw new Error('Discord result channel no longer matches its guild, category, and topic boundary');
  }
  return channel;
}

function validateLiveCategory(category, guildId, categoryId) {
  if (!category || category.id !== categoryId || category.type !== 4
    || category.guild_id !== guildId || category.name !== '기본') {
    throw new Error('Discord 기본 category no longer matches its exact guild and name boundary');
  }
  return category;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function withExclusiveConfigLock(lockFile, action, options = {}) {
  const fsImpl = options.fsImpl || fs;
  const waitMs = Math.min(
    DISCORD_LOCK_WAIT_MS,
    Math.max(1_000, Number(options.timeoutMs || DEFAULT_DISCORD_TIMEOUT_MS) * 2),
  );
  const deadline = Date.now() + waitMs;
  const fullPath = path.resolve(lockFile);
  fsImpl.mkdirSync(path.dirname(fullPath), { recursive: true });
  let descriptor;
  while (descriptor === undefined) {
    try {
      descriptor = fsImpl.openSync(fullPath, 'wx', 0o600);
      fsImpl.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, created_at: Date.now() }));
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      let stale = false;
      try {
        stale = Date.now() - fsImpl.statSync(fullPath).mtimeMs > DISCORD_LOCK_STALE_MS;
      } catch (statError) {
        if (statError?.code !== 'ENOENT') throw statError;
      }
      if (stale) {
        try { fsImpl.unlinkSync(fullPath); } catch (unlinkError) {
          if (unlinkError?.code !== 'ENOENT') throw unlinkError;
        }
        continue;
      }
      if (Date.now() >= deadline) throw new Error('Discord result channel lock timed out');
      await sleep(25);
    }
  }
  try {
    return await action();
  } finally {
    try { fsImpl.closeSync(descriptor); } catch { /* Release remains best-effort. */ }
    try { fsImpl.unlinkSync(fullPath); } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
}

function inspectGuildChannels(channels, guildId) {
  if (!Array.isArray(channels)) throw new Error('Discord guild channel list is invalid');
  const categories = channels.filter((entry) => entry.type === 4 && entry.name === '기본');
  if (categories.length !== 1) {
    throw new Error('Discord 기본 category boundary is missing or ambiguous');
  }
  const categoryId = categories[0].id;
  validateLiveCategory(categories[0], guildId, categoryId);
  const nameConflicts = channels.filter((entry) => entry.type === 0
    && entry.name === RESULT_CHANNEL_NAME
    && (entry.topic !== RESULT_TOPIC_MARKER || entry.parent_id !== categoryId));
  if (nameConflicts.length > 0) {
    throw new Error('Discord result channel name is already used outside the protected boundary');
  }
  const existing = resultChannels(channels);
  if (existing.length > 1) {
    throw new Error('Multiple Discord result channels share the protected topic marker');
  }
  return { categoryId, channel: existing[0] };
}

export async function ensureCompetitionResultChannel(options) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const fsImpl = options.fsImpl || fs;
  const config = parseEnvFile(options.envFile, fsImpl);
  const guildHash = crypto.createHash('sha256').update(config.guildId).digest('hex').slice(0, 24);
  const lockFile = path.join(os.tmpdir(), 'hvsdcm1-competition-discord-' + guildHash + '.lock');
  requireCompetitionDistinctPaths([
    ['env', options.envFile],
    ['config', options.configFile],
    ['lock', lockFile],
  ], { fsImpl, label: 'Discord' });
  return withExclusiveConfigLock(lockFile, async () => {
    const channels = await discordRequest(
      fetchImpl,
      config.token,
      '/guilds/' + config.guildId + '/channels',
      { timeoutMs: options.timeoutMs },
    );
    const boundary = inspectGuildChannels(channels, config.guildId);
    let { channel } = boundary;
    const { categoryId } = boundary;
    let action = 'reused';
    if (!channel) {
      try {
        channel = await discordRequest(
          fetchImpl,
          config.token,
          '/guilds/' + config.guildId + '/channels',
          {
            method: 'POST',
            body: {
              name: RESULT_CHANNEL_NAME,
              type: 0,
              topic: RESULT_TOPIC_MARKER,
              parent_id: categoryId,
            },
            timeoutMs: options.timeoutMs,
          },
        );
        action = 'created';
      } catch (error) {
        if (!/timed out/u.test(error?.message || '')) throw error;
        const afterTimeout = await discordRequest(
          fetchImpl,
          config.token,
          '/guilds/' + config.guildId + '/channels',
          { timeoutMs: options.timeoutMs },
        );
        const reconciled = inspectGuildChannels(afterTimeout, config.guildId);
        if (!reconciled.channel || reconciled.categoryId !== categoryId) throw error;
        channel = reconciled.channel;
        action = 'reconciled';
      }
    }
    validateLiveChannel(channel, config.guildId, categoryId);
    atomicWriteJson(options.configFile, {
      version: 1,
      channelId: channel.id,
      channelName: RESULT_CHANNEL_NAME,
      topicMarker: RESULT_TOPIC_MARKER,
      categoryId,
    }, fsImpl);
    return { ok: true, action, channelName: RESULT_CHANNEL_NAME };
  }, { fsImpl, timeoutMs: options.timeoutMs });
}

function readChannelConfig(file, fsImpl = fs) {
  const value = JSON.parse(fsImpl.readFileSync(path.resolve(file), 'utf8').replace(/^\uFEFF/u, ''));
  if (value?.version !== 1 || !/^\d{10,30}$/u.test(value.channelId || '')
    || !/^\d{10,30}$/u.test(value.categoryId || '')
    || value.channelName !== RESULT_CHANNEL_NAME || value.topicMarker !== RESULT_TOPIC_MARKER) {
    throw new Error('Discord result channel config is missing or invalid');
  }
  return value;
}

function readResultMessage(file, kind, fsImpl = fs, secrets = []) {
  if (!RESULT_KINDS.has(kind)) {
    throw new Error('Discord result kind must be a completed result or exact approval gate');
  }
  const fullPath = path.resolve(file);
  const stat = fsImpl.statSync(fullPath);
  if (!stat.isFile() || stat.size > 1_800) {
    throw new Error('Discord result message is empty, too large, or contains private data');
  }
  const message = fsImpl.readFileSync(fullPath, 'utf8').trim();
  if (!message || message.length > 1_600 || Buffer.byteLength(message, 'utf8') > 1_800
    || discordMessageContainsPrivateData(message, secrets)) {
    throw new Error('Discord result message is empty, too large, or contains private data');
  }
  const labels = {
    discovery_complete: '탐색 완료',
    submission_complete: '지원 완료',
    approval_required: '사람 승인 필요',
  };
  return '[' + labels[kind] + '] ' + message;
}

export async function sendCompetitionResult(options) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const fsImpl = options.fsImpl || fs;
  requireCompetitionDistinctPaths([
    ['env', options.envFile],
    ['config', options.configFile],
    ['message', options.messageFile],
  ], { fsImpl, label: 'Discord' });
  const env = parseEnvFile(options.envFile, fsImpl);
  const saved = readChannelConfig(options.configFile, fsImpl);
  const message = readResultMessage(options.messageFile, options.kind, fsImpl, [env.token]);
  const category = await discordRequest(
    fetchImpl,
    env.token,
    '/channels/' + saved.categoryId,
    { timeoutMs: options.timeoutMs },
  );
  validateLiveCategory(category, env.guildId, saved.categoryId);
  const channel = await discordRequest(
    fetchImpl,
    env.token,
    '/channels/' + saved.channelId,
    { timeoutMs: options.timeoutMs },
  );
  validateLiveChannel(channel, env.guildId, saved.categoryId);
  const nonce = crypto.createHash('sha256')
    .update(saved.channelId + '\0' + options.kind + '\0' + message)
    .digest('hex')
    .slice(0, 25);
  await discordRequest(fetchImpl, env.token, '/channels/' + saved.channelId + '/messages', {
    method: 'POST',
    body: {
      content: message,
      allowed_mentions: { parse: [] },
      nonce,
      enforce_nonce: true,
    },
    timeoutMs: options.timeoutMs,
  });
  return { ok: true, action: 'sent', channelName: RESULT_CHANNEL_NAME, kind: options.kind };
}

function parseArgs(argv) {
  const command = argv[0];
  if (!['ensure-channel', 'send-result'].includes(command)) {
    throw new Error('command must be ensure-channel or send-result');
  }
  const values = { command };
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!['--env', '--config', '--kind', '--message-file'].includes(argument)) {
      throw new Error('unknown argument: ' + argument);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(argument + ' requires a value');
    index += 1;
    if (argument === '--env') values.envFile = value;
    else if (argument === '--config') values.configFile = value;
    else if (argument === '--kind') values.kind = value;
    else values.messageFile = value;
  }
  if (!values.envFile || !values.configFile) {
    throw new Error('--env and --config are required');
  }
  if (command === 'send-result' && (!values.kind || !values.messageFile)) {
    throw new Error('send-result requires --kind and --message-file');
  }
  return values;
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    const result = options.command === 'ensure-channel'
      ? await ensureCompetitionResultChannel(options)
      : await sendCompetitionResult(options);
    process.stdout.write(JSON.stringify(result) + '\n');
  } catch (error) {
    process.stderr.write(
      '[competition-discord] ' + (error?.message || 'unexpected Discord failure') + '\n',
    );
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_FILE) void main();
