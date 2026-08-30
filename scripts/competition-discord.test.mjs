import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  ensureCompetitionResultChannel,
  RESULT_CHANNEL_NAME,
  RESULT_TOPIC_MARKER,
  sendCompetitionResult,
} from './competition-discord.mjs';

function response(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function workspace() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'competition-discord-'));
  const envFile = path.join(directory, '.env');
  const configFile = path.join(directory, 'competition-discord.json');
  fs.writeFileSync(
    envFile,
    'DISCORD_TOKEN=test-bot-token\nDISCORD_GUILD_ID=123456789012345678\n',
    'utf8',
  );
  return {
    directory,
    envFile,
    configFile,
    cleanup: () => fs.rmSync(directory, { recursive: true, force: true }),
  };
}

const category = {
  id: '223456789012345678',
  guild_id: '123456789012345678',
  type: 4,
  name: '기본',
};
const channel = {
  id: '323456789012345678',
  guild_id: '123456789012345678',
  type: 0,
  name: RESULT_CHANNEL_NAME,
  topic: RESULT_TOPIC_MARKER,
  parent_id: category.id,
};

test('ensure-channel reuses the single protected result channel', async () => {
  const files = workspace();
  try {
    let createCalls = 0;
    const result = await ensureCompetitionResultChannel({
      envFile: files.envFile,
      configFile: files.configFile,
      fetchImpl: async (_url, options) => {
        if (options.method === 'POST') createCalls += 1;
        return response([category, channel]);
      },
    });
    assert.deepEqual(result, {
      ok: true,
      action: 'reused',
      channelName: RESULT_CHANNEL_NAME,
    });
    assert.equal(createCalls, 0);
    const saved = JSON.parse(fs.readFileSync(files.configFile, 'utf8'));
    assert.equal(saved.channelId, channel.id);
    assert.equal(saved.topicMarker, RESULT_TOPIC_MARKER);
    assert.equal(saved.categoryId, category.id);
  } finally {
    files.cleanup();
  }
});

test('Discord helpers reject aliased input/output paths before network or overwrite', async () => {
  const files = workspace();
  try {
    const originalEnv = fs.readFileSync(files.envFile, 'utf8');
    let calls = 0;
    await assert.rejects(
      ensureCompetitionResultChannel({
        envFile: files.envFile,
        configFile: files.envFile.toUpperCase(),
        fetchImpl: async () => {
          calls += 1;
          return response([category, channel]);
        },
      }),
      /env and config paths must differ/u,
    );
    await assert.rejects(
      sendCompetitionResult({
        envFile: files.envFile,
        configFile: files.configFile,
        messageFile: path.join(files.directory, '.', 'competition-discord.json'),
        kind: 'discovery_complete',
        fetchImpl: async () => {
          calls += 1;
          return response(channel);
        },
      }),
      /config and message paths must differ/u,
    );
    assert.equal(calls, 0);
    assert.equal(fs.readFileSync(files.envFile, 'utf8'), originalEnv);
  } finally {
    files.cleanup();
  }
});

test('ensure-channel creates one result channel under the exact category', async () => {
  const files = workspace();
  try {
    let createBody;
    const result = await ensureCompetitionResultChannel({
      envFile: files.envFile,
      configFile: files.configFile,
      fetchImpl: async (_url, options) => {
        if (options.method === 'POST') {
          createBody = JSON.parse(options.body);
          return response(channel, 201);
        }
        return response([category]);
      },
    });
    assert.equal(result.action, 'created');
    assert.deepEqual(createBody, {
      name: RESULT_CHANNEL_NAME,
      type: 0,
      topic: RESULT_TOPIC_MARKER,
      parent_id: category.id,
    });
  } finally {
    files.cleanup();
  }
});

test('concurrent ensure-channel calls serialize list, create, and save under one lock', async () => {
  const files = workspace();
  try {
    let liveChannels = [category];
    let createCalls = 0;
    const secondConfigFile = path.join(files.directory, 'competition-discord-second.json');
    const fetchImpl = async (_url, options) => {
      await Promise.resolve();
      if (options.method === 'POST') {
        createCalls += 1;
        liveChannels = [category, channel];
        return response(channel, 201);
      }
      return response([...liveChannels]);
    };
    const [first, second] = await Promise.all([
      ensureCompetitionResultChannel({
        envFile: files.envFile,
        configFile: secondConfigFile,
        fetchImpl,
      }),
      ensureCompetitionResultChannel({
        envFile: files.envFile,
        configFile: files.configFile,
        fetchImpl,
      }),
    ]);
    assert.equal(createCalls, 1);
    assert.deepEqual(new Set([first.action, second.action]), new Set(['created', 'reused']));
    assert.equal(JSON.parse(fs.readFileSync(files.configFile, 'utf8')).channelId, channel.id);
    assert.equal(JSON.parse(fs.readFileSync(secondConfigFile, 'utf8')).channelId, channel.id);
  } finally {
    files.cleanup();
  }
});

