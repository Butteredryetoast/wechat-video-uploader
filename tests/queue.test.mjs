import test from 'node:test';
import assert from 'node:assert/strict';
import '../src/queue.js';

const Queue = globalThis.WXVideoQueue;
const file = (name, size = 42, lastModified = 100) => ({ name, size, lastModified, type: 'video/mp4', privateBytes: 'never persist' });
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const success = async (_item, hooks) => {
  for (const status of ['uploading', 'processing', 'saving', 'verifying']) await hooks.transition(status);
  return { verified: true };
};
const submitted = async (_item, hooks) => {
  for (const status of ['uploading', 'processing', 'saving']) await hooks.transition(status);
  return { submitted: true };
};

test('serialized execution, durable save boundary, and metadata-only snapshots', async () => {
  const states = [];
  let saved;
  let active = 0;
  const visited = [];
  const queue = new Queue({ persist: async (snapshot) => { saved = structuredClone(snapshot); states.push(saved.items.map((item) => item.status)); } });
  await queue.addFiles([file('first.mp4'), file('second.mp4')]);
  await queue.start({ upload: async (item, hooks) => {
    assert.equal(++active, 1);
    assert.equal(item.file.privateBytes, 'never persist');
    visited.push(item.name);
    await hooks.transition('uploading');
    await hooks.transition('saving');
    assert.equal(saved.items.find((entry) => entry.id === item.id).status, 'saving');
    await hooks.transition('verifying');
    active--;
    return { verified: true };
  } });
  assert.deepEqual(visited, ['first.mp4', 'second.mp4']);
  assert.deepEqual(queue.snapshot().items.map((item) => item.status), ['succeeded', 'succeeded']);
  assert(!JSON.stringify(queue.snapshot()).includes('never persist'));
  assert(states.some(([first, second]) => first === 'succeeded' && second === 'opening'));
});

test('pause finishes current item and start cannot run concurrently', async () => {
  const gate = deferred();
  const entered = deferred();
  const queue = new Queue();
  await queue.addFiles([file('a.mp4'), file('b.mp4')]);
  const run = queue.start({ upload: async (item, hooks) => {
    entered.resolve();
    await gate.promise;
    assert.equal(hooks.shouldPause(), true);
    return success(item, hooks);
  } });
  await entered.promise;
  await assert.rejects(queue.start({ upload: success }), /已经在运行/);
  queue.pause();
  gate.resolve();
  await run;
  assert.deepEqual(queue.snapshot().items.map((item) => item.status), ['succeeded', 'queued']);
  await queue.start({ upload: success });
  assert.deepEqual(queue.snapshot().items.map((item) => item.status), ['succeeded', 'succeeded']);
});

test('persistence failure before save prevents save side effects and stops the queue', async () => {
  let savedClicks = 0;
  let uploads = 0;
  let failStorage = true;
  const queue = new Queue({ persist: async (snapshot) => {
    if (failStorage && snapshot.items.some((item) => item.status === 'saving')) throw new Error('quota');
  } });
  await queue.addFiles([file('a.mp4'), file('b.mp4')]);
  await assert.rejects(queue.start({ upload: async (_item, hooks) => {
    uploads++;
    await hooks.transition('uploading');
    await hooks.transition('saving');
    savedClicks++;
  } }), /无法保存队列进度/);
  assert.equal(savedClicks, 0);
  assert.equal(uploads, 1);
  assert.deepEqual(queue.snapshot().items.map((item) => item.status), ['interrupted', 'queued']);
  await assert.rejects(queue.start({ upload: success }), /无法保存队列进度/);
  failStorage = false;
  await queue.resumePersistence();
  await assert.rejects(queue.start({ upload: success }), /先处理或移除异常项目/);
  await queue.requeue(queue.snapshot().items[0].id, { confirmedNotSaved: true });
  await queue.start({ upload: success });
  assert.deepEqual(queue.snapshot().items.map((item) => item.status), ['succeeded', 'succeeded']);
});

