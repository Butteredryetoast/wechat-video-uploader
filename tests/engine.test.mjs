import test from 'node:test';
import assert from 'node:assert/strict';
import { File } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import '../src/queue.js';
import '../src/transport.js';
import '../src/engine.js';

const Engine = globalThis.WXVideoEngine;
const ADD_URL = 'https://mp.weixin.qq.com/cgi-bin/appmsg?action=video_edit';
const LIBRARY_URL = 'https://mp.weixin.qq.com/cgi-bin/appmsg?action=list&type=15';
const clone = value => JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const metadata = file => ({ name: file.name, size: file.size, type: file.type, lastModified: file.lastModified });
const engines = new Set();
test.afterEach(async () => {
  for (const engine of engines) await engine.handle('target.closed');
  engines.clear();
});

function scheduler() {
  const pending = new Map();
  const scheduled = [];
  const cleared = [];
  return {
    pending, scheduled, cleared,
    setTimeout(callback, milliseconds) {
      const timer = { callback, milliseconds, unrefCalled: false, unref() { this.unrefCalled = true; } };
      pending.set(timer, callback);
      scheduled.push(timer);
      return timer;
    },
    clearTimeout(timer) { pending.delete(timer); cleared.push(timer); },
    fire() {
      assert.equal(pending.size, 1, 'only one automatic readiness timer may be pending');
      const [timer, callback] = pending.entries().next().value;
      pending.delete(timer);
      return callback();
    },
  };
}

function harness({ saved = null, page = async () => null, push = async () => {}, write = async () => {}, timers } = {}) {
  const calls = [];
  const snapshots = [];
  let persisted = saved;
  let nextTabId = 101;
  const tabs = new Map([[7, { id: 7, url: ADD_URL, status: 'complete', agreement: false }]]);
  const host = async (command, payload = {}) => {
    calls.push({ command, payload });
    switch (command) {
      case 'read': return persisted;
      case 'write': await write(payload.snapshot); persisted = clone(payload.snapshot); snapshots.push(persisted); return { saved: true };
      case 'push': await push(payload.state); return { delivered: true };
      case 'worker.open': {
        const tab = { id: nextTabId++, url: ADD_URL, status: 'complete', agreement: false };
        tabs.set(tab.id, tab);
        return { tabId: tab.id };
      }
      case 'worker.render': assert(tabs.has(payload.tabId)); assert.notEqual(payload.tabId, 7); return { supported: true, hidden: true, pending: 0, assisted: 0 };
      case 'worker.release': if (payload.verified) tabs.delete(payload.tabId); return { released: true };
      case 'tab.get': assert(tabs.has(payload.tabId)); return { ...tabs.get(payload.tabId) };
      case 'tab.update': assert(tabs.has(payload.tabId)); Object.assign(tabs.get(payload.tabId), payload.update); return { ...tabs.get(payload.tabId) };
      case 'inject': assert(tabs.has(payload.target.tabId)); assert.deepEqual(payload.files, ['src/adapter.js']); return [];
      case 'page': {
        assert(tabs.has(payload.tabId));
        const tab = tabs.get(payload.tabId);
        assert.equal(payload.message.namespace, 'wxvu.page');
        const override = await page(payload.message, payload.tabId);
        if (override) return override;
        let result = {};
        switch (payload.message.command) {
          case 'launchInfo': assert.equal(payload.tabId, 7); result = { ready: true, pageKind: 'video-picker', launchUrl: ADD_URL, reason: 'fixture ready' }; break;
          case 'inspect': result = { ready: tab.url === ADD_URL, pageKind: tab.url === ADD_URL ? 'add-video' : 'video-list', reason: 'fixture ready' }; break;
          case 'begin': assert.notEqual(payload.tabId, 7); tab.agreement = false; break;
          case 'status': result = { uploadComplete: true, needsAgreement: !tab.agreement, readyToSave: tab.agreement }; break;
          case 'agree': tab.agreement = true; break;
          case 'save': tab.url = LIBRARY_URL; result = { clicked: true }; break;
          case 'verify': assert.fail('production engine must not verify after saving'); break;
          case 'diagnostics': result = { pageKind: 'add-video', controls: 3 }; break;
        }
        return { ok: true, result };
      }
      default: throw new Error(`unexpected host operation: ${command}`);
    }
  };
  const engine = new Engine({ host, timers });
  engines.add(engine);
  return { engine, calls, snapshots, tabs, saved: () => persisted };
}

async function initialized(options) {
  const h = harness(options);
  await h.engine.handle('init', { targetTabId: 7, sessionId: 'test-session' });
  let clock = Date.now();
  h.engine.transport.wait = async milliseconds => { clock += milliseconds; };
  h.engine.transport.now = () => clock;
  h.engine._wait = async milliseconds => { clock += milliseconds; };
  return h;
}

async function ingest(engine, file, id = 'file-ingest') {
  await engine.handle('file.begin', { id, ...metadata(file) });
  let index = 0;
  for (let offset = 0; offset < file.size; offset += 384 * 1024) {
    const data = Buffer.from(await file.slice(offset, offset + 384 * 1024).arrayBuffer()).toString('base64');
    await engine.handle('file.chunk', { id, index: index++, data });
  }
  return engine.handle('file.end', { id });
}

