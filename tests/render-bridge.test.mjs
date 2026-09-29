import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const source = await fs.readFile(new URL('../src/render-bridge.js', import.meta.url), 'utf8');
const KEY = '__WXVU_RENDER_BRIDGE_V1__';
const MARKER = 'c755a41f-30f2-4799-9f51-4e819a06ca9a';
const ROUTE = 'https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/videomsg_edit&action=video_edit&type=15&token=FIXTURE';
const WORKER = `${ROUTE}#wxvu-worker=${MARKER}`;

function harness({ url = WORKER, hidden = true, iframe = false, reporterThrows = false } = {}) {
  let time = 0;
  let nextId = 1;
  let isHidden = hidden;
  const nativeJobs = new Map();
  const cancelled = [];
  const errors = [];
  const forbidden = [];
  const document = {};
  Object.defineProperties(document, {
    hidden: { get: () => isHidden, set: () => { forbidden.push('hidden'); throw new Error('Do not change document visibility'); } },
    visibilityState: { get: () => isHidden ? 'hidden' : 'visible', set: () => { forbidden.push('visibilityState'); throw new Error('Do not change document visibility'); } },
  });
  const browser = {
    location: { href: url }, document,
    performance: { now: () => time },
    reportError(error) { errors.push(error); if (reporterThrows) throw new Error('Reporter failure'); },
    console: { error(error) { errors.push(error); } },
    setTimeout() { forbidden.push('setTimeout'); throw new Error('No page timers'); },
    focus() { forbidden.push('focus'); throw new Error('No focus change'); },
    requestAnimationFrame(callback) {
      assert.equal(this, browser);
      if (typeof callback !== 'function') throw new TypeError('A callback function is required');
      const id = nextId++;
      nativeJobs.set(id, callback);
      return id;
    },
    cancelAnimationFrame(id) {
      assert.equal(this, browser);
      if (arguments.length === 0) throw new TypeError('A handle is required');
      cancelled.push(id >>> 0);
      nativeJobs.delete(id >>> 0);
    },
  };
  browser.top = iframe ? {} : browser;
  const nativeRequest = browser.requestAnimationFrame;
  const nativeCancel = browser.cancelAnimationFrame;
  const context = vm.createContext({ window: browser, URL, URLSearchParams });
  const load = () => vm.runInContext(source, context, { filename: 'render-bridge.js' });
  load();
  return {
    window: browser, bridge: browser[KEY], nativeRequest, nativeCancel, nativeJobs, cancelled, errors, forbidden, load,
    advance(ms = 250) { time += ms; },
    visible(value = true) { isHidden = !value; },
    flush(timestamp = time) {
      if (isHidden) return;
      for (const [id, callback] of [...nativeJobs]) {
        if (!nativeJobs.has(id)) continue;
        nativeJobs.delete(id);
        callback.call(browser, timestamp);
      }
    },
  };
}

test('hidden cover completion progresses across animation frames without tab activation', () => {
  const page = harness();
  let modalOpen = true;
  let originalEnabled = false;
  const done = () => page.window.requestAnimationFrame(() => {
    page.window.requestAnimationFrame(() => { modalOpen = false; originalEnabled = true; });
  });
  done();
  page.flush();
  assert.equal(modalOpen, true, 'the hidden browser has paused its animation frames');
  page.bridge.pulse();
  assert.equal(modalOpen, true, 'nested animation frames must not run synchronously');
  page.advance();
  page.bridge.pulse();
  assert.equal(modalOpen, false);
  assert.equal(originalEnabled, true);
  assert.equal(page.bridge.stats().assisted, 2);
  assert.equal(page.bridge.stats().pending, 0);
  assert.equal(page.window.document.hidden, true);
  assert.deepEqual(page.forbidden, []);
});

test('native visible frames preserve native handle, window receiver and browser timestamp', () => {
  const page = harness({ hidden: false });
  const calls = [];
  const id = page.window.requestAnimationFrame(function (timestamp) { calls.push([this, timestamp]); });
  assert.equal(id, 1);
  assert.equal(page.nativeJobs.has(id), true);
  page.bridge.pulse();
  assert.equal(calls.length, 0);
  page.flush(42.25);
  assert.deepEqual(calls, [[page.window, 42.25]]);
  assert.equal(page.bridge.stats().assisted, 0);
  assert.equal(page.bridge.stats().frames, 1);
});

