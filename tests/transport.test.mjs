import test from 'node:test';
import assert from 'node:assert/strict';
import { File } from 'node:buffer';
import '../src/transport.js';
import '../src/queue.js';

const Transport = globalThis.WXVideoTransport;
const Queue = globalThis.WXVideoQueue;
const ADD_URL = 'https://mp.weixin.qq.com/cgi-bin/appmsg?action=video_edit';
const MATERIAL_URL = 'https://mp.weixin.qq.com/cgi-bin/appmsg?action=list&type=15';
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };

function makeItem(name = 'first.mp4', bytes = new Uint8Array([1, 2, 3])) {
  const file = new File([bytes], name, { type: 'video/mp4', lastModified: 1234 });
  return { id: name, name, size: file.size, type: file.type, lastModified: file.lastModified, title: name.replace(/\.[^.]+$/, ''), file };
}

function harness({ saveError, saveResult = {}, status, prepare, verify = () => ({ verified: true }), url = ADD_URL,
  renderPulse, onRenderState, onProgress, verifyAfterSave } = {}) {
  let currentUrl = url;
  let clock = 100_000;
  let agreementNeeded = true;
  const events = [];
  const commands = [];
  const api = {
    tabs: {
      get: async (tabId) => ({ id: tabId, url: currentUrl, status: 'complete' }),
      update: async (tabId, update) => {
        events.push({ kind: 'navigate', url: update.url });
        currentUrl = update.url;
        return { id: tabId, url: currentUrl, status: 'complete' };
      },
      sendMessage: async (_tabId, message) => {
        assert.equal(message.namespace, 'wxvu.page');
        commands.push(message);
        events.push({ kind: 'command', command: message.command, payload: message.payload });
        const payload = message.payload;
        let result = {};
        switch (message.command) {
          case 'inspect':
            result = { ready: currentUrl === ADD_URL, pageKind: currentUrl === ADD_URL ? 'add-video' : 'video-list' };
            break;
          case 'begin':
            agreementNeeded = true;
            break;
          case 'status':
            result = status ? await status(payload) : { uploadComplete: true, needsAgreement: agreementNeeded, readyToSave: !agreementNeeded };
            break;
          case 'prepare':
            result = prepare ? await prepare(payload) : { prepared: true, pending: false, needsPreparation: false, preparationReady: true };
            break;
          case 'agree':
            agreementNeeded = false;
            break;
          case 'save':
            currentUrl = MATERIAL_URL;
            if (saveError) throw saveError;
            result = saveResult;
            break;
          case 'verify':
            result = await verify(payload);
            events.push({ kind: 'verify-result', id: payload.id, verified: result.verified });
            break;
        }
        return { ok: true, result };
      },
    },
    scripting: {
      executeScript: async (args) => {
        events.push({ kind: 'inject', args });
        return [];
      },
    },
  };
  const transport = new Transport({
    targetTabId: 7,
    api,
    renderPulse,
    onRenderState,
    onProgress,
    verifyAfterSave,
    now: () => clock,
    wait: async (milliseconds) => { clock += milliseconds; },
  });
  return { transport, api, commands, events, navigate: (next) => { currentUrl = next; } };
}

function hooks(events, { beforeTransition } = {}) {
  return {
    transition: async (status) => {
      if (beforeTransition) await beforeTransition(status);
      events.push({ kind: 'checkpoint', status });
    },
    shouldPause: () => false,
  };
}

test('agreement is followed by exactly one save command after the durable saving checkpoint', async () => {
  const h = harness();
  const result = await h.transport.upload(makeItem(), hooks(h.events));
  assert.deepEqual(result, { verified: true });
  const names = h.commands.map((message) => message.command);
  assert.equal(names.filter((name) => name === 'agree').length, 1);
  assert.equal(names.filter((name) => name === 'save').length, 1);
  assert(names.indexOf('agree') < names.indexOf('save'));
  const checkpoint = h.events.findIndex((event) => event.kind === 'checkpoint' && event.status === 'saving');
  const save = h.events.findIndex((event) => event.kind === 'command' && event.command === 'save');
  assert(checkpoint >= 0 && checkpoint < save);
  assert(!names.some((name) => /publish|send|broadcast/i.test(name)));
  assert(Number.isFinite(h.commands.find((message) => message.command === 'verify').payload.savedAt));
});

