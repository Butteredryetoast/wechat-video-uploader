import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const panelSource = readFileSync(new URL('../src/panel.js', import.meta.url), 'utf8');
const sidebarSource = readFileSync(new URL('../src/sidebar.js', import.meta.url), 'utf8');
const item = (id, extra = {}) => ({ id, name: `${id}.mp4`, size: 100, title: id, status: 'queued', hasFile: true, ...extra });
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

async function until(check) {
  for (let attempt = 0; attempt < 150; attempt++) {
    if (check()) return;
    await tick();
  }
  assert.fail('Timed out waiting for sidebar operation');
}

async function harness(t, options = {}) {
  const dom = new JSDOM('<!doctype html><html><body><main>公众号素材库</main></body></html>', {
    runScripts: 'outside-only', url: 'https://mp.weixin.qq.com/cgi-bin/test'
  });
  const state = {
    snapshot: { items: [], running: false, pauseRequested: false, ...options.snapshot },
    runtimeInfo: { ready: true, reason: '上传入口已就绪', concurrency: 2 },
    notice: { text: '', kind: 'info' }, ingesting: false
  };
  const calls = [];
  const listeners = new Set();
  const blobs = [];
  const downloads = [];
  const runtime = {
    id: 'test-extension-id',
    onMessage: { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn) },
    sendMessage: async message => {
      calls.push(message);
      const custom = options.handle ? await options.handle(message, state) : undefined;
      if (custom !== undefined) return custom;
      if (message.command === 'file.begin') state.ingesting = true;
      if (message.command === 'file.end' || message.command === 'file.cancel') state.ingesting = false;
      if (message.command === 'update') {
        const row = state.snapshot.items.find(entry => entry.id === message.payload.id);
        if (row) Object.assign(row, message.payload.changes);
      }
      if (message.command === 'configure') {
        if (Object.hasOwn(message.payload, 'concurrency')) state.runtimeInfo.concurrency = message.payload.concurrency;
        if (Object.hasOwn(message.payload, 'foregroundSerial')) state.runtimeInfo.foregroundSerial = message.payload.foregroundSerial;
      }
      return { ok: true, result: message.command === 'state' ? JSON.parse(JSON.stringify(state)) : {} };
    }
  };
  dom.window.chrome = { runtime };
  dom.window.URL.createObjectURL = blob => { blobs.push(blob); return 'blob:test-download'; };
  dom.window.URL.revokeObjectURL = () => {};
  dom.window.HTMLAnchorElement.prototype.click = function () { downloads.push({ href: this.href, download: this.download }); };
  if (options.collapsed) dom.window.sessionStorage.setItem('wxvu.panel.collapsed', '1');
  dom.window.eval(panelSource);
  if (options.orphanedPanel) dom.window.WXVideoPanel.create();
  dom.window.eval(sidebarSource);
  t.after(() => dom.window.close());
  await until(() => calls.some(call => call.command === 'state'));
  await tick();
  const root = dom.window.document.getElementById('wx-video-batch-uploader').shadowRoot;
  const buttons = () => [...root.querySelectorAll('button')];
  const choose = files => {
    const input = root.querySelector('input[type="file"]');
    Object.defineProperty(input, 'files', { configurable: true, value: files });
    input.dispatchEvent(new dom.window.Event('change', { bubbles: true, composed: true }));
  };
  const push = (next, id = runtime.id) => {
    for (const fn of listeners) fn({ namespace: 'wxvu.sidebar', command: 'state', payload: next }, { id });
  };
  return { dom, window: dom.window, root, state, calls, listeners, blobs, downloads, buttons, choose, push };
}

test('mounts inside the current page and repeated injection only shows the existing sidebar', async t => {
  const ui = await harness(t, { collapsed: true });
  assert.equal(ui.root.querySelector('.panel').hidden, true);
  assert.equal(ui.listeners.size, 1);
  assert.equal(ui.root.querySelector('.panel').classList.contains('full-page'), false);
  const count = ui.calls.length;
  ui.window.eval(sidebarSource);
  assert.equal(ui.listeners.size, 1);
  assert.equal(ui.window.document.querySelectorAll('#wx-video-batch-uploader').length, 1);
  assert.equal(ui.root.querySelector('.panel').hidden, false);
  assert.equal(ui.window.sessionStorage.getItem('wxvu.panel.collapsed'), '0');
  assert.equal(ui.calls.length, count, 'reinjection must not restart the session or poll');
  assert.equal(ui.window.document.querySelector('main').textContent, '公众号素材库');
  assert.equal(ui.window.document.querySelector('iframe'), null);
});

