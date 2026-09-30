import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

const ORIGIN = 'https://mp.weixin.qq.com';
const ADD_URL = `${ORIGIN}/cgi-bin/appmsg?t=media/videomsg_edit&action=video_edit&type=15&token=FIXTURE`;
const EXTENSION_ID = 'test-extension-id';
const EXTENSION_URL = `chrome-extension://${EXTENSION_ID}/`;
const CONTEXT_KEY = 'wxvu.inline.context.v3';
const WORKERS_KEY = 'wxvu.workers.v1';
const UPLOAD_SCRIPTS = ['src/launcher.js', 'src/panel.js', 'src/sidebar.js'];
const ARTICLE_SCRIPTS = ['src/launcher.js', 'src/article-format.js', 'src/article-editor.js', 'src/article-panel.js'];
const injectsFiles = (call, files) => call.kind === 'inject' && JSON.stringify(call.args.files) === JSON.stringify(files);
const uploadInjection = call => injectsFiles(call, UPLOAD_SCRIPTS);
const articleInjection = call => injectsFiles(call, ARTICLE_SCRIPTS);
const plain = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };

function event() {
  const listeners = [];
  return {
    addListener(listener) { listeners.push(listener); },
    removeListener(listener) { const index = listeners.indexOf(listener); if (index >= 0) listeners.splice(index, 1); },
    listeners,
    async emit(...args) { for (const listener of listeners) await listener(...args); },
  };
}

async function harness({ session = {}, tabs = [{ id: 7, url: ADD_URL, status: 'complete' }], offscreen = false, engineReply, pageReply, scriptReply } = {}) {
  const calls = [];
  const sessionData = structuredClone(session);
  const localData = {};
  const tabMap = new Map(tabs.map((tab) => [tab.id, { ...tab }]));
  let hasOffscreen = offscreen;
  const storageArea = (data, name) => ({
    async get(keys) {
      if (keys === null || keys === undefined) return structuredClone(data);
      if (typeof keys === 'string') return { [keys]: structuredClone(data[keys]) };
      return Object.fromEntries((Array.isArray(keys) ? keys : Object.keys(keys)).map((key) => [key, structuredClone(data[key] ?? keys[key])]));
    },
    async set(value) { calls.push({ kind: `${name}.set`, value: plain(value) }); Object.assign(data, plain(value)); },
    async remove(keys) { calls.push({ kind: `${name}.remove`, keys: plain(keys) }); for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key]; },
  });
  const chrome = {
    action: {
      onClicked: event(),
      async setBadgeText(args) { calls.push({ kind: 'badge', args: plain(args) }); },
      async setBadgeBackgroundColor(args) { calls.push({ kind: 'badgeColor', args: plain(args) }); },
      async setTitle(args) { calls.push({ kind: 'title', args: plain(args) }); },
    },
    runtime: {
      id: EXTENSION_ID,
      onMessage: event(),
      onInstalled: event(),
      onStartup: event(),
      getURL(path) { return EXTENSION_URL + path; },
      async getContexts(args) { calls.push({ kind: 'contexts', args: plain(args) }); return hasOffscreen ? [{ contextType: 'OFFSCREEN_DOCUMENT', documentUrl: EXTENSION_URL + 'offscreen.html' }] : []; },
      async sendMessage(message) { calls.push({ kind: 'engine', message: plain(message) }); return engineReply ? engineReply(message) : { ok: true, result: {} }; },
    },
    offscreen: {
      Reason: { BLOBS: 'BLOBS' },
      async createDocument(args) { calls.push({ kind: 'offscreen.create', args: plain(args) }); hasOffscreen = true; },
      async closeDocument() { calls.push({ kind: 'offscreen.close' }); hasOffscreen = false; },
    },
    storage: { session: storageArea(sessionData, 'session'), local: storageArea(localData, 'local') },
    scripting: {
      async executeScript(args) { calls.push({ kind: 'inject', args: plain(args) }); return scriptReply ? scriptReply(args) : [{ result: {} }]; },
    },
    tabs: {
      onUpdated: event(),
      onRemoved: event(),
      async get(id) { calls.push({ kind: 'tabs.get', id }); if (!tabMap.has(id)) throw new Error(`No tab with id: ${id}.`); return { ...tabMap.get(id) }; },
      async update(id, args) { calls.push({ kind: 'tabs.update', id, args: plain(args) }); if (!tabMap.has(id)) throw new Error('No tab'); const tab = { ...tabMap.get(id), ...args }; tabMap.set(id, tab); return tab; },
      async create(args) { calls.push({ kind: 'tabs.create', args: plain(args) }); const tab = { id: Math.max(98,...tabMap.keys()) + 1, status: 'complete', ...args }; tabMap.set(tab.id,tab); return tab; },
      async remove(id) { calls.push({ kind: 'tabs.remove', id }); tabMap.delete(id); },
      async sendMessage(id, message) { calls.push({ kind: 'page', id, message: plain(message) }); return pageReply ? pageReply(id,message) : { ok: true, result: message.command === 'launchInfo' ? {ready:true,pageKind:'video-picker',launchUrl:ADD_URL} : {delivered:true} }; },
      async query() { return [...tabMap.values()].map((tab) => ({ ...tab })); },
    },
  };
  const context = vm.createContext({ chrome, URL, URLSearchParams, console, crypto: webcrypto, setTimeout, clearTimeout, structuredClone });
  const source = await fs.readFile(new URL('../src/background.js', import.meta.url), 'utf8');
  vm.runInContext(source, context, { filename: 'background.js' });
  async function message(payload, sender) {
    for (const listener of chrome.runtime.onMessage.listeners) {
      let respond;
      const result = new Promise((resolve) => { respond = resolve; });
      const answer = listener(payload, sender, respond);
      if (answer === true) return plain(await result);
      if (answer && typeof answer.then === 'function') return plain(await answer);
    }
    return undefined;
  }
  async function settle() { await vm.runInContext('operation', context); await new Promise(setImmediate); }
  return { chrome, calls, sessionData, localData, tabMap, message, settle, hasOffscreen: () => hasOffscreen };
}

