/* The offscreen document owns File objects; every privileged action uses runtime messages. */
(function (global) {
  'use strict';
  const MAX_ENCODED_CHUNK = 512 * 1024;
  const INGEST_TIMEOUT = 60 * 1000;
  const AUTO_CHECK_INTERVAL = 2500;
  const BLOCKING = new Set(['failed', 'interrupted']);
  const keyOf = file => JSON.stringify([file.name, file.size, file.lastModified]);
  const messageOf = error => error?.message || String(error);

  class WXVideoEngine {
    constructor({ host, api, onState, timers = {} } = {}) {
      if (typeof host !== 'function') throw new TypeError('host is required');
      this.host = host;
      this.api = api;
      this.onState = onState;
      this.queue = null;
      this.transport = null;
      this.targetTabId = null;
      this.sessionId = null;
      this.concurrency = 1;
      this.foregroundSerial = false;
      this._workers = new Map();
      this._workerProgress = new Map();
      this.runtimeInfo = { ready: false, reason: '正在连接公众号上传页…' };
      this.notice = { text: '', kind: 'info' };
      this.log = [];
      this.ingest = null;
      this._ingestTimer = null;
      this._operations = Promise.resolve();
      this._starting = false;
      this._closed = false;
      this._runTask = null;
      this._abort = new AbortController();
      this._setAutoTimer = timers.setTimeout?.bind(timers) || global.setTimeout.bind(global);
      this._clearAutoTimer = timers.clearTimeout?.bind(timers) || global.clearTimeout.bind(global);
      this._autoCheckEnabled = false;
      this._autoCheckTimer = null;
      this._autoCheckTask = null;
    }

    state() {
      const snapshot = this.queue?.snapshot() || { version: 1, items: [], running: false, pauseRequested: false, persistenceError: null };
      // Preflight is part of the run, so the UI must stay locked while it waits.
      const items = snapshot.items.map(item => ({ ...item, progress: this._workerProgress.get(item.id)?.detail || null }));
      return { snapshot: { ...snapshot, items, running: snapshot.running || this._starting },
        runtimeInfo: { ...this.runtimeInfo, concurrency: this.concurrency, foregroundSerial: this.foregroundSerial, verifyAfterSave: false, activeCount: snapshot.activeCount || 0, autoCheck: { enabled: this._autoCheckEnabled && !this._closed, intervalMs: AUTO_CHECK_INTERVAL } },
        notice: { ...this.notice }, ingesting: Boolean(this.ingest) };
    }

    _record(kind, detail) {
      this.log.push({ time: new Date().toISOString(), kind, detail });
      if (this.log.length > 1000) this.log.shift();
    }

    _progress(itemId, tabId, value = {}) {
      // Transport emits metadata only. Retain an explicit allowlist so diagnostics
      // never copy arbitrary page content, file bytes or authentication URLs.
      const detail = {};
      for (const key of ['phase', 'reason', 'pageKind', 'code']) {
        if (typeof value[key] === 'string') detail[key] = value[key].slice(0, key === 'reason' ? 500 : 80)
          .replace(/(?:https?|file|chrome-extension):\/\/[^\s"<>]+/gi, '[链接已省略]')
          .replace(/\b(token|access_token|cookie|authorization)\s*[:=]\s*[^\s,;]+/gi, '$1=[已省略]');
      }
      for (const key of ['uploadComplete', 'titleNeedsSync', 'needsPreparation', 'preparationReady', 'needsAgreement',
        'readyToSave', 'pending', 'verified', 'submitted', 'uncertain', 'busy', 'documentHidden']) {
        if (typeof value[key] === 'boolean') detail[key] = value[key];
      }
      if (value.preparation && typeof value.preparation === 'object') {
        detail.preparation = {};
        if (['original-dialog', 'original-apply', 'cover-editor', 'cover-select', 'original-control', 'original-enable', 'service-agreement', 'ready'].includes(value.preparation.phase))
          detail.preparation.phase = value.preparation.phase;
        for (const key of ['firstCoverSelected', 'coverConfirmationSent', 'originalEnabled', 'originalConfirmationSent', 'agreementChecked'])
          if (typeof value.preparation[key] === 'boolean') detail.preparation[key] = value.preparation[key];
        for (const key of ['coverCandidateCount', 'coverEditorCount', 'originalControlCount', 'originalDialogCount'])
          if (Number.isSafeInteger(value.preparation[key]) && value.preparation[key] >= 0)
            detail.preparation[key] = Math.min(value.preparation[key], 1000);
      }
      const cached = this._workerProgress.get(itemId);
      const previous = cached?.tabId === tabId ? cached : null;
      const changed = !previous || JSON.stringify(previous.detail) !== JSON.stringify(detail);
      const updatedAt = new Date().toISOString();
      this._workerProgress.set(itemId, { itemId, tabId, detail, updatedAt,
        changedAt: changed ? updatedAt : previous.changedAt,
        lastPageState: detail.preparation ? detail : previous?.lastPageState || null,
        lastPageStateAt: detail.preparation ? updatedAt : previous?.lastPageStateAt || null });
      while (this._workerProgress.size > 500) this._workerProgress.delete(this._workerProgress.keys().next().value);
      if (changed) {
        this._record('worker-progress', { itemId, tabId, ...detail });
        this._push();
      }
    }

    _push() {
      const state = this.state();
      try { this.onState?.(state); } catch { /* UI observers cannot interrupt persistence. */ }
      // A navigation can destroy the sidebar listener. It will request state again.
      Promise.resolve().then(() => this.host('push', { state })).catch(() => {});
    }

    _notice(text, kind = 'info') {
      this.notice = { text, kind };
      this._push();
    }

    _assertOpen() {
      if (this._closed) throw new Error('公众号操作页已关闭，请重新打开上传助手。');
    }

    _assertInitialized() {
      this._assertOpen();
      if (!this.queue || !this.transport) throw new Error('请先在公众号页面打开上传助手。');
    }

    _assertIdle({ allowIngest = false } = {}) {
      this._assertInitialized();
      if (this._starting || this.queue.running) throw new Error('上传正在运行，请先暂停并等待正在处理的视频完成。');
      if (!allowIngest && this.ingest) throw new Error('正在接收所选视频，请等待文件准备完成。');
    }

    _serialize(operation) {
      const result = this._operations.then(operation);
      this._operations = result.catch(() => {});
      return result;
    }

    async _callApi(callback) {
      this._assertOpen();
      const result = await callback();
      this._assertOpen();
      return result;
    }

    _bridgeApi() {
      const api = this.api;
      return {
        tabs: {
          get: tabId => this._callApi(() => api ? api.tabs.get(tabId) : this.host('tab.get', { tabId })),
          update: (tabId, update) => this._callApi(() => api ? api.tabs.update(tabId, update) : this.host('tab.update', { tabId, update })),
          sendMessage: (tabId, message) => this._callApi(() => api ? api.tabs.sendMessage(tabId, message) : this.host('page', { tabId, message })),
        },
        scripting: {
          executeScript: options => this._callApi(() => api ? api.scripting.executeScript(options) : this.host('inject', options)),
        },
      };
    }

    _wait(milliseconds) {
      this._assertOpen();
      return new Promise((resolve, reject) => {
        const abort = () => { clearTimeout(timer); reject(new Error('公众号操作页已关闭，上传已停止。')); };
        const timer = setTimeout(() => { this._abort.signal.removeEventListener('abort', abort); resolve(); }, milliseconds);
        this._abort.signal.addEventListener('abort', abort, { once: true });
      });
    }

    async _init({ targetTabId, sessionId } = {}) {
      this._assertOpen();
      if (!Number.isSafeInteger(targetTabId) || targetTabId < 0 || typeof sessionId !== 'string' || !sessionId)
        throw new Error('上传会话信息无效。');
      if (this.sessionId === sessionId && this.targetTabId === targetTabId && this.queue) return this.state();
      if (this.queue) this._assertIdle();
      if (!this.queue) {
        const saved = await this.host('read');
        this.queue = new global.WXVideoQueue({ persist: snapshot => this.host('write', { snapshot }) });
        this.queue.subscribe(() => this._push());
        if (saved?.items?.length) {
          await this.queue.restore(saved);
          this.notice = { text: '已恢复队列。已提交和保存结果未确认的项目会自动跳过；请重新选择等待上传的视频文件后继续。', kind: 'info' };
        }
      }
      this.targetTabId = targetTabId;
      this.sessionId = sessionId;
      this.transport = new global.WXVideoTransport({ targetTabId, api: this._bridgeApi(),
        wait: milliseconds => this._wait(milliseconds), onNotice: text => this._notice(text) });
      await this._inspect();
      this._startAutoCheck();
      this._push();
      return this.state();
    }

    _startAutoCheck() {
      if (this._closed || this._autoCheckEnabled) return;
      this._autoCheckEnabled = true;
      this._scheduleAutoCheck();
    }

    _scheduleAutoCheck() {
      if (this._closed || !this._autoCheckEnabled || this._autoCheckTimer !== null) return;
      // This timer belongs to the offscreen document, independent of page focus.
      // Re-arm after completion so slow checks never overlap or accumulate.
      this._autoCheckTimer = this._setAutoTimer(() => {
        this._autoCheckTimer = null;
        this._autoCheckTask = this._serialize(async () => {
          if (this._closed || !this._autoCheckEnabled) return;
          if (this._starting || this.queue?.running) return;
          await this._inspect({ automatic: true });
        }).catch(error => {
          if (!this._closed) {
            this._record('auto-check-error', messageOf(error));
            this._push();
          }
        }).finally(() => {
          this._autoCheckTask = null;
          this._scheduleAutoCheck();
        });
        return this._autoCheckTask;
      }, AUTO_CHECK_INTERVAL);
      this._autoCheckTimer?.unref?.();
    }

    _stopAutoCheck() {
      this._autoCheckEnabled = false;
      if (this._autoCheckTimer !== null) this._clearAutoTimer(this._autoCheckTimer);
      this._autoCheckTimer = null;
    }

    _readyReason() {
      if (this.foregroundSerial) return '入口已就绪，将逐个打开前台上传页，提交保存后直接处理下一个视频。';
      if (this.concurrency === 1) return '入口已就绪，将在独立后台页逐个上传，提交保存后直接处理下一个视频。';
      return `入口已就绪，将同时在 ${this.concurrency} 个独立后台页上传视频。`;
    }

    async _inspect({ automatic = false } = {}) {
      this._assertInitialized();
      const previous = this.runtimeInfo;
      try {
        await this.transport.inject();
        const result = await this.transport.command('launchInfo');
        if (this._closed) return this.state();
        this.runtimeInfo = { ready: result.ready === true, pageKind: result.pageKind,
          reason: result.ready === true ? this._readyReason() : result.reason || '请打开公众号的“选择视频”窗口。' };
        if (!automatic || previous.ready !== this.runtimeInfo.ready || previous.reason !== this.runtimeInfo.reason)
          this._record('page-check', { ready: result.ready === true, pageKind: result.pageKind, reason: this.runtimeInfo.reason });
      } catch (error) {
        if (this._closed) return this.state();
        this.runtimeInfo = { ready: false, reason: '连接失败。请打开公众号的“选择视频”窗口后重新检查。' };
        // Automatic readiness updates must not replace upload or user-action errors.
        if (!automatic) this.notice = { text: this.runtimeInfo.reason, kind: 'error' };
        if (!automatic || previous.ready !== this.runtimeInfo.ready || previous.reason !== this.runtimeInfo.reason)
          this._record('page-check-error', messageOf(error));
      }
      if (!automatic || previous.ready !== this.runtimeInfo.ready || previous.reason !== this.runtimeInfo.reason) this._push();
      return this.state();
    }

    _touchIngest() {
      clearTimeout(this._ingestTimer);
      this._ingestTimer = setTimeout(() => {
        // Serialize expiration with file.end so a durable addition cannot race cancellation.
        this._serialize(() => {
          if (!this.ingest || Date.now() - this.ingest.touched < INGEST_TIMEOUT) return;
          this._clearIngest();
          this._notice('所选文件的传输已中断，请重新选择该视频。', 'warning');
        }).catch(() => {});
      }, INGEST_TIMEOUT);
      this._ingestTimer.unref?.();
      this.ingest.touched = Date.now();
    }

    _clearIngest() {
      clearTimeout(this._ingestTimer);
      this._ingestTimer = null;
      this.ingest = null;
    }

    _beginFile(payload) {
      this._assertIdle();
      const { id, name, size, type = '', lastModified } = payload;
      if (typeof id !== 'string' || !id || id.length > 200 || typeof name !== 'string' || !name || name.length > 1024 ||
          !Number.isSafeInteger(size) || size <= 0 || !Number.isSafeInteger(lastModified) || lastModified < 0 || typeof type !== 'string')
        throw new Error('视频文件信息无效或文件为空。');
      if (!type.startsWith('video/') && !/\.(mp4|mov|m4v|webm|avi|mkv|wmv|flv|mpeg|mpg|3gp)$/i.test(name))
        throw new Error(`请选择视频文件：${name}`);
      const exists = this.queue.snapshot().items.some(item => keyOf(item) === keyOf(payload));
      if (!exists && this.queue.snapshot().items.length >= 500) throw new Error('每个队列最多 500 个视频。');
      this.ingest = { id, name, size, type, lastModified, chunks: [], bytes: 0, nextIndex: 0, touched: Date.now() };
      this._touchIngest();
      this._push();
      return { receiving: true };
    }

    _fileState(id) {
      this._assertIdle({ allowIngest: true });
      if (!this.ingest || this.ingest.id !== id) throw new Error('文件传输会话已失效，请重新选择该视频。');
      return this.ingest;
    }

    _chunkFile({ id, index, data }) {
      const ingest = this._fileState(id);
      if (!Number.isSafeInteger(index) || index !== ingest.nextIndex) throw new Error('视频分片顺序不正确，请重新选择该视频。');
      if (typeof data !== 'string' || !data.length || data.length > MAX_ENCODED_CHUNK || data.length % 4 !== 0 ||
          !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data))
        throw new Error('视频分片格式或大小无效。');
      const raw = global.atob(data);
      if (global.btoa(raw) !== data || !raw.length || ingest.bytes + raw.length > ingest.size)
        throw new Error('视频分片大小与文件不一致。');
      const bytes = new Uint8Array(raw.length);
      for (let index = 0; index < raw.length; index++) bytes[index] = raw.charCodeAt(index);
      ingest.chunks.push(bytes);
      ingest.bytes += bytes.length;
      ingest.nextIndex++;
      this._touchIngest();
      return { received: ingest.bytes, size: ingest.size };
    }

    async _endFile({ id }) {
      const ingest = this._fileState(id);
      if (ingest.bytes !== ingest.size) throw new Error('视频文件尚未完整传输，请重新选择该视频。');
      const file = new global.File(ingest.chunks, ingest.name, { type: ingest.type, lastModified: ingest.lastModified });
      const attached = this.queue.snapshot().items.some(item => keyOf(item) === keyOf(file));
      // Hold the ingestion lock until the metadata checkpoint has completed.
      const ids = attached ? await this.queue.attachFiles([file]) : await this.queue.addFiles([file]);
      this._clearIngest();
      this._notice(`${attached ? '已重新关联' : '已添加'}「${file.name}」。请检查素材标题。`);
      return { id: ids[0], attached, state: this.state() };
    }

    _cancelFile({ id } = {}) {
      if (this.ingest && (!id || id === this.ingest.id)) {
        this._clearIngest();
        this._push();
        return { cancelled: true };
      }
      return { cancelled: false };
    }

    _start() {
      this._assertIdle();
      const items = this.queue.snapshot().items;
      if (items.some(item => BLOCKING.has(item.status))) throw new Error('请先处理或移除上传失败、中断的项目，再继续。');
      const pending = items.filter(item => item.status === 'queued');
      if (!pending.length) throw new Error('请先选择需要上传的视频。');
      if (pending.some(item => !item.hasFile)) throw new Error('请先重新选择队列中缺失的本地文件。');
      if (pending.some(item => !item.title.trim() || item.title.length > 64)) throw new Error('请先填写标题，并将所有标题控制在 64 字以内。');
      this._starting = true;
      this._push();
      this._runTask = Promise.resolve().then(() => this._run(pending.length));
      return { started: true, state: this.state() };
    }

    async _uploadInWorker(item, hooks) {
      this._assertOpen();
      const worker = await this.host('worker.open', { itemId: item.id, foregroundSerial: this.foregroundSerial });
      if (!Number.isSafeInteger(worker?.tabId) || worker.tabId < 0 || worker.tabId === this.targetTabId)
        throw new Error('未能创建独立的视频上传页。');
      const tabId = worker.tabId;
      this._workers.set(item.id, tabId);
      let verified = false;
      try {
        this._assertOpen();
        const transport = new global.WXVideoTransport({ targetTabId: tabId, api: this._bridgeApi(),
          verifyAfterSave: false,
          wait: milliseconds => this._wait(milliseconds), now: () => this.transport.now(),
          onNotice: text => this._notice(text),
          onProgress: detail => this._progress(item.id, tabId, detail),
          renderPulse: () => this._callApi(() => this.host('worker.render', { itemId: item.id, tabId })),
          onRenderState: state => this._record('worker-render', { itemId: item.id, tabId, ...state }) });
        this._record('worker-opened', { itemId: item.id, tabId, foregroundSerial: this.foregroundSerial });
        await transport.waitUntilReady();
        const result = await transport.upload(item, hooks);
        verified = result?.verified === true;
        return result;
      } catch (error) {
        this._record('worker-error', { itemId: item.id, tabId,
          phase: this._workerProgress.get(item.id)?.detail.phase || 'opening',
          error: messageOf(error), ...(error.code ? { code: error.code } : {}), uncertain: error.uncertain === true });
        throw error;
      } finally {
        this._workers.delete(item.id);
        // Cleanup is separate from upload outcome. A tab-close error must never
        // turn a verified save into an upload that appears safe to repeat.
        try { await this.host('worker.release', { itemId: item.id, tabId, verified }); }
        catch (error) { this._record('worker-release-error', { itemId: item.id, error: messageOf(error) }); }
        this._push();
      }
    }

    async _run(count) {
      try {
        await this._inspect();
        this._assertOpen();
        if (!this.runtimeInfo.ready) throw new Error(this.runtimeInfo.reason);
        if (this._pauseDuringPreflight) {
          this._notice('已暂停，尚未开始上传。');
          return;
        }
        this._record('run-start', { count, concurrency: this.concurrency, foregroundSerial: this.foregroundSerial, verifyAfterSave: false });
        await this.queue.start({ upload: (item, hooks) => this._uploadInWorker(item, hooks) }, { concurrency: this.concurrency });
        const snapshot = this.queue.snapshot();
        const issue = snapshot.items.find(item => BLOCKING.has(item.status));
        const submitted = snapshot.items.filter(item => item.status === 'submitted').length;
        const unconfirmed = snapshot.items.filter(item => item.status === 'uncertain').length;
        this._notice(issue ? issue.error : snapshot.pauseRequested ? '已在当前视频处理后暂停。' :
          `队列已处理完成：${submitted} 项已提交保存${unconfirmed ? `，${unconfirmed} 项结果未确认并已跳过` : ''}。`, issue ? 'warning' : 'info');
        this._record('run-end', { completed: snapshot.items.filter(item => ['succeeded', 'submitted', 'uncertain'].includes(item.status)).length,
          submitted, unconfirmed, issue: issue?.error || null });
      } catch (error) {
        this._notice(messageOf(error), 'error');
        this._record('run-error', messageOf(error));
      } finally {
        this._starting = false;
        this._pauseDuringPreflight = false;
        this._push();
      }
    }

    async _export() {
      this._assertInitialized();
      let diagnostics;
      if (this._starting || this.queue.running) diagnostics = { note: '使用各上传页最近一次状态检查的结果，不触发额外页面操作。' };
      else {
        try { diagnostics = await this.transport.diagnostics(); }
        catch { diagnostics = { error: '无法读取当前页面结构。' }; }
      }
      const workers = Array.from(this._workerProgress.values(), record => ({ ...record,
        active: this._workers.get(record.itemId) === record.tabId }));
      return { version: '0.4.6', createdAt: new Date().toISOString(), queue: this.queue.snapshot(), events: this.log.slice(),
        diagnostics: { ...diagnostics, workers } };
    }

    async handle(command, payload = {}) {
      if (command === 'state') return this.state();
      if (command === 'target.closed') {
        this._closed = true;
        this._stopAutoCheck();
        this._abort.abort();
        this._clearIngest();
        this.queue?.pause();
        this.runtimeInfo = { ready: false, reason: '公众号操作页已关闭，队列已停止。' };
        this._push();
        return { closed: true, state: this.state() };
      }
      return this._serialize(async () => {
        switch (command) {
          case 'init': return this._init(payload);
          case 'file.begin': return this._beginFile(payload);
          case 'file.chunk': return this._chunkFile(payload);
          case 'file.end': return this._endFile(payload);
          case 'file.cancel': return this._cancelFile(payload);
          case 'configure': {
            this._assertIdle();
            const hasConcurrency = Object.hasOwn(payload, 'concurrency');
            const hasForeground = Object.hasOwn(payload, 'foregroundSerial');
            if (!hasConcurrency && !hasForeground) throw new Error('请设置同时上传数量或前台串行模式。');
            const concurrency = hasConcurrency ? payload.concurrency : this.concurrency;
            const foregroundSerial = hasForeground ? payload.foregroundSerial : this.foregroundSerial;
            if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 10)
              throw new Error('同时上传数量只能设为 1 至 10 之间的整数。');
            if (typeof foregroundSerial !== 'boolean') throw new Error('前台串行模式必须设为开启或关闭。');
            if (foregroundSerial && concurrency !== 1) throw new Error('前台串行模式只能同时上传 1 个视频。');
            this.concurrency = concurrency;
            this.foregroundSerial = foregroundSerial;
            if (this.runtimeInfo.ready) this.runtimeInfo = { ...this.runtimeInfo, reason: this._readyReason() };
            this._push();
            return this.state();
          }
          case 'start': return this._start();
          case 'pause':
            this._assertInitialized();
            this._pauseDuringPreflight = this._starting && !this.queue.running;
            this.queue.pause();
            this._notice('停止安排新视频，正在处理的视频完成后暂停。');
            return this.state();
          case 'inspect':
            this._assertInitialized();
            if (this._starting || this.queue.running) return this.state();
            return this._inspect();
          case 'update':
            this._assertIdle();
            await this.queue.updateItem(payload.id, payload.changes || {});
            return this.state();
          case 'remove':
            this._assertIdle();
            await this.queue.remove(payload.id);
            return this.state();
          case 'retry':
            this._assertIdle();
            await this.queue.requeue(payload.id, { confirmedNotSaved: payload.confirmedNotSaved === true });
            this._workerProgress.delete(payload.id);
            this._push();
            return this.state();
          case 'export': return this._export();
          default: throw new Error('不支持的上传助手操作。');
        }
      });
    }
  }

  global.WXVideoEngine = WXVideoEngine;

  const runtime = global.chrome?.runtime;
  if (runtime?.onMessage?.addListener && runtime?.sendMessage && !global.__wxvuEngineListener) {
    global.__wxvuEngineListener = true;
    const engine = new WXVideoEngine({ host: async (command, payload = {}) => {
      const response = await runtime.sendMessage({ namespace: 'wxvu.host', command, payload });
      if (response?.ok !== true) {
        const error = new Error(response?.error || '扩展后台没有返回结果，请重新打开上传助手。');
        if (typeof response?.code === 'string') error.code = response.code;
        throw error;
      }
      return response.result;
    } });
    runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message?.namespace !== 'wxvu.engine') return false;
      const backgroundUrl = runtime.getURL('src/background.js');
      if (sender?.id !== runtime.id || sender.tab || (sender.url && sender.url !== backgroundUrl)) {
        sendResponse({ ok: false, error: '上传引擎只接受扩展后台请求。' });
        return false;
      }
      engine.handle(message.command, message.payload).then(result => sendResponse({ ok: true, result }),
        error => sendResponse({ ok: false, error: messageOf(error) }));
      return true;
    });
  }
})(globalThis);