test('reload replaces an orphaned panel while retaining the page and restored queue', async t => {
  const ui = await harness(t, { orphanedPanel: true, snapshot: { items: [item('restored')] } });
  assert.equal(ui.window.document.querySelectorAll('#wx-video-batch-uploader').length, 1);
  assert.equal(ui.root.querySelector('.queue-count').textContent, '1');
  assert.equal(ui.listeners.size, 1);
  assert.equal(ui.window.document.querySelector('main').textContent, '公众号素材库');
  assert(!ui.calls.some(call => call.command === 'start' || call.command === 'remove'));
});

test('state pushes require the same extension sender and collapse never pauses a running queue', async t => {
  const ui = await harness(t);
  const next = { ...ui.state, snapshot: { items: [item('one', { status: 'uploading' })], running: true } };
  ui.push(next, 'another-extension');
  assert.equal(ui.root.querySelector('.queue-count').textContent, '0');
  ui.push(next);
  assert.equal(ui.root.querySelector('.queue-count').textContent, '1');
  ui.root.querySelector('[aria-label="折叠面板，任务继续"]').click();
  assert.equal(ui.root.querySelector('.float').hidden, false);
  assert.match(ui.root.querySelector('.float').textContent, /视频上传中/);
  assert.equal(ui.window.sessionStorage.getItem('wxvu.panel.collapsed'), '1');
  assert.equal(ui.calls.some(call => call.command === 'pause'), false);
});

test('files are sent sequentially in 384 KiB chunks and selection locks start without simulating running', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let firstChunk = true;
  const ui = await harness(t, {
    snapshot: { items: [item('queued')] },
    handle: async message => {
      if (message.command === 'file.chunk' && firstChunk) { firstChunk = false; await gate; }
    }
  });
  const size = 384 * 1024 + 17;
  const first = new ui.window.File([new Uint8Array(size).fill(65)], '较长名称'.repeat(20) + '.mp4', { type: 'video/mp4', lastModified: 100 });
  const second = new ui.window.File([new Uint8Array([1, 2, 3])], 'second.mp4', { type: 'video/mp4', lastModified: 101 });
  ui.choose([first, second]);
  await until(() => ui.calls.some(call => call.command === 'file.chunk'));
  assert.equal(ui.root.querySelector('.choose').disabled, true);
  assert.equal(ui.root.querySelector('.main-action').disabled, true);
  assert.match(ui.root.querySelector('.main-action').textContent, /准备视频/);
  assert.doesNotMatch(ui.root.querySelector('.main-action').textContent, /暂停/);
  assert.equal(ui.root.querySelector('input[type="text"]').disabled, true);
  ui.choose([second]);
  assert.equal(ui.calls.filter(call => call.command === 'file.begin').length, 1);
  release();
  await until(() => ui.calls.filter(call => call.command === 'file.end').length === 2 && !ui.root.querySelector('.choose').disabled);
  const transfer = ui.calls.filter(call => call.command.startsWith('file.'));
  assert.deepEqual(transfer.map(call => call.command), ['file.begin', 'file.chunk', 'file.chunk', 'file.end', 'file.begin', 'file.chunk', 'file.end']);
  assert.equal(transfer[0].payload.name, first.name);
  assert.equal(transfer[0].payload.size, size);
  assert.equal(Buffer.from(transfer[1].payload.data, 'base64').length, 384 * 1024);
  assert.equal(Buffer.from(transfer[2].payload.data, 'base64').length, 17);
  assert.equal(transfer[1].payload.index, 0);
  assert.equal(transfer[2].payload.index, 1);
  assert.equal(transfer[1].payload.id, transfer[0].payload.id);
  assert.notEqual(transfer[4].payload.id, transfer[0].payload.id);
  assert.equal(ui.state.snapshot.running, false);
  assert.deepEqual([...Array(ui.window.sessionStorage.length)].map((_, index) => ui.window.sessionStorage.key(index)), [], 'file bytes never enter page storage');
});

