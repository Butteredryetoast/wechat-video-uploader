import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

const source = await readFile(new URL('../src/adapter.js', import.meta.url), 'utf8');
const cardDate = (time = Date.now()) => {
  const date = new Date(time);
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
};
const fixtureWindows = new WeakMap();
const fixture = await readFile(new URL('./fixtures/add-video.html', import.meta.url), 'utf8');
function setup(html = fixture) {
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://mp.weixin.qq.com/cgi-bin/fake?token=SECRET_TOKEN' });
  const { window } = dom;
  let hidden = false;
  Object.defineProperties(window.document, {
    hidden: { configurable: true, get: () => hidden },
    visibilityState: { configurable: true, get: () => hidden ? 'hidden' : 'visible' }
  });
  const setHidden = (value, { dispatch = true } = {}) => {
    hidden = value;
    if (dispatch) window.document.dispatchEvent(new window.Event('visibilitychange'));
  };
  window.HTMLElement.prototype.getClientRects = function () { return [{ width: 100, height: 24 }]; };
  // JSDOM has File but no DataTransfer: emulate the native FileList assignment.
  const files = new WeakMap();
  Object.defineProperty(window.HTMLInputElement.prototype, 'files', {
    configurable: true, get() { return files.get(this) || []; }, set(value) { files.set(this, value); }
  });
  window.DataTransfer = class {
    files = [];
    items = { add: (file) => this.files.push(file) };
  };
  const listeners = [];
  window.chrome = { runtime: { id: 'test-extension', onMessage: { addListener(fn) { listeners.push(fn); } } } };
  window.eval(source);
  const $ = (selector) => window.document.querySelector(selector);
  const api = window.WXVideoAdapter;
  fixtureWindows.set(api, window);
  const meta = { id: 'test-video', name: 'demo.mp4', size: 4, type: 'video/mp4', lastModified: 100, title: '测试视频' };
  const prepare = () => {
    api.begin(meta);
    api.chunk({ id: meta.id, index: 0, data: 'AQIDBA==' });
    api.attach({ id: meta.id });
  };
  const complete = () => {
    $('#upload-state').textContent = '上传完成';
    $('#cover').innerHTML = '<button type="button" aria-pressed="false"><img src="cover.jpg" alt="推荐封面一"></button>';
    $('#cover button').addEventListener('click', () => $('#cover button').setAttribute('aria-pressed', 'true'));
    $('#save').disabled = !$('#agreement').checked;
  };
  $('#agreement')?.addEventListener('change', () => { $('#save').disabled = $('#upload-state').textContent !== '上传完成' || !$('#agreement').checked; });
  return { dom, window, $, api, meta, prepare, complete, listeners, setHidden };
}

// Advance a fixture clock between genuine preparation polls; no page state or
// result is faked. This models the grace period for a delayed original notice.
function settlePreparation(api, meta) {
  const window = fixtureWindows.get(api);
  const previousNow = window.Date.now;
  let now = previousNow();
  window.Date.now = () => now;
  try {
    for (let poll = 0; poll < 8; poll++) {
      const result = api.prepare({ id: meta.id });
      if (result.prepared) return result;
      now += 2000;
    }
    assert.fail('preparation did not converge');
  } finally {
    window.Date.now = previousNow;
  }
}

test('recognizes screenshot form and omits private URL and field values from diagnostics', () => {
  const { api, $, dom } = setup();
  const state = api.inspect();
  assert.equal(state.ready, true);
  assert.equal(state.needsAgreement, true);
  assert.equal(state.hasUploadInput, true);
  assert.equal(state.titleMaxLength, 64);
  $('#video-title').value = 'PRIVATE_TITLE';
  const diagnostic = JSON.stringify(api.diagnostics());
  assert(!diagnostic.includes('SECRET_TOKEN'));
  assert(!diagnostic.includes('PRIVATE_TITLE'));
  assert(!diagnostic.includes('mp.weixin.qq.com'));
  assert.equal(api.inspect().ready, false);
  dom.window.close();
});

test('ordered file transfer and native title events attach exactly the requested video', () => {
  const { api, $, meta, prepare, dom } = setup();
  const events = [];
  $('#video-title').addEventListener('input', () => events.push('title'));
  $('#video-file').addEventListener('change', () => events.push('file'));
  prepare();
  assert.equal($('#video-file').files.length, 1);
  assert.equal($('#video-file').files[0].name, meta.name);
  assert.equal($('#video-file').files[0].size, meta.size);
  assert.equal($('#video-title').value, meta.title);
  assert.deepEqual(events, ['file', 'title']);
  assert.equal(api.status({ id: meta.id }).uploadComplete, false);
  assert.throws(() => api.attach({ id: meta.id }), /已交给页面/);
  dom.window.close();
});

test('chunk sequence, sizes, unfinished transfer and duplicate begin are rejected', () => {
  const { api, meta, dom } = setup();
  api.begin(meta);
  assert.throws(() => api.chunk({ id: meta.id, index: 1, data: 'AQIDBA==' }), /顺序/);
  assert.throws(() => api.chunk({ id: meta.id, index: 0, data: 'AQIDBAUG' }), /大小/);
  assert.throws(() => api.chunk({ id: meta.id, index: 0, data: '**' }), /格式/);
  assert.throws(() => api.attach({ id: meta.id }), /尚未完整/);
  assert.throws(() => api.begin({ ...meta, id: 'second' }), /已有视频任务/);
  dom.window.close();
});

test('refuses to overwrite user-entered title or already selected file', () => {
  for (const modify of [($) => { $('#video-title').value = '用户填写'; }, ($) => { $('#video-file').files = [{ name: 'user.mp4' }]; }]) {
    const { api, $, meta, dom } = setup();
    modify($);
    assert.throws(() => api.begin(meta), /已有标题或视频/);
    dom.window.close();
  }
  const { api, $, meta, dom } = setup();
  api.begin(meta);
  api.chunk({ id: meta.id, index: 0, data: 'AQIDBA==' });
  $('#video-title').value = '上传过程中用户填写';
  assert.throws(() => api.attach({ id: meta.id }), /已有标题或视频/);
  dom.window.close();
});

test('cannot save based on elapsed time, file assignment, initial future-tense text or cover alone', () => {
  const { api, $, meta, prepare, dom } = setup();
  prepare();
  $('#cover').innerHTML = '<img src="preview.jpg">';
  $('#save').disabled = false;
  api.agree({ id: meta.id });
  assert.equal(api.status({ id: meta.id }).uploadComplete, false);
  assert.throws(() => api.save({ id: meta.id }), /尚未识别/);
  dom.window.close();
});

test('completion requires explicit success and asset evidence; active progress still blocks save', () => {
  const { api, $, meta, prepare, complete, dom } = setup();
  prepare();
  complete();
  assert.equal(api.status({ id: meta.id }).uploadComplete, true);
  assert.equal(api.status({ id: meta.id }).needsAgreement, true);
  assert.equal(api.status({ id: meta.id }).readyToSave, false);
  $('#upload-state').insertAdjacentHTML('beforeend', '<progress max="100" value="50"></progress>');
  assert.equal(api.status({ id: meta.id }).busy, true);
  assert.equal(api.status({ id: meta.id }).uploadComplete, false);
  $('#upload-state progress').remove();
  settlePreparation(api, meta);
  assert.equal(api.status({ id: meta.id }).readyToSave, true);
  dom.window.close();
});

test('agreement toggles only service-rules checkbox and is idempotent', () => {
  const { api, $, meta, prepare, dom } = setup();
  prepare();
  let changes = 0;
  $('#agreement').addEventListener('change', () => changes++);
  api.agree({ id: meta.id });
  api.agree({ id: meta.id });
  assert.equal($('#agreement').checked, true);
  assert.equal($('#original').checked, false);
  assert.equal($('#danmaku').checked, true);
  assert.equal(changes, 1);
  dom.window.close();
});

test('clicks precise save once and never preview or save-and-publish', () => {
  const { api, $, meta, prepare, complete, dom } = setup();
  prepare(); complete(); settlePreparation(api, meta);
  const clicks = [];
  for (const id of ['save', 'publish', 'preview']) {
    $(`#${id}`).disabled = false;
    $(`#${id}`).addEventListener('click', () => clicks.push(id));
  }
  assert.equal(api.save({ id: meta.id }).clicked, true);
  assert.deepEqual(clicks, ['save']);
  assert.throws(() => api.save({ id: meta.id }), /已经点击保存/);
  assert.equal(api.verify({ id: meta.id }).verified, false);
  $('#upload-state').textContent = '保存成功';
  assert.equal(api.verify({ id: meta.id }).verified, true);
  dom.window.close();
});

test('changed title, changed file, failed upload, unchecked terms and ambiguous save all prevent save', () => {
  for (const mutate of [
    ($) => { $('#video-title').value = 'different'; },
    ($) => { $('#video-file').files = []; },
    ($) => { $('#upload-state').textContent = '上传失败'; },
    ($) => { $('#agreement').checked = false; },
    ($) => { $('#save').insertAdjacentHTML('afterend', '<button type="button">保存</button>'); }
  ]) {
    const { api, $, meta, prepare, complete, dom } = setup();
    prepare(); complete(); settlePreparation(api, meta);
    mutate($);
    assert.equal(api.status({ id: meta.id }).readyToSave, false);
    assert.throws(() => api.save({ id: meta.id }));
    dom.window.close();
  }
});

