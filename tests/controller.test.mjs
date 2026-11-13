import test from 'node:test';
import assert from 'node:assert/strict';
import { createTpsController, validateRoots } from '../src/controller.mjs';

function fakeHost(saved = null) {
  const handlers = new Map(), statuses = [], posts = [];
  const register = (name, fn) => { handlers.set(name, fn); return { dispose: () => handlers.delete(name) }; };
  return { handlers, statuses, posts, orca: {
    panels: { handle: register, post: (event, data) => posts.push({ event, data }) },
    commands: { register }, storage: { get: async () => saved },
    host: { call: async (method, params) => { assert.equal(method, 'statusBar.update'); statuses.push(params); } },
    log() {}
  } };
}
const target = id => ({ key: `pane:${id}`, provider: 'codex', sessionId: id, transcriptPath: `/private/${id}.jsonl` });
const result = (id, speed = 10, cache = 0.75, estimated = true) => ({ session: {
  id: `codex:${id}`, title: id, provider: 'codex', path: `/private/${id}.jsonl`,
  records: [{ id: `req-${id}-${speed}`, completedAt: 100, outputTokens: 250, durationMs: 25000,
    tokensPerSecond: speed, isEstimatedSpeed: estimated, cacheHitRate: cache }]
}, warnings: [] });
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const settle = () => new Promise(resolve => setImmediate(resolve));

test('follows the active target and displays latest record speed (with CC Switch ≈ / integer formatting) plus cache', async () => {
  const host = fakeHost({ selectedId: 'codex:other', roots: { codex: ['/saved'] } });
  const controller = createTpsController(host.orca, {
    readActive: async () => ({ target: target('old-open-conversation') }),
    readSession: async (active, options) => {
      assert.equal(active.sessionId, 'old-open-conversation');
      assert.deepEqual(options.roots.codex, ['/saved']);
      return result(active.sessionId, 26.4, 0.75, true);
    }, focusPollMs: 0
  });
  await controller.start();
  assert.equal(controller.state().activeSession.id, 'codex:old-open-conversation');
  assert.equal(host.statuses.at(-1).text, '🚀 ≈26 tokens/s · 🍪 命中 75.0%');
  assert.ok(!JSON.stringify(controller.state()).includes('/private'));
  assert.ok(!host.handlers.has('tps.select') && !host.handlers.has('tps.configure'));
  controller.stop();
});

test('exact proxy record displays integer speed without ≈ and 99.96% cache rounds to 100%', async () => {
  const host = fakeHost();
  const controller = createTpsController(host.orca, {
    readActive: async () => ({ target: target('proxy-session') }),
    readSession: async () => ({
      session: {
        id: 'codex:proxy-session', title: 'proxy', provider: 'codex', path: '/private/p.jsonl',
        records: [
          { id: 'newest', completedAt: 200, outputTokens: 300, durationMs: 4000, firstTokenMs: 1000, generationMs: 3000,
            dataSource: 'proxy', tokensPerSecond: 85.7, isEstimatedSpeed: false, cacheHitRate: 0.9996 },
          { id: 'older', completedAt: 100, outputTokens: 200, durationMs: 10000,
            dataSource: 'codex_session', tokensPerSecond: 20, isEstimatedSpeed: true, cacheHitRate: 0.5 }
        ]
      }, warnings: []
    }),
    focusPollMs: 0
  });
  await controller.start();
  assert.equal(host.statuses.at(-1).text, '🚀 86 tokens/s · 🍪 命中 100%');
  controller.stop();
});

test('switch clears records, timestamp, speed and cache before the next file finishes loading', async () => {
  const host = fakeHost(), pendingB = deferred();
  let active = target('a');
  const controller = createTpsController(host.orca, {
    readActive: async () => ({ target: active }),
    readSession: async value => value.sessionId === 'b' ? pendingB.promise : result('a'), focusPollMs: 0
  });
  await controller.start();
  active = target('b');
  const refreshing = controller.refresh();
  await settle();
  assert.equal(controller.state().activeSession.id, 'codex:b');
  assert.deepEqual(controller.state().records, []);
  assert.equal(controller.state().updatedAt, null);
  assert.equal(host.statuses.at(-1).text, '🚀 — tokens/s · 🍪 命中 —');
  pendingB.resolve(result('b', 20, 0));
  await refreshing;
  assert.equal(host.statuses.at(-1).text, '🚀 ≈20 tokens/s · 🍪 命中 0.0%');
  controller.stop();
});