test('persistence failure after clicking save preserves uncertainty on restore', async () => {
  let durable;
  const queue = new Queue({ persist: async (snapshot) => {
    if (snapshot.items.some((item) => item.status === 'verifying')) throw new Error('disk failure');
    durable = structuredClone(snapshot);
  } });
  await queue.addFiles([file('a.mp4')]);
  await assert.rejects(queue.start({ upload: async (_item, hooks) => {
    await hooks.transition('uploading');
    await hooks.transition('saving');
    await hooks.transition('verifying');
  } }), /无法保存队列进度/);
  assert.equal(queue.snapshot().items[0].status, 'uncertain');
  assert.equal(durable.items[0].status, 'saving');
  const restored = new Queue();
  await restored.restore(durable);
  assert.equal(restored.snapshot().items[0].status, 'uncertain');
});

test('ambiguous save is skipped on later starts and retrying that same video still requires confirmation', async () => {
  let calls = 0;
  const queue = new Queue();
  const [itemId] = await queue.addFiles([file('a.mp4')]);
  await queue.start({ upload: async (_item, hooks) => {
    calls++;
    await hooks.transition('uploading');
    await hooks.transition('saving');
    throw new Error('timeout after click');
  } });
  assert.equal(queue.snapshot().items[0].status, 'uncertain');
  await queue.start({ upload: async () => { calls++; } });
  assert.equal(calls, 1);
  assert.equal(queue.snapshot().pauseRequested, false);
  assert.match(queue.snapshot().items[0].error, /结果未确认，已跳过，不自动重传/);
  await assert.rejects(queue.requeue(itemId), /先核对素材库/);
  await queue.requeue(itemId, { confirmedNotSaved: true });
  await queue.start({ upload: success });
  assert.equal(queue.snapshot().items[0].status, 'succeeded');
});

test('failure before saving blocks remaining items until the failed item is handled', async () => {
  let calls = 0;
  const queue = new Queue();
  await queue.addFiles([file('a.mp4'), file('b.mp4')]);
  await queue.start({ upload: async () => { calls++; throw new Error('upload rejected'); } });
  assert.equal(calls, 1);
  assert.deepEqual(queue.snapshot().items.map((item) => item.status), ['failed', 'queued']);
  await assert.rejects(queue.start({ upload: success }), /先处理或移除异常项目/);
  await queue.remove(queue.snapshot().items[0].id);
  await queue.start({ upload: success });
  assert.deepEqual(queue.snapshot().items.map((item) => item.status), ['succeeded']);
});

test('restore loses file references and converts interrupted work without rerunning it', async () => {
  const initial = new Queue();
  await initial.addFiles([file('a.mp4'), file('b.mp4'), file('c.mp4'), file('d.mp4')]);
  const snapshot = initial.snapshot();
  snapshot.items[0].status = 'uploading';
  snapshot.items[1].status = 'saving';
  snapshot.items[2].status = 'verifying';
  const queue = new Queue();
  await queue.restore(snapshot);
  assert.deepEqual(queue.snapshot().items.map((item) => item.status), ['interrupted', 'uncertain', 'uncertain', 'queued']);
  assert(queue.snapshot().items.every((item) => item.hasFile === false));
  let calls = 0;
  await assert.rejects(queue.start({ upload: async () => { calls++; } }), /先处理或移除异常项目/);
  assert.equal(calls, 0);
  await queue.attachFiles([file('a.mp4'), file('b.mp4'), file('c.mp4'), file('d.mp4')]);
  await assert.rejects(queue.start({ upload: success }), /先处理或移除异常项目/);
  assert.deepEqual(queue.snapshot().items.map((item) => item.status), ['interrupted', 'uncertain', 'uncertain', 'queued']);
  for (const item of queue.snapshot().items.slice(0, 3)) await queue.requeue(item.id, { confirmedNotSaved: true });
  await queue.start({ upload: success });
  assert(queue.snapshot().items.every((item) => item.status === 'succeeded'));
});