const ownerSender = (tabId = 7, url = ADD_URL) => ({ id: EXTENSION_ID, tab: { id: tabId, url }, url, frameId: 0 });
const hostSender = () => ({ id: EXTENSION_ID, url: EXTENSION_URL + 'offscreen.html' });
const launcherMessage = (command = 'openVideo') => ({ namespace: 'wxvu.launcher', command });
const uiMessage = (command, payload = {}) => ({ namespace: 'wxvu.ui', command, payload });
const hostMessage = (command, payload = {}) => ({ namespace: 'wxvu.host', command, payload });
const owner = { targetTabId: 7, sessionId: 'existing-session' };
const owned = (options = {}) => harness({ session: { [CONTEXT_KEY]: owner }, offscreen: true, ...options });

test('toolbar starts one offscreen Blob engine and injects an inline sidebar without opening a tab', async () => {
  const h = await harness();
  await h.chrome.action.onClicked.emit({ id: 7, url: ADD_URL });
  await h.settle();
  const context = h.sessionData[CONTEXT_KEY];
  assert.equal(context.targetTabId, 7);
  assert.match(context.sessionId, /^[a-f\d-]{36}$/i);
  assert.deepEqual(Object.keys(context).sort(), ['sessionId', 'targetTabId']);
  assert.deepEqual(h.calls.find((call) => call.kind === 'offscreen.create').args.reasons, ['BLOBS']);
  assert.equal(h.calls.find((call) => call.kind === 'offscreen.create').args.url, 'offscreen.html');
  assert.deepEqual(h.calls.find((call) => call.kind === 'engine').message, { namespace: 'wxvu.engine', command: 'init', payload: context });
  assert.deepEqual(h.calls.find(uploadInjection).args, { target: { tabId: 7 }, files: UPLOAD_SCRIPTS });
  assert(h.calls.findIndex((call) => call.kind === 'engine') < h.calls.findIndex(uploadInjection));
  assert(!h.calls.some((call) => call.kind === 'tabs.create'));
});

test('floating launcher opens the video panel and explicitly shows a previously collapsed sidebar', async () => {
  const h = await harness();
  assert.deepEqual(await h.message(launcherMessage(), ownerSender()), {ok:true,result:{opened:true}});
  const owner = structuredClone(h.sessionData[CONTEXT_KEY]);
  assert.equal(owner.targetTabId,7);
  const show = call => call.kind === 'page' && call.message.namespace === 'wxvu.sidebar' && call.message.command === 'show';
  assert.deepEqual(h.calls.find(show), {kind:'page',id:7,message:{namespace:'wxvu.sidebar',command:'show'}});
  assert(h.calls.findIndex(uploadInjection) < h.calls.findIndex(show));
  assert(h.calls.findIndex(articleInjection) < h.calls.findIndex(uploadInjection));
  assert.deepEqual(await h.message(launcherMessage(), ownerSender()), {ok:true,result:{opened:true}});
  assert.deepEqual(h.sessionData[CONTEXT_KEY],owner);
  assert.equal(h.calls.filter(show).length,2);
  assert.equal(h.calls.filter(call=>call.kind==='offscreen.create').length,1);
  assert(!h.calls.some(call=>['tabs.create','tabs.update','tabs.remove','offscreen.close','local.set'].includes(call.kind)));
});

test('floating launcher messages reject foreign senders, subframes, invalid commands, and extension documents', async () => {
  const h = await harness();
  for(const sender of [
    {...ownerSender(),id:'unrelated-extension'},
    ownerSender(7,'https://mp.weixin.qq.com.evil.test/'),
    {...ownerSender(),frameId:1},
    {...ownerSender(),frameId:undefined},
    hostSender(),
  ]) assert.equal(await h.message(launcherMessage(),sender),undefined);
  for(const command of ['start','save','inject','publish','openArticle',undefined]) {
    const result = await h.message({namespace:'wxvu.launcher',command},ownerSender());
    assert.equal(result.ok,false);
    assert.match(result.error,/未知的悬浮球操作/);
  }
  assert.equal(h.calls.length,0);
});

test('floating launcher rechecks actual tab URLs and refuses queue worker pages before injection', async () => {
  const workerUrl = `${ADD_URL}#wxvu-worker=12345678-1234-1234-1234-123456789abc`;
  for(const [actualUrl,senderUrl] of [
    ['https://example.com/',ADD_URL],
    ['https://mp.weixin.qq.com.evil.test/',ADD_URL],
    [workerUrl,ADD_URL],
    [ADD_URL,workerUrl],
    [workerUrl,workerUrl],
  ]) {
    const h = await harness({tabs:[{id:7,url:actualUrl}]});
    assert.equal((await h.message(launcherMessage(),ownerSender(7,senderUrl))).ok,false);
    assert.equal(h.sessionData[CONTEXT_KEY],undefined);
    assert(!h.calls.some(call=>['inject','engine','session.set','offscreen.create','tabs.create','tabs.update'].includes(call.kind)));
  }
  const closed = await harness({tabs:[]});
  assert.equal((await closed.message(launcherMessage(),ownerSender())).ok,false);
  assert.equal(closed.sessionData[CONTEXT_KEY],undefined);
});

test('simultaneous floating launcher requests preserve single queue ownership', async () => {
  const h = await harness({tabs:[{id:7,url:ADD_URL},{id:8,url:ADD_URL}]});
  const results = await Promise.all([
    h.message(launcherMessage(),ownerSender(7)),
    h.message(launcherMessage(),ownerSender(8)),
  ]);
  assert.equal(results[0].ok,true);
  assert.equal(results[1].ok,false);
  assert.match(results[1].error,/另一个公众号页面已绑定上传队列/);
  assert.equal(h.sessionData[CONTEXT_KEY].targetTabId,7);
  assert.equal(h.calls.filter(call=>call.kind==='offscreen.create').length,1);
  assert.equal(h.calls.filter(call=>call.kind==='engine').length,1);
  assert.deepEqual(h.calls.filter(uploadInjection).map(call=>call.args.target.tabId),[7]);
  assert(!h.calls.some(call=>['tabs.create','tabs.update','tabs.remove','offscreen.close','local.set'].includes(call.kind)));
});