test('assisted callbacks use one monotonic timestamp and cannot be delivered twice', () => {
  const page = harness();
  const calls = [];
  const id = page.window.requestAnimationFrame(function (timestamp) { calls.push([this, timestamp]); });
  const alreadyQueuedNativeCallback = page.nativeJobs.get(id);
  page.advance(345.25);
  page.bridge.pulse();
  alreadyQueuedNativeCallback(350);
  page.visible();
  page.flush(400);
  assert.deepEqual(calls, [[page.window, 345.25]]);
  assert.deepEqual(page.cancelled, [id]);
  assert.equal(page.bridge.stats().frames, 1);
});

test('native completion before a hidden pulse is never repeated', () => {
  const page = harness({ hidden: false });
  let calls = 0;
  page.window.requestAnimationFrame(() => { calls += 1; });
  page.flush();
  page.visible(false);
  page.bridge.pulse();
  assert.equal(calls, 1);
  assert.equal(page.bridge.stats().assisted, 0);
});

test('cancellation includes another callback already captured by the same pulse', () => {
  const page = harness();
  const calls = [];
  let second;
  page.window.requestAnimationFrame(() => { calls.push('first'); page.window.cancelAnimationFrame(second); });
  second = page.window.requestAnimationFrame(() => calls.push('cancelled'));
  const stale = page.nativeJobs.get(second);
  page.bridge.pulse();
  stale(1);
  page.advance();
  page.bridge.pulse();
  assert.deepEqual(calls, ['first']);
  assert.equal(page.bridge.stats().pending, 0);
});

test('cancellation uses unsigned native handles and coerces an object only once', () => {
  const page = harness();
  let calls = 0;
  const first = page.window.requestAnimationFrame(() => { calls += 1; });
  const second = page.window.requestAnimationFrame(() => { calls += 1; });
  page.window.cancelAnimationFrame(String(first));
  let coercions = 0;
  page.window.cancelAnimationFrame({ valueOf() { coercions += 1; return second; } });
  page.bridge.pulse();
  assert.equal(calls, 0);
  assert.equal(coercions, 1);
  assert.deepEqual(page.cancelled, [first, second]);
  assert.throws(() => page.window.cancelAnimationFrame(1n), /BigInt/);
  assert.throws(() => page.window.cancelAnimationFrame(), /handle/);
  assert.throws(() => page.window.requestAnimationFrame(null), /callback/);
});

test('self-rescheduling and reentrant pulses are deferred to the next frame', () => {
  const page = harness();
  let calls = 0;
  function loop() {
    calls += 1;
    page.window.requestAnimationFrame(loop);
    page.advance();
    page.bridge.pulse();
  }
  page.window.requestAnimationFrame(loop);
  page.bridge.pulse();
  assert.equal(calls, 1);
  assert.equal(page.bridge.stats().pending, 1);
  page.bridge.pulse();
  assert.equal(calls, 2);
});

test('pulses respect a 200 ms minimum interval without installing their own timer', () => {
  const page = harness();
  let calls = 0;
  const add = () => page.window.requestAnimationFrame(() => { calls += 1; });
  add();
  page.bridge.pulse();
  add();
  page.advance(199);
  page.bridge.pulse();
  assert.equal(calls, 1);
  page.advance(1);
  page.bridge.pulse();
  assert.equal(calls, 2);
  assert.equal(page.bridge.stats().pulses, 2);
  assert.deepEqual(page.forbidden, []);
});

test('a pulse assists at most 200 callbacks and preserves remaining native jobs', () => {
  const page = harness();
  let calls = 0;
  for (let i = 0; i < 205; i += 1) page.window.requestAnimationFrame(() => { calls += 1; });
  page.bridge.pulse();
  assert.equal(calls, 200);
  assert.equal(page.bridge.stats().pending, 5);
  assert.equal(page.nativeJobs.size, 5);
  page.advance();
  page.bridge.pulse();
  assert.equal(calls, 205);
});

test('the frame time budget leaves unprocessed callbacks scheduled', () => {
  const page = harness();
  let calls = 0;
  for (let i = 0; i < 5; i += 1) {
    page.window.requestAnimationFrame(() => { calls += 1; page.advance(10); });
  }
  page.bridge.pulse();
  assert.equal(calls, 2);
  assert.equal(page.bridge.stats().pending, 3);
  page.visible();
  page.flush();
  assert.equal(calls, 5);
});

