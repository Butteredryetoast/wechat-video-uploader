import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const source = Object.fromEntries(['launcher', 'article-format', 'article-panel', 'panel', 'sidebar']
  .map(name => [name, readFileSync(new URL(`../src/${name}.js`, import.meta.url), 'utf8')]));
const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
const clone = value => JSON.parse(JSON.stringify(value));
const tick = () => new Promise(resolve => setImmediate(resolve));
const item = (id, extra = {}) => ({ id, name: `${id}.mp4`, size: 100, title: id, status: 'queued', hasFile: true, ...extra });

async function until(check) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await tick();
  }
  assert.fail('Combined tools did not settle');
}

// The background transport and editor inspection are mocked. Launcher, article
// parsing/preview, video rows, panel switching and minimize handlers are real.
async function harness(t) {
  const dom = new JSDOM('<!doctype html><html><body><main>公众号正文</main></body></html>', {
    runScripts: 'outside-only',
    url: 'https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit&action=edit&type=77'
  });
  t.after(() => dom.window.close());
  const { window } = dom;
  const calls = [];
  const listeners = new Set();
  const stored = {};
  const state = {
    snapshot: { items: [item('first'), item('second')], running: false, pauseRequested: false },
    runtimeInfo: { ready: true, reason: '上传入口已就绪', concurrency: 1, foregroundSerial: false },
    notice: { text: '', kind: 'info' }, ingesting: false
  };
  const storage = {
    get: async key => typeof key === 'string' ? { [key]: stored[key] } : { ...stored },
    set: async values => Object.assign(stored, values)
  };
  window.chrome = {
    storage: { local: storage, session: storage },
    runtime: {
      id: 'test-tool-launcher',
      onMessage: { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn) },
      sendMessage: async message => {
        calls.push(clone(message));
        if (message.namespace === 'wxvu.launcher' && message.command === 'openVideo') {
          await injectVideo();
          return { ok: true, result: {} };
        }
        if (message.namespace === 'wxvu.ui') {
          if (message.command === 'update') Object.assign(state.snapshot.items.find(row => row.id === message.payload.id), message.payload.changes);
          if (message.command === 'start') {
            state.snapshot.running = true;
            state.snapshot.items[0].status = 'uploading';
          }
          return { ok: true, result: message.command === 'state' ? clone(state) : {} };
        }
        return { ok: true, result: {} };
      }
    }
  };
  window.WXArticleEditor = {
    inspect: () => ({ ready: true, hasContent: true, canUndo: false }),
    insert: async () => { throw new Error('Switching tools must never insert article content'); }
  };
  ['launcher', 'article-format', 'article-panel'].forEach(name => window.eval(source[name]));
  const article = window.document.getElementById('wx-article-formatter').shadowRoot;
  const launcher = () => window.document.getElementById('wx-tool-launcher').shadowRoot;
  const video = () => window.document.getElementById('wx-video-batch-uploader')?.shadowRoot;
  const injectVideo = async () => {
    window.eval(source.panel);
    window.eval(source.sidebar);
    await until(() => calls.some(call => call.command === 'state'));
    await tick();
  };
  const pasteArticle = () => {
    const event = new window.Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: {
      getData: type => type === 'text/html' ? '<h2>一、功能说明</h2><p>保留 中文 GPT 6 原文</p><video></video><p>末尾内容</p>' : '一、功能说明\n保留 中文 GPT 6 原文\n[视频]\n末尾内容'
    } });
    article.querySelector('#article-paste').dispatchEvent(event);
    article.querySelector('.format').click();
  };
  const push = () => {
    for (const fn of listeners) fn({ namespace: 'wxvu.sidebar', command: 'state', payload: clone(state) }, { id: window.chrome.runtime.id });
  };
  return { window, article, launcher, video, calls, state, listeners, injectVideo, pasteArticle, push };
}