test('file attachment matches all three metadata values and rejects ambiguous duplicates atomically', async () => {
  const queue = new Queue();
  await queue.addFiles([file('a.mp4')]);
  await assert.rejects(queue.addFiles([file('a.mp4')]), /重复/);
  const saved = queue.snapshot();
  const restored = new Queue();
  await restored.restore(saved);
  await assert.rejects(restored.attachFiles([file('a.mp4', 43)]), /不匹配/);
  await assert.rejects(restored.attachFiles([file('a.mp4', 42, 101)]), /不匹配/);
  await assert.rejects(restored.attachFiles([file('a.mp4'), file('a.mp4')]), /重复/);
  assert.equal(restored.snapshot().items[0].hasFile, false);
  await restored.attachFiles([file('a.mp4')]);
  assert.equal(restored.snapshot().items[0].hasFile, true);
});

test('unverified adapter return cannot claim success', async () => {
  const queue = new Queue();
  await queue.addFiles([file('a.mp4')]);
  await queue.start({ upload: async (_item, hooks) => {
    for (const state of ['uploading', 'saving', 'verifying']) await hooks.transition(state);
    return {};
  } });
  assert.equal(queue.snapshot().items[0].status, 'uncertain');
});

test('an acknowledged Save settles as submitted and immediately advances without claiming verified success', async () => {
  let durable;
  const checkpoints = [];
  const visited = [];
  const queue = new Queue({ persist: async snapshot => {
    durable = structuredClone(snapshot);
    checkpoints.push(snapshot.items.map(item => item.status));
  } });
  await queue.addFiles([file('a.mp4'), file('b.mp4')]);
  await queue.start({ upload: async (item, hooks) => {
    visited.push(item.name);
    await hooks.transition('uploading');
    await hooks.transition('saving');
    assert.equal(durable.items.find(entry => entry.id === item.id).status, 'saving');
    return { submitted: true };
  } });
  assert.deepEqual(visited, ['a.mp4', 'b.mp4']);
  assert.deepEqual(queue.snapshot().items.map(item => item.status), ['submitted', 'submitted']);
  assert.equal(queue.snapshot().pauseRequested, false);
  assert(checkpoints.some(([first, second]) => first === 'submitted' && second === 'opening'));
  assert(!checkpoints.some(statuses => statuses.includes('succeeded')));
  await queue.start({ upload: async () => assert.fail('submitted videos must not be uploaded again') });
});

test('submitted status requires the adapter return at saving, not a direct hook or a pre-save claim', async () => {
  const hookQueue = new Queue();
  await hookQueue.addFiles([file('hook.mp4'), file('next.mp4')]);
  await hookQueue.start({ upload: async (item, hooks) => {
    if (item.name === 'next.mp4') return submitted(item, hooks);
    await hooks.transition('uploading');
    await hooks.transition('saving');
    await hooks.transition('submitted');
    return { submitted: true };
  } });
  assert.deepEqual(hookQueue.snapshot().items.map(item => item.status), ['uncertain', 'submitted']);
  assert.match(hookQueue.snapshot().items[0].error, /无效的队列状态变化/);

  const preSave = new Queue();
  await preSave.addFiles([file('early.mp4'), file('next.mp4')]);
  await preSave.start({ upload: async () => ({ submitted: true }) });
  assert.deepEqual(preSave.snapshot().items.map(item => item.status), ['failed', 'queued']);
  assert.equal(preSave.snapshot().pauseRequested, true);
});

test('a saving-stage uncertainty response records its reason and continues with the next file', async () => {
  const queue = new Queue();
  await queue.addFiles([file('uncertain.mp4'), file('next.mp4')]);
  await queue.start({ upload: async (item, hooks) => {
    if (item.name === 'next.mp4') return submitted(item, hooks);
    await hooks.transition('uploading');
    await hooks.transition('saving');
    return { uncertain: true, reason: 'Save response channel closed after navigation' };
  } });
  assert.deepEqual(queue.snapshot().items.map(item => item.status), ['uncertain', 'submitted']);
  assert.equal(queue.snapshot().pauseRequested, false);
  assert.match(queue.snapshot().items[0].error, /结果未确认，已跳过，不自动重传/);
  assert.match(queue.snapshot().items[0].error, /Save response channel closed/);
});