test('a create timeout reconciles a remotely committed protected channel before retrying', async () => {
  const files = workspace();
  try {
    let liveChannels = [category];
    let createCalls = 0;
    const result = await ensureCompetitionResultChannel({
      envFile: files.envFile,
      configFile: files.configFile,
      timeoutMs: 10,
      fetchImpl: async (_url, options) => {
        if (options.method === 'POST') {
          createCalls += 1;
          liveChannels = [category, channel];
          return new Promise(() => {});
        }
        return response([...liveChannels]);
      },
    });
    assert.equal(createCalls, 1);
    assert.equal(result.action, 'reconciled');
    assert.equal(JSON.parse(fs.readFileSync(files.configFile, 'utf8')).channelId, channel.id);
  } finally {
    files.cleanup();
  }
});

test('duplicate protected topic markers fail closed', async () => {
  const files = workspace();
  try {
    await assert.rejects(
      ensureCompetitionResultChannel({
        envFile: files.envFile,
        configFile: files.configFile,
        fetchImpl: async () => response([
          category,
          channel,
          { ...channel, id: '423456789012345678' },
        ]),
      }),
      /Multiple Discord result channels/u,
    );
  } finally {
    files.cleanup();
  }
});

test('channel name and category drift fail closed without creating or sending', async () => {
  const files = workspace();
  try {
    const wrongBoundary = { ...channel, topic: 'other-purpose' };
    await assert.rejects(
      ensureCompetitionResultChannel({
        envFile: files.envFile,
        configFile: files.configFile,
        fetchImpl: async () => response([category, wrongBoundary]),
      }),
      /already used outside the protected boundary/u,
    );
    const moved = { ...channel, parent_id: '423456789012345678' };
    await assert.rejects(
      ensureCompetitionResultChannel({
        envFile: files.envFile,
        configFile: files.configFile,
        fetchImpl: async () => response([category, moved]),
      }),
      /outside the protected boundary/u,
    );
  } finally {
    files.cleanup();
  }
});

test('send-result revalidates the guild boundary and disables mentions', async () => {
  const files = workspace();
  try {
    fs.writeFileSync(files.configFile, JSON.stringify({
      version: 1,
      channelId: channel.id,
      channelName: RESULT_CHANNEL_NAME,
      topicMarker: RESULT_TOPIC_MARKER,
      categoryId: category.id,
    }), 'utf8');
    const messageFile = path.join(files.directory, 'message.txt');
    fs.writeFileSync(messageFile, '12개 원본 탐색이 완료되었습니다.', 'utf8');
    let messageBody;
    const result = await sendCompetitionResult({
      envFile: files.envFile,
      configFile: files.configFile,
      messageFile,
      kind: 'discovery_complete',
      fetchImpl: async (url, options) => {
        if (url.endsWith('/messages')) {
          messageBody = JSON.parse(options.body);
          return response({ id: '523456789012345678' }, 201);
        }
        if (url.endsWith('/channels/' + category.id)) return response(category);
        return response(channel);
      },
    });
    assert.equal(result.action, 'sent');
    assert.match(messageBody.content, /^\[탐색 완료\]/u);
    assert.deepEqual(messageBody.allowed_mentions, { parse: [] });
    assert.match(messageBody.nonce, /^[0-9a-f]{25}$/u);
    assert.equal(messageBody.enforce_nonce, true);
  } finally {
    files.cleanup();
  }
});

test('send-result revalidates the exact live parent category before any message POST', async () => {
  const files = workspace();
  try {
    fs.writeFileSync(files.configFile, JSON.stringify({
      version: 1,
      channelId: channel.id,
      channelName: RESULT_CHANNEL_NAME,
      topicMarker: RESULT_TOPIC_MARKER,
      categoryId: category.id,
    }), 'utf8');
    const messageFile = path.join(files.directory, 'message.txt');
    fs.writeFileSync(messageFile, '검증된 탐색 결과입니다.', 'utf8');
    for (const invalidCategory of [
      { ...category, name: 'renamed' },
      { ...category, guild_id: '999999999999999999' },
      { ...category, type: 0 },
    ]) {
      let messagePosts = 0;
      await assert.rejects(
        sendCompetitionResult({
          envFile: files.envFile,
          configFile: files.configFile,
          messageFile,
          kind: 'discovery_complete',
          fetchImpl: async (url, options) => {
            if (url.endsWith('/messages') && options.method === 'POST') messagePosts += 1;
            if (url.endsWith('/channels/' + category.id)) return response(invalidCategory);
            return response(channel);
          },
        }),
        /category no longer matches/u,
      );
      assert.equal(messagePosts, 0);
    }
  } finally {
    files.cleanup();
  }
});