test('a slow previous conversation cannot block or replace the new one', async () => {
  const host = fakeHost(), pendingA = deferred();
  let active = target('a');
  const controller = createTpsController(host.orca, {
    readActive: async () => ({ target: active }),
    readSession: async value => value.sessionId === 'a' ? pendingA.promise : result('b', 20), focusPollMs: 0
  });
  const starting = controller.start();
  await settle();
  active = target('b');
  await controller.refresh();
  pendingA.resolve(result('a', 99));
  await starting;
  assert.equal(controller.state().activeSession.id, 'codex:b');
  assert.equal(controller.state().records[0].tokensPerSecond, 20);
  assert.ok(!host.posts.some(item => item.data.records.some(record => record.tokensPerSecond === 99)));
  controller.stop();
});

test('A to B to A rejects the first A even when the target identity returns', async () => {
  const host = fakeHost(), reads = [deferred(), deferred(), deferred()];
  let active = target('a'), count = 0;
  const controller = createTpsController(host.orca, {
    readActive: async () => ({ target: active }), readSession: async () => reads[count++].promise, focusPollMs: 0
  });
  const first = controller.start(); await settle();
  active = target('b'); const second = controller.refresh(); await settle();
  active = target('a'); const third = controller.refresh(); await settle();
  reads[2].resolve(result('a', 30)); await third;
  reads[1].resolve(result('b', 20)); await second;
  reads[0].resolve(result('a', 10)); await first;
  assert.equal(controller.state().generation, 3);
  assert.equal(controller.state().records[0].tokensPerSecond, 30);
  assert.equal(host.statuses.at(-1).text, '🚀 ≈30 tokens/s · 🍪 命中 75.0%');
  controller.stop();
});

test('unknown target and read errors never retain another conversation', async () => {
  const host = fakeHost(); let active = target('a');
  const controller = createTpsController(host.orca, {
    readActive: async () => ({ target: active, message: active ? '' : '当前页面不是对话。' }),
    readSession: async value => { if (value.sessionId === 'b') throw new Error('/private/file'); return result('a'); }, focusPollMs: 0
  });
  await controller.start();
  // A real conversation switch (no transient busy-state) clears everything immediately,
  // even though the target is momentarily unknown.
  active = null; await controller.refresh();
  assert.equal(controller.state().activeSession, null);
  assert.deepEqual(controller.state().records, []);
  assert.equal(controller.state().updatedAt, null);
  assert.equal(controller.state().emptyMessage, '当前页面不是对话。');
  active = target('b'); await controller.refresh();
  assert.deepEqual(controller.state().records, []);
  assert.match(controller.state().warnings[0], /读取失败/);
  assert.ok(!JSON.stringify(controller.state()).includes('/private'));
  controller.stop();
});

test('wrong session returned by a reader is rejected and missing numeric data stays unknown', async () => {
  const host = fakeHost(); let wrong = true;
  const controller = createTpsController(host.orca, {
    readActive: async () => ({ target: target('a') }),
    readSession: async () => wrong ? result('b') : result('a', null, NaN), focusPollMs: 0
  });
  await controller.start();
  assert.deepEqual(controller.state().records, []);
  wrong = false; await controller.refresh();
  assert.equal(host.statuses.at(-1).text, '🚀 — tokens/s · 🍪 命中 —');
  controller.stop();
});

test('frequent focus checks do not rescan unchanged data before the refresh interval', async () => {
  const host = fakeHost(); let time = 0, reads = 0, active = target('a');
  const controller = createTpsController(host.orca, {
    readActive: async () => ({ target: active }),
    readSession: async value => { reads++; return result(value.sessionId); },
    now: () => time, pollMs: 5000, focusPollMs: 0
  });
  await controller.start();
  time = 1000; await controller.checkActive(); assert.equal(reads, 1);
  active = target('b'); await controller.checkActive(); assert.equal(reads, 2);
  time = 6001; await controller.checkActive(); assert.equal(reads, 3);
  controller.stop();
});