test('a rejected saving checkpoint prevents the save command and verification', async () => {
  const h = harness();
  await assert.rejects(h.transport.upload(makeItem(), hooks(h.events, {
    beforeTransition: async (status) => { if (status === 'saving') throw new Error('storage quota exceeded'); },
  })), /storage quota exceeded/);
  assert(!h.commands.some((message) => ['save', 'verify'].includes(message.command)));
  assert.equal(h.transport.lastVerified, false);
});

test('a save response lost during navigation only enters verification and never resends save', async () => {
  let verifications = 0;
  const h = harness({
    saveError: new Error('The message port closed before a response was received.'),
    verify: () => ++verifications === 1 ? { verified: false, reason: 'loading list' } : { verified: true },
  });
  const result = await h.transport.upload(makeItem(), hooks(h.events));
  assert.equal(result.verified, true);
  assert.equal(verifications, 2);
  assert.equal(h.commands.filter((message) => message.command === 'save').length, 1);
  assert.equal(h.transport.lastVerified, true);
  const afterSave = h.commands.slice(h.commands.findIndex((message) => message.command === 'save') + 1);
  assert(afterSave.every((message) => message.command === 'verify'));
});

test('verification timeout returns uncertainty rather than a successful upload', async () => {
  const h = harness({ verify: () => ({ verified: false, reason: 'no matching saved material' }) });
  h.transport.verifyTimeout = 1500;
  await assert.rejects(h.transport.upload(makeItem(), hooks(h.events)), (error) => {
    assert.equal(error.uncertain, true);
    assert.match(error.message, /人工核对/);
    return true;
  });
  assert.equal(h.transport.lastVerified, false);
  assert.equal(h.commands.filter((message) => message.command === 'save').length, 1);
  assert(h.commands.some((message) => message.command === 'verify'));
  assert(!h.events.some((event) => event.kind === 'navigate'));
});

test('a queued next video opens a fresh add page only after the previous video was verified', async () => {
  const checking = deferred();
  const release = deferred();
  let first = true;
  const h = harness({ verify: async () => {
    if (first) {
      first = false;
      checking.resolve();
      await release.promise;
    }
    return { verified: true };
  } });
  const queue = new Queue();
  await queue.addFiles([makeItem('first.mp4').file, makeItem('second.mp4').file]);
  const run = queue.start(h.transport);
  await checking.promise;
  assert.equal(queue.snapshot().items[0].status, 'verifying');
  assert.equal(queue.snapshot().items[1].status, 'queued');
  assert(!h.events.some((event) => event.kind === 'navigate'));
  assert.equal(h.commands.filter((message) => message.command === 'begin').length, 1);
  release.resolve();
  await run;
  assert(queue.snapshot().items.every((item) => item.status === 'succeeded'));
  assert.equal(h.events.filter((event) => event.kind === 'navigate').length, 1);
  const verified = h.events.findIndex((event) => event.kind === 'verify-result' && event.verified);
  const navigation = h.events.findIndex((event) => event.kind === 'navigate');
  assert(verified >= 0 && navigation > verified);
  assert.equal(h.commands.filter((message) => message.command === 'save').length, 2);
});

test('inspection refuses script injection when the target tab has left the WeChat origin', async () => {
  const h = harness({ url: 'https://example.com/' });
  await assert.rejects(h.transport.inspect(), /离开微信域名/);
  assert(!h.events.some((event) => event.kind === 'inject'));
  assert.equal(h.commands.length, 0);
});