test('ordinary errors after saving or verifying are nonblocking uncertainty and never cause an automatic retry', async () => {
  const queue = new Queue();
  const visited = [];
  await queue.addFiles([file('saving.mp4'), file('verifying.mp4'), file('next.mp4')]);
  await queue.start({ upload: async (item, hooks) => {
    visited.push(item.name);
    if (item.name === 'next.mp4') return submitted(item, hooks);
    await hooks.transition('uploading');
    await hooks.transition('saving');
    if (item.name === 'verifying.mp4') await hooks.transition('verifying');
    throw new Error(`lost response for ${item.name}`);
  } });
  assert.deepEqual(visited, ['saving.mp4', 'verifying.mp4', 'next.mp4']);
  assert.deepEqual(queue.snapshot().items.map(item => item.status), ['uncertain', 'uncertain', 'submitted']);
  assert.equal(queue.snapshot().pauseRequested, false);
  assert(queue.snapshot().items.slice(0, 2).every(item => item.error.includes('lost response')));
  await queue.start({ upload: async () => assert.fail('uncertain videos must remain skipped') });
});

test('an uncertainty flag before the durable saving boundary still fails and pauses the queue', async () => {
  const queue = new Queue();
  await queue.addFiles([file('before-save.mp4'), file('next.mp4')]);
  await queue.start({ upload: async (_item, hooks) => {
    await hooks.transition('uploading');
    const error = new Error('upload failed before Save');
    error.uncertain = true;
    throw error;
  } });
  assert.deepEqual(queue.snapshot().items.map(item => item.status), ['failed', 'queued']);
  assert.equal(queue.snapshot().pauseRequested, true);
});

test('restored uncertainty and submitted records are skipped without requiring their missing local files', async () => {
  const initial = new Queue();
  const input = [file('old-uncertain.mp4'), file('old-submitted.mp4'), file('saving.mp4'), file('verifying.mp4'), file('next.mp4')];
  await initial.addFiles(input);
  const saved = initial.snapshot();
  ['uncertain', 'submitted', 'saving', 'verifying'].forEach((status, index) => { saved.items[index].status = status; });
  saved.items[0].error = '保存结果需要人工核对：旧的响应超时。请在素材库确认后再处理此项。';
  const queue = new Queue();
  await queue.restore(saved);
  assert(queue.snapshot().items.every(item => item.hasFile === false));
  assert.deepEqual(queue.snapshot().items.map(item => item.status), ['uncertain', 'submitted', 'uncertain', 'uncertain', 'queued']);
  for (const item of queue.snapshot().items.filter(item => item.status === 'uncertain')) {
    assert.match(item.error, /结果未确认，已跳过，不自动重传/);
    assert.doesNotMatch(item.error, /请.*核对|确认后再处理/);
  }
  assert.match(queue.snapshot().items[0].error, /旧的响应超时/);
  await queue.attachFiles([input[4]]);
  const visited = [];
  await queue.start({ upload: async (item, hooks) => { visited.push(item.name); return submitted(item, hooks); } });
  assert.deepEqual(visited, ['next.mp4']);
  assert.deepEqual(queue.snapshot().items.map(item => item.status), ['uncertain', 'submitted', 'uncertain', 'uncertain', 'submitted']);
  assert(queue.snapshot().items.slice(0, 4).every(item => item.hasFile === false));
});

test('a persistence failure settling submitted stops the queue even after an acknowledged Save', async () => {
  let durable;
  let calls = 0;
  const queue = new Queue({ persist: async snapshot => {
    if (snapshot.items.some(item => item.status === 'submitted')) throw new Error('disk failed after Save');
    durable = structuredClone(snapshot);
  } });
  await queue.addFiles([file('first.mp4'), file('next.mp4')]);
  await assert.rejects(queue.start({ upload: async (item, hooks) => { calls++; return submitted(item, hooks); } }), /无法保存队列进度/);
  assert.equal(calls, 1);
  assert.equal(queue.snapshot().pauseRequested, true);
  assert.deepEqual(queue.snapshot().items.map(item => item.status), ['uncertain', 'queued']);
  assert.deepEqual(durable.items.map(item => item.status), ['saving', 'queued']);
  await assert.rejects(queue.start({ upload: submitted }), /无法保存队列进度/);
});