test('ambiguous file/title/agreement controls cannot be silently chosen', () => {
  for (const markup of [
    '<input type="file" accept="video/*" id="second-file">',
    '<label for="second-title">标题</label><input type="text" id="second-title">',
    '<label><input type="checkbox">我已阅读并同意《公众平台视频上传服务规则》</label>'
  ]) {
    const { api, $, meta, dom } = setup();
    if (markup.includes('second-file')) $('#video-file').insertAdjacentHTML('afterend', markup);
    else $('form').insertAdjacentHTML('beforeend', markup);
    assert.equal(api.inspect().ready, false);
    assert.throws(() => api.begin(meta));
    dom.window.close();
  }
});

test('image-only file controls are never selected', () => {
  const { api, $, dom } = setup();
  $('#video-file').accept = 'image/*';
  assert.equal(api.inspect().hasUploadInput, false);
  dom.window.close();
});

test('material verification rejects body title and navigation alone; requires one credible card', () => {
  const { api, $, meta, prepare, complete, dom } = setup();
  prepare(); complete(); settlePreparation(api, meta); api.save({ id: meta.id });
  $('main').innerHTML = `<h1>视频素材</h1><p>${meta.title}</p>`;
  assert.equal(api.verify({ id: meta.id }).verified, false);
  $('main').innerHTML = `<h1>视频素材</h1><article><img src="new-video.jpg"><p>${meta.title}</p><span>00:20</span><span>${cardDate()}</span></article>`;
  assert.equal(api.verify({ id: meta.id }).verified, true);
  dom.window.close();
});

test('verification after reinjection accepts a material card but not stale success toast', () => {
  const { api, $, meta, dom } = setup();
  $('main').innerHTML = '<div role="status">保存成功</div>';
  assert.equal(api.verify({ id: meta.id, title: meta.title, savedAt: Date.now() }).verified, false);
  $('main').innerHTML = `<h1>视频素材</h1><article><img src="cover.jpg"><p>${meta.title}</p><span>00:20</span><span>${cardDate()}</span></article>`;
  assert.equal(api.verify({ id: meta.id, title: meta.title, savedAt: Date.now() }).verified, true);
  dom.window.close();
});

test('message API only accepts same-extension messages and injection does not duplicate registration', () => {
  const { window, listeners, dom } = setup();
  window.eval(source);
  assert.equal(listeners.length, 1);
  let response;
  const send = (command, sender = { id: 'test-extension' }) => listeners[0]({ namespace: 'wxvu.page', command }, sender, (value) => { response = value; });
  send('inspect', { id: 'unknown-extension' });
  assert.equal(response, undefined);
  send('inspect');
  assert.equal(response.ok, true);
  assert.equal(response.result.pageKind, 'add-video');
  send('toString');
  assert.equal(response.ok, false);
  dom.window.close();
});

test('hidden uploading/error placeholders do not block a completed upload', () => {
  const { api, $, meta, prepare, complete, dom } = setup();
  prepare(); complete(); settlePreparation(api, meta);
  $('form').insertAdjacentHTML('beforeend', '<div hidden><span>上传中 20%</span><div>上传失败</div></div>');
  assert.equal(api.status({ id: meta.id }).readyToSave, true);
  dom.window.close();
});

test('stale save-success toast from before the upload does not verify this item', () => {
  const { api, $, meta, prepare, complete, dom } = setup();
  $('form').insertAdjacentHTML('beforeend', '<p role="status">保存成功</p>');
  prepare(); complete(); settlePreparation(api, meta); api.save({ id: meta.id });
  assert.equal(api.verify({ id: meta.id }).verified, false);
  dom.window.close();
});

test('title length and non-video MIME types are rejected before changing form', () => {
  const { api, $, meta, dom } = setup();
  assert.throws(() => api.begin({ ...meta, title: '字'.repeat(65) }), /64/);
  assert.throws(() => api.begin({ ...meta, type: 'image/png' }), /只能选择视频/);
  assert.equal($('#video-title').value, '');
  dom.window.close();
});

test('supports explicit ARIA service-rules checkbox while preserving other toggles', () => {
  const { api, $, meta, prepare, complete, dom } = setup();
  $('#agreement').outerHTML = '<span id="agreement" role="checkbox" tabindex="0" aria-checked="false" aria-label="我已阅读并同意《公众平台视频上传服务规则》"></span>';
  $('#agreement').addEventListener('click', () => $('#agreement').setAttribute('aria-checked', 'true'));
  prepare(); complete(); api.agree({ id: meta.id });
  assert.equal($('#agreement').getAttribute('aria-checked'), 'true');
  assert.equal($('#original').checked, false);
  assert.equal($('#danmaku').checked, true);
  dom.window.close();
});

test('title appearing separately from a dated video card cannot verify', () => {
  const { api, $, meta, dom } = setup();
  $('main').innerHTML = `<h1>视频素材</h1><p>${meta.title}</p><article><img src="old.jpg"><p>另一视频</p><span>00:20</span><span>${cardDate()}</span></article>`;
  assert.equal(api.verify({ id: meta.id, title: meta.title, savedAt: Date.now() }).verified, false);
  dom.window.close();
});

test('material card verification requires savedAt, exact title and a recent timestamp', () => {
  const { api, $, meta, dom } = setup();
  const savedAt = Date.now();
  const card = (title, time) => `<article><img src="cover.jpg"><p>${title}</p><span>00:20</span><span>${cardDate(time)}</span></article>`;
  $('main').innerHTML = `<h1>视频素材</h1>${card(meta.title, savedAt)}`;
  assert.equal(api.verify({ id: meta.id, title: meta.title }).verified, false);
  assert.equal(api.verify({ id: meta.id, title: meta.title, savedAt }).verified, true);
  $('main').innerHTML = `<h1>视频素材</h1>${card(meta.title, savedAt - 2 * 60000)}`;
  assert.equal(api.verify({ id: meta.id, title: meta.title, savedAt }).verified, false);
  $('main').innerHTML = `<h1>视频素材</h1>${card(meta.title, savedAt + 3 * 60000)}`;
  assert.equal(api.verify({ id: meta.id, title: meta.title, savedAt }).verified, false);
  $('main').innerHTML = `<h1>视频素材</h1>${card(`${meta.title} extra`, savedAt)}`;
  assert.equal(api.verify({ id: meta.id, title: meta.title, savedAt }).verified, false);
  dom.window.close();
});

test('duplicate exact-title cards require manual verification even when one is new', () => {
  const { api, $, meta, dom } = setup();
  const savedAt = Date.now();
  $('main').innerHTML = `<h1>视频素材</h1>${[savedAt, savedAt - 86400000].map((time) => `<article><img src="cover.jpg"><p>${meta.title}</p><span>00:20</span><span>${cardDate(time)}</span></article>`).join('')}`;
  const result = api.verify({ id: meta.id, title: meta.title, savedAt });
  assert.equal(result.verified, false);
  assert.match(result.reason, /多个同名/);
  dom.window.close();
});

test('timestamp within the save minute is accepted and previous minute is rejected', () => {
  const { api, $, meta, dom } = setup();
  const savedAt = Date.now();
  const minuteStart = Math.floor(savedAt / 60000) * 60000;
  const render = (time) => { $('main').innerHTML = `<h1>视频素材</h1><article><img src="cover.jpg"><p>${meta.title}</p><span>00:20</span><span>${cardDate(time)}</span></article>`; };
  render(minuteStart);
  assert.equal(api.verify({ id: meta.id, title: meta.title, savedAt }).verified, true);
  render(minuteStart - 60000);
  assert.equal(api.verify({ id: meta.id, title: meta.title, savedAt }).verified, false);
  dom.window.close();
});

test('uploader clearing/replacing input requires exact filename and independent completion evidence', () => {
  for (const replace of [false, true]) {
    const { api, $, meta, prepare, complete, dom } = setup();
    prepare(); complete();
    if (replace) $('#video-file').outerHTML = '<input id="video-file" type="file" accept="video/*" style="display:none">';
    else $('#video-file').files = [];
    assert.equal(api.status({ id: meta.id }).error, null);
    assert.equal(api.status({ id: meta.id }).pending, true);
    $('#upload-state').insertAdjacentHTML('afterend', `<p>${meta.name}</p>`);
    assert.equal(api.status({ id: meta.id }).uploadComplete, true);
    assert.equal(api.status({ id: meta.id }).error, null);
    $('#cover').innerHTML = '';
    assert.equal(api.status({ id: meta.id }).error, null);
    assert.equal(api.status({ id: meta.id }).pending, true);
    dom.window.close();
  }
});

test('cleared input with exact filename and active upload can continue waiting', () => {
  const { api, $, meta, prepare, dom } = setup();
  prepare();
  $('#video-file').files = [];
  $('#upload-state').innerHTML = `<span>${meta.name}</span><span>上传中 20%</span>`;
  const result = api.status({ id: meta.id });
  assert.equal(result.uploadComplete, false);
  assert.equal(result.busy, true);
  assert.equal(result.error, null);
  dom.window.close();
});

