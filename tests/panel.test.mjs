import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const source = readFileSync(new URL('../src/panel.js', import.meta.url), 'utf8');
const item = (id, overrides = {}) => ({
  id, name: `${id}.mp4`, title: `视频 ${id}`, size: 1048576,
  lastModified: 100, hasFile: true, status: 'queued', ...overrides
});
const ready = { ready: true, reason: '添加视频页面已连接', adapterLabel: 'test' };

function harness(t, callbacks = {}) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    runScripts: 'outside-only', url: 'https://extension.test/runner.html'
  });
  dom.window.eval(source);
  const panel = dom.window.WXVideoPanel.create({ fullPage: true, ...callbacks });
  const root = dom.window.document.getElementById('wx-video-batch-uploader').shadowRoot;
  t.after(() => { panel.destroy(); dom.window.close(); });
  const update = (items, rest = {}) => panel.update({ items, running: false, pauseRequested: false, ...rest }, ready);
  return { panel, root, window: dom.window, update, action: () => root.querySelector('.main-action') };
}

test('overlong and blank titles prevent starting without silently changing the title', t => {
  let starts = 0;
  const ui = harness(t, { onStart: () => { starts++; } });
  const longTitle = '长'.repeat(65);
  ui.update([item('first', { title: longTitle })]);
  const input = ui.root.querySelector('input[type="text"]');
  assert.equal(input.value, longTitle, 'the user must be able to review and shorten the original title');
  assert.equal(input.maxLength, 64);
  assert.equal(input.getAttribute('aria-invalid'), 'true');
  assert.match(ui.root.querySelector('.title-error').textContent, /超过 64/);
  assert.equal(ui.action().disabled, true);
  ui.action().click();
  assert.equal(starts, 0);

  ui.update([item('first', { title: '   ' })]);
  assert.equal(ui.action().disabled, true);
  assert.match(ui.root.querySelector('.title-error').textContent, /填写/);
  ui.action().click();
  assert.equal(starts, 0);

  ui.update([item('first', { title: '长'.repeat(64) })]);
  assert.equal(ui.action().disabled, false, 'a valid 64-character title must remain uploadable');
  ui.action().click();
  assert.equal(starts, 1);
});

test('a missing local file blocks even a mixed queue until the file is reselected', t => {
  let starts = 0;
  const ui = harness(t, { onStart: () => { starts++; } });
  ui.update([item('restored', { hasFile: false }), item('available')]);
  assert.equal(ui.action().disabled, true);
  assert.match(ui.root.querySelector('.status').textContent, /重新选择文件/);
  ui.action().click();
  assert.equal(starts, 0);

  ui.update([item('restored', { hasFile: true }), item('available')]);
  assert.equal(ui.action().disabled, false);
  ui.action().click();
  assert.equal(starts, 1);
});

test('running locks queue edits while leaving finish-current-tasks pause available', t => {
  let pauses = 0;
  let removes = 0;
  const ui = harness(t, { onPause: () => { pauses++; }, onRemove: () => { removes++; } });
  ui.update([item('active', { status: 'uploading' }), item('next')], { running: true });
  assert([...ui.root.querySelectorAll('input[type="text"]')].every(input => input.disabled));
  assert.equal(ui.root.querySelector('input[type="file"]').disabled, true);
  assert.equal(ui.root.querySelector('.choose').disabled, true);
  const remove = [...ui.root.querySelectorAll('button')].find(button => button.textContent === '移除');
  assert.equal(remove.disabled, true);
  remove.click();
  assert.equal(removes, 0);
  assert.match(ui.action().textContent, /完成当前任务后暂停/);
  assert.equal(ui.action().disabled, false);
  ui.action().click();
  assert.equal(pauses, 1);

  ui.update([item('active', { status: 'uploading' }), item('next')], { running: true, pauseRequested: true });
  assert.equal(ui.action().disabled, true, 'one pause request is enough while the current upload finishes');
  assert.match(ui.action().textContent, /完成当前/);
});

test('untrusted filenames, errors, readiness and notices remain literal text', t => {
  const ui = harness(t);
  const payload = '<img data-untrusted="yes" src=x onerror="window.compromised=true"><script>window.compromised=true</script>';
  ui.update([item('failed', { name: payload, status: 'failed', error: payload })]);
  ui.panel.update(undefined, { ...ready, reason: payload });
  ui.panel.setNotice(payload, 'error');
  assert.equal(ui.root.querySelector('.file-name').textContent, payload);
  assert(ui.root.querySelector('.error-text').textContent.includes(payload));
  assert.equal(ui.root.querySelector('.readiness-description').textContent, payload);
  assert.equal(ui.root.querySelector('.notice').textContent, payload);
  assert.equal(ui.root.querySelector('img,script,[data-untrusted]'), null);
  assert.equal(ui.window.compromised, undefined);
});