test('a persistence failure recording uncertainty still stops instead of consuming another file', async () => {
  const queue = new Queue({ persist: async snapshot => {
    if (snapshot.items.some(item => item.status === 'uncertain')) throw new Error('uncertainty checkpoint failed');
  } });
  let calls = 0;
  await queue.addFiles([file('first.mp4'), file('next.mp4')]);
  await assert.rejects(queue.start({ upload: async (_item, hooks) => {
    calls++;
    await hooks.transition('uploading');
    await hooks.transition('saving');
    throw new Error('response lost');
  } }), /无法保存队列进度/);
  assert.equal(calls, 1);
  assert.equal(queue.snapshot().pauseRequested, true);
  assert.deepEqual(queue.snapshot().items.map(item => item.status), ['uncertain', 'queued']);
});

test('restored duplicate IDs or file identities are rejected without changing the queue', async () => {
  const queue = new Queue();
  await queue.addFiles([file('a.mp4')]);
  const saved = queue.snapshot();
  saved.items.push({ ...saved.items[0], id: 'other-id' });
  await assert.rejects(queue.restore(saved), /重复/);
  assert.equal(queue.snapshot().items.length, 1);
});

test('an in-flight edit at the item boundary finishes before the next upload claims its data', async () => {
  const gate = deferred();
  const editing = deferred();
  const seen = [];
  let pendingEdit;
  let secondId;
  const queue = new Queue({ persist: async (snapshot) => {
    if (snapshot.items[1]?.title === 'new title' && snapshot.items[1]?.status === 'queued') {
      editing.resolve();
      await gate.promise;
    }
  } });
  [, secondId] = await queue.addFiles([file('a.mp4'), file('b.mp4')]);
  queue.subscribe((snapshot) => {
    if (!pendingEdit && snapshot.items[0]?.status === 'succeeded' && snapshot.items[1]?.status === 'queued') {
      pendingEdit = queue.updateItem(secondId, { title: 'new title' });
    }
  });
  const run = queue.start({ upload: async (item, hooks) => {
    seen.push([item.name, item.title, item.status]);
    return success(item, hooks);
  } });
  await editing.promise;
  assert.equal(seen.length, 1);
  gate.resolve();
  await Promise.all([run, pendingEdit]);
  assert.deepEqual(seen, [['a.mp4', 'a', 'opening'], ['b.mp4', 'new title', 'opening']]);
});

test('same-tick starts cannot overlap while the opening checkpoint is pending', async () => {
  const gate = deferred();
  const entered = deferred();
  let uploads = 0;
  const queue = new Queue({ persist: async (snapshot) => {
    if (snapshot.items.some((item) => item.status === 'opening')) {
      entered.resolve();
      await gate.promise;
    }
  } });
  await queue.addFiles([file('a.mp4')]);
  const adapter = { upload: async (item, hooks) => { uploads++; return success(item, hooks); } };
  const run = queue.start(adapter);
  const duplicate = queue.start(adapter);
  await assert.rejects(duplicate, /已经在运行/);
  await entered.promise;
  assert.equal(uploads, 0);
  gate.resolve();
  await run;
  assert.equal(uploads, 1);
});

test('failure to persist an upload error recovers to a blocking state, never a fresh upload', async () => {
  let broken = true;
  let calls = 0;
  const queue = new Queue({ persist: async (snapshot) => {
    if (broken && snapshot.items.some((item) => item.status === 'failed')) throw new Error('storage unavailable');
  } });
  await queue.addFiles([file('a.mp4'), file('b.mp4')]);
  await assert.rejects(queue.start({ upload: async () => { calls++; throw new Error('upload failed'); } }), /无法保存队列进度/);
  assert.deepEqual(queue.snapshot().items.map((item) => item.status), ['interrupted', 'queued']);
  broken = false;
  await queue.resumePersistence();
  await assert.rejects(queue.start({ upload: async () => { calls++; } }), /先处理或移除异常项目/);
  assert.equal(calls, 1);
});