test('sets custom title after synchronous native uploader default and resynchronizes later default', () => {
  const { api, $, meta, prepare, complete, dom } = setup();
  $('#video-file').addEventListener('change', () => { $('#video-title').value = 'demo'; });
  prepare();
  assert.equal($('#video-title').value, meta.title);
  complete();
  $('#video-title').value = 'demo';
  assert.equal(api.status({ id: meta.id }).titleNeedsSync, true);
  assert.equal(api.status({ id: meta.id }).error, null);
  api.fillTitle({ id: meta.id });
  assert.equal($('#video-title').value, meta.title);
  assert.equal(api.status({ id: meta.id }).titleNeedsSync, false);
  $('#video-title').value = '用户重新填写的标题';
  assert.equal(typeof api.status({ id: meta.id }).error, 'string');
  assert.throws(() => api.fillTitle({ id: meta.id }), /页面标题已被修改/);
  dom.window.close();
});

test('unrelated success toast present immediately before save does not prove new save succeeded', () => {
  const { api, $, meta, prepare, complete, dom } = setup();
  prepare(); complete(); settlePreparation(api, meta);
  $('form').insertAdjacentHTML('beforeend', '<p role="status">保存成功</p>');
  api.save({ id: meta.id });
  assert.equal(api.verify({ id: meta.id }).verified, false);
  dom.window.close();
});

test('recognizes screenshot Chinese comma success while cleared input and filename updates remain pending', () => {
  const { api, $, meta, prepare, dom } = setup();
  prepare();
  $('#video-file').files = [];
  let state = api.status({ id: meta.id });
  assert.equal(state.error, null);
  assert.equal(state.pending, true);
  assert.equal(state.uploadComplete, false);
  $('#upload-state').textContent = '视频上传成功，你可以继续编辑其它信息保存提交';
  $('#cover').innerHTML = '<div class="cover-choice" style="background-image: url(cover.jpg)"></div>';
  assert.equal(api.status({ id: meta.id }).uploadComplete, false);
  $('#upload-state').insertAdjacentHTML('afterend', `<p>${meta.name}</p>`);
  state = api.status({ id: meta.id });
  assert.equal(state.error, null);
  assert.equal(state.uploadComplete, true);
  assert.equal(state.needsPreparation, true);
  assert.equal(state.readyToSave, false);
  $('#cover .cover-choice').addEventListener('click', (event) => event.currentTarget.classList.add('select'));
  settlePreparation(api, meta);
  $('#save').disabled = false;
  assert.equal(api.status({ id: meta.id }).preparationReady, true);
  assert.equal(api.status({ id: meta.id }).readyToSave, true);
  dom.window.close();
});

test('owned form inspect identifies active upload instead of reporting user prefilled data', () => {
  const { api, meta, prepare, dom } = setup();
  prepare();
  const state = api.inspect();
  assert.equal(state.ownedTransfer, true);
  assert.equal(state.activeId, meta.id);
  assert.equal(state.ready, false);
  assert.equal(state.reason, '正在处理当前队列视频');
  assert.throws(() => api.begin({ ...meta, id: 'other' }), /已有视频任务/);
  dom.window.close();
});

test('prepare selects first recommended cover, original and service rules once without clicking image library or danmaku', () => {
  const { api, $, meta, prepare, complete, dom } = setup();
  prepare(); complete();
  $('#cover').innerHTML = '<button id="library" type="button"><img src="library.jpg">从图片库选择</button><button id="first-cover" type="button"><img src="one.jpg"></button><button id="second-cover" type="button"><img src="two.jpg"></button>';
  const counts = { library: 0, first: 0, second: 0, original: 0, agreement: 0, danmaku: 0 };
  $('#library').addEventListener('click', () => counts.library++);
  $('#first-cover').addEventListener('click', (event) => { counts.first++; event.currentTarget.classList.add('select'); });
  $('#second-cover').addEventListener('click', () => counts.second++);
  for (const id of ['original', 'agreement', 'danmaku']) $(`#${id}`).addEventListener('click', () => counts[id]++);
  assert.equal(api.status({ id: meta.id }).needsPreparation, true);
  assert.throws(() => api.save({ id: meta.id }), /封面/);
  assert.equal(settlePreparation(api, meta).prepared, true);
  assert.equal(settlePreparation(api, meta).prepared, true);
  assert.deepEqual(counts, { library: 0, first: 1, second: 0, original: 1, agreement: 1, danmaku: 0 });
  assert.equal($('#original').checked, true);
  assert.equal($('#danmaku').checked, true);
  assert.equal(api.status({ id: meta.id }).preparationReady, true);
  dom.window.close();
});

test('prepare waits for asynchronous cover, original and agreement state without repeated clicks', () => {
  const { api, $, meta, prepare, complete, window, dom } = setup();
  prepare(); complete();
  $('#cover').innerHTML = '<button type="button"><img src="cover.jpg"></button>';
  const count = { cover: 0, original: 0, agreement: 0 };
  $('#cover button').addEventListener('click', () => count.cover++);
  $('#original').addEventListener('click', (event) => { event.preventDefault(); count.original++; });
  $('#agreement').addEventListener('click', (event) => { event.preventDefault(); count.agreement++; });
  assert.equal(api.prepare({ id: meta.id }).pending, true);
  assert.equal(api.prepare({ id: meta.id }).pending, true);
  assert.equal(count.cover, 1);
  $('#cover button').classList.add('select');
  assert.equal(api.prepare({ id: meta.id }).pending, true);
  assert.equal(api.prepare({ id: meta.id }).pending, true);
  assert.equal(count.original, 1);
  $('#original').checked = true;
  const afterOriginal = window.Date.now() + 2000;
  window.Date.now = () => afterOriginal;
  assert.equal(api.prepare({ id: meta.id }).pending, true);
  assert.equal(api.prepare({ id: meta.id }).pending, true);
  assert.equal(count.agreement, 1);
  $('#agreement').checked = true;
  assert.equal(settlePreparation(api, meta).prepared, true);
  assert.equal(api.status({ id: meta.id }).preparationReady, true);
  dom.window.close();
});

test('prepare reads scoped WeUI original switch and blocks unknown original dialog', () => {
  const { api, $, meta, prepare, complete, dom } = setup();
  $('#original').outerHTML = '<span id="original" class="weui-desktop-switch"><i class="weui-desktop-switch__box"></i></span>';
  $('#original').addEventListener('click', (event) => event.currentTarget.classList.add('weui-desktop-switch_on'));
  prepare(); complete();
  assert.equal(settlePreparation(api, meta).prepared, true);
  assert.equal($('#original').classList.contains('weui-desktop-switch_on'), true);
  assert.equal($('#danmaku').checked, true);
  dom.window.close();

  const second = setup();
  second.prepare(); second.complete();
  second.$('#original').addEventListener('change', () => second.$('main').insertAdjacentHTML('beforeend', '<div role="dialog"><h2>原创声明</h2><button>确认并声明</button></div>'));
  assert.throws(() => second.api.prepare({ id: second.meta.id }), /额外确认弹窗/);
  assert.equal(second.$('#agreement').checked, false);
  assert.equal(second.api.status({ id: second.meta.id }).readyToSave, false);
  assert.match(second.api.status({ id: second.meta.id }).error, /额外确认弹窗/);
  second.dom.window.close();
});