function assertUnifiedEntry(h) {
  assert.equal(h.window.document.querySelectorAll('#wx-tool-launcher').length, 1);
  assert.equal(h.launcher().querySelectorAll('.ball').length, 1);
  assert.equal(h.launcher().querySelector('.ball').hidden, false);
  assert.equal(h.article.querySelector('.launcher').hidden, true, 'old article entry stays hidden');
  if (h.video()) assert.equal(h.video().querySelector('.float').hidden, true, 'old video entry stays hidden');
}

test('manifest mounts one combined entry before the article UI without opening either panel', async t => {
  const scripts = manifest.content_scripts.find(entry => entry.js.includes('src/article-panel.js')).js;
  assert(scripts.indexOf('src/launcher.js') >= 0);
  assert(scripts.indexOf('src/launcher.js') < scripts.indexOf('src/article-panel.js'));
  const h = await harness(t);
  assertUnifiedEntry(h);
  assert.equal(h.article.querySelector('.panel').hidden, true);
  assert.equal(h.video(), undefined, 'video panel is lazy and does not cover the page at startup');
  assert.equal(h.calls.some(call => call.namespace === 'wxvu.ui'), false, 'mounting the article UI does not acquire or start a video queue');
});

test('floating menu lazily opens real video controls and then switches to article controls', async t => {
  const h = await harness(t);
  h.launcher().querySelector('.ball').click();
  assert.equal(h.launcher().querySelector('.menu').hidden, false);
  h.launcher().querySelector('[data-tool="video"]').click();
  await until(() => h.video()?.querySelector('.panel').hidden === false);
  await tick();
  assert.equal(h.article.querySelector('.panel').hidden, true);
  assert.equal(h.launcher().querySelector('.menu').hidden, true);
  assert.equal(h.calls.filter(call => call.namespace === 'wxvu.launcher' && call.command === 'openVideo').length, 1);
  assertUnifiedEntry(h);

  h.launcher().querySelector('.ball').click();
  h.launcher().querySelector('[data-tool="article"]').click();
  assert.equal(h.video().querySelector('.panel').hidden, true);
  assert.equal(h.article.querySelector('.panel').hidden, false);
  assert.equal(h.launcher().querySelector('.menu').hidden, true);
  h.launcher().querySelector('.ball').click();
  h.launcher().querySelector('[data-tool="video"]').click();
  await tick();
  assert.equal(h.video().querySelector('.panel').hidden, false);
  assert.equal(h.calls.filter(call => call.namespace === 'wxvu.launcher' && call.command === 'openVideo').length, 1,
    'the registered video panel is reused without a second background injection');
  assertUnifiedEntry(h);
});

test('switching real article and video panels preserves draft formatting, queued titles and active upload progress', async t => {
  const h = await harness(t);
  await h.window.WXToolLauncher.open('article');
  h.pasteArticle();
  const input = h.article.querySelector('#article-paste');
  const draft = input.value;
  h.article.querySelector('.color').value = '#e97713';
  h.article.querySelector('.color').dispatchEvent(new h.window.Event('input'));
  const preview = h.article.querySelector('.preview').innerHTML;
  assert(preview.includes('20px'));
  assert(preview.includes('中文GPT 6原文'));

  await h.injectVideo();
  await h.window.WXToolLauncher.open('video');
  assert.equal(h.article.querySelector('.panel').hidden, true);
  assert.equal(h.video().querySelector('.panel').hidden, false);
  assertUnifiedEntry(h);
  const title = h.video().querySelector('input[type="text"]');
  title.value = '排版时保留的视频标题';
  title.dispatchEvent(new h.window.Event('input', { bubbles: true }));
  await until(() => h.state.snapshot.items[0].title === title.value);
  await tick();
  h.video().querySelector('.main-action').click();
  await until(() => h.calls.some(call => call.command === 'start'));
  await until(() => h.video().querySelector('.stat[data-kind="active"] strong').textContent === '1');

  await h.window.WXToolLauncher.open('article');
  assert.equal(h.video().querySelector('.panel').hidden, true);
  assert.equal(h.article.querySelector('.panel').hidden, false);
  assert.equal(h.article.querySelector('#article-paste'), input, 'same draft field survives switching');
  assert.equal(input.value, draft);
  assert.equal(h.article.querySelector('.preview').innerHTML, preview);
  assert.equal(h.article.querySelector('.color').value, '#e97713');
  assertUnifiedEntry(h);

  h.state.snapshot.items[0].status = 'submitted';
  h.state.snapshot.items[1].status = 'uploading';
  h.push();
  assert.match(h.launcher().querySelector('.video-progress').textContent, /上传中.*1\/2/,
    'collapsed video panel continues updating the shared entry');
  await h.window.WXToolLauncher.open('video');
  assert.equal(h.video().querySelector('input[type="text"]').value, '排版时保留的视频标题');
  assert.equal(h.video().querySelector('.stat[data-kind="done"] strong').textContent, '1');
  assert.equal(h.video().querySelector('.stat[data-kind="active"] strong').textContent, '1');
  assert.equal(h.state.snapshot.running, true);
  assert.equal(h.calls.filter(call => call.command === 'start').length, 1);
  assert.equal(h.calls.some(call => ['pause', 'remove', 'retry', 'file.cancel'].includes(call.command)), false);
});

