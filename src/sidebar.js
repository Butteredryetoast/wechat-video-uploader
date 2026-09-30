(() => {
  'use strict';

  // executeScript can run again when the toolbar button is clicked.
  if (globalThis.WXVideoSidebar) {
    globalThis.WXVideoSidebar.show();
    return;
  }

  // Chrome leaves injected DOM behind when an unpacked extension is reloaded.
  // A new isolated world has no sidebar instance; replace only our orphaned UI.
  const stalePanel = document.getElementById('wx-video-batch-uploader');
  if (stalePanel?.shadowRoot?.querySelector('section[aria-label="视频批量上传"]')) stalePanel.remove();

  const CHUNK_BYTES = 384 * 1024;
  const COLLAPSED_KEY = 'wxvu.panel.collapsed';
  let state = {
    snapshot: { items: [], running: false, pauseRequested: false },
    runtimeInfo: { ready: false, reason: '正在连接公众号上传入口…', concurrency: 1, foregroundSerial: false },
    notice: { text: '', kind: 'info' },
    ingesting: false
  };
  let loading = true;
  let localBusy = false;
  let actionBusy = false;
  let alive = true;
  let pageEpoch = 0;
  let activeTransfer = null;
  let localNotice = null;
  let editTail = Promise.resolve();
  const editErrors = new Map();

  async function request(command, payload) {
    const response = await chrome.runtime.sendMessage({ namespace: 'wxvu.ui', command, payload });
    if (!response?.ok) {
      const detail = typeof response?.error === 'string' ? response.error : response?.error?.message;
      throw new Error(detail || '扩展连接未完成，请刷新公众号页面后重试。');
    }
    return response.result;
  }

  function render() {
    if (!alive) return;
    panel.update(state.snapshot, {
      ...state.runtimeInfo,
      importing: localBusy || Boolean(state.ingesting),
      loading: loading || actionBusy
    });
    const notice = localNotice || state.notice;
    panel.setNotice(notice?.text || '', notice?.kind || 'info');
  }

  function acceptState(next) {
    if (!next || typeof next !== 'object' || !next.snapshot || !next.runtimeInfo) return;
    state = next;
    render();
  }

  async function refresh() {
    acceptState(await request('state'));
  }

  function report(error) {
    localNotice = { text: error?.message || '操作未完成，请重试。', kind: 'error' };
    render();
  }

  async function flushEdits() {
    await editTail;
    if (editErrors.size) throw new Error('有标题修改未能保存，请重新修改提示异常的标题后再开始。');
  }

  async function action(command, payload, consume) {
    if (!alive || loading || actionBusy || localBusy || state.ingesting) return;
    actionBusy = true;
    localNotice = null;
    render();
    try {
      await editTail;
      if (command === 'start') await flushEdits();
      const result = await request(command, payload);
      if (command === 'remove') editErrors.delete(payload.id);
      if (consume) consume(result);
    } catch (error) {
      report(error);
    } finally {
      try { await refresh(); } catch (error) { report(error); }
      actionBusy = false;
      render();
    }
  }

  function updateItem(id, changes) {
    if (!alive || loading || actionBusy || localBusy || state.ingesting || state.snapshot.running) return;
    // Preserve input order without blocking typing while a background response arrives.
    const update = { ...changes };
    editTail = editTail.then(async () => {
      try {
        await request('update', { id, changes: update });
        editErrors.delete(id);
        localNotice = null;
      } catch (error) {
        editErrors.set(id, error);
        report(error);
      }
      try { await refresh(); } catch (error) { report(error); }
    });
  }

  function bytesToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    // Bound argument size; spreading an entire video chunk can overflow the stack.
    for (let offset = 0; offset < bytes.length; offset += 8192) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
    }
    return btoa(binary);
  }

  function readChunk(blob) {
    if (typeof blob.arrayBuffer === 'function') return blob.arrayBuffer();
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('无法读取所选视频，请重新选择文件。'));
      reader.onabort = () => reject(new Error('文件读取已中断。'));
      reader.readAsArrayBuffer(blob);
    });
  }

  async function addFiles(files) {
    if (!alive || loading || actionBusy || localBusy || state.ingesting || state.snapshot.running) return;
    localBusy = true;
    const transferEpoch = pageEpoch;
    localNotice = { text: `正在准备 ${files.length} 个视频，请保持当前页面打开…`, kind: 'info' };
    render();
    try {
      await editTail;
      for (const [position, file] of files.entries()) {
        if (!alive || transferEpoch !== pageEpoch) throw new Error('页面已离开，文件读取已中断。');
        const id = crypto.randomUUID();
        activeTransfer = id;
        await request('file.begin', { id, name: file.name, size: file.size, type: file.type, lastModified: file.lastModified });
        let index = 0;
        for (let offset = 0; offset < file.size; offset += CHUNK_BYTES) {
          const data = bytesToBase64(await readChunk(file.slice(offset, offset + CHUNK_BYTES)));
          if (!alive || transferEpoch !== pageEpoch) throw new Error('页面已离开，文件读取已中断。');
          await request('file.chunk', { id, index: index++, data });
        }
        if (!alive || transferEpoch !== pageEpoch) throw new Error('页面已离开，文件读取已中断。');
        await request('file.end', { id });
        activeTransfer = null;
        localNotice = { text: `已准备 ${position + 1}/${files.length} 个视频。`, kind: 'info' };
        await refresh();
      }
      localNotice = { text: '视频已加入队列，请检查标题后开始上传。', kind: 'info' };
    } catch (error) {
      if (activeTransfer) {
        try { await request('file.cancel', { id: activeTransfer }); } catch { /* Receiver also expires abandoned transfers. */ }
      }
      report(error);
    } finally {
      activeTransfer = null;
      localBusy = false;
      try { await refresh(); } catch (error) { report(error); }
      render();
    }
  }

  function safeDiagnostics(value) {
    if (typeof value === 'string') {
      return value.replace(/(?:https?|file|chrome-extension):\/\/[^\s"<>]+/gi, '[链接已省略]')
        .replace(/\b(token|access_token|cookie|authorization)\s*[:=]\s*[^\s,;]+/gi, '$1=[已省略]');
    }
    if (Array.isArray(value)) return value.map(safeDiagnostics);
    if (!value || typeof value !== 'object') return value;
    const result = {};
    for (const [key, child] of Object.entries(value)) {
      if (/url|href|cookie|token|authorization|headers|secret|password/i.test(key)) continue;
      result[key] = safeDiagnostics(child);
    }
    return result;
  }

  function downloadLog(value) {
    const url = URL.createObjectURL(new Blob([JSON.stringify(safeDiagnostics(value), null, 2)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = '公众号批量上传-诊断记录.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function saveCollapsed(collapsed) {
    try { sessionStorage.setItem(COLLAPSED_KEY, collapsed ? '1' : '0'); } catch { /* Optional UI preference only. */ }
    if (collapsed) globalThis.WXToolLauncher?.collapsed('video');
    else globalThis.WXToolLauncher?.activate('video');
  }

  const panel = WXVideoPanel.create({
    fullPage: false,
    unifiedLauncher: Boolean(globalThis.WXToolLauncher),
    onSummary: summary => globalThis.WXToolLauncher?.updateVideo(summary),
    onFiles: addFiles,
    onUpdate: updateItem,
    onRemove: id => action('remove', { id }),
    onRetry: id => action('retry', { id, confirmedNotSaved: true }),
    onStart: () => action('start'),
    onPause: () => action('pause'),
    onConfigure: settings => {
      if (state.snapshot.running) return;
      const payload = {};
      if (Object.hasOwn(settings, 'concurrency')) payload.concurrency = settings.concurrency;
      if (Object.hasOwn(settings, 'foregroundSerial')) payload.foregroundSerial = settings.foregroundSerial;
      return action('configure', payload);
    },
    onInspect: () => action('inspect'),
    onExportLog: () => action('export', undefined, downloadLog),
    onCollapse: saveCollapsed
  });
  const listener = (message, sender) => {
    if (sender?.id !== chrome.runtime.id || message?.namespace !== 'wxvu.sidebar') return false;
    if (message.command === 'state') acceptState(message.payload);
    else if (message.command === 'show') panel.show();
    return false;
  };
  chrome.runtime.onMessage.addListener(listener);

  function leavePage() {
    alive = false;
    pageEpoch++;
    chrome.runtime.onMessage.removeListener(listener);
    if (activeTransfer) request('file.cancel', { id: activeTransfer }).catch(() => {});
  }
  window.addEventListener('pagehide', leavePage);
  window.addEventListener('pageshow', event => {
    if (!event.persisted || alive) return;
    alive = true;
    chrome.runtime.onMessage.addListener(listener);
    refresh().catch(report);
  });
  globalThis.WXVideoSidebar = { show: () => panel.show(), hide: () => panel.hide() };
  globalThis.WXToolLauncher?.register('video',globalThis.WXVideoSidebar);
  globalThis.WXToolLauncher?.activate('video');
  try { if (sessionStorage.getItem(COLLAPSED_KEY) === '1') panel.hide(); } catch { /* Optional preference only. */ }
  render();
  refresh().catch(report).finally(() => { loading = false; render(); });
})();