function originalDialogHarness({ termsChecked = false, showOnSwitch = true, closeOnConfirm = true,
  enableOnConfirm = true, confirmDisabled = false, hideForm = false, deferredSwitch = false, role = true,
  termsKind = 'native', termsDisabled = false } = {}) {
  const harness = setup();
  const { $, window, api, meta, prepare, complete } = harness;
  prepare(); complete();
  $('#cover button').setAttribute('aria-pressed', 'true');
  let time = 100000;
  window.Date.now = () => time;
  const events = [];
  const clicks = { original: 0, terms: 0, confirm: 0, outside: 0, service: 0, save: 0 };
  $('main').insertAdjacentHTML('beforeend', '<button type="button" id="unrelated-confirm">确定</button>');
  $('#unrelated-confirm').addEventListener('click', () => clicks.outside++);
  const apply = () => {
    $('#original-dialog')?.remove();
    $('form').removeAttribute('aria-hidden');
    if (enableOnConfirm) $('#original').checked = true;
    events.push('original-applied');
  };
  const showDialog = () => {
    const dialog = window.document.createElement('section');
    dialog.id = 'original-dialog';
    dialog.className = 'weui-desktop-dialog';
    if (role) dialog.setAttribute('role', 'dialog');
    const terms = termsKind === 'aria' ? `<span id="original-terms" role="checkbox" aria-checked="${termsChecked}"></span>` :
      `<input id="original-terms" type="checkbox" ${termsChecked ? 'checked' : ''} ${termsDisabled ? 'disabled' : ''} ${termsKind === 'hidden-native' ? 'style="display:none"' : ''}>`;
    dialog.innerHTML = `<h2>原创声明</h2><h3>视频原创须知</h3><p>公众平台鼓励用户就自行创作并发布的作品标识原创</p>
      <label>${terms}我已阅读并同意遵守
      <a href="#original-rules">《微信公众平台原创声明及相关功能使用协议》</a></label>
      <button type="button" id="original-confirm" ${confirmDisabled ? 'disabled' : ''}>确定</button>`;
    window.document.body.append(dialog);
    if (hideForm) $('form').setAttribute('aria-hidden', 'true');
    if (termsKind === 'aria') $('#original-terms').addEventListener('click', event => {
      event.currentTarget.setAttribute('aria-checked', 'true');
      event.currentTarget.dispatchEvent(new window.Event('change', { bubbles: true }));
    });
    $('#original-terms').addEventListener('change', () => { clicks.terms++; events.push('original-terms'); });
    $('#original-confirm').addEventListener('click', () => {
      assert.equal(termsKind === 'aria' ? $('#original-terms').getAttribute('aria-checked') === 'true' : $('#original-terms').checked,
        true, 'original terms must be accepted before confirmation');
      clicks.confirm++;
      events.push('original-confirm');
      if (closeOnConfirm) apply();
    });
  };
  $('#original').addEventListener('click', event => {
    clicks.original++;
    events.push('original');
    if (deferredSwitch) event.preventDefault();
    if (showOnSwitch) showDialog();
  });
  $('#agreement').addEventListener('change', () => {
    assert.equal($('#original-dialog'), null, 'main service rules must follow original confirmation');
    assert.equal($('#original').checked, true);
    clicks.service++;
    events.push('service');
  });
  $('#save').addEventListener('click', () => { clicks.save++; events.push('save'); });
  const attempt = () => api.prepare({ id: meta.id });
  const advance = (milliseconds = 1000) => { time += milliseconds; };
  const settle = () => {
    for (let index = 0; index < 10; index++) {
      const result = attempt();
      if (result.prepared) return result;
      advance();
    }
    assert.fail('original confirmation should converge after the form is ready');
  };
  return { ...harness, clicks, events, apply, showDialog, attempt, advance, settle };
}

test('original notice accepts only its own terms and confirms once before the main service agreement and save', () => {
  for (const termsChecked of [false, true]) {
    for (const role of [true, false]) {
      const { api, meta, $, clicks, events, settle, dom } = originalDialogHarness({ termsChecked, role, termsDisabled: termsChecked });
      settle(); settle();
      assert.equal(api.status({ id: meta.id }).readyToSave, true);
      api.save({ id: meta.id });
      assert.deepEqual(clicks, { original: 1, terms: termsChecked ? 0 : 1, confirm: 1, outside: 0, service: 1, save: 1 });
      assert.deepEqual(events, ['original', ...(termsChecked ? [] : ['original-terms']), 'original-confirm', 'original-applied', 'service', 'save']);
      assert.equal($('#danmaku').checked, true);
      dom.window.close();
    }
  }
});

test('original notice supports scoped ARIA and decorated native terms controls', () => {
  for (const termsKind of ['aria', 'hidden-native']) {
    const { api, meta, clicks, settle, dom } = originalDialogHarness({ termsKind });
    settle(); settle();
    assert.equal(api.status({ id: meta.id }).readyToSave, true);
    assert.deepEqual(clicks, { original: 1, terms: 1, confirm: 1, outside: 0, service: 1, save: 0 });
    dom.window.close();
  }
});

test('original notice waits for delayed dialog, enabled confirm and delayed close without toggling or confirming twice', () => {
  const { api, meta, $, clicks, attempt, advance, showDialog, apply, settle, dom } = originalDialogHarness({
    showOnSwitch: false, deferredSwitch: true, closeOnConfirm: false, confirmDisabled: true
  });
  assert.equal(attempt().pending, true);
  advance(500);
  assert.equal(attempt().pending, true);
  assert.equal(clicks.original, 1);
  showDialog();
  assert.equal(attempt().pending, true);
  assert.equal(clicks.confirm, 0);
  assert.equal(clicks.service, 0);
  $('#original-confirm').disabled = false;
  for (let index = 0; index < 3; index++) { advance(500); assert.equal(attempt().pending, true); }
  assert.equal(clicks.terms, 1);
  assert.equal(clicks.confirm, 1);
  assert.equal(api.status({ id: meta.id }).readyToSave, false);
  assert.throws(() => api.save({ id: meta.id }));
  apply(); settle();
  assert.equal(clicks.original, 1);
  assert.equal(clicks.service, 1);
  assert.equal(api.status({ id: meta.id }).readyToSave, true);
  dom.window.close();
});

test('original switch becoming on before its delayed notice does not allow service agreement or save early', () => {
  const { api, meta, $, clicks, attempt, advance, showDialog, settle, dom } = originalDialogHarness({ showOnSwitch: false });
  assert.equal(attempt().pending, true);
  assert.equal($('#original').checked, true);
  assert.equal(clicks.service, 0);
  assert.equal(api.status({ id: meta.id }).readyToSave, false);
  assert.throws(() => api.save({ id: meta.id }));
  advance(500);
  showDialog();
  settle();
  assert.equal(clicks.original, 1);
  assert.equal(clicks.confirm, 1);
  assert.equal(clicks.service, 1);
  dom.window.close();
});

test('owned original notice waits for its loading shell to render the recognized agreement body', () => {
  const { api, meta, $, clicks, attempt, advance, showDialog, settle, dom } = originalDialogHarness({
    showOnSwitch: false, hideForm: true
  });
  $('#original').addEventListener('click', () => {
    $('body').insertAdjacentHTML('beforeend', '<section id="original-dialog" role="dialog" class="weui-desktop-dialog"><h2>原创声明</h2><p>加载中</p><button type="button" disabled>确定</button><button type="button">取消</button></section>');
    $('form').setAttribute('aria-hidden', 'true');
  });
  assert.equal(attempt().pending, true);
  advance(500);
  const loading = api.status({ id: meta.id });
  assert.equal(loading.uploadComplete, true);
  assert.equal(loading.error, null);
  assert.equal(loading.pending, true);
  assert.equal(loading.titleNeedsSync, false);
  assert.equal(loading.readyToSave, false);
  assert.equal(attempt().pending, true);
  assert.deepEqual(clicks, { original: 1, terms: 0, confirm: 0, outside: 0, service: 0, save: 0 });
  assert.throws(() => api.save({ id: meta.id }));
  $('#original-dialog').remove();
  showDialog();
  settle();
  assert.deepEqual(clicks, { original: 1, terms: 1, confirm: 1, outside: 0, service: 1, save: 0 });
  assert.equal(api.status({ id: meta.id }).readyToSave, true);
  dom.window.close();
});

test('original notice over an aria-hidden form retains proven upload and never refills or saves behind the modal', () => {
  const { api, meta, $, clicks, attempt, advance, apply, settle, dom } = originalDialogHarness({
    hideForm: true, closeOnConfirm: false
  });
  assert.equal(attempt().pending, true);
  for (let index = 0; index < 3; index++) {
    advance(500);
    const status = api.status({ id: meta.id });
    assert.equal(status.uploadComplete, true);
    assert.equal(status.titleNeedsSync, false);
    assert.equal(status.error, null);
    assert.equal(status.readyToSave, false);
    assert.equal(attempt().pending, true);
  }
  assert.equal(clicks.confirm, 1);
  assert.equal(clicks.service, 0);
  assert.equal($('#agreement').checked, false);
  assert.throws(() => api.save({ id: meta.id }));
  apply(); settle();
  assert.equal(clicks.service, 1);
  assert.equal(api.status({ id: meta.id }).readyToSave, true);
  dom.window.close();
});

test('closing the confirmed original notice still waits until the original switch is enabled', () => {
  const { api, meta, $, clicks, attempt, advance, settle, dom } = originalDialogHarness({
    deferredSwitch: true, enableOnConfirm: false
  });
  assert.equal(attempt().pending, true);
  assert.equal($('#original-dialog'), null);
  assert.equal($('#original').checked, false);
  advance(1000);
  assert.equal(attempt().pending, true);
  assert.equal(clicks.original, 1);
  assert.equal(clicks.confirm, 1);
  assert.equal(clicks.service, 0);
  $('#original').checked = true;
  settle();
  assert.equal(api.status({ id: meta.id }).readyToSave, true);
  dom.window.close();
});

test('preexisting, ambiguous and unknown original notices are not adopted or confirmed', () => {
  for (const kind of ['preexisting', 'multiple-dialogs', 'multiple-confirms', 'multiple-terms', 'unknown-terms', 'unknown-heading']) {
    const harness = originalDialogHarness({ showOnSwitch: false, closeOnConfirm: false });
    const { api, meta, $, clicks, showDialog, attempt, dom } = harness;
    const show = () => {
      showDialog();
      const dialog = $('#original-dialog');
      if (kind === 'multiple-dialogs') $('body').append(dialog.cloneNode(true));
      if (kind === 'multiple-confirms') dialog.insertAdjacentHTML('beforeend', '<button type="button">确定</button>');
      if (kind === 'multiple-terms') dialog.append(dialog.querySelector('label').cloneNode(true));
      if (kind === 'unknown-terms') dialog.querySelector('a').textContent = '《其他授权协议》';
      if (kind === 'unknown-heading') dialog.querySelector('h3').textContent = '其他声明选项';
    };
    if (kind === 'preexisting') show();
    else $('#original').addEventListener('click', show);
    try { assert.equal(attempt().prepared, false); } catch (error) { assert.match(error.message, /原创|声明|弹窗|唯一|协议|确认/); }
    assert.equal(clicks.confirm, 0, kind);
    assert.equal(clicks.terms, 0, kind);
    assert.equal(clicks.outside, 0, kind);
    assert.equal(clicks.service, 0, kind);
    assert.equal(clicks.save, 0, kind);
    if (kind === 'preexisting') assert.equal(clicks.original, 0);
    assert.equal(api.status({ id: meta.id }).readyToSave, false);
    assert.throws(() => api.save({ id: meta.id }));
    dom.window.close();
  }
});