test('a verified material-list page remains ready for resume and freshPage restores the add page', async () => {
  const h = harness();
  await h.transport.upload(makeItem(), hooks(h.events));
  assert.equal(h.transport.lastVerified, true);
  assert.equal(h.transport.lastVerifiedUrl, MATERIAL_URL);
  const pausedInspection = await h.transport.inspect();
  assert.equal(pausedInspection.pageKind, 'video-list');
  assert.equal(pausedInspection.ready, true);
  assert(!h.events.some((event) => event.kind === 'navigate'));
  await h.transport.freshPage();
  assert.equal(h.transport.lastVerified, false);
  const resumedInspection = await h.transport.inspect();
  assert.equal(resumedInspection.pageKind, 'add-video');
  assert.equal(resumedInspection.ready, true);
  assert.equal(h.events.filter((event) => event.kind === 'navigate').length, 1);
});

test('a manual move away from the verified page prevents automatic return navigation', async () => {
  const h = harness();
  await h.transport.upload(makeItem(), hooks(h.events));
  h.navigate('https://mp.weixin.qq.com/cgi-bin/home');
  const inspection = await h.transport.inspect();
  assert.equal(inspection.ready, false);
  await assert.rejects(h.transport.freshPage(), /页面已被手动切换/);
  assert(!h.events.some((event) => event.kind === 'navigate'));
});

test('each command rechecks the target origin after the initial injection', async () => {
  const h = harness();
  await h.transport.inspect();
  h.navigate('https://example.com/');
  await assert.rejects(h.transport.command('save', { id: 'first.mp4' }), /离开微信域名/);
  assert(!h.commands.some((message) => message.command === 'save'));
});

test('delayed upload and preparation DOM states are polled without repeating attachment or save', async () => {
  let polls = 0;
  let preparations = 0;
  let uploadComplete = false;
  const h = harness({
    status: () => {
      uploadComplete = ++polls >= 3;
      return {
        uploadComplete,
        needsPreparation: true,
        preparationReady: preparations >= 3,
        readyToSave: true,
        ...(preparations >= 3 ? { needsPreparation: false } : {}),
        reason: uploadComplete ? '等待封面和原创设置' : '等待上传状态确认',
      };
    },
    prepare: () => {
      assert.equal(uploadComplete, true, 'preparation must wait for confirmed upload completion');
      preparations++;
      return { prepared: preparations >= 3, pending: preparations < 3, reason: '等待设置界面更新' };
    },
  });
  const result = await h.transport.upload(makeItem(), hooks(h.events));
  assert.equal(result.verified, true);
  assert.equal(preparations, 3);
  assert(polls >= 6);
  const names = h.commands.map((message) => message.command);
  assert.equal(names.filter((name) => name === 'attach').length, 1);
  assert.equal(names.filter((name) => name === 'save').length, 1);
  assert.equal(names.filter((name) => name === 'agree').length, 0);
  assert(names.lastIndexOf('prepare') < names.indexOf('save'));
});

test('preparation that stays pending reaches the bounded upload deadline without saving', async () => {
  const h = harness({
    status: () => ({ uploadComplete: true, needsPreparation: true, preparationReady: false, readyToSave: false }),
    prepare: () => ({ prepared: false, pending: true, reason: '推荐封面仍未出现' }),
  });
  h.transport.uploadTimeout = 3000;
  await assert.rejects(h.transport.upload(makeItem(), hooks(h.events)), /保存准备完成超时.*推荐封面仍未出现/);
  const names = h.commands.map((message) => message.command);
  assert.equal(names.filter((name) => name === 'prepare').length, 3);
  assert.equal(names.filter((name) => name === 'attach').length, 1);
  assert(!names.includes('save'));
  assert(!names.includes('verify'));
  assert(!h.events.some((event) => event.kind === 'checkpoint' && event.status === 'saving'));
});