test('a delayed status-bar call cannot block reading or publishing the newly active conversation', async () => {
  const host = fakeHost(), blockedStatus = deferred();
  let active = target('a'), block = false;
  host.orca.host.call = async (method, params) => {
    if (block) await blockedStatus.promise;
    host.statuses.push(params);
  };
  const reads = [];
  const controller = createTpsController(host.orca, {
    readActive: async () => ({ target: active }),
    readSession: async value => { reads.push(value.sessionId); return result(value.sessionId, value.sessionId === 'a' ? 10 : 20); },
    focusPollMs: 0
  });
  await controller.start(); await settle();
  block = true;
  const refreshingA = controller.refresh(); await settle();
  active = target('b');
  const refreshingB = controller.refresh(); await settle();
  assert.equal(reads.at(-1), 'b');
  assert.equal(controller.state().records[0].tokensPerSecond, 20);
  assert.equal(host.posts.at(-1).data.activeSession.id, 'codex:b');
  blockedStatus.resolve();
  await Promise.all([refreshingA, refreshingB]); await settle();
  assert.equal(host.statuses.at(-1).text, '🚀 ≈20 tokens/s · 🍪 命中 75.0%');
  controller.stop();
});

test('stop unregisters handlers and ignores in-flight file reads', async () => {
  const host = fakeHost(), pending = deferred();
  const controller = createTpsController(host.orca, {
    readActive: async () => ({ target: target('a') }), readSession: async () => pending.promise, focusPollMs: 0
  });
  const starting = controller.start(); await settle();
  controller.stop(); const count = host.posts.length;
  pending.resolve(result('a')); await starting;
  assert.equal(host.handlers.size, 0);
  assert.equal(host.posts.length, count);
  assert.deepEqual(controller.state().records, []);
});

test('routine limits stay hidden while actual read problems remain visible', async () => {
  const host = fakeHost(); let actualError = false;
  const controller = createTpsController(host.orca, {
    readActive: async () => ({ target: target('a') }),
    readSession: async () => ({ ...result('a'), warnings: [
      '仅读取最近 100 个文件会话及最多 10 个数据库。',
      'codex：较大会话只读取末尾 16 MiB，缺少开头的轮次不计入。',
      ...(actualError ? ['读取失败'] : [])
    ] }), focusPollMs: 0
  });
  await controller.start();
  assert.deepEqual(controller.state().warnings, []);
  assert.ok(!host.statuses.at(-1).tooltip.includes('部分数据不可用'));
  actualError = true; await controller.refresh();
  assert.deepEqual(controller.state().warnings, ['读取失败']);
  controller.stop();
});

test('panel delivery failure does not prevent bottom-bar updates', async () => {
  const host = fakeHost(); host.orca.panels.post = () => { throw new Error('closed panel'); };
  const controller = createTpsController(host.orca, {
    readActive: async () => ({ target: target('a') }), readSession: async () => result('a'), focusPollMs: 0
  });
  await controller.start();
  assert.equal(host.statuses.at(-1).text, '🚀 ≈10 tokens/s · 🍪 命中 75.0%');
  controller.stop();
});

test('long-running agent busy-state keeps prior records instead of flashing them away', async () => {
  const host = fakeHost();
  let active = target('a'), busyPage = false, time = 0;
  const controller = createTpsController(host.orca, {
    readActive: async () => busyPage
      ? { target: null, message: '当前页签不是可统计的终端对话。' }
      : { target: active },
    readSession: async value => result(value.sessionId, 42, 0.98),
    now: () => time, pollMs: 5000, focusPollMs: 0, holdActivityMs: 100_000
  });
  await controller.start();
  assert.equal(controller.state().records[0].tokensPerSecond, 42);

  // Agent starts a long task; Orca briefly reports the tab as a non-terminal page.
  time = 1000;
  busyPage = true;
  await controller.refresh();
  const held = controller.state();
  assert.equal(held.records.length, 1, 'records must survive transient busy-state');
  assert.equal(held.records[0].tokensPerSecond, 42);
  assert.match(held.emptyMessage, /保留最近统计/);

  // Still within retention (last fresh data at t≈0, window 100s): busy polls keep the records.
  time = 60_000;
  await controller.checkActive();
  assert.equal(controller.state().records.length, 1);
  assert.equal(controller.state().records[0].tokensPerSecond, 42);

  // After the retention window expires with no recovery, the panel finally clears.
  time = 200_000;
  await controller.checkActive();
  assert.deepEqual(controller.state().records, []);

  // Recovery restores fresh reads.
  busyPage = false;
  await controller.refresh();
  assert.equal(controller.state().records[0].tokensPerSecond, 42);
  controller.stop();
});