test('save rechecks cover and original after prepare; removed selection or disabled originality cannot save', () => {
  for (const reset of [($) => $('#cover button').setAttribute('aria-pressed', 'false'), ($) => { $('#original').checked = false; }]) {
    const { api, $, meta, prepare, complete, dom } = setup();
    prepare(); complete(); settlePreparation(api, meta);
    assert.equal(api.status({ id: meta.id }).readyToSave, true);
    reset($);
    assert.equal(api.status({ id: meta.id }).readyToSave, false);
    assert.throws(() => api.save({ id: meta.id }));
    dom.window.close();
  }
});

test('explicit wrong file is an immediate error while temporary title DOM removal is pending', () => {
  const { api, $, meta, prepare, dom } = setup();
  prepare();
  $('#video-file').files = [{ name: 'wrong.mp4', size: 4, lastModified: 100 }];
  assert.match(api.status({ id: meta.id }).error, /文件与队列视频不一致/);
  $('#video-file').files = [];
  $('#video-title').remove();
  assert.equal(api.status({ id: meta.id }).error, null);
  assert.equal(api.status({ id: meta.id }).pending, true);
  dom.window.close();
});

test('native original checkbox inside a WeUI wrapper is preferred over decorative switch children', () => {
  const { api, $, meta, prepare, complete, dom } = setup();
  $('#original').outerHTML = '<span class="weui-desktop-switch"><input id="original" type="checkbox" style="display:none"><i class="weui-desktop-switch__box"></i></span>';
  prepare(); complete();
  assert.equal(settlePreparation(api, meta).prepared, true);
  assert.equal($('#original').checked, true);
  assert.equal($('#danmaku').checked, true);
  dom.window.close();
});

test('file change removing title input does not fail a successful handoff and later title sync resumes', () => {
  const { api, $, window, meta, prepare, complete, dom } = setup();
  const label = $('label[for="video-title"]');
  $('#video-file').addEventListener('change', () => $('#video-title').remove());
  assert.doesNotThrow(prepare);
  assert.equal(api.status({ id: meta.id }).error, null);
  assert.equal(api.status({ id: meta.id }).pending, true);
  assert.equal(api.fillTitle({ id: meta.id }).pending, true);
  label.insertAdjacentHTML('afterend', '<input id="video-title" type="text" maxlength="64">');
  complete();
  assert.equal(api.status({ id: meta.id }).titleNeedsSync, true);
  assert.equal(api.fillTitle({ id: meta.id }).filled, true);
  assert.equal($('#video-title').value, meta.title);
  assert.equal(settlePreparation(api, meta).prepared, true);
  assert.equal(api.status({ id: meta.id }).readyToSave, true);
  dom.window.close();
});

test('title redraw between status and fillTitle returns pending; explicit user title still stops', () => {
  const { api, $, meta, prepare, complete, dom } = setup();
  prepare(); complete();
  $('#video-title').value = 'demo';
  assert.equal(api.status({ id: meta.id }).titleNeedsSync, true);
  const label = $('label[for="video-title"]');
  $('#video-title').remove();
  assert.equal(api.fillTitle({ id: meta.id }).pending, true);
  label.insertAdjacentHTML('afterend', '<input id="video-title" type="text" maxlength="64">');
  $('#video-title').value = '用户另外填写的新标题';
  assert.throws(() => api.fillTitle({ id: meta.id }), /页面标题已被修改/);
  dom.window.close();
});

test('diagnostics exposes preparation and pending booleans without private field values or image URLs', () => {
  const { api, $, meta, prepare, complete, dom } = setup();
  prepare(); complete();
  $('#cover img').src = 'https://example.invalid/PRIVATE_COVER_PATH?token=SECRET_TOKEN';
  const before = api.diagnostics();
  assert.equal(before.coverCandidateCount, 1);
  assert.equal(before.firstCoverSelected, false);
  assert.equal(before.originalControlCount, 1);
  assert.equal(before.originalEnabled, false);
  assert.equal(before.ownedTransfer, true);
  assert.equal(before.evidence.fileHandedOff, true);
  assert.equal(before.evidence.uploadComplete, true);
  settlePreparation(api, meta);
  const after = api.diagnostics();
  assert.equal(after.firstCoverSelected, true);
  assert.equal(after.originalEnabled, true);
  assert.equal(after.agreementChecked, true);
  assert.equal(after.evidence.preparationReady, true);
  const output = JSON.stringify(after);
  assert(!output.includes(meta.name));
  assert(!output.includes(meta.title));
  assert(!output.includes('PRIVATE_COVER_PATH'));
  assert(!output.includes('SECRET_TOKEN'));
  dom.window.close();
});

function coverEditorHarness({ delayed = false, finishDisabled = false, role = true, title = '编辑封面', applyOnFinish = true } = {}) {
  const harness = setup();
  const { $, api, meta, prepare, complete, window } = harness;
  prepare(); complete();
  $('#cover').innerHTML = '<button id="recommended-cover" type="button" aria-pressed="false"><img src="recommended.jpg" alt="推荐封面一"></button>';
  const clicks = { cover: 0, finish: 0, outside: 0 };
  let now = Date.now();
  window.Date.now = () => now;
  const advance = (milliseconds) => { now += milliseconds; };
  const apply = () => {
    $('#cover-editor')?.remove();
    $('#recommended-cover').setAttribute('aria-pressed', 'true');
  };
  const showDialog = () => {
    $('main').insertAdjacentHTML('beforeend', `<div id="cover-editor" class="weui-desktop-dialog" ${role ? 'role="dialog"' : ''}><h2>${title}</h2><p>裁剪封面</p><div class="cover-preview"><p>封面预览</p><img src="editor-preview.jpg"><div>2.35:1</div><div>16:9</div><div>1:1</div></div><footer><button id="finish-cover" type="button" ${finishDisabled ? 'disabled' : ''}>完成</button></footer></div>`);
    $('#finish-cover').addEventListener('click', () => {
      clicks.finish++;
      if (applyOnFinish) apply();
    });
  };
  $('#recommended-cover').addEventListener('click', () => {
    clicks.cover++;
    if (!delayed) showDialog();
  });
  const attempt = () => api.prepare({ id: meta.id });
  const settle = () => {
    let result;
    for (let poll = 0; poll < 4; poll++) {
      result = attempt();
      if (result.prepared) break;
      advance(2000);
    }
    return result;
  };
  return { ...harness, clicks, showDialog, apply, attempt, settle, advance };
}

test('hidden confirmed cover waits beyond a minute without reclicking and completes after rendering resumes', () => {
  const { api, meta, clicks, $, attempt, advance, apply, settle, setHidden, dom } = coverEditorHarness({ applyOnFinish: false });
  setHidden(true);
  assert.match(attempt().reason, /后台页面等待封面渲染/);
  advance(180000);
  assert.equal(attempt().pending, true);
  const state = api.status({ id: meta.id });
  assert.equal(state.documentHidden, true);
  assert.equal(state.visibilityState, 'hidden');
  assert.match(state.reason, /后台页面等待封面渲染/);
  assert.equal(api.diagnostics().documentHidden, true);
  assert.equal(api.diagnostics().visibilityState, 'hidden');
  assert.equal(state.readyToSave, false);
  assert.equal($('#original').checked, false);
  assert.throws(() => api.save({ id: meta.id }));
  assert.deepEqual(clicks, { cover: 1, finish: 1, outside: 0 });
  setHidden(false);
  advance(59000);
  assert.equal(attempt().pending, true);
  apply();
  assert.equal(settle().prepared, true);
  assert.equal(api.status({ id: meta.id }).readyToSave, true);
  assert.equal(api.status({ id: meta.id }).documentHidden, false);
  assert.deepEqual(clicks, { cover: 1, finish: 1, outside: 0 });
  dom.window.close();
});

test('cover confirmation retains its remaining visible deadline across background suspension', () => {
  const { clicks, attempt, advance, setHidden, dom } = coverEditorHarness({ applyOnFinish: false });
  assert.equal(attempt().pending, true);
  advance(20000);
  setHidden(true); // Boundary records foreground time even without a poll.
  advance(180000);
  assert.equal(attempt().pending, true);
  setHidden(false);
  advance(39000);
  assert.equal(attempt().pending, true);
  advance(1001);
  assert.throws(attempt, /编辑窗口尚未关闭/);
  assert.equal(clicks.finish, 1);
  dom.window.close();
});