test('reopening the sidebar preserves its owner, session, and existing offscreen document', async () => {
  const h = await owned();
  await h.chrome.action.onClicked.emit({ id: 7, url: ADD_URL });
  await h.settle();
  await h.chrome.action.onClicked.emit({ id: 7, url: ADD_URL });
  await h.settle();
  assert.deepEqual(h.sessionData[CONTEXT_KEY], owner);
  assert.equal(h.calls.filter(uploadInjection).length, 2);
  assert.equal(h.calls.filter(articleInjection).length, 2);
  assert.equal(h.calls.filter((call) => call.kind === 'engine' && call.message.command === 'init').length, 2);
  assert(!h.calls.some((call) => ['offscreen.create', 'offscreen.close', 'session.set', 'tabs.create'].includes(call.kind)));
});

test('another live WeChat owner cannot be silently replaced from a second tab', async () => {
  const h = await owned({ tabs: [{ id: 7, url: ADD_URL }, { id: 8, url: ADD_URL }] });
  await h.chrome.action.onClicked.emit({ id: 8, url: ADD_URL });
  await h.settle();
  assert.deepEqual(h.sessionData[CONTEXT_KEY], owner);
  assert(h.calls.some((call) => call.kind === 'badge' && call.args.tabId === 8 && call.args.text === '!'));
  assert(!h.calls.some((call) => ['engine', 'offscreen.close', 'tabs.create'].includes(call.kind)));
  assert(!h.calls.some(uploadInjection));
  assert.equal(h.calls.filter(articleInjection).length, 1);
});

test('toolbar rejects non-WeChat origins and can replace a stale closed owner', async () => {
  const invalid = await harness();
  await invalid.chrome.action.onClicked.emit({ id: 7, url: 'https://mp.weixin.qq.com.evil.test/' });
  await invalid.settle();
  assert.equal(invalid.sessionData[CONTEXT_KEY], undefined);
  assert(!invalid.calls.some((call) => ['offscreen.create', 'inject', 'tabs.create'].includes(call.kind)));

  const stale = await owned({ tabs: [{ id: 8, url: ADD_URL }] });
  await stale.chrome.action.onClicked.emit({ id: 8, url: ADD_URL });
  await stale.settle();
  assert.equal(stale.sessionData[CONTEXT_KEY].targetTabId, 8);
  assert.notEqual(stale.sessionData[CONTEXT_KEY].sessionId, owner.sessionId);
  assert(stale.calls.findIndex((call) => call.kind === 'offscreen.close') < stale.calls.findIndex((call) => call.kind === 'offscreen.create'));
});

test('top-frame UI messages from the current owner reconnect and forward to the engine', async () => {
  const h = await owned();
  assert.equal((await h.message(uiMessage('update', { id: 'video-1', title: '新标题' }), ownerSender())).ok, true);
  assert.deepEqual(h.calls.filter((call) => call.kind === 'engine').map((call) => call.message), [
    { namespace: 'wxvu.engine', command: 'init', payload: owner },
    { namespace: 'wxvu.engine', command: 'update', payload: { id: 'video-1', title: '新标题' } },
  ]);
  assert(!h.calls.some((call) => call.kind === 'tabs.create'));
});

test('UI routes ignore foreign extensions, non-WeChat pages, subframes, and extension documents', async () => {
  const h = await owned();
  for (const sender of [
    { ...ownerSender(), id: 'unrelated-extension' },
    ownerSender(7, 'https://mp.weixin.qq.com.evil.test/'),
    { ...ownerSender(), frameId: 2 },
    { ...ownerSender(), frameId: undefined },
    hostSender(),
  ]) assert.equal(await h.message(uiMessage('start'), sender), undefined);
  assert.equal(h.calls.length, 0);
});

test('UI cannot control another owner or directly overwrite persisted queue records', async () => {
  const h = await owned({ tabs: [{ id: 7, url: ADD_URL }, { id: 8, url: ADD_URL }] });
  const other = await h.message(uiMessage('start'), ownerSender(8));
  assert.equal(other.ok, false);
  const write = await h.message(uiMessage('write', { snapshot: { version: 1, items: [] } }), ownerSender());
  assert.equal(write.ok, false);
  assert(!h.calls.some((call) => call.kind === 'engine' || call.kind === 'local.set'));
});

test('host messages require the exact extension offscreen URL and no tab sender', async () => {
  const h = await owned();
  for (const sender of [
    ownerSender(),
    { ...hostSender(), tab: { id: 7 } },
    { ...hostSender(), id: 'unrelated-extension' },
    { ...hostSender(), url: EXTENSION_URL + 'runner.html' },
    { ...hostSender(), url: EXTENSION_URL + 'offscreen.html?forged=1' },
    { ...hostSender(), url: EXTENSION_URL + 'offscreen.html#forged' },
  ]) assert.equal(await h.message(hostMessage('write', { snapshot: { version: 1, items: [] } }), sender), undefined);
  assert.equal(h.calls.length, 0);
});

test('trusted offscreen storage round-trips queue metadata and rejects malformed snapshots', async () => {
  const h = await owned();
  assert.deepEqual(await h.message(hostMessage('read'), hostSender()), { ok: true, result: null });
  const snapshot = { version: 1, items: [{ id: 'video-1', name: 'demo.mp4', status: 'pending' }] };
  assert.deepEqual(await h.message(hostMessage('write', { snapshot }), hostSender()), { ok: true, result: { saved: true } });
  assert.deepEqual(await h.message(hostMessage('read'), hostSender()), { ok: true, result: snapshot });
  for (const invalid of [null, { version: 2, items: [] }, { version: 1, items: {} }, { version: 1, items: Array(501).fill({}) }]) {
    assert.equal((await h.message(hostMessage('write', { snapshot: invalid }), hostSender())).ok, false);
  }
  assert.deepEqual(h.localData['wxvu.queue.v2'], snapshot);
});