test('real File bytes cross the sidebar fragments and the existing transport without corruption', async () => {
  const h = await initialized();
  const bytes = Uint8Array.from({ length: 1_100_003 }, (_, index) => (index * 31 + 97) % 256);
  const file = new File([bytes], '精确字节.mp4', { type: 'video/mp4', lastModified: 1234 });
  const added = await ingest(h.engine, file);
  assert.equal(added.attached, false);
  assert.equal(added.state.ingesting, false);
  assert.equal(added.state.snapshot.items[0].title, '精确字节');
  await h.engine.handle('start');
  await h.engine._runTask;
  assert.equal(h.engine.state().snapshot.items[0].status, 'submitted');
  const pageMessages = h.calls.filter(call => call.command === 'page').map(call => call.payload.message);
  const chunks = pageMessages.filter(message => message.command === 'chunk');
  assert(chunks.length > 1);
  for (const [index, message] of chunks.entries()) {
    assert.equal(message.payload.index, index);
    assert(message.payload.data.length <= 512 * 1024);
  }
  assert.deepEqual(Buffer.concat(chunks.map(message => Buffer.from(message.payload.data, 'base64'))), Buffer.from(bytes));
  assert.equal(pageMessages.filter(message => message.command === 'agree').length, 1);
  assert.equal(pageMessages.filter(message => message.command === 'save').length, 1);
  assert(!pageMessages.some(message => /publish|send|broadcast/.test(message.command)));
  assert(h.snapshots.every(snapshot => snapshot.items.every(item => !Object.hasOwn(item, 'file') && !Object.hasOwn(item, 'chunks'))));
});

test('same-session init is idempotent during file reception and preserves the original File references', async () => {
  const h = await initialized();
  const file = new File(['abc'], 'file.mp4', { type: 'video/mp4', lastModified: 55 });
  await h.engine.handle('file.begin', { id: 'active-ingest', ...metadata(file) });
  const queue = h.engine.queue;
  const transport = h.engine.transport;
  const before = h.calls.length;
  await h.engine.handle('init', { targetTabId: 7, sessionId: 'test-session' });
  assert.equal(h.calls.length, before);
  assert.equal(h.engine.state().ingesting, true);
  await h.engine.handle('file.chunk', { id: 'active-ingest', index: 0, data: 'YWJj' });
  await h.engine.handle('file.end', { id: 'active-ingest' });
  const storedFile = h.engine.queue._items[0].file;
  await h.engine.handle('init', { targetTabId: 7, sessionId: 'test-session' });
  assert.equal(h.engine.queue, queue);
  assert.equal(h.engine.transport, transport);
  assert.equal(h.engine.queue._items[0].file, storedFile);
  assert.equal(storedFile instanceof File, true);
});

test('restart restores durable metadata and matches all three file identity fields', async () => {
  const first = await initialized();
  const original = new File(['same'], 'same.mp4', { type: 'video/mp4', lastModified: 80 });
  const added = await ingest(first.engine, original);
  await first.engine.handle('update', { id: added.id, changes: { title: '自定义标题' } });
  const h = await initialized({ saved: first.saved() });
  assert.equal(h.engine.state().snapshot.items[0].hasFile, false);
  const wrongTime = new File(['same'], 'same.mp4', { type: 'video/mp4', lastModified: 81 });
  const separate = await ingest(h.engine, wrongTime, 'different');
  assert.equal(separate.attached, false);
  assert.equal(h.engine.state().snapshot.items[0].hasFile, false);
  const restored = await ingest(h.engine, original, 'original');
  assert.equal(restored.attached, true);
  assert.equal(restored.id, added.id);
  assert.equal(h.engine.state().snapshot.items.length, 2);
  assert.equal(h.engine.state().snapshot.items[0].title, '自定义标题');
  assert.equal(h.engine.state().snapshot.items[0].hasFile, true);
  assert.equal(h.calls.filter(call => call.command === 'read').length, 1);
});

test('interrupted saving is restored as uncertain and explicit reupload still requires retry confirmation', async () => {
  const first = await initialized();
  const file = new File(['x'], 'test.mp4', { type: 'video/mp4', lastModified: 5 });
  const added = await ingest(first.engine, file);
  const saved = clone(first.saved());
  saved.items[0].status = 'saving';
  const h = await initialized({ saved });
  assert.equal(h.engine.state().snapshot.items[0].status, 'uncertain');
  await ingest(h.engine, file);
  await assert.rejects(h.engine.handle('retry', { id: added.id }), /确认视频尚未入库/);
  await h.engine.handle('retry', { id: added.id, confirmedNotSaved: true });
  assert.equal(h.engine.state().snapshot.items[0].status, 'queued');
});

test('restored uncertain item without a local file does not block the next queued upload or trigger reupload', async () => {
  const first = await initialized();
  const previous = new File(['previous'], 'previous.mp4', { type: 'video/mp4', lastModified: 1 });
  const next = new File(['next'], 'next.mp4', { type: 'video/mp4', lastModified: 2 });
  const oldItem = await ingest(first.engine, previous);
  const nextItem = await ingest(first.engine, next);
  const saved = clone(first.saved());
  saved.items[0].status = 'uncertain';
  saved.items[0].error = '保存结果尚未确认';
  const h = await initialized({ saved });
  await ingest(h.engine, next);
  assert.equal(h.engine.state().snapshot.items[0].hasFile, false);
  assert.equal(h.engine.state().snapshot.items[1].hasFile, true);
  assert.equal((await h.engine.handle('start')).started, true);
  await h.engine._runTask;
  assert.deepEqual(h.engine.state().snapshot.items.map(item => item.status), ['uncertain', 'submitted']);
  assert.equal(h.calls.filter(call => call.command === 'worker.open').length, 1);
  assert.deepEqual(h.calls.filter(call => call.command === 'page' && call.payload.message.command === 'begin')
    .map(call => call.payload.message.payload.id), [nextItem.id]);
  assert(!h.calls.some(call => call.command === 'worker.open' && call.payload.itemId === oldItem.id));
  assert(!h.calls.some(call => call.command === 'page' && call.payload.message.command === 'verify'));
  assert.equal(h.calls.filter(call => call.command === 'page' && call.payload.message.command === 'save').length, 1);
});