test('opening persistence failure invokes no adapter and remains blocked after storage recovery', async () => {
  let broken = true;
  let calls = 0;
  const queue = new Queue({ persist: async (snapshot) => {
    if (broken && snapshot.items.some((item) => item.status === 'opening')) throw new Error('storage unavailable');
  } });
  await queue.addFiles([file('a.mp4')]);
  await assert.rejects(queue.start({ upload: async () => { calls++; } }), /无法保存队列进度/);
  assert.equal(calls, 0);
  assert.equal(queue.snapshot().items[0].status, 'interrupted');
  broken = false;
  await queue.resumePersistence();
  await assert.rejects(queue.start({ upload: success }), /先处理或移除异常项目/);
});

test('parallel slots overlap uploads, refill in order, and serialize every durable checkpoint', async () => {
  const gates = [deferred(), deferred(), deferred()];
  const entered = [deferred(), deferred(), deferred()];
  const visited = [];
  let writing = 0;
  let active = 0;
  let peak = 0;
  const queue = new Queue({ persist: async () => {
    assert.equal(++writing, 1, 'parallel workers must never race checkpoint writes');
    await Promise.resolve();
    writing--;
  } });
  await queue.addFiles([file('a.mp4'), file('b.mp4'), file('c.mp4')]);
  const run = queue.start({ upload: async (item, hooks) => {
    const index = visited.length;
    visited.push(item.name);
    peak = Math.max(peak, ++active);
    entered[index].resolve();
    await gates[index].promise;
    const result = await success(item, hooks);
    active--;
    return result;
  } }, { concurrency: 2 });
  await Promise.all([entered[0].promise, entered[1].promise]);
  assert.deepEqual(visited, ['a.mp4', 'b.mp4']);
  assert.equal(queue.snapshot().activeCount, 2);
  gates[0].resolve();
  await entered[2].promise;
  assert.equal(active, 2, 'third upload starts while second is still processing');
  gates[1].resolve();
  gates[2].resolve();
  await run;
  assert.equal(peak, 2);
  assert.equal(queue.snapshot().activeCount, 0);
  assert(queue.snapshot().items.every(item => item.status === 'succeeded'));
});

test('an uncertain Save frees its parallel slot for the next file while another upload remains active', async () => {
  const secondEntered = deferred();
  const thirdEntered = deferred();
  const release = deferred();
  const visited = [];
  const queue = new Queue();
  await queue.addFiles([file('first.mp4'), file('second.mp4'), file('third.mp4')]);
  const run = queue.start({ upload: async (item, hooks) => {
    visited.push(item.name);
    if (item.name === 'first.mp4') {
      await hooks.transition('uploading');
      await hooks.transition('saving');
      await secondEntered.promise;
      throw new Error('first Save response lost');
    }
    if (item.name === 'second.mp4') secondEntered.resolve();
    if (item.name === 'third.mp4') thirdEntered.resolve();
    await release.promise;
    return submitted(item, hooks);
  } }, { concurrency: 2 });
  await thirdEntered.promise;
  assert.deepEqual(visited, ['first.mp4', 'second.mp4', 'third.mp4']);
  assert.equal(queue.snapshot().pauseRequested, false);
  assert.equal(queue.snapshot().items[0].status, 'uncertain');
  assert.equal(queue.snapshot().activeCount, 2);
  release.resolve();
  await run;
  assert.deepEqual(queue.snapshot().items.map(item => item.status), ['uncertain', 'submitted', 'submitted']);
});

test('parallel pause finishes every active upload without assigning waiting files', async () => {
  const entered = deferred();
  const gate = deferred();
  let calls = 0;
  const queue = new Queue();
  await queue.addFiles([file('a.mp4'), file('b.mp4'), file('c.mp4')]);
  const run = queue.start({ upload: async (item, hooks) => {
    if (++calls === 2) entered.resolve();
    await gate.promise;
    return success(item, hooks);
  } }, { concurrency: 2 });
  await entered.promise;
  queue.pause();
  assert.equal(queue.running, true);
  gate.resolve();
  await run;
  assert.equal(calls, 2);
  assert.deepEqual(queue.snapshot().items.map(item => item.status), ['succeeded', 'succeeded', 'queued']);
});