test('genuinely different conversation still clears records immediately', async () => {
  const host = fakeHost();
  let active = target('a');
  const controller = createTpsController(host.orca, {
    readActive: async () => ({ target: active }),
    readSession: async value => result(value.sessionId, 11), focusPollMs: 0
  });
  await controller.start();
  active = target('b');
  await controller.refresh();
  assert.equal(controller.state().activeSession.id, 'codex:b');
  assert.equal(controller.state().records[0].id, 'req-b-11');
  assert.ok(!controller.state().records.some(record => record.id === 'req-a-11'));
  controller.stop();
});

test('a missed targeted read keeps the last records and surfaces the reason', async () => {
  const host = fakeHost(); let failReads = false;
  const controller = createTpsController(host.orca, {
    readActive: async () => ({ target: target('a') }),
    readSession: async () => failReads
      ? { session: null, warnings: ['claude：会话读取失败（EBUSY），未生成估算数据。'] }
      : result('a', 33), focusPollMs: 0
  });
  await controller.start();
  assert.equal(controller.state().records[0].tokensPerSecond, 33);
  failReads = true;
  await controller.refresh();
  const held = controller.state();
  assert.equal(held.records.length, 1, 'transient read miss must retain records');
  assert.equal(held.records[0].tokensPerSecond, 33);
  assert.match(held.warnings[0], /读取失败/);
  failReads = false;
  await controller.refresh();
  assert.equal(controller.state().records[0].tokensPerSecond, 33);
  assert.deepEqual(controller.state().warnings, []);
  controller.stop();
});

test('a thrown read error keeps the last records with a recovery hint', async () => {
  const host = fakeHost(); let throws = false;
  const controller = createTpsController(host.orca, {
    readActive: async () => ({ target: target('a') }),
    readSession: async () => { if (throws) throw new Error('EIO'); return result('a', 21); }, focusPollMs: 0
  });
  await controller.start();
  assert.equal(controller.state().records[0].tokensPerSecond, 21);
  throws = true;
  await controller.refresh();
  const held = controller.state();
  assert.equal(held.records.length, 1);
  assert.equal(held.records[0].tokensPerSecond, 21);
  assert.match(held.warnings[0], /保留上次统计/);
  controller.stop();
});

test('legacy custom roots remain bounded and validated without exposing a settings UI', () => {
  assert.deepEqual(validateRoots({ codex: [' ~/sessions ', '~/sessions', ''] }).codex, ['~/sessions']);
  assert.throws(() => validateRoots({ codex: ['https://example.com'] }), /本机/);
  assert.throws(() => validateRoots({ codex: ['a\nsecret'] }), /路径/);
  assert.throws(() => validateRoots({ credentials: [] }), /未知/);
  assert.throws(() => validateRoots({ codex: Array.from({ length: 8 }, (_, i) => `${i}${'a'.repeat(3000)}`) }), /过长/);
});