test('cover waiting phases each pause hidden time but still expire after sixty visible seconds', () => {
  for (const phase of ['open', 'ready', 'close', 'apply']) {
    const { $, attempt, advance, setHidden, clicks, dom } = coverEditorHarness({
      delayed: phase === 'open', finishDisabled: phase === 'ready', applyOnFinish: false
    });
    setHidden(true);
    assert.equal(attempt().pending, true);
    if (phase === 'apply') { $('#cover-editor').remove(); assert.equal(attempt().pending, true); }
    advance(180000);
    assert.equal(attempt().pending, true, phase);
    setHidden(false);
    advance(60001);
    assert.throws(attempt, /尚未出现编辑窗口|长时间未就绪|编辑窗口尚未关闭|尚未显示封面应用成功/, phase);
    assert.equal(clicks.cover, 1);
    assert.equal(clicks.finish, ['close','apply'].includes(phase) ? 1 : 0);
    dom.window.close();
  }
});

test('hidden original confirmation waits without reclicking and completes after rendering resumes', () => {
  const { api, meta, clicks, attempt, advance, apply, settle, setHidden, dom } = originalDialogHarness({ closeOnConfirm: false });
  setHidden(true);
  assert.match(attempt().reason, /后台页面等待原创声明更新/);
  advance(180000);
  assert.equal(attempt().pending, true);
  assert.equal(api.status({ id: meta.id }).readyToSave, false);
  assert.throws(() => api.save({ id: meta.id }));
  assert.equal(clicks.confirm, 1);
  assert.equal(clicks.service, 0);
  setHidden(false);
  advance(59000);
  assert.equal(attempt().pending, true);
  apply();
  assert.equal(settle().prepared, true);
  assert.equal(clicks.confirm, 1);
  assert.equal(clicks.service, 1);
  dom.window.close();
});

test('original confirmation retains its visible deadline across background suspension', () => {
  const { clicks, attempt, advance, setHidden, dom } = originalDialogHarness({ closeOnConfirm: false });
  assert.equal(attempt().pending, true);
  advance(20000);
  setHidden(true);
  advance(180000);
  assert.equal(attempt().pending, true);
  setHidden(false);
  advance(39000);
  assert.equal(attempt().pending, true);
  advance(1001);
  assert.throws(attempt, /原创声明已点击.*弹窗尚未关闭/);
  assert.equal(clicks.confirm, 1);
  dom.window.close();
});

test('original notice loading and post-close state waits exclude hidden time', () => {
  for (const phase of ['ready', 'apply']) {
    const { attempt, advance, setHidden, clicks, dom } = originalDialogHarness({
      confirmDisabled: phase === 'ready', deferredSwitch: phase === 'apply', enableOnConfirm: phase !== 'apply'
    });
    setHidden(true);
    assert.equal(attempt().pending, true);
    if (phase === 'apply') assert.equal(attempt().pending, true);
    advance(180000);
    assert.equal(attempt().pending, true);
    setHidden(false);
    advance(60001);
    assert.throws(attempt, /长时间未就绪|原创开关尚未确认开启/);
    assert.equal(clicks.original, 1);
    assert.equal(clicks.confirm, phase === 'apply' ? 1 : 0);
    dom.window.close();
  }
});

test('original agreement checkbox does not timeout or toggle twice while hidden', () => {
  const { $, attempt, advance, setHidden, showDialog, clicks, dom } = originalDialogHarness({ showOnSwitch: false });
  $('#original').addEventListener('click', () => {
    showDialog();
    $('#original-terms').addEventListener('click', event => event.preventDefault());
  });
  setHidden(true);
  assert.equal(attempt().pending, true);
  advance(180000);
  assert.equal(attempt().pending, true);
  assert.equal(clicks.terms, 0);
  assert.equal(clicks.confirm, 0);
  setHidden(false);
  advance(15001);
  assert.throws(attempt, /原创声明协议已点击勾选/);
  assert.equal(clicks.original, 1);
  dom.window.close();
});

test('visibility polling remains conservative if a visibilitychange event is missed', () => {
  const { attempt, advance, setHidden, dom } = coverEditorHarness({ applyOnFinish: false });
  assert.equal(attempt().pending, true);
  setHidden(true, { dispatch: false });
  advance(180000);
  assert.equal(attempt().pending, true);
  setHidden(false, { dispatch: false });
  assert.equal(attempt().pending, true);
  advance(60001);
  assert.throws(attempt, /编辑窗口尚未关闭/);
  dom.window.close();
});

test('explicit upload errors remain fatal even when cover rendering is waiting in a hidden tab', () => {
  const { $, api, meta, attempt, setHidden, dom } = coverEditorHarness({ applyOnFinish: false });
  setHidden(true);
  assert.equal(attempt().pending, true);
  $('#upload-state').textContent = '上传失败';
  assert.match(api.status({ id: meta.id }).error, /公众号页面报告上传或保存失败/);
  assert.throws(attempt, /公众号页面报告上传或保存失败/);
  dom.window.close();
});

test('cover editor synchronous dialog applies its precise finish button before preparation succeeds', () => {
  for (const role of [true, false]) {
    const harness = coverEditorHarness({ role });
    const { api, meta, clicks, $, settle, dom } = harness;
    assert.equal(settle().prepared, true);
    assert.deepEqual(clicks, { cover: 1, finish: 1, outside: 0 });
    assert.equal($('#cover-editor'), null);
    assert.equal(api.status({ id: meta.id }).readyToSave, true);
    assert.equal($('#original').checked, true);
    assert.equal($('#agreement').checked, true);
    dom.window.close();
  }
});

test('cover editor delayed dialog does not repeat the recommendation click and remains pending until applied', () => {
  const { api, meta, clicks, $, showDialog, attempt, apply, dom } = coverEditorHarness({ delayed: true, applyOnFinish: false });
  assert.equal(attempt().pending, true);
  assert.equal(attempt().pending, true);
  assert.equal(clicks.cover, 1);
  showDialog();
  assert.equal(attempt().pending, true);
  assert.equal(attempt().pending, true);
  assert.equal(clicks.finish, 1);
  assert.equal(api.status({ id: meta.id }).readyToSave, false);
  assert.equal($('#original').checked, false);
  assert.throws(() => api.save({ id: meta.id }));
  apply();
  assert.equal(settlePreparation(api, meta).prepared, true);
  assert.equal(api.status({ id: meta.id }).readyToSave, true);
  dom.window.close();
});

test('cover editor finish waits until enabled and uses an independent confirmation timer after clicking once', () => {
  const { api, meta, clicks, $, attempt, advance, apply, dom } = coverEditorHarness({ finishDisabled: true, applyOnFinish: false });
  assert.equal(attempt().pending, true);
  advance(14000);
  assert.equal(attempt().pending, true);
  assert.equal(clicks.finish, 0);
  $('#finish-cover').disabled = false;
  assert.equal(attempt().pending, true);
  assert.equal(clicks.finish, 1);
  advance(6000); // 20 seconds after selecting cover, only 6 seconds after confirming editor.
  assert.equal(attempt().pending, true);
  assert.equal(api.status({ id: meta.id }).error, null);
  assert.equal(api.status({ id: meta.id }).readyToSave, false);
  assert.equal(clicks.finish, 1);
  advance(2000);
  apply();
  assert.equal(settlePreparation(api, meta).prepared, true);
  assert.equal(api.status({ id: meta.id }).readyToSave, true);
  dom.window.close();
});

test('cover editor scopes finish to its modal and never clicks a same-label button elsewhere', () => {
  const { $, clicks, settle, dom } = coverEditorHarness();
  $('main').insertAdjacentHTML('beforeend', '<button id="outside-finish" type="button">完成</button>');
  $('#outside-finish').addEventListener('click', () => clicks.outside++);
  assert.equal(settle().prepared, true);
  assert.equal(clicks.finish, 1);
  assert.equal(clicks.outside, 0);
  dom.window.close();
});

test('cover editor ignores hidden old dialogs and does not confirm a different titled dialog', () => {
  const first = coverEditorHarness();
  first.$('main').insertAdjacentHTML('beforeend', '<div role="dialog" hidden><h2>编辑封面</h2><p>封面预览</p><button id="hidden-finish" type="button">完成</button></div>');
  let hiddenClicks = 0;
  first.$('#hidden-finish').addEventListener('click', () => hiddenClicks++);
  assert.equal(first.settle().prepared, true);
  assert.equal(hiddenClicks, 0);
  assert.equal(first.clicks.finish, 1);
  first.dom.window.close();

  const second = coverEditorHarness({ title: '编辑图片', applyOnFinish: false });
  for (let poll = 0; poll < 2; poll++) {
    try { assert.equal(second.attempt().prepared, false); } catch (error) { assert.match(error.message, /封面|弹窗|确认|页面/); }
  }
  assert.equal(second.clicks.finish, 0);
  assert.equal(second.api.status({ id: second.meta.id }).readyToSave, false);
  second.dom.window.close();
});