test('host tab routes reject unrelated tabs and navigation outside the WeChat origin', async () => {
  const h = await owned({ tabs: [{ id: 7, url: ADD_URL, status: 'complete' }, { id: 8, url: ADD_URL }] });
  assert.deepEqual(await h.message(hostMessage('tab.get', { tabId: 7 }), hostSender()), { ok: true, result: { id: 7, url: ADD_URL, status: 'complete' } });
  for (const command of ['tab.get', 'tab.update', 'page']) {
    assert.equal((await h.message(hostMessage(command, { tabId: 8, update: { url: ADD_URL }, message: { namespace: 'wxvu.page', command: 'save' } }), hostSender())).ok, false);
  }
  for (const update of [
    { url: 'https://evil.test/' },
    { url: 'https://mp.weixin.qq.com.evil.test/' },
    { url: 'javascript:alert(1)' },
    { url: ADD_URL, active: true },
    { active: true },
  ]) assert.equal((await h.message(hostMessage('tab.update', { tabId: 7, update }), hostSender())).ok, false);
  assert(!h.calls.some((call) => call.kind === 'tabs.update' || call.kind === 'page'));
  const next = `${ORIGIN}/cgi-bin/appmsg?action=list&type=15`;
  assert.equal((await h.message(hostMessage('tab.update', { tabId: 7, update: { url: next } }), hostSender())).ok, false);
  assert.equal(h.tabMap.get(7).url, ADD_URL);
});

test('host page messages allow bound worker upload/save but reject publishing and namespace substitution', async () => {
  const h = await owned({session:{[CONTEXT_KEY]:owner,[WORKERS_KEY]:{sessionId:owner.sessionId,items:[{tabId:8,itemId:'video-1',state:'active'}]}},tabs:[{id:7,url:ADD_URL},{id:8,url:ADD_URL}]});
  for (const command of ['prepare', 'agree', 'save']) {
    assert.equal((await h.message(hostMessage('page', { tabId: 8, message: { namespace: 'wxvu.page', command, payload: { id: 'video-1' } } }), hostSender())).ok, true);
  }
  for (const message of [
    { namespace: 'wxvu.page', command: 'publish' },
    { namespace: 'wxvu.page', command: 'broadcast' },
    { namespace: 'wxvu.sidebar', command: 'state' },
  ]) assert.equal((await h.message(hostMessage('page', { tabId: 8, message }), hostSender())).ok, false);
  assert.deepEqual(h.calls.filter((call) => call.kind === 'page').map((call) => call.message.command), ['prepare', 'agree', 'save']);
});

test('host injection is restricted to the owner top frame and the fixed adapter script', async () => {
  const h = await owned();
  const valid = { target: { tabId: 7 }, files: ['src/adapter.js'] };
  assert.equal((await h.message(hostMessage('inject', valid), hostSender())).ok, true);
  for (const payload of [
    { ...valid, target: { tabId: 8 } },
    { ...valid, target: { tabId: 7, allFrames: true } },
    { ...valid, target: { tabId: 7, frameIds: [0] } },
    { ...valid, files: ['src/sidebar.js'] },
    { ...valid, files: ['src/adapter.js', 'src/sidebar.js'] },
    { ...valid, func: 'malicious' },
  ]) assert.equal((await h.message(hostMessage('inject', payload), hostSender())).ok, false);
  assert.deepEqual(h.calls.filter((call) => call.kind === 'inject').map((call) => call.args), [valid]);
});

test('host tab operations recheck the actual owner URL before using its permissions', async () => {
  const h = await owned({ tabs: [{ id: 7, url: 'https://example.com/' }] });
  for (const [command, payload] of [
    ['tab.get', { tabId: 7 }],
    ['tab.update', { tabId: 7, update: { url: ADD_URL } }],
    ['page', { tabId: 7, message: { namespace: 'wxvu.page', command: 'save' } }],
    ['inject', { target: { tabId: 7 }, files: ['src/adapter.js'] }],
  ]) assert.equal((await h.message(hostMessage(command, payload), hostSender())).ok, false);
  assert(!h.calls.some((call) => ['inject', 'page', 'tabs.update'].includes(call.kind)));
});

test('state pushes reach only the owner and never create or activate another tab', async () => {
  const h = await owned();
  const state = { items: [{ id: 'video-1', status: 'processing' }] };
  assert.deepEqual(await h.message(hostMessage('push', { state }), hostSender()), { ok: true, result: { delivered: true } });
  assert.deepEqual(h.calls.filter((call) => call.kind === 'page'), [
    { kind: 'page', id: 7, message: { namespace: 'wxvu.sidebar', command: 'state', payload: state } },
  ]);
  assert(!h.calls.some((call) => call.kind === 'tabs.create' || call.kind === 'tabs.update'));
});

test('owner navigation completion reconnects the existing session and reinjects the sidebar', async () => {
  const h = await owned();
  await h.chrome.tabs.onUpdated.emit(7, { status: 'loading' });
  await h.chrome.tabs.onUpdated.emit(8, { status: 'complete' });
  await h.settle();
  assert.equal(h.calls.length, 0);
  h.tabMap.get(7).url = `${ORIGIN}/cgi-bin/appmsg?action=list&type=15`;
  await h.chrome.tabs.onUpdated.emit(7, { status: 'complete' });
  await h.settle();
  assert.deepEqual(h.sessionData[CONTEXT_KEY], owner);
  assert.deepEqual(h.calls.find(uploadInjection).args, { target: { tabId: 7 }, files: UPLOAD_SCRIPTS });
  assert(!h.calls.some((call) => ['offscreen.create', 'offscreen.close', 'session.set', 'tabs.create'].includes(call.kind)));
  assert(!h.calls.some(call=>call.kind==='page' && call.message.command==='show'),'automatic restoration must respect the collapsed panel state');
});

test('closing the owner disposes its Blob host and context while unrelated tab closure has no effect', async () => {
  const h = await owned();
  await h.chrome.tabs.onRemoved.emit(8);
  await h.settle();
  assert.equal(h.calls.length, 0);
  await h.chrome.tabs.onRemoved.emit(7);
  await h.settle();
  assert.equal(h.hasOffscreen(), false);
  assert.equal(h.sessionData[CONTEXT_KEY], undefined);
  assert.equal((await h.message(hostMessage('read'), hostSender())).ok, false);
});