test('succeeded items count as completed even after their local File reference is gone', t => {
  const ui = harness(t);
  ui.update([item('saved', { status: 'succeeded', hasFile: false }), item('waiting')]);
  assert.equal(ui.root.querySelector('.stat[data-kind="done"] strong').textContent, '1');
  assert.equal(ui.root.querySelector('.stat[data-kind="waiting"] strong').textContent, '1');
  assert.equal(ui.root.querySelector('.stat[data-kind="problem"] strong').textContent, '0');
  assert.equal(ui.root.querySelector('.status').textContent, '已入库');
  assert.equal(ui.action().disabled, false, 'completed uploads must not require local files again');

  ui.update([item('saved', { status: 'succeeded', hasFile: false }), item('waiting', { status: 'succeeded' })]);
  assert.equal(ui.root.querySelector('.stat[data-kind="done"] strong').textContent, '2');
  assert.match(ui.action().textContent, /队列已处理/);
  assert.equal(ui.action().disabled, true);
});

test('unconfirmed and submitted items need no file or reconciliation to start the waiting item', t => {
  let starts = 0;
  const ui = harness(t, { onStart: () => starts++ });
  ui.update([item('old', { status: 'uncertain', hasFile: false, title: '', error: '保存结果需要人工核对，请核对后继续' }),
    item('submitted', { status: 'submitted', hasFile: false }), item('waiting')]);
  assert.equal(ui.action().disabled, false);
  assert.match(ui.action().textContent, /1 个视频/);
  ui.action().click();
  assert.equal(starts, 1);
  const rows = ui.root.querySelectorAll('.item');
  assert.equal(rows[0].querySelector('.status').textContent, '结果未确认');
  assert.match(rows[0].querySelector('.error-text').textContent, /已跳过/);
  assert.doesNotMatch(rows[0].querySelector('.error-text').textContent, /人工核对|请核对/);
  assert.equal(rows[0].querySelector('.item-actions button').hidden, true);
  assert.equal(rows[1].querySelector('.status').textContent, '已提交');
  assert.equal(ui.root.querySelector('.stat[data-kind="waiting"] strong').textContent, '1');
});

test('explicit retry of a failed upload still requires a separate user action', t => {
  const retried = [];
  const ui = harness(t, { onRetry: id => { retried.push(id); } });
  ui.update([item('ambiguous', { status: 'failed' }), item('waiting')]);
  assert.equal(ui.action().disabled, true, 'pre-save failures remain blocking');
  const retry = [...ui.root.querySelectorAll('button')].find(button => button.textContent === '核对后重试');
  retry.click();
  const confirmation = ui.root.querySelector('.retry-confirm');
  assert.equal(confirmation.hidden, false);
  const submit = confirmation.querySelector('.retry-submit');
  assert.equal(submit.disabled, true);
  submit.click();
  assert.deepEqual(retried, []);
  const checkbox = confirmation.querySelector('input[type="checkbox"]');
  checkbox.click();
  assert.equal(submit.disabled, false);
  submit.click();
  assert.deepEqual(retried, ['ambiguous']);
  assert.equal(confirmation.hidden, true);
});

test('importing files locks editing and start without offering a queue pause', t => {
  let starts = 0;
  const ui = harness(t, { onStart: () => { starts++; } });
  ui.panel.update({ items: [item('next')], running: false }, { ...ready, importing: true });
  assert.equal(ui.root.querySelector('input[type="text"]').disabled, true);
  assert.equal(ui.root.querySelector('.choose').disabled, true);
  assert.equal(ui.root.querySelector('input[type="file"]').disabled, true);
  assert.equal(ui.action().disabled, true);
  assert.match(ui.action().textContent, /准备视频/);
  assert.doesNotMatch(ui.action().textContent, /暂停/);
  ui.action().click();
  assert.equal(starts, 0);
  ui.panel.update(undefined, { importing: false });
  assert.equal(ui.action().disabled, false);
});

test('inline panel collapses without pausing and preserves full filenames', t => {
  let pauses = 0;
  const collapsed = [];
  const ui = harness(t, { fullPage: false, onPause: () => { pauses++; }, onCollapse: value => collapsed.push(value) });
  const filename = '完整文件名称'.repeat(30) + '.mp4';
  ui.update([item('active', { name: filename, status: 'uploading' })], { running: true });
  assert.equal(ui.root.querySelector('.panel').classList.contains('full-page'), false);
  assert.equal(ui.root.querySelector('.file-name').textContent, filename);
  assert.doesNotMatch(ui.root.querySelector('style').textContent, /text-overflow:\s*ellipsis/);
  ui.root.querySelector('button[aria-label="折叠面板，任务继续"]').click();
  assert.equal(ui.root.querySelector('.panel').hidden, true);
  assert.equal(ui.root.querySelector('.float').hidden, false);
  assert.equal(pauses, 0);
  ui.root.querySelector('.float').click();
  assert.equal(ui.root.querySelector('.panel').hidden, false);
  assert.deepEqual(collapsed, [true, false]);
  assert.match(ui.root.querySelector('.help').textContent, /保持当前任务页面和正在上传的页面打开/);
  assert.doesNotMatch(ui.root.textContent, /两个页面|独立助手/);
});