test('send-result rejects progress kinds and private content before transmission', async () => {
  const files = workspace();
  try {
    fs.writeFileSync(files.configFile, JSON.stringify({
      version: 1,
      channelId: channel.id,
      channelName: RESULT_CHANNEL_NAME,
      topicMarker: RESULT_TOPIC_MARKER,
      categoryId: category.id,
    }), 'utf8');
    const messageFile = path.join(files.directory, 'message.txt');
    fs.writeFileSync(messageFile, 'contact@example.com 진행 중', 'utf8');
    let calls = 0;
    await assert.rejects(
      sendCompetitionResult({
        envFile: files.envFile,
        configFile: files.configFile,
        messageFile,
        kind: 'progress',
        fetchImpl: async () => {
          calls += 1;
          return response(channel);
        },
      }),
      /completed result or exact approval gate/u,
    );
    await assert.rejects(
      sendCompetitionResult({
        envFile: files.envFile,
        configFile: files.configFile,
        messageFile,
        kind: 'approval_required',
        fetchImpl: async () => {
          calls += 1;
          return response(channel);
        },
      }),
      /contains private data/u,
    );
    for (const privateText of [
      'session=abc123',
      '02-1234-5678',
      'api_key=privatevalue',
      'cookie: privatevalue',
      'address=private place',
      'test-bot-token',
      '완료 결과 ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      '완료 결과 github_pat_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      '완료 결과 glpat-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      '완료 결과 npm_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      '완료 결과 sk-proj-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      '완료 결과 eyJAAAAAAAAAAAA.BBBBBBBBBBBB.CCCCCCCCCCCC',
      '-----BEGIN PRIVATE KEY-----',
      '지원자: 홍길동',
      '신청자 성명=홍길동',
      '지원자 홍길동의 지원 결과',
      '주소 서울특별시 중구',
      'person%40example.com',
      '완료 결과 ghp%5FAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      'person\u200B@example.com',
      'test%2Dbot%2Dtoken',
      '<script>alert(1)</script>',
      '<!-- raw scraped html -->',
      '%3Cscript%3Ealert%281%29%3C%2Fscript%3E',
    ]) {
      fs.writeFileSync(messageFile, privateText, 'utf8');
      await assert.rejects(
        sendCompetitionResult({
          envFile: files.envFile,
          configFile: files.configFile,
          messageFile,
          kind: 'approval_required',
          fetchImpl: async () => {
            calls += 1;
            return response(channel);
          },
        }),
        /contains private data/u,
      );
    }
    assert.equal(calls, 0);
  } finally {
    files.cleanup();
  }
});

test('send-result retries use one stable enforced Discord nonce after an ambiguous timeout', async () => {
  const files = workspace();
  try {
    fs.writeFileSync(files.configFile, JSON.stringify({
      version: 1,
      channelId: channel.id,
      channelName: RESULT_CHANNEL_NAME,
      topicMarker: RESULT_TOPIC_MARKER,
      categoryId: category.id,
    }), 'utf8');
    const messageFile = path.join(files.directory, 'message.txt');
    fs.writeFileSync(messageFile, '검증 완료 후보 1건입니다.', 'utf8');
    const posts = [];
    const attempt = () => sendCompetitionResult({
      envFile: files.envFile,
      configFile: files.configFile,
      messageFile,
      kind: 'discovery_complete',
      timeoutMs: 10,
      fetchImpl: async (url, options) => {
        if (url.endsWith('/channels/' + category.id)) return response(category);
        if (url.endsWith('/channels/' + channel.id)) return response(channel);
        if (url.endsWith('/messages')) {
          posts.push(JSON.parse(options.body));
          return new Promise(() => {});
        }
        throw new Error('unexpected Discord URL');
      },
    });
    await assert.rejects(attempt(), /timed out/u);
    await assert.rejects(attempt(), /timed out/u);
    assert.equal(posts.length, 2);
    assert.match(posts[0].nonce, /^[0-9a-f]{25}$/u);
    assert.equal(posts[0].nonce, posts[1].nonce);
    assert.equal(posts[0].enforce_nonce, true);
    assert.equal(posts[1].enforce_nonce, true);
  } finally {
    files.cleanup();
  }
});

test('Discord requests time out even when a fetch implementation never settles', async () => {
  const files = workspace();
  try {
    await assert.rejects(
      ensureCompetitionResultChannel({
        envFile: files.envFile,
        configFile: files.configFile,
        timeoutMs: 10,
        fetchImpl: async () => new Promise(() => {}),
      }),
      /timed out/u,
    );
  } finally {
    files.cleanup();
  }
});