test('cover editor does not assume close means applied and never saves without a selected recommendation', () => {
  const { api, meta, clicks, $, attempt, apply, dom } = coverEditorHarness({ applyOnFinish: false });
  assert.equal(attempt().pending, true);
  assert.equal(attempt().pending, true);
  assert.equal(clicks.finish, 1);
  $('#cover-editor').remove();
  assert.equal(attempt().prepared, false);
  assert.equal(api.status({ id: meta.id }).readyToSave, false);
  assert.throws(() => api.save({ id: meta.id }));
  assert.equal(clicks.cover, 1);
  assert.equal(clicks.finish, 1);
  apply();
  assert.equal(settlePreparation(api, meta).prepared, true);
  assert.equal(api.status({ id: meta.id }).readyToSave, true);
  dom.window.close();
});

test('cover editor already open before this task recommendation click is never adopted or confirmed', () => {
  const { api, meta, clicks, showDialog, attempt, dom } = coverEditorHarness({ delayed: true, applyOnFinish: false });
  showDialog();
  try { assert.equal(attempt().prepared, false); } catch (error) { assert.match(error.message, /封面|弹窗|确认|页面/); }
  assert.equal(clicks.cover, 0);
  assert.equal(clicks.finish, 0);
  assert.equal(api.status({ id: meta.id }).readyToSave, false);
  dom.window.close();
});

test('cover editor refuses ambiguous finish buttons inside its modal', () => {
  const { api, meta, clicks, $, showDialog, attempt, dom } = coverEditorHarness({ delayed: true, applyOnFinish: false });
  assert.equal(attempt().pending, true);
  showDialog();
  $('#cover-editor footer').insertAdjacentHTML('beforeend', '<button id="other-modal-finish" type="button">完成</button>');
  let otherClicks = 0;
  $('#other-modal-finish').addEventListener('click', () => otherClicks++);
  try { assert.equal(attempt().prepared, false); } catch (error) { assert.match(error.message, /唯一|完成|封面|弹窗/); }
  assert.equal(clicks.finish, 0);
  assert.equal(otherClicks, 0);
  assert.equal(api.status({ id: meta.id }).readyToSave, false);
  dom.window.close();
});

test('cover editor remaining open blocks save even if the underlying recommendation already looks selected', () => {
  const { api, meta, clicks, $, attempt, dom } = coverEditorHarness({ applyOnFinish: false });
  assert.equal(attempt().pending, true);
  $('#recommended-cover').setAttribute('aria-pressed', 'true');
  $('#original').checked = true;
  $('#agreement').checked = true;
  $('#save').disabled = false;
  assert.equal(api.status({ id: meta.id }).readyToSave, false);
  assert.throws(() => api.save({ id: meta.id }));
  assert.equal(attempt().pending, true);
  assert.equal(clicks.finish, 1);
  $('#cover-editor').remove();
  assert.equal(settlePreparation(api, meta).prepared, true);
  assert.equal(api.status({ id: meta.id }).readyToSave, true);
  dom.window.close();
});

test('cover editor outside an aria-hidden form keeps proven upload pending and confirms only once', () => {
  const { api, meta, clicks, $, attempt, showDialog, apply, advance, dom } = coverEditorHarness({ delayed: true, applyOnFinish: false });
  // The uploader consumed its File before opening an accessible top-level modal.
  $('#video-file').files = [];
  $('#upload-state').insertAdjacentHTML('afterend', `<p>${meta.name}</p>`);
  assert.equal(api.status({ id: meta.id }).uploadComplete, true);
  assert.equal(attempt().pending, true);
  showDialog();
  $('body').append($('#cover-editor'));
  $('main').setAttribute('aria-hidden', 'true');

  const obscured = api.status({ id: meta.id });
  assert.equal(obscured.uploadComplete, true);
  assert.equal(obscured.error, null);
  assert.equal(obscured.readyToSave, false);
  assert.equal(obscured.titleNeedsSync, false);
  assert.equal(attempt().pending, true);
  advance(20000);
  assert.equal(attempt().pending, true);
  assert.deepEqual(clicks, { cover: 1, finish: 1, outside: 0 });
  assert.equal($('#original').checked, false);
  assert.equal($('#agreement').checked, false);
  assert.throws(() => api.save({ id: meta.id }));
  assert.equal(api.verify({ id: meta.id }).verified, false);

  apply();
  $('main').removeAttribute('aria-hidden');
  assert.equal(settlePreparation(api, meta).prepared, true);
  assert.equal(api.status({ id: meta.id }).readyToSave, true);
  assert.equal(api.verify({ id: meta.id }).verified, false);
  assert.deepEqual(clicks, { cover: 1, finish: 1, outside: 0 });
  dom.window.close();
});

test('confirmed crop replaced with plain applied preview continues original, agreement and exact save in order', () => {
  for (const preview of [
    '<img src="cropped.jpg"><button type="button">修改封面</button>',
    '<img src="recommended.jpg">',
    '<div><p>视频消息封面（16:9）</p><img src="landscape.jpg"></div><div><p>视频消息封面（1:1）</p><img src="square.jpg"></div>'
  ]) {
    const { api, meta, $, clicks, attempt, dom } = coverEditorHarness({ applyOnFinish: false, delayed: true });
    const order = [];
    $('#original').addEventListener('click', () => order.push('original'));
    $('#agreement').addEventListener('click', () => order.push('agreement'));
    $('#save').addEventListener('click', () => order.push('save'));
    assert.equal(attempt().pending, true);
    $('main').insertAdjacentHTML('beforeend', '<div id="cover-editor" role="dialog"><h2>编辑封面</h2><p>封面预览</p><img src="crop.jpg"><button id="finish-applied" type="button">完成</button></div>');
    $('#finish-applied').addEventListener('click', () => {
      order.push('cover-finish');
      $('#cover').innerHTML = preview;
      $('#cover-editor').remove();
    });
    assert.equal(attempt().pending, true);
    assert.deepEqual(order, ['cover-finish']);
    assert.equal(settlePreparation(api, meta).prepared, true);
    assert.equal(api.status({ id: meta.id }).readyToSave, true);
    api.save({ id: meta.id });
    assert.deepEqual(order, ['cover-finish', 'original', 'agreement', 'save']);
    assert.equal(clicks.cover, 1);
    dom.window.close();
  }
});

test('confirmation does not accept an unchanged re-rendered recommendation and applied preview removal blocks save', () => {
  const first = coverEditorHarness({ applyOnFinish: false });
  first.attempt();
  first.$('#cover-editor').remove();
  first.$('#cover').innerHTML = '<button type="button" aria-pressed="false"><img src="recommended.jpg"></button>';
  assert.equal(first.attempt().prepared, false);
  assert.equal(first.$('#original').checked, false);
  first.dom.window.close();

  const second = coverEditorHarness({ applyOnFinish: false });
  second.attempt();
  second.$('#cover-editor').remove();
  second.$('#cover').innerHTML = '<img src="applied.jpg"><button type="button">修改封面</button>';
  assert.equal(settlePreparation(second.api, second.meta).prepared, true);
  second.$('#cover').innerHTML = '';
  assert.equal(second.api.status({ id: second.meta.id }).readyToSave, false);
  assert.throws(() => second.api.save({ id: second.meta.id }), /封面/);
  second.dom.window.close();
});

const relativeCard = (title, time, status = '转码中') => `<tr><td><div class="thumbnail"><img src="cover.jpg"><span>00:00</span></div></td><td><p>${title}</p></td><td><span>${status}</span></td><td><span>${time}</span></td><td><button>操作</button></td></tr>`;
const renderLibrary = ($, cards) => { $('main').innerHTML = `<h1>素材库</h1><nav><span>图片</span><span>音频</span><span>视频</span></nav><table><thead><tr><th>封面</th><th>名称</th><th>状态</th><th>更新时间</th><th>操作</th></tr></thead><tbody>${cards}</tbody></table>`; };

test('material library HH:mm row verifies save while still transcoding and rejects stale/future rows', () => {
  const { api, $, meta, window, dom } = setup();
  const savedAt = new Date(2026, 8, 28, 16, 16, 24).getTime();
  window.Date.now = () => savedAt + 10000;
  renderLibrary($, relativeCard(meta.title, '16:16'));
  assert.equal(api.verify({ id: meta.id, title: meta.title, savedAt }).verified, true);
  for (const time of ['16:15', '14:43', '16:19', '25:16', '16:90']) {
    renderLibrary($, relativeCard(meta.title, time));
    assert.equal(api.verify({ id: meta.id, title: meta.title, savedAt }).verified, false, time);
  }
  dom.window.close();
});

test('relative weekday timestamps use the most recent weekday and duplicate titles stay uncertain', () => {
  const { api, $, meta, window, dom } = setup();
  const savedAt = new Date(2026, 8, 28, 16, 16, 24).getTime(); // Monday.
  window.Date.now = () => savedAt + 10000;
  for (const time of ['星期一 16:16', '周一 16:16', '今天 16:16']) {
    renderLibrary($, relativeCard(meta.title, time));
    assert.equal(api.verify({ id: meta.id, title: meta.title, savedAt }).verified, true, time);
  }
  for (const time of ['星期三 18:49', '昨天 16:16', '前天 16:16', '星期一 16:15']) {
    renderLibrary($, relativeCard(meta.title, time));
    assert.equal(api.verify({ id: meta.id, title: meta.title, savedAt }).verified, false, time);
  }
  renderLibrary($, relativeCard(meta.title, '16:16') + relativeCard(meta.title, '星期三 18:49'));
  const result = api.verify({ id: meta.id, title: meta.title, savedAt });
  assert.equal(result.verified, false);
  assert.match(result.reason, /多个同名/);
  dom.window.close();
});