test('switching the active tab during upload never redirects or focuses the bound target tab', async () => {
  const h = harness();
  let activeTabId = 7;
  let inactiveOperations = 0;
  const originalGet = h.api.tabs.get;
  h.api.tabs.get = async (tabId) => {
    assert.equal(tabId, 7);
    if (activeTabId !== tabId) inactiveOperations++;
    return { ...await originalGet(tabId), active: activeTabId === tabId };
  };
  const originalMessage = h.api.tabs.sendMessage;
  h.api.tabs.sendMessage = async (tabId, message) => {
    assert.equal(tabId, 7);
    if (message.command === 'attach') activeTabId = 99;
    return originalMessage(tabId, message);
  };
  const originalUpdate = h.api.tabs.update;
  h.api.tabs.update = async (tabId, update) => {
    assert.equal(tabId, 7);
    assert.equal(Object.hasOwn(update, 'active'), false);
    assert.equal(Object.hasOwn(update, 'highlighted'), false);
    return originalUpdate(tabId, update);
  };
  const originalInject = h.api.scripting.executeScript;
  h.api.scripting.executeScript = async (args) => {
    assert.equal(args.target.tabId, 7);
    return originalInject(args);
  };
  h.api.tabs.query = async () => { assert.fail('the current active tab must never be queried'); };
  h.api.tabs.highlight = async () => { assert.fail('background uploading must never highlight a tab'); };
  h.api.windows = { update: async () => { assert.fail('background uploading must never focus a window'); } };
  await h.transport.upload(makeItem('first.mp4'), hooks(h.events));
  await h.transport.upload(makeItem('second.mp4'), hooks(h.events));
  assert(inactiveOperations > 0);
  assert.equal(activeTabId, 99);
  assert.equal(h.commands.filter((message) => message.command === 'save').length, 2);
  assert.equal(h.events.filter((event) => event.kind === 'navigate').length, 1);
});

test('real File bytes arrive intact in ordered chunks with base64 payloads at most 512 KiB', async () => {
  const bytes = new Uint8Array(1_100_003);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 17 + 31) % 256;
  const item = makeItem('large.mp4', bytes);
  const h = harness();
  await h.transport.upload(item, hooks(h.events));
  const chunks = h.commands.filter((message) => message.command === 'chunk');
  assert(chunks.length > 1);
  const decoded = chunks.map(({ payload }, index) => {
    assert.equal(payload.id, item.id);
    assert.equal(payload.index, index);
    assert(payload.data.length <= 512 * 1024);
    const data = Buffer.from(payload.data, 'base64');
    assert(data.length <= 384 * 1024);
    return data;
  });
  assert.deepEqual(Buffer.concat(decoded), Buffer.from(bytes));
  const attachIndex = h.commands.findIndex((message) => message.command === 'attach');
  const finalChunkIndex = h.commands.findLastIndex((message) => message.command === 'chunk');
  assert(attachIndex > finalChunkIndex);
});

test('a newly created worker waits for navigation and form readiness before any upload commands', async()=>{
  const h=harness();
  let reads=0,forms=0;
  const originalGet=h.api.tabs.get;
  const originalSend=h.api.tabs.sendMessage;
  h.api.tabs.get=async id=>({...await originalGet(id),status:++reads<3?'loading':'complete'});
  h.api.tabs.sendMessage=async (id,message)=>message.command==='inspect' && ++forms<3
    ? {ok:true,result:{ready:false,pageKind:'add-video',reason:'初始化上传组件'}} : originalSend(id,message);
  const state=await h.transport.waitUntilReady();
  assert.equal(state.ready,true);
  assert(forms>=3);
  assert(h.commands.every(message=>message.command==='inspect'));
  assert(!h.events.some(event=>event.kind==='navigate'));
});

test('a worker that never loads a fresh form times out without attaching or navigating', async()=>{
  const h=harness();
  h.api.tabs.sendMessage=async()=>({ok:true,result:{ready:false,pageKind:'add-video',reason:'已存在视频'}});
  await assert.rejects(h.transport.waitUntilReady(),/加载超时.*已存在视频/);
  assert.equal(h.commands.length,0);
  assert(!h.events.some(event=>event.kind==='navigate'));
});