test('one failed worker stops new claims but lets an already saving worker verify', async () => {
  const saveEntered = deferred();
  const savingGate = deferred();
  const failed = deferred();
  const queue = new Queue();
  await queue.addFiles([file('a.mp4'), file('b.mp4'), file('c.mp4')]);
  queue.subscribe(snapshot => { if (snapshot.items[0]?.status === 'failed') failed.resolve(); });
  const run = queue.start({ upload: async (item, hooks) => {
    if (item.name === 'a.mp4') { await saveEntered.promise; throw new Error('cover failed'); }
    assert.equal(item.name, 'b.mp4');
    await hooks.transition('uploading');
    await hooks.transition('saving');
    saveEntered.resolve();
    await savingGate.promise;
    await hooks.transition('verifying');
    return { verified: true };
  } }, { concurrency: 2 });
  await failed.promise;
  assert.equal(queue.running, true);
  savingGate.resolve();
  await run;
  assert.deepEqual(queue.snapshot().items.map(item => item.status), ['failed', 'succeeded', 'queued']);
});

test('parallel persistence failure preserves uncertainty per worker and prevents later save clicks', async () => {
  const saving = deferred();
  const processing = deferred();
  const release = deferred();
  let clicks = 0;
  let broken = false;
  const queue = new Queue({ persist: async () => { if (broken) throw new Error('storage failed'); } });
  await queue.addFiles([file('a.mp4'), file('b.mp4'), file('c.mp4')]);
  const run = queue.start({ upload: async (item, hooks) => {
    await hooks.transition('uploading');
    if (item.name === 'a.mp4') {
      await hooks.transition('saving');
      clicks++;
      saving.resolve();
      await release.promise;
      await hooks.transition('verifying');
      return { verified: true };
    }
    await saving.promise;
    await hooks.transition('processing');
    processing.resolve();
    await release.promise;
    await hooks.transition('saving');
    clicks++;
  } }, { concurrency: 2 });
  await processing.promise;
  broken = true;
  release.resolve();
  await assert.rejects(run, /无法保存队列进度/);
  assert.equal(clicks, 1);
  assert.deepEqual(queue.snapshot().items.map(item => item.status), ['uncertain', 'interrupted', 'queued']);
  assert.equal(queue.snapshot().activeCount, 0);
});

test('invalid parallelism is rejected before claiming or persisting an upload', async () => {
  const queue = new Queue();
  await queue.addFiles([file('a.mp4')]);
  for (const concurrency of [0, 11, 2.5, '2', NaN])
    await assert.rejects(queue.start({ upload: success }, { concurrency }), /1 至 10 之间的整数/);
  assert.equal(queue.running, false);
  assert.equal(queue.snapshot().items[0].status, 'queued');
});

test('ten slots start together and the eleventh waits until one slot finishes', async () => {
  const gates = Array.from({ length: 11 }, deferred);
  const entered = Array.from({ length: 11 }, deferred);
  const queue = new Queue();
  const started = [];
  let active = 0;
  let peak = 0;
  await queue.addFiles(Array.from({ length: 11 }, (_, index) => file(`video-${index}.mp4`)));
  const run = queue.start({ upload: async (item, hooks) => {
    const index = started.length;
    started.push(item.name);
    peak = Math.max(peak, ++active);
    entered[index].resolve();
    await gates[index].promise;
    const result = await success(item, hooks);
    active--;
    return result;
  } }, { concurrency: 10 });
  await Promise.all(entered.slice(0, 10).map(gate => gate.promise));
  assert.equal(started.length, 10);
  assert.equal(active, 10);
  assert.equal(queue.snapshot().activeCount, 10);
  assert.equal(queue.snapshot().items[10].status, 'queued');
  gates[0].resolve();
  await entered[10].promise;
  assert.equal(started.length, 11);
  assert.equal(active, 10, 'eleventh reuses the freed slot without exceeding the limit');
  for (const gate of gates.slice(1)) gate.resolve();
  await run;
  assert.equal(peak, 10);
  assert.equal(queue.snapshot().activeCount, 0);
  assert(queue.snapshot().items.every(item => item.status === 'succeeded'));
});