test('start answers before a long upload, blocks reentry and remains responsive to state, pause and init', async () => {
  const uploadBegan = deferred();
  const release = deferred();
  const h = await initialized({ page: async message => {
    if (message.command === 'status') { uploadBegan.resolve(); await release.promise; }
  } });
  await ingest(h.engine, new File(['x'], 'test.mp4', { type: 'video/mp4', lastModified: 5 }));
  let ended = false;
  const response = await h.engine.handle('start');
  h.engine._runTask.then(() => { ended = true; });
  assert.equal(response.started, true);
  assert.equal(response.state.snapshot.running, true);
  assert.equal(ended, false);
  await uploadBegan.promise;
  assert.equal((await h.engine.handle('state')).snapshot.running, true);
  const transport = h.engine.transport;
  await h.engine.handle('init', { targetTabId: 7, sessionId: 'test-session' });
  assert.equal(h.engine.transport, transport);
  await assert.rejects(h.engine.handle('start'), /正在运行/);
  await assert.rejects(h.engine.handle('file.begin', { id: 'second', name: 'second.mp4', size: 1, lastModified: 1 }), /正在运行/);
  await assert.rejects(h.engine.handle('init', { targetTabId: 8, sessionId: 'other-session' }), /正在运行/);
  await h.engine.handle('pause');
  assert.equal(ended, false);
  release.resolve();
  await h.engine._runTask;
  assert.equal(h.engine.state().snapshot.running, false);
  assert.equal(h.engine.state().snapshot.pauseRequested, true);
  assert.equal(h.engine.state().snapshot.items[0].status, 'submitted');
});

test('the whole ingest is exclusive and invalid, out-of-order, truncated and excess chunks never enqueue files', async () => {
  const h = await initialized();
  const meta = { id: 'x', name: 'x.mp4', size: 4, lastModified: 1 };
  await h.engine.handle('file.begin', meta);
  await assert.rejects(h.engine.handle('file.begin', { ...meta, id: 'y' }), /正在接收/);
  await assert.rejects(h.engine.handle('start'), /正在接收/);
  await assert.rejects(h.engine.handle('file.chunk', { id: 'x', index: 1, data: 'YQ==' }), /顺序/);
  await assert.rejects(h.engine.handle('file.chunk', { id: 'x', index: 0, data: 'Y$==' }), /格式/);
  await assert.rejects(h.engine.handle('file.chunk', { id: 'x', index: 0, data: 'a'.repeat(512 * 1024 + 4) }), /大小/);
  await assert.rejects(h.engine.handle('file.chunk', { id: 'x', index: 0, data: 'YWJjZGU=' }), /大小/);
  await h.engine.handle('file.chunk', { id: 'x', index: 0, data: 'YQ==' });
  await assert.rejects(h.engine.handle('file.end', { id: 'x' }), /完整/);
  assert.equal(h.engine.state().snapshot.items.length, 0);
  assert.deepEqual(await h.engine.handle('file.cancel', { id: 'unrelated' }), { cancelled: false });
  assert.equal(h.engine.state().ingesting, true);
  await h.engine.handle('file.cancel', { id: 'x' });
  assert.equal(h.engine.state().ingesting, false);
  const added = await ingest(h.engine, new File(['next'], 'next.mp4', { type: 'video/mp4', lastModified: 2 }));
  assert.equal(added.state.snapshot.items.length, 1);
});

test('file.end holds the ingestion lock until persistence finishes', async () => {
  const writing = deferred();
  const release = deferred();
  const h = await initialized({ write: async () => { writing.resolve(); await release.promise; } });
  await h.engine.handle('file.begin', { id: 'x', name: 'x.mp4', size: 1, lastModified: 1 });
  await h.engine.handle('file.chunk', { id: 'x', index: 0, data: 'YQ==' });
  const ending = h.engine.handle('file.end', { id: 'x' });
  await writing.promise;
  assert.equal(h.engine.state().ingesting, true);
  assert.equal(h.engine.state().snapshot.items.length, 0);
  release.resolve();
  await ending;
  assert.equal(h.engine.state().ingesting, false);
  assert.equal(h.engine.state().snapshot.items[0].hasFile, true);
});

test('unresponsive sidebar push listeners cannot hang durable changes or initialization', async () => {
  const never = new Promise(() => {});
  const h = await initialized({ push: () => never });
  const added = await ingest(h.engine, new File(['x'], 'test.mp4', { type: 'video/mp4', lastModified: 5 }));
  assert.equal(added.state.snapshot.items.length, 1);
  await h.engine.handle('update', { id: added.id, changes: { title: 'new title' } });
  assert.equal(h.saved().items[0].title, 'new title');
});

test('format, empty files, missing local references and title limits block start before any upload action', async () => {
  const h = await initialized();
  await assert.rejects(h.engine.handle('file.begin', { id: 'x', name: 'x.txt', size: 1, type: 'text/plain', lastModified: 1 }), /请选择视频/);
  await assert.rejects(h.engine.handle('file.begin', { id: 'x', name: 'x.mp4', size: 0, lastModified: 1 }), /为空/);
  const added = await ingest(h.engine, new File(['x'], 'x.mp4', { type: 'video/mp4', lastModified: 1 }));
  await h.engine.handle('update', { id: added.id, changes: { title: '长'.repeat(65) } });
  await assert.rejects(h.engine.handle('start'), /64/);
  await h.engine.handle('update', { id: added.id, changes: { title: '' } });
  await assert.rejects(h.engine.handle('start'), /填写标题/);
  assert(!h.calls.some(call => call.command === 'page' && call.payload.message.command === 'begin'));
  const restored = await initialized({ saved: h.saved() });
  await assert.rejects(restored.engine.handle('start'), /缺失的本地文件/);
});