test('hidden cover and original rendering advance through bounded worker pulses before status deadlines', async () => {
  let phase = 'cover';
  let started = null;
  const frames = [];
  const pulseTimes = [];
  const renderStates = [];
  const enqueueFrames = (count, done) => frames.push(() => count > 1 ? enqueueFrames(count - 1, done) : done());
  const h = harness({
    status: () => {
      if (phase === 'cover-wait' && h.transport.now() - started >= 1000)
        return { error: '封面已点击完成但窗口未关闭' };
      return { uploadComplete: true, needsPreparation: phase !== 'ready', preparationReady: phase === 'ready', readyToSave: phase === 'ready' };
    },
    prepare: () => {
      if (phase === 'cover') {
        phase = 'cover-wait';
        started = h.transport.now();
        enqueueFrames(3, () => { phase = 'original'; });
      } else if (phase === 'original') {
        phase = 'original-wait';
        enqueueFrames(2, () => { phase = 'ready'; });
      }
      return { pending: phase !== 'ready', reason: '等待编辑窗口关闭' };
    },
    renderPulse: async () => {
      assert(!h.commands.some(message => message.command === 'save'), 'material verification must not pulse the editor');
      pulseTimes.push(h.transport.now());
      const scheduled = frames.splice(0);
      scheduled.forEach(callback => callback());
      return { supported: true, hidden: true, pending: frames.length, assisted: scheduled.length };
    },
    onRenderState: state => renderStates.push(state),
  });
  h.api.tabs.update = async () => assert.fail('render assistance must not focus, navigate or refresh the worker');
  assert.equal((await h.transport.upload(makeItem(), hooks(h.events))).verified, true);
  assert.equal(phase, 'ready');
  assert.equal(frames.length, 0);
  assert(pulseTimes.length >= 6);
  assert(pulseTimes.every((time, index) => !index || time - pulseTimes[index - 1] >= 250));
  assert.deepEqual(renderStates, [
    { supported: true, hidden: true, assisted: false },
    { supported: true, hidden: true, assisted: true },
  ]);
  assert.equal(h.commands.filter(message => message.command === 'attach').length, 1);
  assert.equal(h.commands.filter(message => message.command === 'save').length, 1);
});

test('render pulses share one in-flight callback and never run more than once every 250 ms', async () => {
  const entered = deferred();
  const release = deferred();
  let calls = 0;
  const h = harness({ renderPulse: async () => {
    calls++;
    entered.resolve();
    await release.promise;
    return { supported: true, hidden: true, assisted: 0 };
  } });
  const first = h.transport._pulseRender();
  const second = h.transport._pulseRender();
  await entered.promise;
  assert.equal(calls, 1);
  release.resolve();
  await Promise.all([first, second]);
  await h.transport._pulseRender();
  assert.equal(calls, 1);
  await h.transport.wait(249);
  await h.transport._pulseRender();
  assert.equal(calls, 1);
  await h.transport.wait(1);
  await h.transport._pulseRender();
  assert.equal(calls, 2);
});

test('initial worker readiness can release a hidden pending animation frame before inspecting the form', async () => {
  let framePending = true;
  const h = harness({ renderPulse: async () => {
    const assisted = framePending ? 1 : 0;
    framePending = false;
    return { supported: true, hidden: true, assisted };
  } });
  const send = h.api.tabs.sendMessage;
  h.api.tabs.sendMessage = async (tabId, message) => {
    if (message.command === 'inspect' && framePending)
      return { ok: true, result: { ready: false, pageKind: 'add-video', reason: '初始化组件' } };
    return send(tabId, message);
  };
  assert.equal((await h.transport.waitUntilReady()).ready, true);
  assert.equal(framePending, false);
  assert(h.commands.every(message => message.command === 'inspect'));
});

test('missing rendering support warns once and preserves the existing upload path', async () => {
  const notices = [];
  const states = [];
  const h = harness({ renderPulse: async () => ({ supported: false }), onRenderState: state => states.push(state) });
  h.transport.onNotice = text => notices.push(text);
  assert.equal((await h.transport.upload(makeItem(), hooks(h.events))).verified, true);
  assert.equal(notices.filter(text => text.includes('后台渲染辅助尚未加载')).length, 1);
  assert.equal(states.length, 1);
  assert.equal(states[0].supported, false);
  assert.equal(h.commands.filter(message => message.command === 'save').length, 1);
});

test('an unexpected rendering channel failure before Save remains an error and never submits the item', async () => {
  const h = harness({ renderPulse: async () => { throw new Error('render message port disconnected'); } });
  await assert.rejects(h.transport.upload(makeItem(), hooks(h.events)), /render message port disconnected/);
  assert.equal(h.commands.filter(message => message.command === 'attach').length, 1);
  assert(!h.commands.some(message => message.command === 'save'));
  assert(!h.events.some(event => event.kind === 'navigate'));
});