test('minimize and close keep one floating entry and do not pause a running video queue', async t => {
  const h = await harness(t);
  await h.injectVideo();
  h.state.snapshot.running = true;
  h.state.snapshot.items[0].status = 'processing';
  h.push();
  for (const label of ['折叠面板，任务继续', '收起面板，不暂停上传']) {
    await h.window.WXToolLauncher.open('video');
    h.video().querySelector(`[aria-label="${label}"]`).click();
    assert.equal(h.video().querySelector('.panel').hidden, true);
    assert.equal(h.article.querySelector('.panel').hidden, true);
    assertUnifiedEntry(h);
  }
  await h.window.WXToolLauncher.open('article');
  h.pasteArticle();
  const draft = h.article.querySelector('#article-paste').value;
  h.article.querySelector('.close').click();
  assert.equal(h.article.querySelector('.panel').hidden, true);
  assertUnifiedEntry(h);
  await h.window.WXToolLauncher.open('article');
  assert.equal(h.article.querySelector('#article-paste').value, draft);
  assert.equal(h.state.snapshot.running, true);
  assert.equal(h.state.snapshot.pauseRequested, false);
  assert.equal(h.calls.some(call => ['pause', 'remove', 'retry', 'file.cancel'].includes(call.command)), false);
});

test('reinjection reuses the combined entry and existing draft, video rows and runtime subscription', async t => {
  const h = await harness(t);
  await h.injectVideo();
  await h.window.WXToolLauncher.open('article');
  h.pasteArticle();
  const host = h.window.document.getElementById('wx-tool-launcher');
  const draft = h.article.querySelector('#article-paste');
  const preview = h.article.querySelector('.preview').innerHTML;
  const videoTitle = h.video().querySelector('input[type="text"]');
  const subscriptions = h.listeners.size;
  for (let i = 0; i < 2; i++) {
    ['launcher', 'article-format', 'article-panel', 'panel', 'sidebar'].forEach(name => h.window.eval(source[name]));
    assertUnifiedEntry(h);
    assert.equal(h.window.document.getElementById('wx-tool-launcher'), host);
    assert.equal(h.window.document.querySelectorAll('#wx-article-formatter').length, 1);
    assert.equal(h.window.document.querySelectorAll('#wx-video-batch-uploader').length, 1);
    assert.equal(h.article.querySelector('#article-paste'), draft);
    assert.equal(h.article.querySelector('.preview').innerHTML, preview);
    assert.equal(h.video().querySelector('input[type="text"]'), videoTitle);
    assert.equal(h.listeners.size, subscriptions);
  }
  await h.window.WXToolLauncher.open('article');
  assert.equal(h.article.querySelector('.panel').hidden, false);
  assert.equal(h.video().querySelector('.panel').hidden, true);
  assert.equal(h.state.snapshot.items.length, 2);
  assert.equal(h.calls.some(call => ['start', 'pause', 'remove', 'retry'].includes(call.command)), false);
});