test('an upload preflight can be paused without starting file attachment', async () => {
  const checking = deferred();
  const release = deferred();
  let initial = true;
  const h = await initialized({ page: async message => {
    if (message.command !== 'launchInfo') return;
    if (initial) { initial = false; return; }
    checking.resolve();
    await release.promise;
  } });
  await ingest(h.engine, new File(['x'], 'x.mp4', { type: 'video/mp4', lastModified: 1 }));
  await h.engine.handle('start');
  await checking.promise;
  await h.engine.handle('pause');
  release.resolve();
  await h.engine._runTask;
  assert.equal(h.engine.state().snapshot.items[0].status, 'queued');
  assert.equal(h.engine.state().snapshot.running, false);
  assert(!h.calls.some(call => call.command === 'page' && call.payload.message.command === 'begin'));
});

test('offscreen checks readiness every 2500 ms with one unref timer and no dependency on page visibility', async () => {
  const timers = scheduler();
  let ready = false;
  const pushes = [];
  const h = await initialized({ timers, push: async state => { pushes.push(state); }, page: async message => {
    if (message.command === 'launchInfo') return { ok: true, result: { ready, pageKind: ready ? 'add-video' : 'other', reason: ready ? '添加视频页已就绪' : '请打开添加视频页' } };
  } });
  assert.equal(timers.pending.size, 1);
  assert.equal(timers.scheduled[0].milliseconds, 2500);
  assert.equal(timers.scheduled[0].unrefCalled, true);
  assert.deepEqual(h.engine.state().runtimeInfo.autoCheck, { enabled: true, intervalMs: 2500 });
  assert.equal(h.engine.state().runtimeInfo.ready, false);
  const count = h.calls.filter(call => call.command === 'page' && call.payload.message.command === 'launchInfo').length;
  ready = true;
  const pushCount = pushes.length;
  await timers.fire();
  assert.equal(h.calls.filter(call => call.command === 'page' && call.payload.message.command === 'launchInfo').length, count + 1);
  assert.equal(h.engine.state().runtimeInfo.ready, true);
  assert(pushes.length > pushCount);
  assert.equal(timers.pending.size, 1);
  const timer = h.engine._autoCheckTimer;
  await h.engine.handle('init', { targetTabId: 7, sessionId: 'test-session' });
  assert.equal(h.engine._autoCheckTimer, timer);
  assert.equal(timers.pending.size, 1);
  const source = await readFile(new URL('../src/engine.js', import.meta.url), 'utf8');
  assert(!/document\.(hidden|visibilityState)|document\.hasFocus|window\.focus/.test(source));
});

test('a slow automatic check never overlaps another check and serializes start preflight behind it', async () => {
  const timers = scheduler();
  const checking = deferred();
  const release = deferred();
  let count = 0;
  let active = 0;
  let peak = 0;
  const h = await initialized({ timers, page: async message => {
    if (message.command !== 'launchInfo') return;
    count++;
    active++;
    peak = Math.max(peak, active);
    if (count === 2) { checking.resolve(); await release.promise; }
    active--;
  } });
  await ingest(h.engine, new File(['x'], 'x.mp4', { type: 'video/mp4', lastModified: 1 }));
  const poll = timers.fire();
  await checking.promise;
  assert.equal(timers.pending.size, 0, 'next timer is scheduled only after this check settles');
  let started = false;
  const start = h.engine.handle('start').then(result => { started = result.started; return result; });
  await Promise.resolve();
  assert.equal(started, false);
  assert.equal(count, 2);
  release.resolve();
  await poll;
  await start;
  await h.engine._runTask;
  assert.equal(peak, 1);
  assert.equal(started, true);
  assert.equal(h.engine.state().snapshot.items[0].status, 'submitted');
  assert.equal(timers.pending.size, 1);
});

test('automatic ticks skip upload forms and unchanged pushes without changing File data', async () => {
  const timers = scheduler();
  const uploading = deferred();
  const release = deferred();
  const pushes = [];
  const h = await initialized({ timers, push: async state => { pushes.push(state); }, page: async message => {
    if (message.command === 'status') { uploading.resolve(); await release.promise; }
  } });
  await ingest(h.engine, new File(['keep-file'], 'keep.mp4', { type: 'video/mp4', lastModified: 1 }));
  const file = h.engine.queue._items[0].file;
  await h.engine.handle('start');
  await uploading.promise;
  const checks = h.calls.filter(call => call.command === 'page' && call.payload.message.command === 'launchInfo').length;
  const beforePush = pushes.length;
  await timers.fire();
  await timers.fire();
  assert.equal(h.calls.filter(call => call.command === 'page' && call.payload.message.command === 'launchInfo').length, checks);
  assert.equal(pushes.length, beforePush);
  assert.equal(h.engine.queue._items[0].file, file);
  assert.equal(await file.text(), 'keep-file');
  assert.equal(h.engine.state().snapshot.running, true);
  release.resolve();
  await h.engine._runTask;
});

test('automatic inspection errors preserve an actionable notice and unchanged errors do not flood the event log', async () => {
  const timers = scheduler();
  let fail = false;
  const h = await initialized({ timers, page: async message => {
    if (fail && message.command === 'launchInfo') throw new Error('fixture page was replaced');
  } });
  h.engine._notice('保存结果需要人工核对，请先确认素材库。', 'error');
  const notice = h.engine.state().notice;
  fail = true;
  await timers.fire();
  assert.equal(h.engine.state().runtimeInfo.ready, false);
  assert.deepEqual(h.engine.state().notice, notice);
  const logCount = h.engine.log.length;
  await timers.fire();
  assert.equal(h.engine.log.length, logCount);
  assert.deepEqual(h.engine.state().notice, notice);
  fail = false;
  await timers.fire();
  assert.equal(h.engine.state().runtimeInfo.ready, true);
  assert.deepEqual(h.engine.state().notice, notice);
  const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
  assert.equal((await h.engine.handle('export')).version, manifest.version);
});