test('a rejected chunk cancels its buffer, preserves the failure notice, and skips subsequent files', async t => {
  const ui = await harness(t, {
    handle: message => message.command === 'file.chunk' ? { ok: false, error: '分片传输已中断' } : undefined
  });
  const file = new ui.window.File(['video bytes'], 'example.mp4', { type: 'video/mp4' });
  ui.choose([file, file]);
  await until(() => ui.calls.some(call => call.command === 'file.cancel') && !ui.root.querySelector('.choose').disabled);
  const begin = ui.calls.find(call => call.command === 'file.begin');
  assert.equal(ui.calls.find(call => call.command === 'file.cancel').payload.id, begin.payload.id);
  assert.equal(ui.calls.filter(call => call.command === 'file.begin').length, 1);
  assert.equal(ui.calls.filter(call => call.command === 'file.end').length, 0);
  assert.match(ui.root.querySelector('.notice').textContent, /分片传输已中断/);
  assert.equal(ui.root.querySelector('.notice').dataset.kind, 'error');
});

test('title changes are ordered and a failed change prevents starting until corrected', async t => {
  const ui = await harness(t, {
    snapshot: { items: [item('example')] },
    handle: message => message.command === 'update' && message.payload.changes.title === '失败标题' ? { ok: false, error: '标题保存失败' } : undefined
  });
  const input = ui.root.querySelector('input[type="text"]');
  input.focus();
  input.value = '失败标题';
  input.dispatchEvent(new ui.window.Event('input', { bubbles: true }));
  await until(() => /标题保存失败/.test(ui.root.querySelector('.notice').textContent));
  ui.root.querySelector('.main-action').click();
  await until(() => /有标题修改未能保存/.test(ui.root.querySelector('.notice').textContent));
  assert.equal(ui.calls.some(call => call.command === 'start'), false);
  await until(() => !ui.root.querySelector('.main-action').disabled);
  input.focus();
  for (const title of ['修正', '修正标题']) {
    input.value = title;
    input.dispatchEvent(new ui.window.Event('input', { bubbles: true }));
  }
  ui.root.querySelector('.main-action').click();
  await until(() => ui.calls.some(call => call.command === 'start'));
  assert.deepEqual(ui.calls.filter(call => call.command === 'update').map(call => call.payload.changes.title), ['失败标题', '修正', '修正标题']);
  assert.equal(ui.state.snapshot.items[0].title, '修正标题');
});

test('action lock prevents repeated starts while the background response is pending', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const ui = await harness(t, {
    snapshot: { items: [item('example')] },
    handle: async message => { if (message.command === 'start') await gate; }
  });
  const action = ui.root.querySelector('.main-action');
  action.click();
  action.click();
  await until(() => ui.calls.some(call => call.command === 'start'));
  assert.equal(ui.calls.filter(call => call.command === 'start').length, 1);
  assert.equal(action.disabled, true);
  release();
  await until(() => !action.disabled);
});

test('parallel configuration reaches the background and is locked until the response and while running', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const ui = await harness(t, {
    snapshot: { items: [item('first'), item('second')] },
    handle: async message => { if (message.command === 'configure') await gate; }
  });
  const select = ui.root.querySelector('.concurrency');
  assert.equal(select.value, '2');
  select.value = '10';
  select.dispatchEvent(new ui.window.Event('change', { bubbles: true, composed: true }));
  await until(() => ui.calls.some(call => call.command === 'configure'));
  const configure = ui.calls.find(call => call.command === 'configure');
  assert.equal(configure.namespace, 'wxvu.ui');
  assert.deepEqual(JSON.parse(JSON.stringify(configure.payload)), { concurrency: 10 });
  assert.equal(select.disabled, true);
  assert.equal(ui.root.querySelector('.main-action').disabled, true);
  release();
  await until(() => !select.disabled);
  assert.equal(select.value, '10');
  ui.state.snapshot.running = true;
  ui.state.snapshot.items[0].status = 'uploading';
  ui.state.snapshot.items[1].status = 'processing';
  ui.push(JSON.parse(JSON.stringify(ui.state)));
  assert.equal(select.disabled, true);
  assert.equal(ui.root.querySelector('.stat[data-kind="active"] strong').textContent, '2');
  select.value = '1';
  select.dispatchEvent(new ui.window.Event('change', { bubbles: true, composed: true }));
  await tick();
  assert.equal(ui.calls.filter(call => call.command === 'configure').length, 1);
});