test('leaving WeChat disposes the old session instead of injecting into an unrelated website', async () => {
  const h = await owned();
  h.tabMap.get(7).url = 'https://example.com/';
  await h.chrome.tabs.onUpdated.emit(7, { status: 'complete', url: 'https://example.com/' });
  await h.settle();
  assert.equal(h.hasOffscreen(), false);
  assert.equal(h.sessionData[CONTEXT_KEY], undefined);
  assert(!h.calls.some((call) => call.kind === 'inject' || call.kind === 'engine'));
});

test('pending UI commands complete before owner disposal and rebinding to another page', async () => {
  const entered = deferred();
  const release = deferred();
  const h = await owned({
    tabs: [{ id: 7, url: ADD_URL }, { id: 8, url: ADD_URL }],
    engineReply: async (message) => {
      if (message.command === 'init' && message.payload.sessionId === owner.sessionId) {
        entered.resolve();
        await release.promise;
      }
      return { ok: true, result: {} };
    },
  });
  const pendingUI = h.message(uiMessage('start'), ownerSender());
  await entered.promise;
  h.tabMap.delete(7);
  await h.chrome.tabs.onRemoved.emit(7);
  await h.chrome.action.onClicked.emit({ id: 8, url: ADD_URL });
  await new Promise(setImmediate);
  // A delayed init response must not let an old start command jump into a new host.
  const disposedBeforeUICompleted = h.calls.some((call) => call.kind === 'offscreen.close');
  release.resolve();
  assert.equal((await pendingUI).ok, true);
  await h.settle();
  assert.equal(disposedBeforeUICompleted, false);
  assert.equal(h.sessionData[CONTEXT_KEY].targetTabId, 8);
  const engineCalls = h.calls.filter((call) => call.kind === 'engine').map((call) => call.message);
  assert.deepEqual(engineCalls.map((message) => message.command), ['init', 'start', 'init']);
  assert.equal(engineCalls[0].payload.targetTabId, 7);
  assert.equal(engineCalls[2].payload.targetTabId, 8);
  assert(h.calls.findIndex((call) => call.kind === 'engine' && call.message.command === 'start') < h.calls.findIndex((call) => call.kind === 'offscreen.close'));
});

async function claim(h, ids, status='opening') {
  return h.message(hostMessage('write',{snapshot:{version:1,items:ids.map(id=>({id,status}))}}),hostSender());
}
async function open(h,itemId) { return h.message(hostMessage('worker.open',{itemId}),hostSender()); }
const registry = h => h.sessionData[WORKERS_KEY]?.items || [];

test('concurrent worker opens create distinct inactive pages without moving the controller', async()=>{
  const h = await owned();
  const ids = Array.from({length:11},(_,i)=>String(i));
  await claim(h,ids);
  const results = await Promise.all(ids.slice(0,10).map(id=>open(h,id)));
  assert(results.every(result=>result.ok));
  assert.equal(new Set(results.map(result=>result.result.tabId)).size,10);
  assert.equal(registry(h).length,10);
  assert.equal((await open(h,'10')).ok,false);
  assert.equal((await open(h,'0')).ok,false);
  assert.equal(h.tabMap.get(7).url,ADD_URL);
  assert(h.calls.filter(call=>call.kind==='tabs.create').every(call=>call.args.active===false && call.args.openerTabId===7));
  assert(!h.calls.some(call=>call.kind==='tabs.update'));
  assert(!JSON.stringify(h.sessionData).includes('FIXTURE'),'launch login parameters are not persisted');
});

test('workers require a durable opening claim and a recognized same-origin upload entry', async()=>{
  const h = await owned();
  assert.equal((await open(h,'a')).ok,false);
  await claim(h,['a'],'queued');
  assert.equal((await open(h,'a')).ok,false);
  assert(!h.calls.some(call=>call.kind==='tabs.create'));
  for(const launchUrl of ['https://evil.test/',`${ORIGIN}/cgi-bin/appmsg?action=publish`,`${ORIGIN}/cgi-bin/appmsg?t=media/videomsg_edit&action=video_edit&type=15`]) {
    const invalid = await owned({pageReply:async()=>({ok:true,result:{ready:true,launchUrl}})});
    await claim(invalid,['a']);
    assert.equal((await open(invalid,'a')).ok,false);
    assert(!invalid.calls.some(call=>call.kind==='tabs.create'));
  }
});

test('controller is read-only while mutations and identity stay bound to each worker', async()=>{
  const h = await owned();
  await claim(h,['a','b']);
  const a=(await open(h,'a')).result.tabId;
  const b=(await open(h,'b')).result.tabId;
  for(const [tabId,id] of [[7,'a'],[a,'b'],[b,'a']]) {
    assert.equal((await h.message(hostMessage('page',{tabId,message:{namespace:'wxvu.page',command:'save',payload:{id}}}),hostSender())).ok,false);
  }
  for(const [tabId,id] of [[a,'a'],[b,'b']]) {
    assert.equal((await h.message(hostMessage('page',{tabId,message:{namespace:'wxvu.page',command:'prepare',payload:{id}}}),hostSender())).ok,true);
  }
  assert.equal((await h.message(uiMessage('start'),ownerSender(a))).ok,false);
  assert.equal((await h.message(hostMessage('page',{tabId:7,message:{namespace:'wxvu.page',command:'launchInfo'}}),hostSender())).ok,true);
});

test('release closes only a verified owned worker and retains failed pages for inspection', async()=>{
  const h = await owned();
  await claim(h,['a','b']);
  const a=(await open(h,'a')).result.tabId;
  const b=(await open(h,'b')).result.tabId;
  const release=(itemId,tabId,verified)=>h.message(hostMessage('worker.release',{itemId,tabId,verified}),hostSender());
  assert.equal((await release('a',a,true)).ok,false,'opening is not proof of save');
  assert.equal((await release('a',7,true)).ok,false,'never close user controller');
  assert.equal((await release('a',b,true)).ok,false,'never close another item');
  await claim(h,['a'],'verifying');
  assert.equal((await release('a',a,true)).ok,true);
  assert(!h.tabMap.has(a));
  assert.equal((await release('b',b,false)).ok,true);
  assert(h.tabMap.has(b));
  assert.equal(registry(h).find(item=>item.tabId===b).state,'retained');
  assert.equal((await h.message(hostMessage('page',{tabId:b,message:{namespace:'wxvu.page',command:'save',payload:{id:'b'}}}),hostSender())).ok,false);
  await claim(h,['b']);
  const retry=await open(h,'b');
  assert.equal(retry.ok,true);
  assert.notEqual(retry.result.tabId,b);
  assert(h.tabMap.has(b));
  assert(h.tabMap.has(7));
});