test('frozen or discarded workers require waking or review without reinjection, refresh or upload', async () => {
  for (const flag of ['frozen', 'discarded']) {
    const h = harness({ renderPulse: async () => assert.fail('a suspended tab cannot be pulsed') });
    const get = h.api.tabs.get;
    h.api.tabs.get = async id => ({ ...await get(id), [flag]: true });
    await assert.rejects(h.transport.waitUntilReady(), flag === 'frozen' ? /冻结.*唤醒/ : /回收.*核对素材库/);
    await assert.rejects(h.transport.upload(makeItem(), hooks(h.events)), /标签页已被 Chrome/);
    assert.equal(h.commands.length, 0);
    assert(!h.events.some(event => ['inject', 'navigate'].includes(event.kind)));
  }
});

test('freezing after Save is uncertain and never retries or redirects the upload', async () => {
  const h = harness();
  let saved = false;
  const get = h.api.tabs.get;
  const send = h.api.tabs.sendMessage;
  h.api.tabs.get = async id => ({ ...await get(id), frozen: saved });
  h.api.tabs.sendMessage = async (id, message) => {
    const result = await send(id, message);
    if (message.command === 'save') saved = true;
    return result;
  };
  await assert.rejects(h.transport.upload(makeItem(), hooks(h.events)), error => {
    assert.equal(error.uncertain, true);
    assert.match(error.message, /冻结.*唤醒/);
    return true;
  });
  assert.equal(h.commands.filter(message => message.command === 'save').length, 1);
  assert(!h.events.some(event => event.kind === 'navigate'));
});

test('a lost worker binding after Save is reported as uncertain immediately with its actual code', async () => {
  const progress = [];
  const h = harness({ onProgress: state => progress.push(state) });
  const get = h.api.tabs.get;
  h.api.tabs.get = async id => {
    const tab = await get(id);
    if (tab.url === MATERIAL_URL) {
      const error = new Error('此页面不是当前上传队列绑定的页面。');
      error.code = 'WORKER_UNBOUND';
      throw error;
    }
    return tab;
  };
  const started = h.transport.now();
  await assert.rejects(h.transport.upload(makeItem(), hooks(h.events)), error => {
    assert.equal(error.code, 'WORKER_UNBOUND');
    assert.equal(error.uncertain, true);
    assert.match(error.message, /绑定/);
    return true;
  });
  assert(h.transport.now() - started < 5000, 'a terminal binding error must not wait through the 90 second verification deadline');
  assert.equal(h.commands.filter(message => message.command === 'save').length, 1);
  assert.equal(progress.at(-1).phase, 'verifying');
  assert.equal(progress.at(-1).code, 'WORKER_UNBOUND');
  assert(!progress.at(-1).reason.includes('页面正在跳转'));
  assert(!h.events.some(event => event.kind === 'navigate'));
});

test('a closed-tab response to Save remains uncertain and never retries the side effect', async () => {
  const closed = Object.assign(new Error('上传标签页已关闭'), { code: 'TAB_CLOSED' });
  const h = harness({ saveError: closed });
  await assert.rejects(h.transport.upload(makeItem(), hooks(h.events)), error => {
    assert.equal(error.uncertain, true);
    assert.equal(error.code, 'TAB_CLOSED');
    return true;
  });
  assert.equal(h.commands.filter(message => message.command === 'save').length, 1);
  assert(!h.commands.some(message => message.command === 'verify'));
});

test('transient verification-channel errors keep their reason while a later read can confirm the same Save', async () => {
  const progress = [];
  let attempts = 0;
  const h = harness({ onProgress: state => progress.push(state), verify: () => {
    if (++attempts === 1) throw new Error('The message port closed before a response was received.');
    return { verified: true };
  } });
  assert.equal((await h.transport.upload(makeItem(), hooks(h.events))).verified, true);
  assert.equal(attempts, 2);
  assert.equal(h.commands.filter(message => message.command === 'save').length, 1);
  assert(progress.some(state => state.phase === 'verifying' && state.reason.includes('message port closed')));
  assert.equal(progress.at(-1).phase, 'succeeded');
});