test('rejected parallel configuration restores the confirmed setting with a visible error', async t => {
  const ui = await harness(t, {
    handle: message => message.command === 'configure' ? { ok: false, error: '并行数量修改失败' } : undefined
  });
  const select = ui.root.querySelector('.concurrency');
  select.value = '1';
  select.dispatchEvent(new ui.window.Event('change', { bubbles: true }));
  await until(() => ui.calls.some(call => call.command === 'configure') && !select.disabled);
  assert.equal(select.value, '2');
  assert.match(ui.root.querySelector('.notice').textContent, /并行数量修改失败/);
});

test('foreground serial option reaches the host together with a single upload slot', async t => {
  const ui = await harness(t, { snapshot: { items: [item('first')] } });
  const checkbox = ui.root.querySelector('[aria-label="前台串行上传"]');
  checkbox.click();
  await until(() => ui.calls.some(call => call.command === 'configure') && !checkbox.disabled);
  const configure = ui.calls.find(call => call.command === 'configure');
  assert.deepEqual(JSON.parse(JSON.stringify(configure.payload)), { concurrency: 1, foregroundSerial: true });
  assert.equal(checkbox.checked, true);
  assert.equal(ui.root.querySelector('.concurrency').value, '1');
  assert.equal(ui.root.querySelector('.concurrency').disabled, true);
});

test('export downloads JSON with URLs and authentication fields removed', async t => {
  const ui = await harness(t, {
    handle: message => message.command === 'export' ? { ok: true, result: {
      version: '0.2.0', url: 'https://mp.weixin.qq.com?token=secret', token: 'secret',
      diagnostics: { ready: true, details: 'failure at https://mp.weixin.qq.com?token=secret', cookie: 'private' },
      items: [{ name: '视频.mp4', status: 'queued' }]
    } } : undefined
  });
  ui.buttons().find(button => button.textContent === '导出日志').click();
  await until(() => ui.blobs.length === 1);
  const text = await new Promise((resolve, reject) => {
    const reader = new ui.window.FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsText(ui.blobs[0]);
  });
  assert.doesNotMatch(text, /https:\/\/|secret|private|"token"|"cookie"|"url"/);
  assert.equal(JSON.parse(text).items[0].name, '视频.mp4');
  assert.equal(ui.downloads[0].download, '公众号批量上传-诊断记录.json');
  assert.equal(ui.downloads[0].href, 'blob:test-download');
});

test('leaving the page cleans listeners and cancels an unfinished file transfer', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const ui = await harness(t, { handle: async message => { if (message.command === 'file.chunk') await gate; } });
  ui.choose([new ui.window.File(['video bytes'], 'example.mp4', { type: 'video/mp4' })]);
  await until(() => ui.calls.some(call => call.command === 'file.chunk'));
  ui.window.dispatchEvent(new ui.window.Event('pagehide'));
  await until(() => ui.calls.some(call => call.command === 'file.cancel'));
  assert.equal(ui.listeners.size, 0);
  release();
  await tick();
  await tick();
  assert.equal(ui.calls.some(call => call.command === 'file.end'), false);
});

test('a page restored from the back-forward cache reconnects exactly one listener', async t => {
  const ui = await harness(t);
  ui.window.dispatchEvent(new ui.window.Event('pagehide'));
  assert.equal(ui.listeners.size, 0);
  ui.window.dispatchEvent(new ui.window.PageTransitionEvent('pageshow', { persisted: true }));
  assert.equal(ui.listeners.size, 1);
  ui.window.dispatchEvent(new ui.window.PageTransitionEvent('pageshow', { persisted: true }));
  assert.equal(ui.listeners.size, 1);
  ui.window.dispatchEvent(new ui.window.Event('pagehide'));
  assert.equal(ui.listeners.size, 0);
});