test('a thumbnail duration, a separate title, or time without material status cannot verify a relative-date save', () => {
  const { api, $, meta, window, dom } = setup();
  const savedAt = new Date(2026, 8, 28, 16, 16, 24).getTime();
  window.Date.now = () => savedAt + 10000;
  renderLibrary($, relativeCard('另一条视频', '16:16'));
  $('main').insertAdjacentHTML('beforeend', `<p>${meta.title}</p>`);
  assert.equal(api.verify({ id: meta.id, title: meta.title, savedAt }).verified, false);
  renderLibrary($, `<tr><td><div><img src="cover.jpg"><span>16:16</span></div></td><td><p>${meta.title}</p></td><td><span>转码中</span></td></tr>`);
  assert.equal(api.verify({ id: meta.id, title: meta.title, savedAt }).verified, false);
  renderLibrary($, relativeCard(meta.title, '16:16', '未知'));
  assert.equal(api.verify({ id: meta.id, title: meta.title, savedAt }).verified, false);
  dom.window.close();
});

test('save across midnight accepts new-day time and rejects yesterday earlier than the save minute', () => {
  const { api, $, meta, window, dom } = setup();
  const savedAt = new Date(2026, 8, 28, 23, 59, 50).getTime();
  window.Date.now = () => savedAt + 20000;
  renderLibrary($, relativeCard(meta.title, '00:00'));
  assert.equal(api.verify({ id: meta.id, title: meta.title, savedAt }).verified, true);
  renderLibrary($, relativeCard(meta.title, '昨天 23:59'));
  assert.equal(api.verify({ id: meta.id, title: meta.title, savedAt }).verified, true);
  renderLibrary($, relativeCard(meta.title, '昨天 23:58'));
  assert.equal(api.verify({ id: meta.id, title: meta.title, savedAt }).verified, false);
  dom.window.close();
});

const pickerMarkup = (launch = '<button type="button">本地上传</button>') => `<h1>图文编辑</h1><section role="dialog"><h2>选择视频</h2><nav><span>素材库</span><span>视频链接</span></nav>${launch}<button type="button">确定</button></section>`;

test('status preparation snapshot identifies pending cover confirmation without clicking or exposing page values', () => {
  const { api, meta, $, clicks, attempt, dom } = coverEditorHarness({ finishDisabled: true, applyOnFinish: false });
  assert.equal(attempt().pending, true);
  $('#cover-editor img').src = 'https://private.invalid/PRIVATE_COVER?token=SECRET_TOKEN';
  $('#cover-editor').insertAdjacentHTML('beforeend', '<p>PRIVATE_MODAL_TEXT</p>');
  const read = () => JSON.parse(JSON.stringify(api.status({ id: meta.id }).preparation));
  const expected = {
    coverCandidateCount: 1, firstCoverSelected: false, coverEditorCount: 1, coverConfirmationSent: false,
    originalControlCount: 1, originalEnabled: false, originalDialogCount: 0, originalConfirmationSent: false,
    agreementChecked: false, phase: 'cover-editor'
  };
  assert.deepEqual(read(), expected);
  assert.deepEqual(read(), expected);
  assert.deepEqual(clicks, { cover: 1, finish: 0, outside: 0 });
  $('#finish-cover').disabled = false;
  assert.equal(attempt().pending, true);
  assert.deepEqual(read(), { ...expected, coverConfirmationSent: true });
  assert.deepEqual(read(), { ...expected, coverConfirmationSent: true });
  assert.deepEqual(clicks, { cover: 1, finish: 1, outside: 0 });
  assert.equal(api.status({ id: meta.id }).readyToSave, false);
  dom.window.close();
});

test('status preparation snapshot identifies pending original confirmation and application without clicks', () => {
  const { api, meta, $, clicks, attempt, apply, dom } = originalDialogHarness({ confirmDisabled: true, closeOnConfirm: false });
  assert.equal(attempt().pending, true);
  const read = () => JSON.parse(JSON.stringify(api.status({ id: meta.id }).preparation));
  const expected = {
    coverCandidateCount: 1, firstCoverSelected: true, coverEditorCount: 0, coverConfirmationSent: false,
    originalControlCount: 1, originalEnabled: true, originalDialogCount: 1, originalConfirmationSent: false,
    agreementChecked: false, phase: 'original-dialog'
  };
  const before = { ...clicks };
  assert.deepEqual(read(), expected);
  assert.deepEqual(read(), expected);
  assert.deepEqual(clicks, before);
  $('#original-confirm').disabled = false;
  assert.equal(attempt().pending, true);
  const after = { ...clicks };
  assert.equal(after.confirm, 1);
  assert.deepEqual(read(), { ...expected, originalConfirmationSent: true });
  assert.deepEqual(read(), { ...expected, originalConfirmationSent: true });
  assert.deepEqual(clicks, after);
  apply();
  assert.deepEqual(read(), { ...expected, originalDialogCount: 0, originalConfirmationSent: true, phase: 'original-apply' });
  assert.deepEqual(clicks, after);
  assert.equal(api.status({ id: meta.id }).readyToSave, false);
  dom.window.close();
});

test('launchInfo reads video picker without clicking or changing article and constructs separate blank upload URL', () => {
  const { api, $, window, dom } = setup(pickerMarkup());
  const original = window.document.body.innerHTML;
  let clicks = 0;
  $('button').addEventListener('click', () => clicks++);
  const result = api.launchInfo();
  assert.equal(result.ready, true);
  assert.equal(result.pageKind, 'video-picker');
  const url = new URL(result.launchUrl);
  assert.equal(url.origin, 'https://mp.weixin.qq.com');
  assert.equal(url.pathname, '/cgi-bin/appmsg');
  assert.equal(url.searchParams.get('t'), 'media/videomsg_edit');
  assert.equal(url.searchParams.get('action'), 'video_edit');
  assert.equal(url.searchParams.get('type'), '15');
  assert.equal(url.searchParams.get('token'), 'SECRET_TOKEN');
  assert.equal(clicks, 0);
  assert.equal(window.document.body.innerHTML, original);
  assert(!JSON.stringify(api.diagnostics()).includes('SECRET_TOKEN'));
  dom.window.close();
});

test('launchInfo prefers observed upload anchor and rejects other origins, existing video IDs or unrelated routes', () => {
  const valid = '/cgi-bin/appmsg?t=media/videomsg_edit&action=video_edit&type=15&token=ANCHOR_SESSION&lang=zh_CN';
  const good = setup(pickerMarkup(`<a href="${valid}&unrelated=removed">本地上传</a>`));
  const result = good.api.launchInfo();
  assert.equal(result.ready, true);
  const url = new URL(result.launchUrl);
  assert.equal(url.searchParams.get('token'), 'ANCHOR_SESSION');
  assert.equal(url.searchParams.has('unrelated'), false);
  good.dom.window.close();
  for (const href of ['https://example.invalid' + valid, valid + '&appmsgid=100', valid + '&media_id=100', valid.replace('video_edit&type=15', 'edit&type=77')]) {
    const { api, dom } = setup(pickerMarkup(`<a href="${href}">本地上传</a>`));
    assert.equal(api.launchInfo().ready, false, href);
    dom.window.close();
  }
});

test('launchInfo supports material video list and existing add page without requiring controller to be empty', () => {
  const add = setup();
  add.$('#video-title').value = '控制页已有内容';
  assert.equal(add.api.launchInfo().ready, true);
  assert.equal(add.api.launchInfo().pageKind, 'add-video');
  assert.equal(add.$('#video-title').value, '控制页已有内容');
  add.dom.window.close();
  const library = setup('<main><h1>素材库</h1><nav><span>图片</span><span>音频</span><span>视频</span></nav><button type="button">添加</button></main>');
  assert.equal(library.api.launchInfo().ready, true);
  assert.equal(library.api.launchInfo().pageKind, 'video-library');
  library.dom.window.close();
});

test('launchInfo does not infer source from arbitrary article, ambiguous picker or missing session', () => {
  const article = setup('<main><h1>图文编辑</h1><button>本地上传</button></main>');
  assert.equal(article.api.launchInfo().ready, false);
  assert.equal(article.api.launchInfo().pageKind, 'other');
  article.dom.window.close();
  const ambiguous = setup(pickerMarkup() + pickerMarkup());
  assert.equal(ambiguous.api.launchInfo().ready, false);
  ambiguous.dom.window.close();
  const missing = setup(pickerMarkup());
  missing.dom.reconfigure({ url: 'https://mp.weixin.qq.com/cgi-bin/appmsg?lang=zh_CN' });
  assert.equal(missing.api.launchInfo().ready, false);
  missing.dom.reconfigure({ url: 'https://example.invalid/cgi-bin/appmsg?token=TOKEN' });
  assert.equal(missing.api.launchInfo().ready, false);
  missing.dom.window.close();
});