test('channel target aggregates records, refreshes in-place when channel panes change, and clears on channel switch', async () => {
  const host = fakeHost();
  let currentTarget = {
    key: 'ch-1',
    worktreeId: 'repo-1::/private/proj/1.5.0',
    worktreePath: '/private/proj/1.5.0',
    title: 'proj/1.5.0',
    sessions: [{ provider: 'claude', sessionId: 's1', transcriptPath: '/private/s1.jsonl' }]
  };
  const calls = [];
  const controller = createTpsController(host.orca, {
    readActive: async () => ({ target: currentTarget }),
    readSession: async (active, opts) => {
      calls.push({ count: active.sessions?.length ?? 0, fresh: Boolean(opts.fresh) });
      const id = `channel:${active.worktreeId}`;
      return {
        session: {
          id, title: active.title, provider: 'channel', updatedAt: 500,
          records: [{
            id: `req-${calls.length}`, provider: active.sessions.length > 1 ? 'codex' : 'claude',
            completedAt: 500 + calls.length, outputTokens: 240, durationMs: 3000,
            tokensPerSecond: active.sessions.length > 1 ? 80 : 60, isEstimatedSpeed: true, cacheHitRate: 0.9
          }]
        },
        warnings: []
      };
    },
    now: () => 1000,
    pollMs: 5000,
    focusPollMs: 0
  });

  await controller.start();
  const channelId = controller.state().activeSession.id;
  assert.ok(!channelId.includes('/private'));
  assert.equal(controller.state().activeSession.provider, 'channel');
  assert.equal(controller.state().activeSession.title, 'proj/1.5.0');
  assert.equal(controller.state().records[0].tokensPerSecond, 60);
  assert.equal(calls[0].fresh, true, 'manual/initial refresh passes fresh: true');
  assert.ok(!JSON.stringify(controller.state()).includes('/private'));

  // Same channel gains a second registered pane within pollMs: refreshes in-place without wiping prior records or bumping generation.
  const genBefore = controller.state().generation;
  currentTarget = {
    ...currentTarget,
    sessions: [
      ...currentTarget.sessions,
      { provider: 'codex', sessionId: 's2', transcriptPath: '/private/s2.jsonl' }
    ]
  };
  await controller.checkActive();
  assert.equal(controller.state().generation, genBefore, 'same channel keeps generation');
  assert.equal(controller.state().activeSession.id, channelId, 'pane changes keep the public channel identity');
  assert.equal(controller.state().records[0].tokensPerSecond, 80, 'new pane triggers immediate channel re-read');
  assert.equal(host.statuses.at(-1).text, '🚀 ≈80 tokens/s · 🍪 命中 90.0%');

  // Switching to another channel increments generation and switches cleanly.
  currentTarget = {
    key: 'ch-2',
    worktreeId: 'repo-1::/private/proj/main',
    worktreePath: '/private/proj/main',
    title: 'proj/main',
    sessions: []
  };
  await controller.checkActive();
  assert.equal(controller.state().generation, genBefore + 1);
  assert.equal(controller.state().activeSession.title, 'proj/main');
  controller.stop();
});

test('channel identities are stable and keep local paths out of state, responses and pushes', async () => {
  const host = fakeHost();
  const original = {
    key: JSON.stringify(['/private/orca-profile', 'profile-a', 'repo::/private/project']),
    worktreeId: 'repo::/private/project', worktreePath: '/private/project', title: 'project',
    sessions: [{ provider: 'codex', sessionId: 'session-a', transcriptPath: '/private/session-a.jsonl' }]
  };
  let active = original;
  const controller = createTpsController(host.orca, {
    readActive: async () => ({ target: active }),
    readSession: async value => ({
      session: { id: `channel:${value.worktreeId}`, provider: 'channel', path: '/private/log.jsonl', records: [] },
      warnings: []
    }),
    focusPollMs: 0
  });
  const publicId = () => controller.state().activeSession.id;
  const assertPrivate = () => {
    assert.ok(!JSON.stringify(controller.state()).includes('/private'));
    assert.ok(!JSON.stringify(host.handlers.get('tps.state')()).includes('/private'));
    assert.ok(!JSON.stringify(host.posts).includes('/private'));
  };

  await controller.start();
  const initialId = publicId();
  assertPrivate();

  active = { ...original, sessions: [] };
  await controller.refresh();
  assert.equal(publicId(), initialId, 'adding or removing panes cannot change the channel identity');

  active = { ...original, key: JSON.stringify(['/private/orca-profile', 'profile-b', 'repo::/private/project']) };
  await controller.refresh();
  const otherProfileId = publicId();
  assert.notEqual(otherProfileId, initialId, 'the same worktree in a different profile has a distinct identity');

  active = { ...original, worktreeId: 'repo::/private/other', worktreePath: '/private/other' };
  await controller.refresh();
  assert.notEqual(publicId(), initialId, 'different worktrees have distinct identities');
  assert.notEqual(publicId(), otherProfileId);

  active = original;
  await controller.refresh();
  assert.equal(publicId(), initialId, 'returning to the original channel restores its identity');
  assertPrivate();
  controller.stop();
});

test('initial startup with no active target clears loading state immediately', async () => {
  const host = fakeHost();
  const controller = createTpsController(host.orca, {
    readActive: async () => ({ target: null, message: '当前没有打开对话。' }),
    readSession: async () => { throw new Error('must not be called'); },
    focusPollMs: 0
  });
  await controller.start();
  assert.equal(controller.state().loading, false);
  assert.equal(controller.state().emptyMessage, '当前没有打开对话。');
  controller.stop();
});