test('a callback exception and even a broken reporter cannot block other callbacks', () => {
  const page = harness({ reporterThrows: true });
  let calls = 0;
  const failure = new Error('Page animation failed');
  page.window.requestAnimationFrame(() => { throw failure; });
  page.window.requestAnimationFrame(() => { calls += 1; });
  assert.doesNotThrow(() => page.bridge.pulse());
  assert.equal(calls, 1);
  assert.deepEqual(page.errors, [failure]);
});

test('stop restores original methods and hands pending callbacks back with their original handles', () => {
  const page = harness();
  const calls = [];
  const first = page.window.requestAnimationFrame(() => calls.push('first'));
  const second = page.window.requestAnimationFrame(() => calls.push('cancelled'));
  page.bridge.stop();
  assert.equal(page.window.requestAnimationFrame, page.nativeRequest);
  assert.equal(page.window.cancelAnimationFrame, page.nativeCancel);
  assert.equal(page.nativeJobs.has(first), true);
  assert.equal(page.nativeJobs.has(second), true);
  page.window.cancelAnimationFrame(second);
  page.bridge.pulse();
  assert.deepEqual(calls, []);
  page.visible();
  page.flush(55);
  assert.deepEqual(calls, ['first']);
  assert.equal(page.bridge.stats().stopped, true);
  assert.equal(page.bridge.stats().assisted, 0);
  assert.equal(page.bridge.stats().pending, 0);
  page.bridge.stop();
});

test('stop inside a pulse preserves the remaining native callbacks', () => {
  const page = harness();
  const calls = [];
  page.window.requestAnimationFrame(() => { calls.push('assisted'); page.bridge.stop(); });
  page.window.requestAnimationFrame(() => calls.push('native'));
  page.bridge.pulse();
  assert.deepEqual(calls, ['assisted']);
  page.visible();
  page.flush();
  assert.deepEqual(calls, ['assisted', 'native']);
});

test('the bridge is frozen, idempotent, and does not replace a later page shim on stop', () => {
  const page = harness();
  assert.equal(Object.isFrozen(page.bridge), true);
  const request = page.window.requestAnimationFrame;
  page.load();
  assert.equal(page.window[KEY], page.bridge);
  assert.equal(page.window.requestAnimationFrame, request);
  const laterShim = () => 'later';
  page.window.requestAnimationFrame = laterShim;
  page.bridge.stop();
  assert.equal(page.window.requestAnimationFrame, laterShim);
});

test('ordinary pages, wrong routes and iframes retain their native functions', () => {
  const urls = [
    ROUTE,
    `${ROUTE}&wxvu-worker=${MARKER}`,
    WORKER.replace('https://', 'http://'),
    WORKER.replace('mp.weixin.qq.com', 'example.com'),
    WORKER.replace('/cgi-bin/appmsg', '/cgi-bin/filepage'),
    WORKER.replace('media/videomsg_edit', 'media/appmsg_edit'),
    WORKER.replace('video_edit', 'edit'),
    WORKER.replace('type=15', 'type=77'),
    WORKER.replace('token=FIXTURE', 'token=FIXTURE&type=15'),
    WORKER.replace(MARKER, 'not-a-worker'),
    `${WORKER}&wxvu-worker=${MARKER}`,
    WORKER.replace('https://', 'https://user:password@'),
  ];
  for (const url of urls) {
    const page = harness({ url });
    assert.equal(page.bridge, undefined, url);
    assert.equal(page.window.requestAnimationFrame, page.nativeRequest, url);
    assert.equal(page.window.cancelAnimationFrame, page.nativeCancel, url);
    assert.deepEqual(page.forbidden, []);
  }
  const frame = harness({ iframe: true });
  assert.equal(frame.bridge, undefined);
  assert.equal(frame.window.requestAnimationFrame, frame.nativeRequest);
});

test('a valid worker marker may coexist with other hash parameters', () => {
  const page = harness({ url: `${ROUTE}#section=upload&wxvu-worker=${MARKER}` });
  assert.equal(page.bridge.stats().version, 1);
  assert.equal(page.bridge.stats().hidden, true);
});