test('progress records merge unchanged preparation polls and expose only approved diagnostic fields', async () => {
  const progress = [];
  let preparations = 0;
  const preparation = { phase: 'cover-editor', coverCandidateCount: 8, firstCoverSelected: false, coverEditorCount: 1,
    coverConfirmationSent: true, originalControlCount: 1, originalEnabled: false, originalDialogCount: 0,
    originalConfirmationSent: false, agreementChecked: false, url: 'PRIVATE', html: '<form>PRIVATE</form>' };
  const h = harness({ onProgress: state => progress.push(state), status: () => ({
    uploadComplete: true, needsPreparation: preparations < 3, preparationReady: preparations >= 3,
    readyToSave: preparations >= 3, reason: '等待封面', preparation, file: 'PRIVATE', url: 'PRIVATE', documentHidden: true,
  }), prepare: () => { preparations++; return { pending: true, reason: '等待封面', privateData: 'PRIVATE' }; } });
  assert.equal((await h.transport.upload(makeItem(), hooks(h.events))).verified, true);
  const preparing = progress.filter(state => state.phase === 'preparing');
  assert.equal(preparing.length, 3);
  assert.deepEqual(preparing[0], preparing[1]);
  assert.equal(preparing[0].preparation.coverEditorCount, 1);
  assert.equal(preparing[0].preparation.coverConfirmationSent, true);
  assert.equal(preparing[0].documentHidden, true);
  assert(!JSON.stringify(progress).includes('PRIVATE'));
  const prepareIndexes = progress.map((state, index) => state.phase === 'preparing' ? index : -1).filter(index => index >= 0);
  assert.equal(prepareIndexes.at(-1) - prepareIndexes[0], prepareIndexes.length - 1);
});

test('progress observers cannot interrupt uploads and native missing-tab errors are classified narrowly', async () => {
  const h = harness({ onProgress: () => { throw new Error('observer failed'); } });
  assert.equal((await h.transport.upload(makeItem(), hooks(h.events))).verified, true);
  const missing = harness();
  missing.api.tabs.get = async () => { throw new Error('No tab with id: 7.'); };
  await assert.rejects(missing.transport.waitUntilReady(), error => error.code === 'TAB_CLOSED');
  const other = harness();
  other.api.tabs.get = async () => { throw new Error('temporary browser connection failure'); };
  await assert.rejects(other.transport.waitUntilReady(), error => error.code === undefined && error.message === 'temporary browser connection failure');
});

test('submission-only mode advances immediately after an acknowledged Save without verifying material storage', async () => {
  const progress = [];
  const h = harness({ verifyAfterSave: false, saveResult: { clicked: true }, onProgress: state => progress.push(state),
    verify: () => assert.fail('submission-only mode must not inspect the material library') });
  let savedAt;
  const send = h.api.tabs.sendMessage;
  h.api.tabs.sendMessage = async (tabId, message) => {
    if (message.command === 'save') savedAt = h.transport.now();
    return send(tabId, message);
  };
  assert.deepEqual(await h.transport.upload(makeItem(), hooks(h.events)), { submitted: true, verified: false });
  assert.equal(h.transport.now(), savedAt, 'no verification delay may follow the acknowledged Save');
  assert.equal(h.transport.lastVerified, false);
  assert.equal(h.transport.lastVerifiedUrl, null);
  assert.equal(h.commands.filter(message => message.command === 'save').length, 1);
  assert(!h.commands.some(message => message.command === 'verify'));
  assert(!h.events.some(event => event.kind === 'checkpoint' && event.status === 'verifying'));
  const checkpoint = h.events.findIndex(event => event.kind === 'checkpoint' && event.status === 'saving');
  const save = h.events.findIndex(event => event.kind === 'command' && event.command === 'save');
  assert(checkpoint >= 0 && checkpoint < save);
  assert.deepEqual(progress.at(-1), { phase: 'submitted', reason: '保存已提交，将继续下一项。', verified: false, submitted: true });
  assert(!JSON.stringify(progress.at(-1)).includes('已保存到素材库'));
  assert(h.commands.findIndex(message => message.command === 'agree') < h.commands.findIndex(message => message.command === 'save'));
});