test('worker close or navigation cannot retarget tasks or dispose the controller engine', async()=>{
  const h = await owned();
  await claim(h,['a','b']);
  const a=(await open(h,'a')).result.tabId;
  const b=(await open(h,'b')).result.tabId;
  h.tabMap.get(a).url='https://example.com/';
  assert.equal((await h.message(hostMessage('tab.get',{tabId:a}),hostSender())).ok,false);
  await h.chrome.tabs.onUpdated.emit(a,{status:'complete'});
  await h.chrome.tabs.onRemoved.emit(b);
  await h.settle();
  assert.equal(h.hasOffscreen(),true);
  assert.equal(registry(h).find(item=>item.tabId===b).state,'closed');
  assert.equal(h.sessionData[CONTEXT_KEY].targetTabId,7);
  await h.chrome.tabs.onRemoved.emit(7);
  await h.settle();
  assert(!h.calls.some(call=>call.kind==='tabs.remove'),'unverified child pages must stay available');
});

test('new worker loading about:blank uses only its validated pending upload URL', async()=>{
  const h=await owned();
  await claim(h,['a']);
  const id=(await open(h,'a')).result.tabId;
  Object.assign(h.tabMap.get(id),{url:'about:blank',pendingUrl:ADD_URL,status:'loading'});
  assert.equal((await h.message(hostMessage('tab.get',{tabId:id}),hostSender())).result.url,ADD_URL);
  h.tabMap.get(id).pendingUrl='https://example.com/';
  assert.equal((await h.message(hostMessage('tab.get',{tabId:id}),hostSender())).ok,false);
});


test('rebuilding a lost offscreen host retains old pages and frees their worker slots', async()=>{
  const h=await owned({offscreen:false,session:{[CONTEXT_KEY]:owner,[WORKERS_KEY]:{sessionId:owner.sessionId,items:[{tabId:8,itemId:'a',state:'active'},{tabId:9,itemId:'closed',state:'closed',closedAt:123}]}},tabs:[{id:7,url:ADD_URL},{id:8,url:ADD_URL}]});
  await h.chrome.action.onClicked.emit({id:7,url:ADD_URL});
  await h.settle();
  assert.equal(registry(h)[0].state,'retained');
  assert.equal(registry(h)[1].state,'closed');
  assert.equal(registry(h)[1].closedAt,123);
  assert(h.tabMap.has(8));
  await claim(h,['a']);
  const newWorker=await open(h,'a');
  assert.equal(newWorker.ok,true);
  assert.notEqual(newWorker.result.tabId,8);
  assert(!h.calls.some(call=>call.kind==='tabs.remove'));
});


test('worker URL markers opt in before document_start without changing the controller URL', async()=>{
  const h=await owned(); await claim(h,['a','b']);
  await open(h,'a'); await open(h,'b');
  const urls=h.calls.filter(call=>call.kind==='tabs.create').map(call=>new URL(call.args.url));
  assert.equal(urls.length,2);
  const markers=[];
  for(const url of urls) {
    const marker=new URLSearchParams(url.hash.slice(1));
    assert.match(marker.get('wxvu-worker'),/^[a-f0-9-]{36}$/);
    markers.push(marker.get('wxvu-worker'));
    url.hash='';
    assert.equal(url.href,ADD_URL);
  }
  assert.notEqual(markers[0],markers[1]);
  assert.equal(h.tabMap.get(7).url,ADD_URL);
  const manifest=JSON.parse(await fs.readFile(new URL('../manifest.json',import.meta.url),'utf8'));
  const bridge=manifest.content_scripts.find(entry=>entry.js.includes('src/render-bridge.js'));
  assert.equal(bridge.world,'MAIN'); assert.equal(bridge.run_at,'document_start');
  assert.equal(bridge.all_frames,false);
  assert.deepEqual(bridge.matches,['https://mp.weixin.qq.com/cgi-bin/appmsg*']);
});

test('render pulses use only fixed MAIN-world code on the currently bound worker', async()=>{
  let currentId; const actions=[];
  const h=await owned({scriptReply:async args=>{
    if(args.world!=='MAIN')return [{result:{}}];
    assert.equal(args.target.tabId,currentId);
    const page=vm.createContext({document:{hidden:true},__WXVU_RENDER_BRIDGE_V1__:{
      pulse(){actions.push('pulse');return {hidden:true,pending:2,assisted:3,frames:3,pulses:1,lastPulseAt:100,lastFrameAt:100,privateURL:'must not escape'};},
      stop(){actions.push('stop');return {stopped:true};}
    }});
    const result=vm.runInContext(`(${args.func.toString()})(${args.args[0]})`,page);
    return [{result}];
  }});
  await claim(h,['a']); currentId=(await open(h,'a')).result.tabId;
  const invoke=(payload)=>h.message(hostMessage('worker.render',payload),hostSender());
  for(const payload of [{tabId:7,itemId:'a'},{tabId:currentId,itemId:'other'},{tabId:999,itemId:'a'}])assert.equal((await invoke(payload)).ok,false);
  assert.deepEqual(actions,[]);
  const pulse=await invoke({tabId:currentId,itemId:'a',func:'untrusted',command:'stop'});
  assert.equal(pulse.ok,true);assert.equal(pulse.result.assisted,3);assert.equal(pulse.result.supported,true);
  assert.equal(pulse.result.privateURL,undefined);assert.deepEqual(actions,['pulse']);
  await h.message(hostMessage('worker.release',{tabId:currentId,itemId:'a',verified:false}),hostSender());
  assert.deepEqual(actions,['pulse','stop']);
  assert.equal((await invoke({tabId:currentId,itemId:'a'})).ok,false);
  assert(!h.calls.some(call=>call.kind==='tabs.update'));
});

