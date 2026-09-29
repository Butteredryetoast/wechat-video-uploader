import test from 'node:test';
import assert from 'node:assert/strict';
import { File as NodeFile } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import '../src/queue.js';
import '../src/transport.js';

const fixture = await readFile(new URL('./fixtures/add-video.html', import.meta.url), 'utf8');
const adapterSource = await readFile(new URL('../src/adapter.js', import.meta.url), 'utf8');
const ADD_URL = 'https://mp.weixin.qq.com/cgi-bin/add-video?token=FIXTURE_TOKEN';
const LIBRARY_URL = 'https://mp.weixin.qq.com/cgi-bin/video-library?token=FIXTURE_TOKEN';
const TAB_ID = 17;
const EXTENSION_ID = 'integration-fixture-extension';
const cloneMessage = value => JSON.parse(JSON.stringify(value));

function cardDate(time) {
  const date = new Date(time);
  const pad = value => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function sampleFile(name, size, offset) {
  const bytes = Uint8Array.from({ length: size }, (_, index) => (index * 31 + offset) % 256);
  return { file: new NodeFile([bytes], name, { type: 'video/mp4', lastModified: 1720000000000 + offset }), bytes };
}

// This emulates the browser boundary, not the adapter. All page commands go
// through the real content-script message listener with Chrome JSON serialization.
function browserHarness(t, { failUploadOrdinal, beforeSave = () => {}, delayedRender = false, switchActiveTab = false, coverDialog = false } = {}) {
  const pages = [];
  const attachments = [];
  const saved = [];
  const commands = [];
  const navigations = [];
  const checkboxChanges = [];
  const checkboxClicks = [];
  const coverClicks = [];
  const coverDialogEvents = [];
  const apiCalls = [];
  const forbiddenClicks = [];
  const fileReads = [];
  let page;
  let clock = Date.now();
  let activeTabId = TAB_ID;

  function openPage(kind) {
    const dom = new JSDOM(kind === 'add' ? fixture : '<!doctype html><html><body><main><h1>视频素材</h1></main></body></html>', {
      runScripts: 'outside-only', url: kind === 'add' ? ADD_URL : LIBRARY_URL
    });
    const { window } = dom;
    const instance = { dom, kind, window, number: pages.length + 1, listeners: [], task: null, pending: false, pendingNavigation: false, tick: 0 };
    pages.push(instance);
    page = instance;
    // Transport and every navigated content-script context share one clock.
    window.Date.now = () => clock;
    window.HTMLElement.prototype.getClientRects = function () { return [{ width: 100, height: 24 }]; };
    const fileLists = new WeakMap();
    Object.defineProperty(window.HTMLInputElement.prototype, 'files', {
      configurable: true,
      get() { return fileLists.get(this) || []; },
      set(files) { fileLists.set(this, files); }
    });
    window.DataTransfer = class {
      files = [];
      items = { add: file => this.files.push(file) };
    };
    window.chrome = { runtime: { id: EXTENSION_ID, onMessage: { addListener(listener) { instance.listeners.push(listener); } } } };
    const $ = selector => window.document.querySelector(selector);
    instance.$ = $;

    if (kind === 'library') {
      for (const video of saved) {
        const card = window.document.createElement('article');
        const image = window.document.createElement('img');
        image.src = '/fixture-cover.jpg';
        const title = window.document.createElement('p');
        title.textContent = video.title;
        const duration = window.document.createElement('span');
        duration.textContent = '00:20';
        const date = window.document.createElement('span');
        date.textContent = cardDate(video.savedAt);
        card.append(image, title, duration, date);
        $('main').append(card);
      }
    } else {
      const coverSelected = () => Boolean($('#cover [aria-pressed="true"], #cover .select'));
      instance.syncSave = () => {
        $('#save').disabled = !/^上传(?:完成|成功)/.test($('#upload-state').textContent) ||
          !coverSelected() || !$('#original').checked || !$('#agreement').checked;
      };
      if (coverDialog) {
        const unrelatedDone = window.document.createElement('button');
        unrelatedDone.type = 'button';
        unrelatedDone.id = 'outside-done';
        unrelatedDone.textContent = '完成';
        unrelatedDone.addEventListener('click', () => forbiddenClicks.push('outside-done'));
        $('main').append(unrelatedDone);
        instance.openCoverDialog = () => {
          const dialog = window.document.createElement('section');
          dialog.className = 'weui-desktop-dialog';
          dialog.id = 'cover-editor';
          dialog.setAttribute('role', 'dialog');
          dialog.setAttribute('aria-modal', 'true');
          dialog.setAttribute('aria-labelledby', 'cover-dialog-title');
          dialog.innerHTML = `<h3 id="cover-dialog-title">编辑封面</h3>
            <div class="cover-crop"><canvas width="1920" height="1080"></canvas>
              <img src="/fixture-cover-0.jpg" alt="待裁剪封面"></div>
            <section><h4>封面预览</h4><img src="/fixture-cover-0.jpg" alt="封面预览">
              <label><input type="radio" name="cover-aspect" value="16:9" checked>视频消息封面（16:9）</label>
              <label><input type="radio" name="cover-aspect" value="1:1">正方形封面（1:1）</label>
              <input type="range" aria-label="封面缩放" value="35" min="0" max="100"></section>
            <footer><button type="button" id="cover-cancel">取消</button>
              <button type="button" id="cover-done" class="weui-desktop-btn_primary" disabled>完成</button></footer>`;
          instance.coverEditor = dialog;
          window.document.body.append(dialog);
          coverDialogEvents.push({ kind: 'opened', tick: instance.tick });
          instance.dialogReadyAt = instance.tick + 2;
          dialog.querySelector('#cover-cancel').addEventListener('click', () => forbiddenClicks.push('cover-cancel'));
          for (const input of dialog.querySelectorAll('input')) {
            input.addEventListener('input', () => forbiddenClicks.push('crop-input'));
            input.addEventListener('change', () => forbiddenClicks.push('crop-change'));
            input.addEventListener('click', () => forbiddenClicks.push('crop-option'));
          }
          for (const crop of dialog.querySelectorAll('canvas, .cover-crop img')) {
            for (const eventName of ['click', 'mousedown', 'pointerdown']) {
              crop.addEventListener(eventName, () => forbiddenClicks.push(`crop-${eventName}`));
            }
          }
          dialog.querySelector('#cover-done').addEventListener('click', () => {
            coverDialogEvents.push({ kind: 'done', tick: instance.tick });
            assert.equal(dialog.querySelector('#cover-done').disabled, false);
            assert.equal(dialog.querySelector('input[value="16:9"]').checked, true);
            assert.equal(dialog.querySelector('input[value="1:1"]').checked, false);
            assert.equal(dialog.querySelector('input[type="range"]').value, '35');
            instance.dialogCloseAt = instance.tick + 2;
          });
        };
      }
      instance.renderCover = () => {
        if ($('#cover img')) return;
        const group = window.document.createElement('div');
        const label = window.document.createElement('p');
        label.textContent = '推荐封面';
        group.append(label);
        for (let index = 0; index < 2; index++) {
          const button = window.document.createElement('button');
          button.type = 'button';
          if (!delayedRender) button.setAttribute('aria-pressed', 'false');
          const image = window.document.createElement('img');
          image.src = `/fixture-cover-${index}.jpg`;
          image.alt = `推荐封面 ${index + 1}`;
          button.append(image);
          button.addEventListener('click', () => {
            coverClicks.push({ page: instance.number, index });
            if (coverDialog) instance.dialogAt = instance.tick + 2;
            else if (delayedRender) instance.coverAt = instance.tick + 2;
            else button.setAttribute('aria-pressed', 'true');
            instance.syncSave();
          });
          group.append(button);
        }
        $('#cover').replaceChildren(group);
      };
      for (const checkbox of window.document.querySelectorAll('input[type="checkbox"]')) {
        checkbox.addEventListener('change', () => checkboxChanges.push({ page: instance.number, id: checkbox.id, checked: checkbox.checked }));
      }
      for (const id of ['original', 'agreement']) {
        $(`#${id}`).addEventListener('change', instance.syncSave);
        $(`#${id}`).addEventListener('click', event => {
          checkboxClicks.push({ page: instance.number, id, tick: instance.tick });
          if (delayedRender) {
            // Framework-backed controls can revert the native click until a
            // later response writes the confirmed checked state.
            event.preventDefault();
            instance[`${id}At`] = instance.tick + 2;
          }
        });
      }
      for (const id of ['preview', 'publish']) {
        $(`#${id}`).disabled = false;
        $(`#${id}`).addEventListener('click', () => forbiddenClicks.push(id));
      }
      $('#video-file').addEventListener('change', () => {
        const [file] = $('#video-file').files;
        assert(file instanceof window.File, 'the adapter must reconstruct a browser File after the JSON/base64 boundary');
        assert.equal($('#video-file').files.length, 1);
        attachments.push({ page: instance.number, name: file.name, size: file.size, type: file.type, lastModified: file.lastModified });
        fileReads.push(new Promise((resolve, reject) => {
          const reader = new window.FileReader();
          reader.onerror = () => reject(reader.error);
          reader.onload = () => resolve({ name: file.name, bytes: new Uint8Array(reader.result) });
          reader.readAsArrayBuffer(file);
        }));
        instance.uploadOrdinal = attachments.length;
        instance.pending = true;
        if (switchActiveTab) activeTabId = 98;
        if (delayedRender) $('#video-file').files = [];
        $('#upload-state').textContent = '上传中 20%';
        // The page initially derives its title from the selected file.
        $('#video-title').value = file.name.replace(/\.[^.]+$/, '');
      });
      $('#save').addEventListener('click', () => {
        beforeSave(instance.task);
        assert.equal($('#agreement').checked, true);
        assert.equal($('#original').checked, true);
        assert.equal(coverSelected(), true);
        assert.equal($('#danmaku').checked, true);
        assert.equal($('#video-title').value, instance.task.title);
        assert.match($('#upload-state').textContent, /^上传(?:完成|成功)/);
        saved.push({ ...instance.task, title: $('#video-title').value, savedAt: clock });
        instance.pendingNavigation = true;
      });
    }
    return instance;
  }

  openPage('add');
  t.after(() => { for (const entry of pages) entry.dom.window.close(); });
  const api = {
    tabs: {
      async get(id) {
        assert.equal(id, TAB_ID);
        apiCalls.push({ method: 'get', id, activeTabId });
        return { id, url: page.window.location.href, status: 'complete', active: id === activeTabId };
      },
      async update(id, update) {
        assert.equal(id, TAB_ID);
        assert.equal(Object.hasOwn(update, 'active'), false, 'background uploads must not activate the target tab');
        assert.equal(Object.hasOwn(update, 'highlighted'), false);
        apiCalls.push({ method: 'update', id, activeTabId });
        assert.equal(update.url, ADD_URL, 'only the bound adding page may be reopened');
        navigations.push({ from: page.kind, to: 'add' });
        openPage('add');
        return this.get(id);
      },
      async sendMessage(id, message) {
        assert.equal(id, TAB_ID);
        apiCalls.push({ method: 'sendMessage', id, activeTabId });
        const sent = cloneMessage(message);
        const origin = page;
        assert.equal(origin.listeners.length, 1, 'reinjection must keep one real message handler');
        const command = { command: sent.command, page: origin.number, id: sent.payload?.id, index: sent.payload?.index,
          bytes: sent.command === 'chunk' ? Buffer.from(sent.payload.data, 'base64').length : undefined };
        commands.push(command);
        if (sent.command === 'begin') origin.task = sent.payload;
        let response;
        origin.listeners[0](sent, { id: EXTENSION_ID }, value => { response = cloneMessage(value); });
        assert(response, `content script must answer ${sent.command}`);
        if (['status', 'prepare'].includes(sent.command)) command.result = response.result;
        if (origin.pendingNavigation) {
          origin.pendingNavigation = false;
          navigations.push({ from: 'add', to: 'library' });
          openPage('library');
          // Saving can destroy its own response channel. Transport must verify
          // the new page instead of treating this as permission to click twice.
          throw new Error('The message port closed before a response was received.');
        }
        return response;
      },
      async query() { assert.fail('upload routing must not follow the currently active tab'); },
      async highlight() { assert.fail('background uploads must not highlight a tab'); }
    },
    windows: { async update() { assert.fail('background uploads must not focus a window'); } },
    scripting: {
      async executeScript({ target, files }) {
        assert.equal(target.tabId, TAB_ID);
        apiCalls.push({ method: 'executeScript', id: target.tabId, activeTabId });
        assert.deepEqual(files, ['src/adapter.js']);
        page.window.eval(adapterSource);
      }
    }
  };
  const transport = new globalThis.WXVideoTransport({
    targetTabId: TAB_ID, api, now: () => clock,
    wait: async milliseconds => {
      clock += milliseconds;
      if (page.kind !== 'add' || !page.pending) return;
      page.tick++;
      const $ = page.$;
      if (page.uploadOrdinal === failUploadOrdinal) {
        page.pending = false;
        $('#upload-state').textContent = '上传失败：请重新上传';
        $('#save').disabled = true;
        return;
      }
      if (!delayedRender) {
        page.pending = false;
        $('#upload-state').textContent = '上传完成';
        page.renderCover();
        // A later reactive render can restore the filename-derived title.
        $('#video-title').value = page.task.name.replace(/\.[^.]+$/, '');
      } else {
        if (page.tick >= 2) $('#upload-state').textContent = '上传成功，视频转码完成';
        if (page.tick === 3) {
          const filename = page.window.document.createElement('p');
          filename.textContent = page.task.name;
          filename.id = 'selected-file-name';
          $('#upload-row').append(filename);
        }
        if (page.tick === 4) {
          page.renderCover();
          $('#video-title').value = page.task.name.replace(/\.[^.]+$/, '');
        }
        if (page.coverAt && page.tick >= page.coverAt) {
          $('#cover button').classList.add('select');
          if (coverDialog) coverDialogEvents.push({ kind: 'applied', tick: page.tick });
          page.coverAt = null;
        }
        if (page.dialogAt && page.tick >= page.dialogAt) {
          page.openCoverDialog();
          page.dialogAt = null;
        }
        if (page.dialogReadyAt && page.tick >= page.dialogReadyAt) {
          $('#cover-done').disabled = false;
          coverDialogEvents.push({ kind: 'ready', tick: page.tick });
          page.dialogReadyAt = null;
        }
        if (page.dialogCloseAt && page.tick >= page.dialogCloseAt) {
          page.coverEditor.remove();
          coverDialogEvents.push({ kind: 'closed', tick: page.tick });
          page.coverAt = page.tick + 1;
          page.dialogCloseAt = null;
        }
        for (const id of ['original', 'agreement']) {
          if (page[`${id}At`] && page.tick >= page[`${id}At`]) {
            $(`#${id}`).checked = true;
            $(`#${id}`).dispatchEvent(new page.window.Event('change', { bubbles: true }));
            page[`${id}At`] = null;
          }
        }
      }
      page.syncSave();
    }
  });
  transport.uploadTimeout = coverDialog ? 35000 : delayedRender ? 20000 : 8000;
  transport.verifyTimeout = 4500;
  return { transport, attachments, saved, commands, navigations, checkboxChanges, checkboxClicks, coverClicks,
    coverDialogEvents, forbiddenClicks, fileReads, pages, apiCalls, activeTab: () => activeTabId };
}

test('two Node Files cross the real transport, upload sequentially and verify after page navigation', { timeout: 20000 }, async t => {
  let durable;
  const browser = browserHarness(t, { beforeSave(task) {
    assert.equal(durable.items.find(item => item.id === task.id).status, 'saving', 'the durable saving checkpoint precedes the page save click');
  } });
  const queue = new globalThis.WXVideoQueue({ persist: async snapshot => { durable = cloneMessage(snapshot); } });
  // First file deliberately crosses a transport chunk boundary and contains all
  // byte values, so filename/size-only mocks cannot conceal transfer corruption.
  const input = [sampleFile('01 原始标题.mp4', 384 * 1024 + 37, 11), sampleFile('02 原始标题.mp4', 4099, 29)];
  const ids = await queue.addFiles(input.map(entry => entry.file));
  await queue.updateItem(ids[0], { title: '第一段 · 自定义素材标题' });
  await queue.updateItem(ids[1], { title: '第二段 · 自定义素材标题' });
  const inspected = await browser.transport.inspect();
  assert.equal(inspected.ready, true);
  await queue.start(browser.transport);

  assert.deepEqual(queue.snapshot().items.map(item => item.status), ['succeeded', 'succeeded']);
  assert.deepEqual(browser.attachments.map(file => file.name), input.map(entry => entry.file.name));
  assert.deepEqual(browser.saved.map(video => video.title), ['第一段 · 自定义素材标题', '第二段 · 自定义素材标题']);
  assert.deepEqual(browser.navigations, [{ from: 'add', to: 'library' }, { from: 'library', to: 'add' }, { from: 'add', to: 'library' }]);
  assert.deepEqual(browser.checkboxChanges.map(event => [event.id, event.checked]), [['original', true], ['agreement', true], ['original', true], ['agreement', true]]);
  assert.deepEqual(browser.coverClicks.map(event => event.index), [0, 0]);
  assert.deepEqual(browser.forbiddenClicks, []);
  assert.equal(browser.commands.filter(command => command.command === 'save').length, 2, 'navigation must never cause a duplicate save');
  assert.equal(browser.commands.filter(command => command.command === 'fillTitle').length, 2, 'reactive filename resets must be repaired before saving');
  for (let index = 0; index < input.length; index++) {
    assert.deepEqual(browser.attachments[index], {
      page: index === 0 ? 1 : 3, name: input[index].file.name, size: input[index].file.size,
      type: input[index].file.type, lastModified: input[index].file.lastModified
    });
  }
  const firstChunks = browser.commands.filter(command => command.command === 'chunk' && command.id === ids[0]);
  assert.deepEqual(firstChunks.map(chunk => [chunk.index, chunk.bytes]), [[0, 384 * 1024], [1, 37]]);
  const reconstructed = await Promise.all(browser.fileReads);
  for (let index = 0; index < input.length; index++) {
    assert.equal(reconstructed[index].name, input[index].file.name);
    assert.deepEqual(Buffer.from(reconstructed[index].bytes), Buffer.from(input[index].bytes));
  }
  assert.equal(browser.transport.lastVerified, true);
  assert.equal(browser.pages.at(-1).kind, 'library');
  assert(browser.pages.at(-1).$('main').textContent.includes(cardDate(browser.saved.at(-1).savedAt)));
});

test('failure uploading the second file never saves it or starts the third file', { timeout: 20000 }, async t => {
  const browser = browserHarness(t, { failUploadOrdinal: 2 });
  const queue = new globalThis.WXVideoQueue();
  const input = [sampleFile('first.mp4', 31, 1), sampleFile('second.mp4', 43, 2), sampleFile('third.mp4', 57, 3)];
  const ids = await queue.addFiles(input.map(entry => entry.file));
  await queue.start(browser.transport);
  const result = queue.snapshot();

  assert.deepEqual(result.items.map(item => item.status), ['succeeded', 'failed', 'queued']);
  assert.match(result.items[1].error, /失败/, 'failure must retain a readable page reason, not the string "true"');
  assert.equal(result.running, false);
  assert.equal(result.pauseRequested, true);
  assert.deepEqual(browser.attachments.map(file => file.name), ['first.mp4', 'second.mp4']);
  assert.deepEqual(browser.saved.map(video => video.name), ['first.mp4']);
  assert.deepEqual(browser.commands.filter(command => command.command === 'save').map(command => command.id), [ids[0]]);
  assert.deepEqual(browser.commands.filter(command => command.command === 'begin').map(command => command.id), [ids[0], ids[1]]);
  assert.deepEqual(browser.checkboxChanges.map(event => [event.id, event.checked]), [['original', true], ['agreement', true]]);
  assert.deepEqual(browser.forbiddenClicks, []);
  assert.equal(browser.pages.at(-1).kind, 'add');
  await Promise.all(browser.fileReads);
});

test('cleared file input and delayed upload, cover, original and agreement states finish once while another tab is active', { timeout: 20000 }, async t => {
  let durable;
  const browser = browserHarness(t, { delayedRender: true, switchActiveTab: true, beforeSave(task) {
    assert.equal(durable.items.find(item => item.id === task.id).status, 'saving');
  } });
  const queue = new globalThis.WXVideoQueue({ persist: async snapshot => { durable = cloneMessage(snapshot); } });
  const input = sampleFile('延迟就绪测试.mp4', 2057, 7);
  const [id] = await queue.addFiles([input.file]);
  await queue.updateItem(id, { title: '异步页面 · 入库验证' });
  await queue.start(browser.transport);
  const result = queue.snapshot();
  assert.equal(result.items[0].status, 'succeeded', result.items[0].error || undefined);
  assert.equal(browser.attachments.length, 1);
  assert.equal(browser.saved.length, 1);
  assert.equal(browser.saved[0].title, '异步页面 · 入库验证');
  assert.equal(browser.commands.filter(command => command.command === 'attach').length, 1);
  assert.equal(browser.commands.filter(command => command.command === 'save').length, 1);
  assert(browser.commands.filter(command => command.command === 'prepare').length >= 3);
  const statusResults = browser.commands.filter(command => command.command === 'status').map(command => command.result);
  assert(statusResults.some(state => state.pending && !state.uploadComplete && !state.error));
  assert(statusResults.some(state => state.uploadComplete && state.needsPreparation && !state.error));
  assert.deepEqual(browser.coverClicks.map(event => event.index), [0], 'only the first recommended cover is clicked, once');
  assert.deepEqual(browser.checkboxClicks.map(event => event.id), ['original', 'agreement'], 'pending framework state must not cause toggle retries');
  assert.deepEqual(browser.checkboxChanges.map(event => [event.id, event.checked]), [['original', true], ['agreement', true]]);
  assert.equal(browser.pages[0].$('#video-file').files.length, 0);
  assert.equal(browser.pages[0].$('#cover button').classList.contains('select'), true);
  assert.match(browser.pages[0].$('#upload-state').textContent, /上传成功，/);
  assert.equal(browser.pages[0].$('#selected-file-name').textContent, input.file.name);
  assert.equal(browser.activeTab(), 98);
  assert(browser.apiCalls.some(call => call.activeTabId === 98));
  assert(browser.apiCalls.every(call => call.id === TAB_ID));
  assert.deepEqual(browser.forbiddenClicks, []);
  const [read] = await Promise.all(browser.fileReads);
  assert.deepEqual(Buffer.from(read.bytes), Buffer.from(input.bytes));
});

test('delayed cover crop dialog applies the default crop with one scoped Done click before saving', { timeout: 30000 }, async t => {
  let durable;
  const browser = browserHarness(t, { delayedRender: true, coverDialog: true, switchActiveTab: true, beforeSave(task) {
    assert.equal(durable.items.find(item => item.id === task.id).status, 'saving');
    assert.equal(browser.pages[0].$('#cover-editor'), null, 'saving must wait until the cover dialog has closed');
  } });
  const queue = new globalThis.WXVideoQueue({ persist: async snapshot => { durable = cloneMessage(snapshot); } });
  const input = sampleFile('封面裁剪回归.mp4', 1031, 13);
  await queue.addFiles([input.file]);
  await queue.start(browser.transport);
  const result = queue.snapshot();
  assert.equal(result.items[0].status, 'succeeded', result.items[0].error || undefined);
  assert.equal(browser.saved.length, 1);
  assert.equal(browser.attachments.length, 1);
  assert.equal(browser.commands.filter(command => command.command === 'save').length, 1);
  assert.equal(browser.commands.filter(command => command.command === 'attach').length, 1);
  assert.deepEqual(browser.coverClicks.map(event => event.index), [0]);
  assert.deepEqual(browser.coverDialogEvents.map(event => event.kind), ['opened', 'ready', 'done', 'closed', 'applied']);
  const [opened, ready, done, closed, applied] = browser.coverDialogEvents;
  assert(ready.tick > opened.tick && done.tick >= ready.tick);
  assert(closed.tick > done.tick && applied.tick > closed.tick);
  assert(browser.checkboxClicks.every(event => event.tick >= applied.tick));
  const editor = browser.pages[0].coverEditor;
  assert.equal(editor.querySelector('input[value="16:9"]').checked, true);
  assert.equal(editor.querySelector('input[value="1:1"]').checked, false);
  assert.equal(editor.querySelector('input[type="range"]').value, '35');
  assert.equal(editor.querySelector('canvas').width, 1920);
  assert.equal(editor.querySelector('canvas').height, 1080);
  assert.deepEqual(browser.forbiddenClicks, [], 'outside Done, Cancel, publishing and crop controls must be untouched');
  assert.equal(browser.activeTab(), 98);
  assert(browser.apiCalls.every(call => call.id === TAB_ID));
  const [read] = await Promise.all(browser.fileReads);
  assert.deepEqual(Buffer.from(read.bytes), Buffer.from(input.bytes));
});