test('submission-only mode treats a lost Save channel as uncertain and does not wait or click again', async () => {
  const progress = [];
  const h = harness({ verifyAfterSave: false, saveError: new Error('The message port closed before a response was received.'),
    onProgress: state => progress.push(state) });
  const result = await h.transport.upload(makeItem(), hooks(h.events));
  assert.equal(result.uncertain, true);
  assert.equal(result.verified, false);
  assert.equal(result.submitted, undefined);
  assert.match(result.reason, /保存响应未确认.*继续下一项.*message port closed/);
  assert.equal(h.commands.filter(message => message.command === 'save').length, 1);
  assert(!h.commands.some(message => message.command === 'verify'));
  assert(!h.events.some(event => event.kind === 'checkpoint' && event.status === 'verifying'));
  assert.equal(progress.at(-1).phase, 'uncertain');
  assert.equal(progress.at(-1).uncertain, true);
  assert.equal(h.transport.lastVerified, false);
});

test('submission-only mode requires clicked true and does not infer submission from an otherwise successful reply', async () => {
  for (const saveResult of [{}, { clicked: false }, { saved: true }, { clicked: 'true' }, null]) {
    const h = harness({ verifyAfterSave: false, saveResult });
    const result = await h.transport.upload(makeItem(), hooks(h.events));
    assert.equal(result.uncertain, true);
    assert.equal(result.verified, false);
    assert.equal(result.submitted, undefined);
    assert.match(result.reason, /没有返回保存点击确认/);
    assert.equal(h.commands.filter(message => message.command === 'save').length, 1);
    assert(!h.commands.some(message => message.command === 'verify'));
  }
});

test('submission-only mode still propagates terminal and explicit page errors after its single Save attempt', async () => {
  const closed = harness({ verifyAfterSave: false, saveError: Object.assign(new Error('上传标签页已关闭'), { code: 'TAB_CLOSED' }) });
  await assert.rejects(closed.transport.upload(makeItem(), hooks(closed.events)), error => error.code === 'TAB_CLOSED' && error.uncertain === true);
  const page = harness({ verifyAfterSave: false });
  const send = page.api.tabs.sendMessage;
  page.api.tabs.sendMessage = async (tabId, message) => {
    if (message.command !== 'save') return send(tabId, message);
    await send(tabId, message);
    return { ok: false, error: '封面设置尚未完成，不能保存' };
  };
  await assert.rejects(page.transport.upload(makeItem(), hooks(page.events)), /封面设置尚未完成/);
  for (const h of [closed, page]) {
    assert.equal(h.commands.filter(message => message.command === 'save').length, 1);
    assert(!h.commands.some(message => message.command === 'verify'));
  }
});

test('submission-only mode still validates preparation and the durable checkpoint before Save', async () => {
  const preparation = harness({ verifyAfterSave: false, status: () => ({ uploadComplete: true, needsPreparation: true, preparationReady: false }),
    prepare: () => ({ error: '原创确认尚未完成' }) });
  await assert.rejects(preparation.transport.upload(makeItem(), hooks(preparation.events)), /原创确认尚未完成/);
  assert(!preparation.commands.some(message => message.command === 'save'));
  const persistence = harness({ verifyAfterSave: false, saveResult: { clicked: true } });
  await assert.rejects(persistence.transport.upload(makeItem(), hooks(persistence.events, {
    beforeTransition: async status => { if (status === 'saving') throw new Error('checkpoint failed'); },
  })), /checkpoint failed/);
  assert(!persistence.commands.some(message => message.command === 'save'));
  const title = harness({ verifyAfterSave: false });
  await assert.rejects(title.transport.upload({ ...makeItem(), title: '' }, hooks(title.events)), /标题不能为空/);
  assert(!title.commands.some(message => ['attach', 'save'].includes(message.command)));
});