test('closing the owner clears automatic timers and an in-flight check cannot resurrect the closed session', async () => {
  const timers = scheduler();
  const h = await initialized({ timers });
  await h.engine.handle('target.closed');
  assert.equal(timers.pending.size, 0);
  assert.equal(timers.cleared.length, 1);
  assert.deepEqual(h.engine.state().runtimeInfo.autoCheck, { enabled: false, intervalMs: 2500 });

  const delayedTimers = scheduler();
  const checking = deferred();
  const release = deferred();
  let initial = true;
  const delayed = await initialized({ timers: delayedTimers, page: async message => {
    if (message.command !== 'launchInfo') return;
    if (initial) { initial = false; return; }
    checking.resolve();
    await release.promise;
  } });
  const poll = delayedTimers.fire();
  await checking.promise;
  await delayed.engine.handle('target.closed');
  const closed = delayed.engine.state();
  release.resolve();
  await poll;
  assert.equal(delayedTimers.pending.size, 0);
  assert.deepEqual(delayed.engine.state().runtimeInfo, closed.runtimeInfo);
  assert.equal(delayed.engine.state().runtimeInfo.autoCheck.enabled, false);
});

test('production offscreen uses runtime only and rejects page/foreign senders', async () => {
  const source = await readFile(new URL('../src/engine.js', import.meta.url), 'utf8');
  let listener;
  const runtime = {
    id: 'test-extension',
    getURL: path => `chrome-extension://test-extension/${path}`,
    onMessage: { addListener(value) { listener = value; } },
    async sendMessage() { throw new Error('state should not need a host call'); },
  };
  const chrome = new Proxy({ runtime }, { get(target, key) {
    if (key !== 'runtime') throw new Error(`offscreen cannot access chrome.${String(key)}`);
    return target.runtime;
  } });
  const context = vm.createContext({ chrome, AbortController, setTimeout, clearTimeout });
  vm.runInContext(source, context);
  assert.equal(typeof listener, 'function');
  const send = (sender, namespace = 'wxvu.engine') => new Promise(resolve => {
    const accepted = listener({ namespace, command: 'state' }, sender, value => resolve({ accepted, value }));
    // Sync responses need a separate receiver to avoid TDZ in this test helper.
    if (accepted === false) resolve({ accepted });
  });
  const rejected = sender => {
    let value;
    assert.equal(listener({ namespace: 'wxvu.engine', command: 'state' }, sender, response => { value = response; }), false);
    assert.equal(value.ok, false);
  };
  rejected({ id: 'foreign' });
  rejected({ id: 'test-extension', tab: { id: 7 }, url: ADD_URL });
  rejected({ id: 'test-extension', url: 'chrome-extension://test-extension/welcome.html' });
  const background = await send({ id: 'test-extension', url: runtime.getURL('src/background.js') });
  assert.equal(background.accepted, true);
  assert.equal(background.value.ok, true);
  const worker = await send({ id: 'test-extension' });
  assert.equal(worker.value.ok, true);
  assert.equal(listener({ namespace: 'wxvu.host' }, {}, () => assert.fail('unrelated namespace must be ignored')), false);
});