test('frozen or discarded worker diagnostics are exposed without executing rendering code', async()=>{
  const h=await owned();await claim(h,['a']);const tabId=(await open(h,'a')).result.tabId;
  Object.assign(h.tabMap.get(tabId),{frozen:true,discarded:false});
  const result=await h.message(hostMessage('tab.get',{tabId}),hostSender());
  assert.equal(result.result.frozen,true);assert.equal(result.result.discarded,false);
  const pulse=await h.message(hostMessage('worker.render',{tabId,itemId:'a'}),hostSender());
  assert.deepEqual(pulse.result,{supported:false,frozen:true,discarded:false});
  assert(!h.calls.some(call=>call.kind==='inject' && call.args.world==='MAIN'));
  h.tabMap.get(tabId).url='https://example.com/';
  assert.equal((await h.message(hostMessage('worker.render',{tabId,itemId:'a'}),hostSender())).ok,false);
});

test('closed worker tombstones preserve the real terminal cause and cleanup never certifies a save', async () => {
  const h = await owned();
  await claim(h,['a','b']);
  const a=(await open(h,'a')).result.tabId;
  const b=(await open(h,'b')).result.tabId;
  h.tabMap.delete(a);
  await h.chrome.tabs.onRemoved.emit(a);
  await h.settle();
  assert.equal(registry(h).find(item=>item.tabId===a).state,'closed');
  const state=await h.message(hostMessage('tab.get',{tabId:a}),hostSender());
  assert.equal(state.ok,false);
  assert.equal(state.code,'TAB_CLOSED');
  const pulse=await h.message(hostMessage('worker.render',{itemId:'a',tabId:a}),hostSender());
  assert.equal(pulse.code,'TAB_CLOSED');
  const cleanup=await h.message(hostMessage('worker.release',{itemId:'a',tabId:a,verified:false}),hostSender());
  assert.deepEqual(cleanup,{ok:true,result:{released:true,alreadyClosed:true}});
  assert.equal(Object.hasOwn(cleanup.result,'verified'),false);
  const wrong=await h.message(hostMessage('worker.release',{itemId:'b',tabId:a,verified:false}),hostSender());
  assert.equal(wrong.ok,false);
  assert.equal(wrong.code,'WORKER_UNBOUND');
  assert.equal((await h.message(hostMessage('tab.get',{tabId:b}),hostSender())).ok,true);
  assert(h.tabMap.has(b));
  assert(!h.calls.some(call=>call.kind==='tabs.remove'));
});

test('terminal tab errors survive host responses without classifying transient failures as closure', async () => {
  const h=await owned(); await claim(h,['a']);
  const tabId=(await open(h,'a')).result.tabId;
  h.tabMap.delete(tabId);
  assert.equal((await h.message(hostMessage('tab.get',{tabId}),hostSender())).code,'TAB_CLOSED');
  h.chrome.tabs.get=async()=>{ throw new Error('temporary Chrome connection failure'); };
  const transient=await h.message(hostMessage('tab.get',{tabId}),hostSender());
  assert.equal(transient.error,'temporary Chrome connection failure');
  assert.equal(transient.code,undefined);
  const unbound=await h.message(hostMessage('tab.get',{tabId:123456}),hostSender());
  assert.equal(unbound.code,'WORKER_UNBOUND');
  delete h.sessionData[CONTEXT_KEY];
  assert.equal((await h.message(hostMessage('tab.get',{tabId}),hostSender())).code,'CONTEXT_CLOSED');
});

test('closed-worker diagnostic history is bounded without dropping active worker bindings', async () => {
  const items=Array.from({length:100},(_,index)=>({tabId:1000+index,itemId:`old-${index}`,state:'closed',closedAt:index+1}));
  items.push({tabId:8,itemId:'a',state:'active'},{tabId:9,itemId:'b',state:'active'});
  const h=await owned({session:{[CONTEXT_KEY]:owner,[WORKERS_KEY]:{sessionId:owner.sessionId,items}},tabs:[{id:7,url:ADD_URL},{id:8,url:ADD_URL},{id:9,url:ADD_URL}]});
  h.tabMap.delete(8);
  await h.chrome.tabs.onRemoved.emit(8);
  await h.settle();
  assert.equal(registry(h).filter(item=>item.state==='closed').length,100);
  assert.equal(registry(h).find(item=>item.tabId===8).state,'closed');
  assert.equal(registry(h).some(item=>item.tabId===1000),false);
  assert.equal((await h.message(hostMessage('tab.get',{tabId:9}),hostSender())).ok,true);
});

test('foreground serial opt-in activates only the newly created owned tab and rejects overlapping workers', async () => {
  const h = await owned();
  await h.message(hostMessage('write', { snapshot: { version: 1, items: [{id:'a',status:'opening'},{id:'b',status:'queued'}] } }), hostSender());
  const first = await h.message(hostMessage('worker.open', { itemId: 'a', foregroundSerial: true }), hostSender());
  assert.equal(first.ok,true);
  const creation=h.calls.find(call=>call.kind==='tabs.create');
  assert.equal(creation.args.active,true);
  assert.equal(creation.args.openerTabId,7);
  assert.equal(registry(h).find(item=>item.tabId===first.result.tabId).foregroundSerial,true);
  await claim(h,['b']);
  for(const foregroundSerial of [false,true]) {
    const next=await h.message(hostMessage('worker.open',{itemId:'b',foregroundSerial}),hostSender());
    assert.equal(next.ok,false);
    assert.match(next.error,/前台串行视频尚未完成/);
  }
  assert.equal(h.calls.filter(call=>call.kind==='tabs.create').length,1);
  assert(!h.calls.some(call=>call.kind==='tabs.update'));
  assert.equal(h.tabMap.get(7).url,ADD_URL);
  await claim(h,['a'],'verifying');
  assert.equal((await h.message(hostMessage('worker.release',{itemId:'a',tabId:first.result.tabId,verified:true}),hostSender())).ok,true);
  await claim(h,['b']);
  assert.equal((await h.message(hostMessage('worker.open',{itemId:'b',foregroundSerial:true}),hostSender())).ok,true);
  assert(h.calls.filter(call=>call.kind==='tabs.create').every(call=>call.args.active===true));
});