test('upload controls default to serial, accept one to ten, and lock throughout running and import', t => {
  const configured = [];
  const ui = harness(t, { onConfigure: settings => configured.push({ ...settings }) });
  ui.update([item('first')]);
  const select = ui.root.querySelector('select[aria-label="同时上传的视频数量"]');
  assert.equal(select.value, '1');
  assert.deepEqual([...select.options].map(option => option.value), Array.from({ length: 10 }, (_, index) => String(index + 1)));
  assert.equal(select.disabled, false);
  select.value = '10';
  select.dispatchEvent(new ui.window.Event('change', { bubbles: true }));
  assert.deepEqual(configured, [{ concurrency: 10 }]);
  ui.panel.update(undefined, { concurrency: 10 });
  assert.equal(select.value, '10');
  assert.match(ui.root.querySelector('.sequence-note').textContent, /同时上传 10 个/);

  ui.update([item('first', { status: 'uploading' }), item('second', { status: 'processing' }), item('third')], { running: true });
  assert.equal(select.disabled, true);
  assert.equal(ui.root.querySelector('.stat[data-kind="active"] strong').textContent, '2');
  assert.equal(ui.root.querySelector('.stat[data-kind="waiting"] strong').textContent, '1');
  assert.match(ui.root.querySelector('.readiness-description').textContent, /2 个视频正在处理/);
  select.value = '1';
  select.dispatchEvent(new ui.window.Event('change', { bubbles: true }));
  assert.deepEqual(configured, [{ concurrency: 10 }], 'even synthetic events cannot reconfigure a running queue');
  assert.equal(select.value, '10');

  ui.panel.update({ running: false }, { importing: true });
  assert.equal(select.disabled, true);
  ui.panel.update(undefined, { importing: false, loading: true });
  assert.equal(select.disabled, true);
  ui.panel.update(undefined, { loading: false, concurrency: 1 });
  assert.equal(select.disabled, false);
  assert.equal(select.value, '1');
});

test('foreground serial is explicit, explains visibility, and cannot change while a run is active', t => {
  const configured = [];
  const ui = harness(t, { onConfigure: settings => configured.push({ ...settings }) });
  ui.update([item('first')]);
  const checkbox = ui.root.querySelector('[aria-label="前台串行上传"]');
  assert.equal(checkbox.checked, false);
  checkbox.click();
  assert.deepEqual(configured, [{ foregroundSerial: true, concurrency: 1 }]);
  ui.panel.update({ running: true, items: [item('first', { status: 'processing' }), item('second')] }, { foregroundSerial: true, concurrency: 1 });
  assert.equal(checkbox.disabled, true);
  assert.equal(ui.root.querySelector('.concurrency').disabled, true);
  assert.match(ui.root.querySelector('.readiness-description').textContent, /保持当前上传页可见/);
  assert.doesNotMatch(ui.root.querySelector('.footer-tip').textContent, /切换标签页后/);
  checkbox.checked = false;
  checkbox.dispatchEvent(new ui.window.Event('change', { bubbles: true }));
  assert.equal(configured.length, 1);
  assert.equal(checkbox.checked, true);
});

test('entry readiness preserves automatic checks and parallel pause describes every active task', t => {
  const ui = harness(t, { fullPage: false });
  ui.panel.update({ items: [item('first'), item('second')], running: false }, {
    ...ready, reason: '选择视频素材库入口已就绪', concurrency: 2,
    autoCheck: { enabled: true, intervalMs: 2500 }
  });
  assert.equal(ui.root.querySelector('.readiness-title').textContent, '公众号上传入口已就绪');
  assert.match(ui.root.querySelector('.readiness-description').textContent, /每 2.5 秒自动检查/);
  assert.match(ui.root.querySelector('.header-sub').textContent, /独立后台页面并行上传/);
  assert.match(ui.root.querySelector('.help').textContent, /无需等待转码/);
  ui.panel.update({ items: [item('first', { status: 'saving' }), item('second', { status: 'uploading' })], running: true, pauseRequested: true });
  assert.equal(ui.action().disabled, true);
  assert.equal(ui.action().textContent, '正在完成当前 2 项任务…');
  assert.match(ui.root.querySelector('.float').textContent, /2 个进行中/);
});

test('panel input and click events do not reach host page handlers', t => {
  const ui = harness(t, { fullPage: false });
  ui.update([item('first')]);
  const observed = [];
  for (const type of ['click', 'input', 'change']) ui.window.document.addEventListener(type, () => observed.push(type));
  const title = ui.root.querySelector('input[type="text"]');
  for (const type of ['click', 'input', 'change']) title.dispatchEvent(new ui.window.Event(type, { bubbles: true, composed: true }));
  assert.deepEqual(observed, []);
});
