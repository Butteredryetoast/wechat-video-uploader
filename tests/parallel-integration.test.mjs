import test from 'node:test';
import assert from 'node:assert/strict';
import { File } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import '../src/queue.js';
import '../src/transport.js';
import '../src/engine.js';

const adapterSource = await readFile(new URL('../src/adapter.js', import.meta.url), 'utf8');
const renderSource = await readFile(new URL('../src/render-bridge.js', import.meta.url), 'utf8');
const addFixture = await readFile(new URL('./fixtures/add-video.html', import.meta.url), 'utf8');
const MASTER = 7;
const EXTENSION = 'parallel-integration-fixture';
const EDIT_URL = 'https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit&action=edit&type=77&token=FIXTURE';
const ADD_URL = 'https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/videomsg_edit&action=video_edit&type=15&token=FIXTURE&lang=zh_CN';
const LIST_URL = 'https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/video_list&action=list&type=15&token=FIXTURE';
const clone = value => JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

// Only browser boundaries are faked. Queue checkpoints, offscreen orchestration,
// base64 file transfer, page selection, cover workflow and save submission use
// the production modules, with a separate real DOM for every upload tab.
test('hidden parallel workers continue after lost save responses without verifying, repeating uploads or activating tabs', { timeout: 30000 }, async t => {
  const tabs = new Map();
  const workers = new Map();
  const completedWorkers = [];
  const doms = [];
  const events = [];
  const pageCommands = [];
  const saved = [];
  const attachments = [];
  const bytesRead = [];
  const renderCalls = [];
  const firstTwoAttached = deferred();
  const thirdOpened = deferred();
  let nextTabId = 101;
  let durable = null;
  let active = 0;
  let peak = 0;
  let waits = 0;
  let activeTabId = 999; // The user is browsing an unrelated tab throughout.
  const clockStart = Date.now();
  let elapsed = 0;
  let engine;

  function page(tabId, kind, video) {
    const html = kind === 'master' ? `<!doctype html><main><h1>图文编辑</h1>
      <textarea id="article">用户未保存的正文</textarea><section role="dialog"><h2>选择视频</h2>
      <span>素材库</span><a href="${ADD_URL}">本地上传</a><button>确定</button></section></main>` :
      kind === 'add' ? addFixture : '<!doctype html><main><h1>素材库</h1><span>视频</span><table><tbody></tbody></table></main>';
    const marker = `00000000-0000-4000-8000-${String(tabId).padStart(12, '0')}`;
    const dom = new JSDOM(html, { runScripts: 'outside-only', url: kind === 'master' ? EDIT_URL : kind === 'add' ? `${ADD_URL}#wxvu-worker=${marker}` : LIST_URL });
    doms.push(dom);
    const { window } = dom;
    const instance = { tabId, kind, window, listeners: [], tick: 0, task: null, pendingNavigation: false };
    window.Date.now = () => clockStart + elapsed;
    window.performance.now = () => elapsed;
    Object.defineProperty(window.document, 'hidden', { get: () => true });
    Object.defineProperty(window.document, 'visibilityState', { get: () => 'hidden' });
    window.focus = () => assert.fail('render assistance must never focus a worker');
    // The browser boundary intentionally never dispatches a native animation
    // frame: only the production bridge can progress these hidden documents.
    instance.frameJobs = new Map();
    let frameId = 0;
    window.requestAnimationFrame = callback => {
      instance.frameJobs.set(++frameId, callback);
      return frameId;
    };
    window.cancelAnimationFrame = id => instance.frameJobs.delete(id);
    instance.nativeRequest = window.requestAnimationFrame;
    window.reportError = error => assert.fail(`unexpected page rendering failure: ${error}`);
    window.eval(renderSource);
    instance.bridge = window.__WXVU_RENDER_BRIDGE_V1__;
    assert.equal(Boolean(instance.bridge), kind === 'add', 'only marked upload pages install the frame bridge');
    const $ = selector => window.document.querySelector(selector);
    instance.$ = $;
    window.HTMLElement.prototype.getClientRects = function () { return [{ width: 200, height: 30 }]; };
    const fileLists = new WeakMap();
    Object.defineProperty(window.HTMLInputElement.prototype, 'files', {
      configurable: true, get() { return fileLists.get(this) || []; }, set(value) { fileLists.set(this, value); }
    });
    window.DataTransfer = class { files = []; items = { add: file => this.files.push(file) }; };
    window.chrome = { runtime: { id: EXTENSION, onMessage: { addListener: listener => instance.listeners.push(listener) } } };
    tabs.set(tabId, instance);
    if (kind === 'master') {
      $('a').addEventListener('click', () => assert.fail('master upload entry must not navigate or spawn untracked tabs'));
      $('button').addEventListener('click', () => assert.fail('uploaded videos must not be inserted into the article'));
    }
    if (kind === 'library') {
      const row = window.document.createElement('tr');
      const thumb = window.document.createElement('td');
      thumb.innerHTML = '<img src="/finished-cover.jpg"><span>00:00</span>';
      const title = window.document.createElement('td'); title.textContent = video.title;
      const status = window.document.createElement('td'); status.textContent = '转码中';
      const time = window.document.createElement('td');
      const date = new Date(video.savedAt);
      time.textContent = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
      row.append(thumb, title, status, time);
      $('tbody').append(row);
    }
    if (kind !== 'add') return instance;

    const emit = name => events.push({ tabId, name });
    const selected = () => Boolean($('#cover .applied-preview'));
    instance.syncSave = () => { $('#save').disabled = !selected() || !instance.originalConfirmed || !$('#original').checked || !$('#agreement').checked; };
    instance.renderOriginalNotice = () => {
      assert.equal(instance.originalNotice, undefined, 'original switch must only be clicked once');
      const dialog = window.document.createElement('section');
      dialog.setAttribute('role', 'dialog');
      dialog.className = 'weui-desktop-dialog';
      dialog.innerHTML = `<h2>原创声明</h2><h3>视频原创须知</h3><label>
        <input id="original-terms" type="checkbox" ${tabId === 102 ? 'checked' : ''}>我已阅读并同意遵守
        <a href="#original-rules">《微信公众平台原创声明及相关功能使用协议》</a></label>
        <button type="button" id="original-confirm" disabled>确定</button>`;
      instance.originalNotice = dialog;
      window.document.body.append(dialog);
      $('form').setAttribute('aria-hidden', 'true');
      instance.enableOriginalConfirmAt = instance.tick + 1;
      dialog.querySelector('#original-terms').addEventListener('change', () => emit('original-terms'));
      dialog.querySelector('#original-confirm').addEventListener('click', () => {
        assert.equal(dialog.querySelector('#original-terms').checked, true);
        assert.equal(instance.closeOriginalAt, undefined, 'original confirmation must only be clicked once');
        emit('original-confirm');
        instance.closeOriginalAt = instance.tick + 1;
      });
    };
    instance.renderRecommendations = () => {
      const group = window.document.createElement('div');
      group.innerHTML = '<p>推荐封面</p>';
      for (let index = 0; index < 2; index++) {
        const button = window.document.createElement('button'); button.type = 'button';
        button.innerHTML = `<img src="/recommend-${index}.jpg" alt="推荐封面 ${index + 1}">`;
        button.addEventListener('click', () => {
          assert.equal(index, 0);
          assert(!instance.editor, 'recommendation must only be selected once');
          emit('cover-selected');
          const dialog = window.document.createElement('section');
          dialog.setAttribute('role', 'dialog');
          dialog.className = 'weui-desktop-dialog';
          dialog.innerHTML = '<h2>编辑封面</h2><canvas></canvas><h3>封面预览</h3><img src="/recommend-0.jpg"><button id="done" disabled>完成</button><button id="cancel">取消</button>';
          instance.editor = dialog;
          window.document.body.append(dialog);
          instance.enableDoneAt = instance.tick + 1;
          dialog.querySelector('#cancel').addEventListener('click', () => assert.fail('must confirm the default cover'));
          dialog.querySelector('#done').addEventListener('click', () => {
            assert.equal(dialog.querySelector('#done').disabled, false);
            assert.equal(instance.doneClicked, undefined, 'Done must be clicked once');
            instance.doneClicked = true;
            emit('cover-done');
            // WeChat's crop UI can defer both the close and applied preview to
            // animation frames. Passing time alone must not complete this step.
            window.requestAnimationFrame(() => {
              assert.equal(window.document.hidden, true);
              instance.editor.remove();
              emit('cover-frame-closed');
              window.requestAnimationFrame(() => {
                const previews = window.document.createElement('div');
                previews.className = 'applied-preview';
                previews.innerHTML = '<p>视频消息封面（16:9）</p><img src="/crop-wide.jpg"><img src="/crop-square.jpg"><img src="/crop-player.jpg">';
                $('#cover').replaceChildren(previews);
                emit('cover-applied');
                instance.syncSave();
              });
            });
          });
        });
        group.append(button);
      }
      $('#cover').replaceChildren(group);
    };
    instance.advance = () => {
      if (!instance.attached) return;
      instance.tick++;
      if (instance.tick === 1) {
        $('#upload-state').textContent = '上传成功';
        const name = window.document.createElement('p'); name.textContent = instance.task.name;
        $('#upload-row').append(name);
        instance.renderRecommendations();
      }
      if (instance.enableDoneAt && instance.tick >= instance.enableDoneAt) {
        instance.editor.querySelector('#done').disabled = false;
        instance.enableDoneAt = null;
      }
      if (instance.enableOriginalConfirmAt && instance.tick >= instance.enableOriginalConfirmAt) {
        instance.originalNotice.querySelector('#original-confirm').disabled = false;
        instance.enableOriginalConfirmAt = null;
      }
      if (instance.closeOriginalAt && instance.tick >= instance.closeOriginalAt) {
        instance.originalNotice.remove();
        $('form').removeAttribute('aria-hidden');
        instance.originalConfirmed = true;
        instance.closeOriginalAt = null;
        emit('original-applied');
      }
      instance.syncSave();
    };
    $('#video-file').addEventListener('change', () => {
      const [file] = $('#video-file').files;
      assert(file instanceof window.File);
      assert.equal(file.name, instance.task.name);
      attachments.push({ tabId, name: file.name });
      bytesRead.push(new Promise((resolve, reject) => {
        const reader = new window.FileReader();
        reader.onerror = () => reject(reader.error);
        reader.onload = () => resolve({ name: file.name, bytes: Buffer.from(reader.result) });
        reader.readAsArrayBuffer(file);
      }));
      instance.attached = true;
      $('#video-file').files = []; // Real widgets can clear the native input immediately.
      $('#upload-state').textContent = '上传中 20%';
      $('#video-title').value = file.name.replace(/\.[^.]+$/, '');
      emit('attached');
      if (attachments.length === 2) firstTwoAttached.resolve();
    });
    for (const name of ['original', 'agreement']) {
      $(`#${name}`).addEventListener('change', () => {
        assert(selected(), `${name} must follow cover confirmation`);
        if (name === 'agreement') {
          assert.equal($('#original').checked, true);
          assert.equal(instance.originalConfirmed, true, 'service rules must follow original dialog completion');
          assert.equal(window.document.querySelector('[role="dialog"]'), null);
        }
        emit(name);
        if (name === 'original') instance.renderOriginalNotice();
        instance.syncSave();
      });
    }
    for (const name of ['preview', 'publish']) {
      $(`#${name}`).disabled = false;
      $(`#${name}`).addEventListener('click', () => assert.fail(`unexpected ${name} action`));
    }
    $('#save').addEventListener('click', () => {
      assert.equal(durable.items.find(item => item.id === instance.task.id).status, 'saving');
      assert.equal($('#original').checked, true);
      assert.equal($('#agreement').checked, true);
      assert.equal($('#danmaku').checked, true);
      assert.equal(window.document.querySelector('[role="dialog"]'), null);
      assert(selected());
      emit('save');
      const video = { tabId, title: $('#video-title').value, savedAt: clockStart + elapsed };
      saved.push(video);
      instance.saved = video;
      instance.pendingNavigation = true;
    });
    return instance;
  }

  async function send(tabId, message) {
    const origin = tabs.get(tabId);
    assert(origin, 'page routing must use a registered tab');
    assert.equal(origin.listeners.length, 1);
    assert.notEqual(message.command, 'verify', 'production uploads never inspect saved material results');
    pageCommands.push({ tabId, command: message.command });
    if (message.command === 'begin') origin.task = clone(message.payload);
    // Hold worker two while worker one finishes. Opening worker three proves
    // the engine has refilled a free slot without waiting for all current tabs.
    if (tabId === 102 && message.command === 'status') await thirdOpened.promise;
    let response;
    origin.listeners[0](clone(message), { id: EXTENSION }, value => { response = clone(value); });
    assert(response);
    if (origin.pendingNavigation) {
      origin.pendingNavigation = false;
      page(tabId, 'library', origin.saved);
      throw new Error('The message port closed during the save navigation.');
    }
    return response;
  }
  page(MASTER, 'master');
  const master = tabs.get(MASTER);
  const host = async (command, payload = {}) => {
    if (command === 'read') return durable;
    if (command === 'write') { durable = clone(payload.snapshot); return { saved: true }; }
    if (command === 'push') return { delivered: true };
    if (command === 'worker.open') {
      assert.equal(durable.items.find(item => item.id === payload.itemId).status, 'opening');
      master.window.eval(adapterSource);
      const launch = (await send(MASTER, { namespace: 'wxvu.page', command: 'launchInfo', payload: {} })).result;
      assert.equal(launch.ready, true);
      assert.equal(launch.pageKind, 'video-picker');
      assert.equal(new URL(launch.launchUrl).origin, new URL(ADD_URL).origin);
      assert.deepEqual([...new URL(launch.launchUrl).searchParams], [...new URL(ADD_URL).searchParams]);
      const tabId = nextTabId++;
      const workerPage = page(tabId, 'add');
      workers.set(tabId, { itemId: payload.itemId, page: workerPage });
      peak = Math.max(peak, ++active);
      if (tabId === 103) thirdOpened.resolve();
      return { tabId };
    }
    if (command === 'worker.render') {
      const worker = workers.get(payload.tabId);
      assert(worker, 'render requests must target a registered upload worker');
      assert.equal(worker.itemId, payload.itemId, 'render requests must retain the worker item binding');
      assert.notEqual(payload.tabId, MASTER);
      const target = tabs.get(payload.tabId);
      assert(target);
      assert.equal(target.window.document.hidden, true);
      renderCalls.push({ tabId: payload.tabId, itemId: payload.itemId, elapsed });
      return target.bridge ? { supported: true, ...target.bridge.pulse() } : { supported: false, hidden: true };
    }
    if (command === 'worker.release') {
      const worker = workers.get(payload.tabId);
      assert(worker);
      assert.equal(worker.itemId, payload.itemId);
      assert.equal(payload.verified, false);
      assert.equal(tabs.get(payload.tabId).kind, 'library');
      assert.match(tabs.get(payload.tabId).$('tbody').textContent, /转码中/);
      assert.equal(durable.items.find(item => item.id === payload.itemId).status, 'saving');
      const beforeStop = worker.page.bridge.stats();
      assert.equal(beforeStop.assisted, 2, 'two hidden animation frames are required to apply each cover');
      assert.equal(beforeStop.pending, 0);
      worker.page.bridge.stop();
      assert.equal(worker.page.window.requestAnimationFrame, worker.page.nativeRequest);
      assert.equal(worker.page.frameJobs.size, 0, 'assisted frames cancel their corresponding native jobs');
      completedWorkers.push({ tabId: payload.tabId, page: worker.page, beforeStop });
      workers.delete(payload.tabId);
      events.push({ tabId: payload.tabId, name: 'released' });
      assert(tabs.has(payload.tabId), 'an unverified save page must remain open');
      active--;
      return { released: true };
    }
    if (command === 'tab.get') {
      const target = tabs.get(payload.tabId);
      assert(target);
      return { id: payload.tabId, url: target.window.location.href, status: 'complete', active: payload.tabId === activeTabId };
    }
    if (command === 'inject') {
      assert.deepEqual(payload.files, ['src/adapter.js']);
      tabs.get(payload.target.tabId).window.eval(adapterSource);
      return [];
    }
    if (command === 'page') return send(payload.tabId, payload.message);
    assert.fail(`unexpected browser command: ${command}`);
  };
  engine = new globalThis.WXVideoEngine({ host });
  t.after(async () => { await engine.handle('target.closed'); for (const dom of doms) dom.window.close(); });
  engine._wait = async milliseconds => {
    assert(++waits < 300, 'page workflow did not converge');
    if (attachments.length < 2) await firstTwoAttached.promise;
    elapsed += milliseconds;
    for (const target of tabs.values()) target.advance?.();
    await new Promise(resolve => setImmediate(resolve));
  };
  await engine.handle('init', { targetTabId: MASTER, sessionId: 'parallel-dom-session' });
  await engine.handle('configure', { concurrency: 2 });
  engine.transport.now = () => clockStart + elapsed;
  const inputs = [1, 2, 3].map(index => new File([`file bytes ${index}`], `并行视频 ${index}.mp4`, { type: 'video/mp4', lastModified: index }));
  await engine.queue.addFiles(inputs);
  await engine.handle('start');
  await engine._runTask;

  assert.deepEqual(engine.state().snapshot.items.map(item => item.status), ['uncertain', 'uncertain', 'uncertain'], engine.state().notice.text);
  assert.equal(peak, 2);
  assert.equal(active, 0);
  assert.equal(activeTabId, 999);
  assert.equal(workers.size, 0);
  assert.equal(completedWorkers.length, 3);
  assert.deepEqual([...tabs.keys()], [MASTER, 101, 102, 103]);
  assert.equal(tabs.get(MASTER), master);
  assert.equal(master.window.location.href, EDIT_URL);
  assert.equal(master.$('#article').value, '用户未保存的正文');
  assert(master.$('[role="dialog"]'));
  assert(pageCommands.filter(call => call.tabId === MASTER).every(call => call.command === 'launchInfo'));
  assert.equal(saved.length, 3);
  assert(events.findIndex(event => event.tabId === 102 && event.name === 'attached') < events.findIndex(event => event.tabId === 101 && event.name === 'save'));
  assert(events.findIndex(event => event.tabId === 103 && event.name === 'attached') < events.findIndex(event => event.tabId === 102 && event.name === 'save'));
  for (const tabId of [101, 102, 103]) {
    assert.deepEqual(events.filter(event => event.tabId === tabId).map(event => event.name),
      ['attached', 'cover-selected', 'cover-done', 'cover-frame-closed', 'cover-applied', 'original',
        ...(tabId === 102 ? [] : ['original-terms']), 'original-confirm', 'original-applied', 'agreement', 'save', 'released']);
    assert.equal(pageCommands.filter(call => call.tabId === tabId && call.command === 'save').length, 1);
    assert.equal(pageCommands.filter(call => call.tabId === tabId && call.command === 'attach').length, 1);
    assert(renderCalls.filter(call => call.tabId === tabId).length >= 2);
    const completed = completedWorkers.find(worker => worker.tabId === tabId);
    assert.equal(completed.page.bridge.stats().stopped, true);
    assert.equal(completed.page.window.document.hidden, true);
  }
  const transferred = await Promise.all(bytesRead);
  for (const [index, file] of inputs.entries()) {
    assert.equal(transferred[index].name, file.name);
    assert.deepEqual(transferred[index].bytes, Buffer.from(await file.arrayBuffer()));
  }
});