test('foreground serial creation requires exactly one active queue item and no existing worker', async () => {
  const h=await owned();
  await claim(h,['a','b']);
  const request=()=>h.message(hostMessage('worker.open',{itemId:'b',foregroundSerial:true}),hostSender());
  assert.equal((await request()).ok,false);
  assert(!h.calls.some(call=>call.kind==='tabs.create'));
  for(const status of ['uploading','processing','saving','verifying']) {
    await h.message(hostMessage('write',{snapshot:{version:1,items:[{id:'a',status},{id:'b',status:'opening'}]}}),hostSender());
    assert.equal((await request()).ok,false);
  }
  await claim(h,['a']);
  assert.equal((await open(h,'a')).ok,true);
  await claim(h,['b']);
  assert.equal((await request()).ok,false,'a stale snapshot cannot bypass an existing active worker');
  assert(h.calls.filter(call=>call.kind==='tabs.create').every(call=>call.args.active===false));
});

test('foreground request values are validated before creation while omitted and false stay in background', async () => {
  for(const foregroundSerial of ['true',1,null]) {
    const h=await owned(); await claim(h,['a']);
    const result=await h.message(hostMessage('worker.open',{itemId:'a',foregroundSerial}),hostSender());
    assert.equal(result.ok,false);
    assert.match(result.error,/参数无效/);
    assert(!h.calls.some(call=>call.kind==='tabs.create'));
  }
  for(const payload of [{itemId:'a'},{itemId:'a',foregroundSerial:false}]) {
    const h=await owned(); await claim(h,['a']);
    assert.equal((await h.message(hostMessage('worker.open',payload),hostSender())).ok,true);
    assert.equal(h.calls.find(call=>call.kind==='tabs.create').args.active,false);
    assert(!h.calls.some(call=>call.kind==='tabs.update'));
  }
});

test('toolbar restores the article entry in a second WeChat tab before upload ownership rejects rebinding', async () => {
  const articleUrl = `${ORIGIN}/cgi-bin/appmsg?t=media/appmsg_edit&action=edit`;
  const h = await owned({ tabs: [{id:7,url:ADD_URL},{id:8,url:articleUrl}] });
  const savedQueue = {version:1,items:[{id:'in-flight',status:'processing'}]};
  h.localData['wxvu.queue.v2'] = structuredClone(savedQueue);
  await h.chrome.action.onClicked.emit({id:8,url:articleUrl});
  await h.settle();
  const article = h.calls.filter(articleInjection);
  assert.deepEqual(article.map(call=>call.args), [{target:{tabId:8},files:ARTICLE_SCRIPTS}]);
  assert.deepEqual(h.sessionData[CONTEXT_KEY], owner);
  assert.deepEqual(h.localData['wxvu.queue.v2'], savedQueue);
  assert.equal(h.hasOffscreen(), true);
  assert(!h.calls.some(uploadInjection));
  assert(!h.calls.some(call=>['engine','offscreen.create','offscreen.close','local.set','session.set','tabs.create','tabs.update','tabs.remove'].includes(call.kind)));
  assert(h.calls.findIndex(articleInjection) < h.calls.findIndex(call=>call.kind==='badge' && call.args.text==='!'));
});

test('article bootstrap failure cannot prevent the existing upload toolbar initialization', async () => {
  const h = await harness({scriptReply:async args=>{
    if (JSON.stringify(args.files) === JSON.stringify(ARTICLE_SCRIPTS)) throw new Error('article entry injection failed');
    return [{result:{}}];
  }});
  await h.chrome.action.onClicked.emit({id:7,url:ADD_URL});
  await h.settle();
  assert.equal(h.calls.filter(articleInjection).length,1);
  assert.equal(h.calls.filter(uploadInjection).length,1);
  assert.equal(h.calls.filter(call=>call.kind==='offscreen.create').length,1);
  assert.equal(h.calls.filter(call=>call.kind==='engine' && call.message.command==='init').length,1);
  assert.equal(h.sessionData[CONTEXT_KEY].targetTabId,7);
  assert(h.calls.some(call=>call.kind==='badge' && call.args.text===''));
  assert(!h.calls.some(call=>['tabs.create','tabs.update','tabs.remove','local.set'].includes(call.kind)));
});

test('article automatic bootstrap is restricted to the existing WeChat host permission and adds no permissions', async () => {
  const manifest = JSON.parse(await fs.readFile(new URL('../manifest.json',import.meta.url),'utf8'));
  assert.deepEqual([...manifest.permissions].sort(), ['activeTab','offscreen','scripting','storage']);
  assert.deepEqual(manifest.host_permissions, [`${ORIGIN}/*`]);
  const entry = manifest.content_scripts.find(script=>script.js.includes('src/article-panel.js'));
  assert(entry, 'article entry must bootstrap on ordinary WeChat pages as well as a newly navigated article editor');
  assert.deepEqual(entry.matches, [`${ORIGIN}/*`]);
  assert.deepEqual(entry.js, ARTICLE_SCRIPTS);
  assert.equal(entry.run_at, 'document_idle');
  assert.equal(entry.all_frames, false);
  assert(!entry.world || entry.world === 'ISOLATED');
  assert(!manifest.optional_permissions?.length);
  assert(!manifest.optional_host_permissions?.length);
});

test('toolbar never injects article or upload code on non-WeChat origins or internal browser pages', async () => {
  for(const url of ['https://mp.weixin.qq.com.evil.test/','https://example.com/','http://mp.weixin.qq.com/','chrome://extensions/']) {
    const h=await harness({tabs:[{id:7,url,status:'complete'}]});
    await h.chrome.action.onClicked.emit({id:7,url});
    await h.settle();
    assert(!h.calls.some(call=>['inject','engine','offscreen.create','tabs.create','tabs.update'].includes(call.kind)));
    assert.equal(h.sessionData[CONTEXT_KEY],undefined);
  }
});
