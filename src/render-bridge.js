/* MAIN-world frame assistance for extension-created video upload tabs only. */
(() => {
  'use strict';

  const KEY = '__WXVU_RENDER_BRIDGE_V1__';
  const VERSION = 1;
  const PULSE_INTERVAL = 200;
  const MAX_CALLBACKS = 200;
  const FRAME_BUDGET = 16;
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  // The marker only identifies pages created by the extension. The background
  // service worker independently authorizes every request to pulse this bridge.
  try {
    if (window !== window.top || Object.prototype.hasOwnProperty.call(window, KEY)) return;
    const url = new URL(window.location.href);
    if (url.origin !== 'https://mp.weixin.qq.com' || url.username || url.password || url.pathname !== '/cgi-bin/appmsg') return;
    for (const [key, value] of [['t', 'media/videomsg_edit'], ['action', 'video_edit'], ['type', '15']]) {
      if (url.searchParams.getAll(key).length !== 1 || url.searchParams.get(key) !== value) return;
    }
    const marker = new URLSearchParams(url.hash.slice(1));
    if (marker.getAll('wxvu-worker').length !== 1 || !UUID.test(marker.get('wxvu-worker') || '')) return;
  } catch { return; }

  const nativeRequest = window.requestAnimationFrame;
  const nativeCancel = window.cancelAnimationFrame;
  if (typeof nativeRequest !== 'function' || typeof nativeCancel !== 'function') return;
  const now = window.performance.now.bind(window.performance);
  const pending = new Map();
  let stopped = false;
  let pulsing = false;
  let assisted = 0;
  let frames = 0;
  let pulses = 0;
  let lastPulseAt = null;
  let lastFrameAt = null;

  function stats() {
    return { version: VERSION, stopped, hidden: window.document.hidden === true,
      pending: pending.size, assisted, frames, pulses, lastPulseAt, lastFrameAt };
  }

  function report(error) {
    try {
      if (typeof window.reportError === 'function') window.reportError(error);
      else window.console?.error(error);
    } catch { /* A page error reporter must not block the remaining callbacks. */ }
  }

  function deliver(entry, timestamp, isAssisted) {
    if (!entry.active) return;
    entry.active = false;
    pending.delete(entry.id);
    frames += 1;
    if (isAssisted) assisted += 1;
    lastFrameAt = timestamp;
    try { entry.callback.call(window, timestamp); } catch (error) { report(error); }
  }

  function requestAnimationFrame(callback) {
    if (stopped) return nativeRequest.call(window, callback);
    if (typeof callback !== 'function') {
      // Let the browser supply its usual callback validation error.
      return nativeRequest.call(window, callback);
    }
    const entry = { id: null, callback, active: true };
    entry.id = nativeRequest.call(window, (timestamp) => deliver(entry, timestamp, false));
    pending.set(entry.id, entry);
    return entry.id;
  }

  function cancelAnimationFrame(handle) {
    if (arguments.length === 0) return nativeCancel.call(window);
    // Native handles use Web IDL unsigned-long conversion. Convert once so
    // strings and valueOf objects cancel both the native and assisted callback.
    const id = handle >>> 0;
    nativeCancel.call(window, id);
    const entry = pending.get(id);
    if (entry) entry.active = false;
    pending.delete(id);
  }

  function pulse() {
    if (stopped || pulsing || window.document.hidden !== true) return stats();
    const timestamp = now();
    if (lastPulseAt !== null && timestamp - lastPulseAt < PULSE_INTERVAL) return stats();
    lastPulseAt = timestamp;
    pulses += 1;
    // Snapshot one frame only: callbacks registered by this frame wait for the
    // next native frame or pulse instead of creating a synchronous render loop.
    const frame = [];
    for (const entry of pending.values()) {
      frame.push(entry);
      if (frame.length === MAX_CALLBACKS) break;
    }
    pulsing = true;
    try {
      for (const entry of frame) {
        if (stopped || window.document.hidden !== true || now() - timestamp >= FRAME_BUDGET) break;
        if (!entry.active || pending.get(entry.id) !== entry) continue;
        nativeCancel.call(window, entry.id);
        deliver(entry, timestamp, true);
      }
    } finally { pulsing = false; }
    return stats();
  }

  function stop() {
    if (!stopped) {
      stopped = true;
      // Native requests have stayed scheduled all along. Leaving them intact
      // hands pending callbacks back without replacing their returned handles.
      if (window.requestAnimationFrame === requestAnimationFrame) window.requestAnimationFrame = nativeRequest;
      if (window.cancelAnimationFrame === cancelAnimationFrame) window.cancelAnimationFrame = nativeCancel;
      pending.clear();
    }
    return stats();
  }

  try {
    window.requestAnimationFrame = requestAnimationFrame;
    window.cancelAnimationFrame = cancelAnimationFrame;
    Object.defineProperty(window, KEY, { value: Object.freeze({ pulse, stop, stats }) });
  } catch {
    if (window.requestAnimationFrame === requestAnimationFrame) window.requestAnimationFrame = nativeRequest;
    if (window.cancelAnimationFrame === cancelAnimationFrame) window.cancelAnimationFrame = nativeCancel;
  }
})();