test('offscreen page loads only the queue, transport and hidden engine', async () => {
  const html = await readFile(new URL('../offscreen.html', import.meta.url), 'utf8');
  assert.deepEqual([...html.matchAll(/<script src="([^"]+)"/g)].map(match => match[1]), ['src/queue.js', 'src/transport.js', 'src/engine.js']);
  assert(!html.includes('runner.js'));
  const source = await readFile(new URL('../src/engine.js', import.meta.url), 'utf8');
  assert(!/chrome\.(storage|tabs|scripting|downloads)/.test(source));
  assert(!/tabs\.create/.test(source));
});

test('controller opens two independent upload tabs and fills the next slot without navigating itself', async () => {
  const firstTwo = deferred();
  const third = deferred();
  const gates = new Map([[101, deferred()], [102, deferred()], [103, deferred()]]);
  const entered = new Set();
  const h = await initialized({ page: async (message, tabId) => {
    if (message.command !== 'status') return;
    entered.add(tabId);
    if (entered.size === 2) firstTwo.resolve();
    if (entered.size === 3) third.resolve();
    await gates.get(tabId).promise;
  } });
  for (let index = 0; index < 3; index++)
    await ingest(h.engine, new File([`bytes${index}`], `${index}.mp4`, { type: 'video/mp4', lastModified: index }));
  await h.engine.handle('configure', { concurrency: 2 });
  assert.equal(h.engine.state().runtimeInfo.concurrency, 2);
  await h.engine.handle('start');
  await firstTwo.promise;
  assert.equal(h.calls.filter(call => call.command === 'worker.open').length, 2);
  assert.equal(h.engine.state().runtimeInfo.activeCount, 2);
  assert.equal(h.tabs.get(7).url, ADD_URL);
  await assert.rejects(h.engine.handle('configure', { concurrency: 3 }), /正在运行/);
  gates.get(101).resolve();
  await third.promise;
  assert(h.tabs.has(102), 'slow second worker remains open while third starts');
  assert(h.tabs.has(101), 'submitted worker remains open while its ownership is released');
  gates.get(102).resolve();
  gates.get(103).resolve();
  await h.engine._runTask;
  assert(h.engine.state().snapshot.items.every(item => item.status === 'submitted'));
  assert.deepEqual([...h.tabs.keys()], [7, 101, 102, 103]);
  const pageCalls = h.calls.filter(call => call.command === 'page');
  assert(pageCalls.filter(call => call.payload.tabId === 7).every(call => call.payload.message.command === 'launchInfo'));
  assert(!h.calls.some(call => call.command === 'tab.update'));
  assert.equal(h.calls.filter(call => call.command === 'worker.release' && call.payload.verified === false).length, 3);
});

test('an upload error leaves its tab for inspection, lets other active work finish and stops new tasks', async () => {
  const bothStarted = deferred();
  const failureObserved = deferred();
  const otherRelease = deferred();
  const entered = new Set();
  const h = await initialized({ page: async (message, tabId) => {
    if (message.command !== 'status') return;
    entered.add(tabId);
    if (entered.size === 2) bothStarted.resolve();
    await bothStarted.promise;
    if (tabId === 101) return { ok: true, result: { error: 'cover processing failed' } };
    await otherRelease.promise;
  } });
  for (let index = 0; index < 3; index++)
    await ingest(h.engine, new File(['x'], `${index}.mp4`, { type: 'video/mp4', lastModified: index }));
  await h.engine.handle('configure', { concurrency: 2 });
  h.engine.queue.subscribe(snapshot => { if (snapshot.items[0]?.status === 'failed') failureObserved.resolve(); });
  await h.engine.handle('start');
  await failureObserved.promise;
  assert.equal(h.engine.state().snapshot.running, true);
  otherRelease.resolve();
  await h.engine._runTask;
  assert.deepEqual(h.engine.state().snapshot.items.map(item => item.status), ['failed', 'submitted', 'queued']);
  assert(h.tabs.has(101));
  assert(h.tabs.has(102), 'submitted pages are retained for the site to finish processing');
  assert.equal(h.calls.filter(call => call.command === 'worker.open').length, 2);
  assert.deepEqual(h.calls.filter(call => call.command === 'worker.release').map(call => call.payload.verified), [false, false]);
});

test('parallel setting accepts only integers from one to ten and rejects changes during ingestion', async () => {
  const h = await initialized();
  for (const concurrency of [0, 11, 2.1, '2', null])
    await assert.rejects(h.engine.handle('configure', { concurrency }), /1 至 10 之间的整数/);
  assert.equal((await h.engine.handle('configure', { concurrency: 10 })).runtimeInfo.concurrency, 10);
  assert.equal((await h.engine.handle('configure', { concurrency: 1 })).runtimeInfo.concurrency, 1);
  await h.engine.handle('file.begin', { id: 'x', name: 'x.mp4', size: 1, lastModified: 0 });
  await assert.rejects(h.engine.handle('configure', { concurrency: 2 }), /正在接收/);
  assert.equal(h.engine.state().runtimeInfo.concurrency, 1);
});

test('a worker cleanup error cannot turn an acknowledged save into a failed retry', async () => {
  const h = await initialized();
  const originalHost = h.engine.host;
  h.engine.host = async (command, payload) => {
    if (command === 'worker.release') throw new Error('tab is already closed');
    return originalHost(command, payload);
  };
  await ingest(h.engine, new File(['x'], 'x.mp4', { type: 'video/mp4', lastModified: 1 }));
  await h.engine.handle('start');
  await h.engine._runTask;
  assert.equal(h.engine.state().snapshot.items[0].status, 'submitted');
  assert(h.engine.log.some(event => event.kind === 'worker-release-error'));
  assert.equal(h.calls.filter(call => call.command === 'page' && call.payload.message.command === 'save').length, 1);
});

test('only owned upload workers receive render pulses and pulses stop before save submission and release', async () => {
  const timers = scheduler();
  const pendingFrames = new Map();
  const prepared = new Set();
  const h = await initialized({ timers, page: async (message, tabId) => {
    if (message.command === 'status')
      return { ok: true, result: { uploadComplete: true, needsPreparation: !prepared.has(tabId), preparationReady: prepared.has(tabId), readyToSave: prepared.has(tabId) } };
    if (message.command === 'prepare') {
      pendingFrames.set(tabId, () => prepared.add(tabId));
      return { ok: true, result: { pending: true, reason: '等待封面渲染' } };
    }
  } });
  const originalHost = h.engine.host;
  const renderCalls = [];
  h.engine.host = async (command, payload) => {
    const result = await originalHost(command, payload);
    if (command !== 'worker.render') return result;
    assert.notEqual(payload.tabId, 7, 'controller rendering must never be modified');
    const item = h.engine.state().snapshot.items.find(item => item.id === payload.itemId);
    assert(item, 'every pulse remains bound to a queue item');
    assert(!['saving', 'verifying', 'submitted'].includes(item.status), 'render assistance ends before save submission');
    renderCalls.push({ ...payload });
    const callback = pendingFrames.get(payload.tabId);
    pendingFrames.delete(payload.tabId);
    callback?.();
    return { supported: true, hidden: true, pending: 0, assisted: callback ? 1 : 0 };
  };
  await ingest(h.engine, new File(['x'], 'background.mp4', { type: 'video/mp4', lastModified: 1 }));
  await h.engine.handle('start');
  await h.engine._runTask;
  assert.equal(h.engine.state().snapshot.items[0].status, 'submitted');
  assert(renderCalls.length >= 2);
  assert(renderCalls.every(call => call.tabId === 101));
  assert.equal(h.calls.filter(call => call.command === 'worker.release').length, 1);
  const pulseCount = renderCalls.length;
  await timers.fire();
  assert.equal(renderCalls.length, pulseCount, 'idle controller checks must not restart released worker rendering');
  assert.deepEqual(h.engine.log.filter(event => event.kind === 'worker-render').map(event => event.detail.assisted), [false, true]);
});

test('a render-channel failure releases its worker as unverified without beginning a duplicate upload', async () => {
  const h = await initialized();
  const originalHost = h.engine.host;
  h.engine.host = async (command, payload) => {
    if (command === 'worker.render') throw new Error('worker render channel lost');
    return originalHost(command, payload);
  };
  await ingest(h.engine, new File(['x'], 'background.mp4', { type: 'video/mp4', lastModified: 1 }));
  await h.engine.handle('start');
  await h.engine._runTask;
  assert.equal(h.engine.state().snapshot.items[0].status, 'failed');
  assert.match(h.engine.state().snapshot.items[0].error, /worker render channel lost/);
  assert(h.tabs.has(101));
  assert.equal(h.calls.filter(call => call.command === 'worker.open').length, 1);
  assert.deepEqual(h.calls.filter(call => call.command === 'worker.release').map(call => call.payload.verified), [false]);
  assert(!h.calls.some(call => call.command === 'page' && ['begin', 'attach', 'save'].includes(call.payload.message.command)));
});

test('live export keeps each worker preparation snapshot without extra page calls or overwriting another worker', async () => {
  let holding = true;
  const release = deferred();
  const bothObserved = deferred();
  const h = await initialized({ page: async (message, tabId) => {
    if (holding && ['status', 'prepare'].includes(message.command)) return { ok: true, result: {
      uploadComplete: true, needsPreparation: true, preparationReady: false, pending: true,
      reason: tabId === 101 ? '等待封面完成' : '等待原创确定',
      preparation: { coverEditorCount: tabId === 101 ? 1 : 0, originalDialogCount: tabId === 102 ? 1 : 0,
        coverConfirmationSent: true, originalConfirmationSent: tabId === 102 }
    } };
  } });
  const originalWait = h.engine._wait;
  h.engine._wait = async ms => { if (holding) await release.promise; return originalWait(ms); };
  h.engine.onState = state => {
    if (state.snapshot.items.length === 2 && state.snapshot.items.every(item => item.progress?.preparation)) bothObserved.resolve();
  };
  await ingest(h.engine, new File(['a'], 'first.mp4', { type: 'video/mp4', lastModified: 1 }));
  await ingest(h.engine, new File(['b'], 'second.mp4', { type: 'video/mp4', lastModified: 2 }));
  await h.engine.handle('configure', { concurrency: 2 });
  await h.engine.handle('start');
  try {
    await bothObserved.promise;
    const callsBefore = h.calls.length;
    const exported = await h.engine.handle('export');
    assert.equal(h.calls.slice(callsBefore).filter(call => ['page', 'inject', 'tab.get'].includes(call.command)).length, 0);
    const workers = exported.diagnostics.workers.sort((a, b) => a.tabId - b.tabId);
    assert.equal(workers.length, 2);
    assert(workers.every(worker => worker.active && worker.updatedAt && worker.changedAt));
    assert.equal(workers[0].detail.preparation.coverEditorCount, 1);
    assert.equal(workers[1].detail.preparation.originalDialogCount, 1);
    assert.match(h.engine.state().snapshot.items[0].progress.reason, /封面/);
    assert.match(h.engine.state().snapshot.items[1].progress.reason, /原创/);
  } finally { holding = false; release.resolve(); }
  await h.engine._runTask;
  assert(h.engine.state().snapshot.items.every(item => item.status === 'submitted'));
});

test('progress logging deduplicates unchanged states and excludes page content and authentication metadata', async () => {
  const h = await initialized();
  const detail = { phase: 'preparing', reason: '等待 https://example.test/?token=secret token=secret',
    uploadComplete: true, file: 'private bytes', url: 'https://example.test/?token=secret',
    preparation: { phase: 'cover-editor', coverEditorCount: 1, html: '<private>', originalEnabled: false } };
  h.engine._progress('one', 101, detail);
  h.engine._progress('one', 101, detail);
  assert.equal(h.engine.log.filter(event => event.kind === 'worker-progress').length, 1);
  h.engine._progress('two', 102, { phase: 'verifying', reason: '等待入库' });
  h.engine._progress('one', 101, { phase: 'preparing', reason: '上传页已关闭', code: 'TAB_CLOSED' });
  const exported = await h.engine.handle('export');
  assert.equal(exported.diagnostics.workers.length, 2);
  const text = JSON.stringify(exported.diagnostics.workers);
  assert(!/secret|private|example\.test/.test(text));
  assert.equal(exported.diagnostics.workers[0].detail.code, 'TAB_CLOSED');
  assert.equal(exported.diagnostics.workers[0].lastPageState.preparation.phase, 'cover-editor');
  h.engine._progress('one', 103, { phase: 'opening', reason: '新上传页正在加载' });
  const retried = (await h.engine.handle('export')).diagnostics.workers.find(worker => worker.itemId === 'one');
  assert.equal(retried.tabId, 103);
  assert.equal(retried.lastPageState, null, 'a new tab must never inherit another tab\'s cover/original state');
  assert.equal(retried.lastPageStateAt, null);
});

test('worker failures retain item and tab identity even after the queue record is removed', async () => {
  const h = await initialized({ page: async message => {
    if (message.command === 'status') return { ok: true, result: { error: '封面编辑窗口尚未关闭' } };
  } });
  const added = await ingest(h.engine, new File(['x'], 'failed.mp4', { type: 'video/mp4', lastModified: 1 }));
  await h.engine.handle('start');
  await h.engine._runTask;
  await h.engine.handle('remove', { id: added.id });
  const exported = await h.engine.handle('export');
  const failure = exported.events.find(event => event.kind === 'worker-error');
  assert.equal(failure.detail.itemId, added.id);
  assert.equal(failure.detail.tabId, 101);
  assert.match(failure.detail.error, /封面/);
  assert.equal(exported.queue.items.length, 0);
});

test('default serial execution opens the next worker only after save acknowledgement and cleanup finish without verifying', async () => {
  const saving = deferred();
  const saveRelease = deferred();
  const cleaning = deferred();
  const cleanupRelease = deferred();
  const h = await initialized({ page: async (message, tabId) => {
    if (message.command === 'verify') assert.fail('serial uploads must not verify saved items');
    if (message.command === 'save' && tabId === 101) {
      saving.resolve();
      await saveRelease.promise;
      return { ok: true, result: { clicked: true } };
    }
  } });
  const originalHost = h.engine.host;
  h.engine.host = async (command, payload) => {
    if (command === 'worker.release' && payload.tabId === 101) {
      assert.equal(payload.verified, false);
      cleaning.resolve();
      await cleanupRelease.promise;
    }
    return originalHost(command, payload);
  };
  assert.equal(h.engine.state().runtimeInfo.concurrency, 1);
  assert.equal(h.engine.state().runtimeInfo.foregroundSerial, false);
  await ingest(h.engine, new File(['a'], 'first.mp4', { type: 'video/mp4', lastModified: 1 }));
  await ingest(h.engine, new File(['b'], 'second.mp4', { type: 'video/mp4', lastModified: 2 }));
  await h.engine.handle('start');
  await saving.promise;
  assert.equal(h.calls.filter(call => call.command === 'worker.open').length, 1);
  assert.deepEqual(h.engine.state().snapshot.items.map(item => item.status), ['saving', 'queued']);
  saveRelease.resolve();
  await cleaning.promise;
  assert.equal(h.calls.filter(call => call.command === 'worker.open').length, 1, 'save acknowledgement must not overlap cleanup with a new upload');
  cleanupRelease.resolve();
  await h.engine._runTask;
  assert(h.engine.state().snapshot.items.every(item => item.status === 'submitted'));
  const opens = h.calls.filter(call => call.command === 'worker.open');
  assert.equal(opens.length, 2);
  assert(opens.every(call => call.payload.foregroundSerial === false));
  const releasedFirst = h.calls.findIndex(call => call.command === 'worker.release' && call.payload.tabId === 101);
  const openedSecond = h.calls.indexOf(opens[1]);
  assert(releasedFirst >= 0 && openedSecond > releasedFirst);
  assert.deepEqual([...h.tabs.keys()], [7, 101, 102]);
  assert(!h.calls.some(call => call.command === 'page' && call.payload.message.command === 'verify'));
});

test('default serial execution leaves every later item queued when the first upload fails', async () => {
  const h = await initialized({ page: async message => message.command === 'status'
    ? { ok: true, result: { error: 'first upload failed' } } : undefined });
  await ingest(h.engine, new File(['a'], 'first.mp4', { type: 'video/mp4', lastModified: 1 }));
  await ingest(h.engine, new File(['b'], 'second.mp4', { type: 'video/mp4', lastModified: 2 }));
  await h.engine.handle('start');
  await h.engine._runTask;
  assert.deepEqual(h.engine.state().snapshot.items.map(item => item.status), ['failed', 'queued']);
  assert.equal(h.calls.filter(call => call.command === 'worker.open').length, 1);
  assert(h.tabs.has(101));
  assert.equal(h.calls.filter(call => call.command === 'worker.release')[0].payload.verified, false);
});

test('foreground serial configuration is optional, atomic and incompatible with parallel uploads', async () => {
  const h = await initialized();
  assert.equal(h.engine.state().runtimeInfo.foregroundSerial, false);
  await h.engine.handle('configure', { concurrency: 2 });
  await assert.rejects(h.engine.handle('configure', { foregroundSerial: true }), /只能同时上传 1 个/);
  assert.equal(h.engine.state().runtimeInfo.concurrency, 2);
  assert.equal(h.engine.state().runtimeInfo.foregroundSerial, false);
  await h.engine.handle('configure', { concurrency: 1, foregroundSerial: true });
  assert.equal(h.engine.state().runtimeInfo.foregroundSerial, true);
  for (const foregroundSerial of ['true', 1, null, undefined]) {
    await assert.rejects(h.engine.handle('configure', { concurrency: 3, foregroundSerial }), /开启或关闭/);
    assert.equal(h.engine.state().runtimeInfo.concurrency, 1);
    assert.equal(h.engine.state().runtimeInfo.foregroundSerial, true);
  }
  await assert.rejects(h.engine.handle('configure', { concurrency: 2 }), /只能同时上传 1 个/);
  await h.engine.handle('configure', { foregroundSerial: false });
  assert.equal(h.engine.state().runtimeInfo.concurrency, 1);
  assert.equal(h.engine.state().runtimeInfo.foregroundSerial, false);
  await h.engine.handle('configure', { concurrency: 2, foregroundSerial: false });
  assert.equal(h.engine.state().runtimeInfo.concurrency, 2);
  await assert.rejects(h.engine.handle('configure', {}), /请设置/);
});

test('foreground serial choice reaches only new worker creation and cannot change mid-upload', async () => {
  const started = deferred();
  const release = deferred();
  const h = await initialized({ page: async message => {
    if (message.command === 'status') { started.resolve(); await release.promise; }
  } });
  await h.engine.handle('configure', { foregroundSerial: true });
  await ingest(h.engine, new File(['a'], 'foreground.mp4', { type: 'video/mp4', lastModified: 1 }));
  await h.engine.handle('start');
  await started.promise;
  assert.equal(h.calls.find(call => call.command === 'worker.open').payload.foregroundSerial, true);
  await assert.rejects(h.engine.handle('configure', { foregroundSerial: false }), /正在运行/);
  assert(!h.calls.some(call => call.command === 'tab.update'));
  release.resolve();
  await h.engine._runTask;
  assert.equal(h.engine.state().snapshot.items[0].status, 'submitted');
  assert.equal(h.engine.log.find(event => event.kind === 'run-start').detail.foregroundSerial, true);
});

test('readiness guidance reflects mode changes immediately without new page operations', async () => {
  const h = await initialized();
  assert.match(h.engine.state().runtimeInfo.reason, /后台页逐个上传/);
  const pageCalls = () => h.calls.filter(call => ['page', 'inject', 'tab.get'].includes(call.command)).length;
  const before = pageCalls();
  await h.engine.handle('configure', { foregroundSerial: true });
  assert.match(h.engine.state().runtimeInfo.reason, /逐个打开前台上传页/);
  assert(!h.engine.state().runtimeInfo.reason.includes('后台'));
  await h.engine.handle('configure', { foregroundSerial: false, concurrency: 3 });
  assert.match(h.engine.state().runtimeInfo.reason, /同时在 3 个独立后台页/);
  await h.engine.handle('configure', { concurrency: 1 });
  assert.match(h.engine.state().runtimeInfo.reason, /后台页逐个上传/);
  assert.equal(pageCalls(), before);
});
