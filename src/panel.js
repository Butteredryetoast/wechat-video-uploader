(() => {
  'use strict';

  const HOST_ID = 'wx-video-batch-uploader';
  const SUCCESS = new Set(['succeeded', 'submitted', 'completed', 'complete', 'success', 'done']);
  const PROBLEM = new Set(['failed', 'error', 'uncertain', 'interrupted', 'missing_file', 'missing-file', 'needs_file']);
  const ACTIVE = new Set(['opening', 'uploading', 'processing', 'saving', 'selecting', 'preparing', 'verifying']);
  const STATUS_LABELS = {
    pending: '等待上传', waiting: '等待上传', queued: '等待上传', ready: '等待上传',
    opening: '打开上传页', preparing: '准备上传', selecting: '选择文件', uploading: '正在上传',
    processing: '视频处理中', saving: '正在保存', verifying: '确认入库',
    succeeded: '已入库', completed: '已入库', complete: '已入库', success: '已入库', done: '已入库',
    submitted: '已提交', failed: '处理失败', error: '处理失败', uncertain: '结果未确认',
    interrupted: '上传已中断', missing_file: '请重选文件', 'missing-file': '请重选文件',
    needs_file: '请重选文件', paused: '已暂停', skipped: '已跳过'
  };

  const STYLES = `
    :host { all: initial; color: #183b2b; font: 14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif; color-scheme: light; }
    *,*::before,*::after { box-sizing: border-box; }
    [hidden] { display: none !important; }
    button,input,textarea,select { font: inherit; }
    button { cursor: pointer; }
    button:disabled { cursor: not-allowed; }
    button,input,textarea,select,a { -webkit-tap-highlight-color: transparent; }
    button:focus-visible,input:focus-visible,textarea:focus-visible,select:focus-visible,a:focus-visible { outline: 3px solid #89dcb4; outline-offset: 3px; }
    .panel { position: fixed; z-index: 2147483601; right: 20px; top: 20px; bottom: 20px; width: min(400px,calc(100vw - 24px)); display: flex; flex-direction: column; overflow: hidden; border: 1px solid #d7e7df; border-radius: 22px; background: #f5f8f6; box-shadow: 0 18px 70px #14332530,0 2px 12px #14332510; }
    .header { flex-shrink: 0; padding: 22px 22px 17px; background: #fff; border-bottom: 1px solid #e4ece7; }
    .header-top { display: flex; align-items: center; gap: 10px; }
    .brand { display: grid; place-items: center; width: 39px; height: 39px; flex-shrink: 0; color: #fff; background: #07a85e; border-radius: 12px; }
    svg { display: block; }
    h1,h2,p { margin: 0; }
    h1 { font-size: 18px; letter-spacing: -.4px; line-height: 1.35; font-weight: 700; }
    .eyebrow { margin-top: 2px; font-size: 11px; color: #719181; letter-spacing: .4px; }
    .heading { flex: 1; }
    .icon-button { display: grid; place-items: center; width: 29px; height: 29px; padding: 0; border: 0; border-radius: 8px; background: transparent; color: #71847a; }
    .icon-button:hover { background: #f0f5f2; color: #173e2d; }
    .header-sub { color: #63796c; font-size: 12px; margin-top: 14px; }
    .scroll { flex: 1; min-height: 0; overflow: auto; overscroll-behavior: contain; padding: 18px 18px 10px; scrollbar-width: thin; scrollbar-color: #c7d8ce transparent; }
    .readiness { display: flex; align-items: flex-start; gap: 8px; margin: 0 2px 14px; }
    .dot { width: 7px; height: 7px; flex-shrink: 0; margin-top: 6px; border-radius: 100%; background: #d39e3e; }
    .readiness.ready .dot { background: #05a75e; }
    .readiness-main { flex: 1; min-width: 0; }
    .readiness-title { font-size: 12px; font-weight: 600; color: #5d7366; }
    .readiness-description { margin-top: 2px; font-size: 11px; line-height: 1.6; color: #829287; overflow-wrap: anywhere; }
    .text-button { padding: 2px 0; border: 0; background: transparent; color: #07864c; font-size: 11px; white-space: nowrap; }
    .text-button:hover { text-decoration: underline; }
    .notice { margin-bottom: 13px; padding: 10px 12px; border: 1px solid #cce5d8; background: #eaf7ef; border-radius: 10px; color: #316345; font-size: 12px; overflow-wrap: anywhere; }
    .notice[data-kind="error"] { color: #934c40; background: #fff0ec; border-color: #f3d3cb; }
    .notice[data-kind="warning"] { color: #89602a; background: #fff7e8; border-color: #eedfbd; }
    .notice[data-kind="action"] { padding: 16px; border: 2px solid #e3b050; background: #fff5df; color: #754a12; font-size: 14px; font-weight: 600; }
    .persistence { margin-bottom: 13px; padding: 11px 12px; border: 1px solid #eed6c2; border-radius: 10px; background: #fff7ee; color: #9d693f; font-size: 12px; }
    .parallel-options { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 0 2px; margin-bottom: 14px; }
    .parallel-label { display: block; color: #526f5d; font-size: 12px; font-weight: 600; }
    .parallel-hint { margin-top: 2px; color: #8b9b90; font-size: 10px; }
    .concurrency { padding: 6px 9px; color: #237846; border: 1px solid #c7ded0; border-radius: 7px; background: #fff; font-size: 12px; }
    .concurrency:disabled { color: #83958a; background: #f1f5f2; opacity: 1; }
    .foreground-option { display: flex; align-items: flex-start; gap: 7px; margin: -4px 2px 15px; color: #526f5d; font-size: 11px; }
    .foreground-option input { accent-color: #07a85e; margin-top: 3px; }
    .foreground-option small { display: block; margin-top: 2px; color: #829287; font-size: 10px; }
    .drop-zone { position: relative; display: flex; flex-direction: column; align-items: center; padding: 20px 18px 17px; margin-bottom: 20px; border: 1.5px dashed #bbd8c8; background: #fafffc; border-radius: 14px; transition: background .15s,border-color .15s; text-align: center; }
    .drop-zone.dragging { border-color: #07a85e; background: #e4f5eb; }
    .upload-icon { color: #0b9959; margin-bottom: 9px; }
    .drop-title { font-size: 13px; color: #365c47; }
    .choose { margin-top: 11px; padding: 7px 19px; background: #fff; border: 1px solid #bfdecc; border-radius: 8px; color: #078a4e; font-size: 12px; font-weight: 600; box-shadow: 0 1px 2px #0c5f2510; }
    .choose:hover:enabled { background: #edf9f1; border-color: #8dc4a6; }
    .choose:disabled { opacity: .5; }
    .drop-hint { margin-top: 9px; color: #90a195; font-size: 10px; }
    .file-input { display: none; }
    .list-heading { display: flex; align-items: center; justify-content: space-between; margin: 0 2px 10px; }
    h2 { font-size: 12px; font-weight: 650; color: #6a7e70; }
    .queue-count { margin-left: 6px; color: #278250; font-size: 11px; background: #e5eee8; padding: 1px 6px; border-radius: 5px; }
    .sequence-note { color: #90a095; font-size: 10px; }
    .empty { display: flex; align-items: center; flex-direction: column; padding: 32px 10px 35px; color: #93a399; text-align: center; }
    .empty strong { margin-top: 12px; color: #6f8779; font-size: 13px; font-weight: 500; }
    .empty p { margin-top: 5px; font-size: 11px; }
    .list { display: flex; flex-direction: column; gap: 10px; }
    .item { padding: 13px; background: #fff; border: 1px solid #e0e9e3; border-radius: 12px; }
    .item[data-tone="active"] { border-color: #9dd2b5; box-shadow: 0 0 0 2px #e8f5ed; }
    .item[data-tone="problem"] { border-color: #edd5c3; }
    .item-top { display: flex; align-items: center; gap: 8px; }
    .video-icon { flex-shrink: 0; width: 31px; height: 35px; display: grid; place-items: center; background: #edf6f0; border-radius: 7px; color: #3a9963; }
    .file-meta { min-width: 0; flex: 1; }
    .file-name { color: #284635; font-size: 12px; font-weight: 600; overflow-wrap: anywhere; }
    .file-size { margin-top: 2px; color: #91a095; font-size: 10px; }
    .progress-text { margin-top: 9px; color: #527762; font-size: 11px; overflow-wrap: anywhere; }
    .status { border-radius: 5px; padding: 3px 6px; background: #f0f3f1; color: #829187; font-size: 10px; font-weight: 500; white-space: nowrap; }
    .item[data-tone="success"] .status { color: #228454; background: #edf8f0; }
    .item[data-tone="active"] .status { color: #048548; background: #e3f5e9; }
    .item[data-tone="problem"] .status { color: #aa763d; background: #fff3e5; }
    .field { display: block; margin-top: 11px; }
    .field-label { display: block; color: #7d8f82; font-size: 10px; margin-bottom: 4px; }
    .field-heading { display: flex; justify-content: space-between; gap: 12px; }
    .title-count { color: #90a095; font-size: 10px; font-variant-numeric: tabular-nums; }
    .title-count.invalid { color: #b35940; }
    .field input[aria-invalid="true"] { border-color: #d49b84; background: #fff9f5; }
    .title-error { color: #a2553c; font-size: 11px; margin-top: 6px; }
    .field input,.field textarea { display: block; width: 100%; padding: 8px 10px; color: #345440; background: #fcfdfc; border: 1px solid #e1e9e3; border-radius: 7px; font-size: 12px; line-height: 1.5; }
    .field textarea { min-height: 52px; height: 52px; max-height: 140px; resize: vertical; }
    .field input:disabled,.field textarea:disabled { color: #83958a; background: #f7f9f7; opacity: 1; }
    .field input::placeholder,.field textarea::placeholder { color: #a3b0a7; }
    .item-bottom { display: flex; justify-content: space-between; align-items: center; margin-top: 9px; }
    .item-index { font-size: 10px; color: #a0ada4; }
    .item-actions { display: flex; align-items: center; gap: 13px; }
    .remove-button { color: #92a095; }
    .remove-button:hover:enabled { color: #a45448; }
    .text-button:disabled { color: #bcc5bf; text-decoration: none; }
    .error-text { margin-top: 9px; padding: 8px 9px; color: #9f6740; background: #fff7ed; border-radius: 7px; font-size: 11px; overflow-wrap: anywhere; }
    .retry-confirm { margin-top: 10px; padding: 10px; background: #fff9ef; border: 1px solid #f2e3cc; border-radius: 8px; }
    .retry-check { display: flex; align-items: flex-start; gap: 7px; color: #86603c; font-size: 11px; line-height: 1.7; }
    .retry-check input { margin: 3px 0 0; accent-color: #079653; }
    .retry-controls { display: flex; justify-content: flex-end; gap: 12px; margin-top: 9px; }
    .retry-submit { background: #0b9957; color: white; border: 0; border-radius: 6px; font-size: 11px; padding: 5px 10px; }
    .retry-submit:disabled { background: #c5d7cc; }
    .help { margin: 15px 3px 4px; color: #8b9b90; font-size: 10px; line-height: 1.8; }
    .footer { flex-shrink: 0; padding: 16px 20px 15px; border-top: 1px solid #e0e9e3; background: #fff; }
    .stats { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
    .stat { display: flex; align-items: baseline; gap: 5px; color: #8b9b90; font-size: 11px; }
    .stat strong { font-size: 16px; font-weight: 650; color: #234c34; font-variant-numeric: tabular-nums; }
    .stat[data-kind="done"] strong { color: #099655; }
    .stat[data-kind="problem"] strong { color: #bb8950; }
    .main-action { display: flex; align-items: center; justify-content: center; gap: 8px; width: 100%; min-height: 42px; padding: 10px 15px; border: 1px solid #079e57; border-radius: 10px; background: #07a85e; color: #fff; font-size: 13px; font-weight: 600; transition: background .15s; }
    .main-action:hover:enabled { background: #078e50; }
    .main-action:disabled { border-color: #dce9e1; background: #e6eee9; color: #95aea0; }
    .main-action.pausing { background: #f3f8f5; border-color: #dce9e1; color: #69907a; }
    .footer-bottom { display: flex; align-items: center; justify-content: space-between; margin-top: 10px; }
    .footer-tip { color: #a1afa6; font-size: 10px; }
    .float { position: fixed; z-index: 2147483647; right: 20px; bottom: 24px; display: flex; align-items: center; gap: 9px; padding: 12px 16px; border-radius: 15px; border: 1px solid #bcd9c9; color: #14673b; background: #fff; box-shadow: 0 5px 24px #204d2d26; font-size: 12px; }
    .float:hover { background: #f1f9f4; }
    .float .dot { margin: 0; background: #069d56; }
    .float.running .dot { animation: pulse 1.7s ease-in-out infinite; }
    :host(.full-page-host) { display: block; width: 100%; min-height: 100vh; padding: 38px 0; background: radial-gradient(ellipse at 80% 0%,#e3f1e8 0,transparent 55%),#eff4f0; }
    .panel.full-page { position: relative; inset: auto; width: min(1000px,calc(100vw - 48px)); min-height: min(850px,calc(100vh - 76px)); margin: 0 auto; border-color: #dce7df; box-shadow: 0 12px 55px #233f2d0d; overflow: clip; }
    .full-page .header { padding: 30px 34px 22px; }
    .full-page .header-top { gap: 14px; }
    .full-page .brand { width: 45px; height: 45px; border-radius: 14px; }
    .full-page h1 { font-size: 25px; letter-spacing: -.6px; }
    .full-page .eyebrow { margin-top: 4px; font-size: 12px; }
    .full-page .header-sub { font-size: 13px; }
    .full-page .scroll { overflow: visible; padding: 25px 34px 18px; }
    .full-page .readiness { padding: 0 0 5px; }
    .full-page .readiness-title { font-size: 13px; }
    .full-page .readiness-description { color: #667e6e; font-size: 12px; line-height: 1.8; }
    .full-page .text-button { font-size: 12px; }
    .full-page .drop-zone { padding: 23px 24px; }
    .full-page .drop-title { font-size: 14px; }
    .full-page .choose { padding: 8px 25px; font-size: 13px; }
    .full-page .drop-hint { font-size: 11px; }
    .full-page .list { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); align-items: start; gap: 14px; }
    .full-page .item { padding: 17px; }
    .full-page h2 { font-size: 13px; }
    .full-page .file-name { font-size: 13px; }
    .full-page .field input { font-size: 13px; }
    .full-page .field-label,.full-page .title-count { font-size: 11px; }
    .full-page .help { font-size: 11px; margin-top: 19px; }
    .full-page .footer { position: sticky; bottom: 0; display: grid; grid-template-columns: 1fr minmax(250px,340px); column-gap: 70px; padding: 21px 34px 18px; box-shadow: 0 -5px 20px #23452e05; }
    .full-page .stats { margin: 0; align-self: center; }
    .full-page .stat { font-size: 12px; }
    .full-page .stat strong { font-size: 22px; }
    .full-page .footer-bottom { grid-column: 1/-1; margin-top: 13px; }
    .full-page .footer-tip { font-size: 11px; }
    @keyframes pulse { 50% { box-shadow: 0 0 0 4px #09a45920; opacity: .6; } }
    @media (max-width: 760px) { :host(.full-page-host) { padding: 16px 0; } .panel.full-page { width: calc(100vw - 24px); min-height: calc(100vh - 32px); border-radius: 16px; } .full-page .header { padding: 24px 22px 20px; } .full-page .scroll { padding: 20px 22px 14px; } .full-page .list { grid-template-columns: minmax(0,1fr); } .full-page .footer { padding: 17px 22px; column-gap: 25px; grid-template-columns: 1fr minmax(220px,1fr); } }
    @media (max-width: 480px) { .panel { top: 12px; bottom: 12px; right: 12px; border-radius: 16px; } .header { padding: 18px 18px 14px; } }
    @media (max-width: 520px) { .full-page .footer { display: flex; flex-direction: column; } .full-page .stats { width: 100%; margin-bottom: 13px; } .full-page h1 { font-size: 21px; } .full-page .footer-bottom { gap: 20px; } }
    @media (prefers-reduced-motion: reduce) { *,*::before,*::after { animation: none !important; transition: none !important; } }
  `;

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = String(text);
    return node;
  }

  function icon(kind, size = 20) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', String(size));
    svg.setAttribute('height', String(size));
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.65');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    const paths = {
      video: ['M5 4.5h14a1.5 1.5 0 0 1 1.5 1.5v12a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 18V6A1.5 1.5 0 0 1 5 4.5Z', 'm10 8 6 4-6 4Z'],
      upload: ['M12 15V3', 'm7 8 5-5 5 5', 'M4 14v5a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5'],
      close: ['m6 6 12 12', 'M18 6 6 18'],
      minimize: ['M5 12h14'],
      stack: ['m12 3 9 5-9 5-9-5Z', 'm3 12 9 5 9-5', 'm3 16 9 5 9-5'],
      play: ['m8 5 11 7-11 7Z']
    };
    (paths[kind] || paths.video).forEach(d => {
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', d);
      svg.append(path);
    });
    return svg;
  }

  function button(text, className, action) {
    const node = el('button', className, text);
    node.type = 'button';
    node.addEventListener('click', action);
    return node;
  }

  function sizeLabel(bytes) {
    const value = Number(bytes);
    if (!Number.isFinite(value) || value < 0) return '大小未知';
    if (value < 1024 * 1024) return `${Math.max(1, Math.round(value / 1024))} KB`;
    if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
    return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`;
  }

  function create(options = {}) {
    const prior = document.getElementById(HOST_ID);
    if (prior) throw new Error('视频批量上传面板已经打开');
    let snapshot = { items: [], running: false, pauseRequested: false };
    let runtimeInfo = { ready: false, reason: '正在检查素材库入口…', adapterLabel: '', concurrency: 1, foregroundSerial: false };
    let destroyed = false;
    let dragDepth = 0;
    const rows = new Map();
    const host = el('div');
    host.id = HOST_ID;
    const fullPage = Boolean(options.fullPage);
    if (fullPage) host.classList.add('full-page-host');
    const shadow = host.attachShadow({ mode: 'open' });
    // Keep the host page's delegated editor handlers away from the assistant.
    ['click', 'input', 'change', 'keydown', 'keyup'].forEach(type => {
      shadow.addEventListener(type, event => event.stopPropagation());
    });
    const style = el('style');
    style.textContent = STYLES;
    const panel = el('section', 'panel');
    if (fullPage) panel.classList.add('full-page');
    panel.setAttribute('aria-label', '视频批量上传');
    const call = (name, ...args) => {
      if (destroyed || typeof options[name] !== 'function') return;
      try {
        const result = options[name](...args);
        if (result && typeof result.catch === 'function') result.catch(error => setNotice(error?.message || '操作未完成，请重试。', 'error'));
      } catch (error) {
        setNotice(error?.message || '操作未完成，请重试。', 'error');
      }
    };
    const busy = () => Boolean(snapshot.running || runtimeInfo.importing || runtimeInfo.loading);
    const concurrencyLimit = () => {
      const value = Number(runtimeInfo.concurrency ?? snapshot.concurrency ?? 1);
      return Number.isInteger(value) && value >= 1 && value <= 10 ? value : 1;
    };

    const header = el('header', 'header');
    const headerTop = el('div', 'header-top');
    const brand = el('div', 'brand');
    brand.append(icon('video', 23));
    const heading = el('div', 'heading');
    heading.append(el('h1', '', '视频批量上传'), el('p', 'eyebrow', '微信公众号 · 素材库'));
    const minimize = button('', 'icon-button', hide);
    minimize.title = '折叠面板，任务继续';
    minimize.setAttribute('aria-label', '折叠面板，任务继续');
    minimize.append(icon('minimize', 17));
    const close = button('', 'icon-button', () => { hide(); call('onClose'); });
    close.title = '收起面板，不暂停上传';
    close.setAttribute('aria-label', '收起面板，不暂停上传');
    close.append(icon('close', 15));
    headerTop.append(brand, heading);
    if (!fullPage) headerTop.append(minimize, close);
    const headerSub = el('p', 'header-sub', '一次选择多个视频，逐个上传并保存到素材库。');
    header.append(headerTop, headerSub);

    const scroll = el('div', 'scroll');
    const readiness = el('div', 'readiness');
    const readinessMain = el('div', 'readiness-main');
    const readinessTitle = el('p', 'readiness-title');
    const readinessDescription = el('p', 'readiness-description');
    readinessMain.append(readinessTitle, readinessDescription);
    const inspect = button('立即检查', 'text-button', () => call('onInspect'));
    readiness.append(el('span', 'dot'), readinessMain, inspect);
    const notice = el('div', 'notice');
    notice.hidden = true;
    notice.setAttribute('role', 'status');
    notice.setAttribute('aria-live', 'polite');
    const persistence = el('div', 'persistence');
    persistence.hidden = true;
    persistence.setAttribute('role', 'status');

    const parallelOptions = el('div', 'parallel-options');
    const parallelLabel = el('label');
    parallelLabel.htmlFor = 'wxvu-concurrency';
    parallelLabel.append(el('span', 'parallel-label', '同时上传'), el('p', 'parallel-hint', '每个视频使用独立上传页'));
    const concurrency = el('select', 'concurrency');
    concurrency.id = 'wxvu-concurrency';
    concurrency.setAttribute('aria-label', '同时上传的视频数量');
    Array.from({ length: 10 }, (_, index) => index + 1).forEach(value => {
      const option = el('option', '', value === 1 ? '串行 · 每次 1 个' : `并行 · ${value} 个视频`);
      option.value = String(value);
      concurrency.append(option);
    });
    concurrency.addEventListener('change', () => {
      if (busy()) { concurrency.value = String(concurrencyLimit()); return; }
      const value = Number(concurrency.value);
      if (Number.isInteger(value) && value >= 1 && value <= 10) call('onConfigure', { concurrency: value });
    });
    parallelOptions.append(parallelLabel, concurrency);
    const foregroundOption = el('label', 'foreground-option');
    const foregroundCheckbox = el('input');
    foregroundCheckbox.type = 'checkbox';
    foregroundCheckbox.setAttribute('aria-label', '前台串行上传');
    const foregroundText = el('span', '', '前台串行上传');
    foregroundText.append(el('small', '', '每次打开一个上传页，提交保存后自动处理下一项。'));
    foregroundOption.append(foregroundCheckbox, foregroundText);
    foregroundCheckbox.addEventListener('change', () => {
      if (busy()) { foregroundCheckbox.checked = runtimeInfo.foregroundSerial === true; return; }
      call('onConfigure', { foregroundSerial: foregroundCheckbox.checked, concurrency: 1 });
    });

    const dropZone = el('div', 'drop-zone');
    const uploadIcon = el('div', 'upload-icon');
    uploadIcon.append(icon('upload', 25));
    const input = el('input', 'file-input');
    input.type = 'file';
    input.accept = 'video/*';
    input.multiple = true;
    input.setAttribute('aria-label', '选择多个本地视频');
    const choose = button('选择视频', 'choose', () => input.click());
    const dropHint = el('p', 'drop-hint', '支持多选 · 自动分配到空闲上传页');
    dropZone.append(uploadIcon, el('p', 'drop-title', '将视频拖到这里'), choose, dropHint, input);
    input.addEventListener('change', () => {
      const files = Array.from(input.files || []);
      input.value = '';
      if (files.length && !busy()) call('onFiles', files);
    });
    dropZone.addEventListener('dragenter', event => {
      event.preventDefault();
      event.stopPropagation();
      dragDepth++;
      if (!busy()) dropZone.classList.add('dragging');
    });
    dropZone.addEventListener('dragover', event => {
      event.preventDefault();
      event.stopPropagation();
      if (event.dataTransfer) event.dataTransfer.dropEffect = busy() ? 'none' : 'copy';
    });
    dropZone.addEventListener('dragleave', event => {
      event.preventDefault();
      event.stopPropagation();
      dragDepth = Math.max(0, dragDepth - 1);
      if (!dragDepth) dropZone.classList.remove('dragging');
    });
    dropZone.addEventListener('drop', event => {
      event.preventDefault();
      event.stopPropagation();
      dragDepth = 0;
      dropZone.classList.remove('dragging');
      if (!busy()) {
        const files = Array.from(event.dataTransfer?.files || []);
        if (files.length) call('onFiles', files);
      }
    });

    const listHeading = el('div', 'list-heading');
    const listTitle = el('h2', '', '上传队列');
    const queueCount = el('span', 'queue-count', '0');
    listTitle.append(queueCount);
    const sequenceNote = el('span', 'sequence-note', '按顺序逐个上传');
    listHeading.append(listTitle, sequenceNote);
    const list = el('div', 'list');
    list.setAttribute('role', 'list');
    const empty = el('div', 'empty');
    empty.append(icon('stack', 34), el('strong', '', '把重复的上传交给队列'), el('p', '', '选择视频后，可在这里检查和修改标题'));
    const help = el('p', 'help', '在“选择视频 → 素材库”入口或素材库页面打开此面板。每个视频自动完成第一张封面确认、原创声明、服务协议和保存；提交保存后继续下一项，无需等待转码或核验入库。保持当前任务页面和正在上传的页面打开，可切换其他标签页。重启浏览器或重新加载扩展后需重选等待上传的文件。');
    scroll.append(readiness, notice, persistence, parallelOptions, foregroundOption, dropZone, listHeading, empty, list, help);

    const footer = el('footer', 'footer');
    const stats = el('div', 'stats');
    const statValues = {};
    [['done', '已完成'], ['active', '进行中'], ['waiting', '等待'], ['problem', '异常']].forEach(([key, label]) => {
      const stat = el('div', 'stat');
      stat.dataset.kind = key;
      const value = el('strong', '', '0');
      statValues[key] = value;
      stat.append(value, el('span', '', label));
      stats.append(stat);
    });
    const mainAction = button('', 'main-action', () => {
      if (mainAction.disabled) return;
      if (snapshot.running) call('onPause');
      else call('onStart');
    });
    const footerBottom = el('div', 'footer-bottom');
    const footerTip = el('span', 'footer-tip', '仅上传素材，不发布内容');
    const exportLog = button('导出日志', 'text-button', () => call('onExportLog'));
    footerBottom.append(footerTip, exportLog);
    footer.append(stats, mainAction, footerBottom);
    panel.append(header, scroll, footer);

    const floating = button('', 'float', show);
    floating.hidden = true;
    floating.setAttribute('aria-label', '展开视频批量上传面板');
    floating.setAttribute('aria-expanded', 'true');
    const floatingLabel = el('span', '', '视频批量上传');
    floating.append(el('span', 'dot'), floatingLabel);
    shadow.append(style, panel);
    if (!fullPage) shadow.append(floating);
    document.documentElement.append(host);

    function createRow(id) {
      const root = el('article', 'item');
      root.setAttribute('role', 'listitem');
      const top = el('div', 'item-top');
      const videoIcon = el('span', 'video-icon');
      videoIcon.append(icon('video', 19));
      const meta = el('div', 'file-meta');
      const name = el('p', 'file-name');
      const size = el('p', 'file-size');
      meta.append(name, size);
      const status = el('span', 'status');
      top.append(videoIcon, meta, status);
      const titleLabel = el('label', 'field');
      const title = el('input');
      title.type = 'text';
      title.maxLength = 64;
      title.placeholder = '输入视频标题';
      title.addEventListener('input', () => {
        if (busy()) return;
        call('onUpdate', id, { title: title.value });
        update();
      });
      const titleHeading = el('span', 'field-heading');
      const titleCount = el('span', 'title-count');
      titleHeading.append(el('span', 'field-label', '标题'), titleCount);
      const titleError = el('p', 'title-error');
      titleError.hidden = true;
      titleLabel.append(titleHeading, title, titleError);
      const error = el('p', 'error-text');
      error.hidden = true;
      const progress = el('p', 'progress-text');
      progress.hidden = true;
      const bottom = el('div', 'item-bottom');
      const index = el('span', 'item-index');
      const actions = el('div', 'item-actions');
      const retry = button('核对后重试', 'text-button', () => {
        confirmation.hidden = false;
        checkbox.focus();
      });
      const remove = button('移除', 'text-button remove-button', () => call('onRemove', id));
      actions.append(retry, remove);
      bottom.append(index, actions);
      const confirmation = el('div', 'retry-confirm');
      confirmation.hidden = true;
      const confirmLabel = el('label', 'retry-check');
      const checkbox = el('input');
      checkbox.type = 'checkbox';
      const submit = button('重新排队', 'retry-submit', () => {
        if (!checkbox.checked || busy()) return;
        checkbox.checked = false;
        submit.disabled = true;
        confirmation.hidden = true;
        call('onRetry', id);
      });
      submit.disabled = true;
      checkbox.addEventListener('change', () => { submit.disabled = !checkbox.checked || busy(); });
      confirmLabel.append(checkbox, el('span', '', '我已核对素材库，此视频尚未入库'));
      const controls = el('div', 'retry-controls');
      controls.append(button('取消', 'text-button', () => {
        confirmation.hidden = true;
        checkbox.checked = false;
        submit.disabled = true;
      }), submit);
      confirmation.append(confirmLabel, controls);
      root.append(top, titleLabel, progress, error, bottom, confirmation);
      return { root, name, size, status, title, titleCount, titleError, error, progress, index, retry, remove, confirmation, checkbox, submit };
    }

    function update(nextSnapshot, nextRuntimeInfo) {
      if (destroyed) return;
      if (nextSnapshot) snapshot = { ...snapshot, ...nextSnapshot, items: Array.isArray(nextSnapshot.items) ? nextSnapshot.items : snapshot.items };
      if (nextRuntimeInfo) runtimeInfo = { ...runtimeInfo, ...nextRuntimeInfo };
      const items = snapshot.items;
      const limit = concurrencyLimit();
      const foreground = runtimeInfo.foregroundSerial === true;
      headerSub.textContent = limit === 1 ? '一次选择多个视频，逐个上传并保存到素材库。' : '一次选择多个视频，在独立后台页面并行上传并保存到素材库。';
      const counts = { done: 0, waiting: 0, problem: 0, active: 0 };
      let blockingCount = 0;
      let invalidTitles = 0;
      const ids = new Set(items.map(item => item.id));
      rows.forEach((row, id) => {
        if (!ids.has(id)) { row.root.remove(); rows.delete(id); }
      });
      items.forEach((item, itemIndex) => {
        let row = rows.get(item.id);
        if (!row) { row = createRow(item.id); rows.set(item.id, row); }
        const state = String(item.status || 'pending');
        const done = SUCCESS.has(state);
        const unconfirmed = state === 'uncertain';
        const missingFile = !done && !unconfirmed && item.hasFile === false;
        const problem = PROBLEM.has(state) || missingFile;
        if (problem && !unconfirmed) blockingCount++;
        const active = ACTIVE.has(state);
        counts[done ? 'done' : problem ? 'problem' : active ? 'active' : 'waiting']++;
        row.root.dataset.tone = done ? 'success' : problem ? 'problem' : active ? 'active' : 'waiting';
        row.name.textContent = item.name || '未命名视频';
        row.name.title = item.name || '未命名视频';
        row.size.textContent = sizeLabel(item.size);
        row.status.textContent = missingFile ? '需重新选择文件' : STATUS_LABELS[state] || state;
        row.progress.textContent = state === 'submitted' ? '保存已提交，不等待入库核验。' : active && typeof item.progress?.reason === 'string' ? item.progress.reason : '';
        row.progress.hidden = !row.progress.textContent;
        row.title.setAttribute('aria-label', `视频 ${itemIndex + 1} 的标题`);
        if (shadow.activeElement !== row.title) row.title.value = item.title || '';
        const tooLong = row.title.value.length > 64;
        const emptyTitle = !row.title.value.trim();
        const invalid = !done && !unconfirmed && (tooLong || emptyTitle);
        if (invalid && !problem && !active) invalidTitles++;
        row.titleCount.textContent = `${row.title.value.length}/64`;
        row.titleCount.classList.toggle('invalid', invalid);
        row.title.setAttribute('aria-invalid', String(invalid));
        row.titleError.textContent = tooLong ? '标题超过 64 字，请手动缩短后再上传。' : emptyTitle ? '请填写视频标题。' : '';
        row.titleError.hidden = !invalid;
        row.title.disabled = Boolean(busy() || done || unconfirmed);
        row.index.textContent = String(itemIndex + 1).padStart(2, '0');
        row.remove.disabled = busy();
        row.retry.hidden = !problem || unconfirmed || missingFile || ['missing_file', 'missing-file', 'needs_file'].includes(state);
        row.retry.disabled = busy();
        row.checkbox.disabled = busy();
        row.submit.disabled = !row.checkbox.checked || busy();
        const details = typeof item.error === 'string' ? item.error : item.error?.message;
        const verifyHint = missingFile ? '请通过上方“选择视频”重新选择此文件，恢复本地文件访问。' : problem && !row.retry.hidden ? '重试前请先核对素材库，避免重复入库。' : '';
        row.error.textContent = unconfirmed ? '保存结果未确认，已跳过此项。后续视频可继续，此项不会自动重传。' : [details, verifyHint].filter(Boolean).join(' ');
        row.error.hidden = !row.error.textContent;
        if (!problem || missingFile || unconfirmed) {
          row.confirmation.hidden = true;
          row.checkbox.checked = false;
        }
        const atPosition = list.children[itemIndex];
        if (atPosition !== row.root) list.insertBefore(row.root, atPosition || null);
      });
      queueCount.textContent = String(items.length);
      call('onSummary', { running: Boolean(snapshot.running), done: counts.done, total: items.length, problem: counts.problem });
      empty.hidden = items.length > 0;
      Object.keys(statValues).forEach(key => { statValues[key].textContent = String(counts[key]); });
      readiness.classList.toggle('ready', Boolean(snapshot.running || runtimeInfo.ready));
      readinessTitle.textContent = snapshot.running ? '正在处理上传队列' : runtimeInfo.ready ? '公众号上传入口已就绪' : '等待公众号上传入口就绪';
      const autoCheck = runtimeInfo.autoCheck?.enabled ? `每 ${runtimeInfo.autoCheck.intervalMs / 1000} 秒自动检查` : '';
      readinessDescription.textContent = snapshot.running ? foreground ? '前台串行处理中 · 请保持当前上传页可见，提交保存后自动处理下一项。' : `${counts.active} 个视频正在处理 · 保持此任务页面打开，可切换其他标签页。` : [runtimeInfo.reason || runtimeInfo.adapterLabel || '', autoCheck].filter(Boolean).join(' · ');
      readinessDescription.hidden = !readinessDescription.textContent;
      persistence.textContent = snapshot.persistenceError ? `进度记录未能保存：${typeof snapshot.persistenceError === 'string' ? snapshot.persistenceError : snapshot.persistenceError.message || '浏览器存储暂不可用'}。请保持当前公众号页面打开，浏览器重启后可能无法恢复队列。` : '';
      persistence.hidden = !snapshot.persistenceError;
      choose.disabled = busy();
      input.disabled = busy();
      inspect.disabled = busy();
      concurrency.disabled = busy() || foreground;
      concurrency.value = String(limit);
      foregroundCheckbox.checked = foreground;
      foregroundCheckbox.disabled = busy();
      sequenceNote.textContent = limit === 1 ? '按顺序逐个上传' : `最多同时上传 ${limit} 个`;
      exportLog.disabled = Boolean(runtimeInfo.loading || runtimeInfo.importing);
      dropHint.textContent = runtimeInfo.importing ? '正在读取所选视频，请保持当前页面打开…' : snapshot.running ? '上传进行中，暂停后可修改队列' : limit === 1 ? '支持多选 · 提交保存后上传下一个' : '支持多选 · 自动分配到空闲上传页';
      mainAction.classList.toggle('pausing', Boolean(snapshot.pauseRequested));
      if (snapshot.running) {
        mainAction.textContent = snapshot.pauseRequested ? `正在完成当前 ${counts.active} 项任务…` : '完成当前任务后暂停';
        mainAction.disabled = Boolean(snapshot.pauseRequested || runtimeInfo.loading || runtimeInfo.importing);
        mainAction.title = '停止分配新视频，已开始的上传会继续完成';
      } else {
        mainAction.textContent = runtimeInfo.importing ? '正在准备视频…' : counts.waiting ? `开始上传 · ${counts.waiting} 个视频` : items.length && !blockingCount ? '队列已处理' : '开始上传';
        mainAction.disabled = busy() || !runtimeInfo.ready || !counts.waiting || blockingCount > 0 || invalidTitles > 0 || Boolean(snapshot.persistenceError);
        mainAction.title = !runtimeInfo.ready ? runtimeInfo.reason || '请先打开公众号“选择视频 → 素材库”入口或素材库页面' : snapshot.persistenceError ? '请先恢复进度记录，再开始上传' : invalidTitles ? '请先修正队列中的标题' : blockingCount ? '请先处理上传失败、中断或缺失文件的项目' : !counts.waiting ? '请先选择视频' : `最多同时上传 ${limit} 个视频，提交保存后自动继续`;
      }
      floating.classList.toggle('running', Boolean(snapshot.running));
      floatingLabel.textContent = snapshot.running ? `视频上传中 · ${counts.active} 个进行中 · ${counts.done}/${items.length} 完成` : items.length ? `视频批量上传 · ${counts.done}/${items.length} 已完成` : '视频批量上传';
      footerTip.textContent = snapshot.running ? foreground ? '请保持上传页可见，等待自动完成' : '切换标签页后，上传会继续' : '仅上传素材，不发布内容';
      if (nextRuntimeInfo && Object.prototype.hasOwnProperty.call(nextRuntimeInfo, 'notice')) setNotice(nextRuntimeInfo.notice || '');
    }

    function setNotice(text, kind = 'info') {
      if (destroyed) return;
      notice.textContent = String(text || '');
      notice.dataset.kind = kind;
      notice.setAttribute('role', kind === 'error' || kind === 'action' ? 'alert' : 'status');
      notice.setAttribute('aria-live', kind === 'error' || kind === 'action' ? 'assertive' : 'polite');
      notice.hidden = !text;
    }

    function show() {
      if (destroyed) return;
      panel.hidden = false;
      floating.hidden = true;
      floating.setAttribute('aria-expanded', 'true');
      call('onCollapse', false);
    }

    function hide() {
      if (destroyed) return;
      if (fullPage) return;
      panel.hidden = true;
      floating.hidden = Boolean(options.unifiedLauncher);
      floating.setAttribute('aria-expanded', 'false');
      call('onCollapse', true);
    }

    function destroy() {
      destroyed = true;
      rows.clear();
      host.remove();
    }

    update();
    return { update, show, hide, destroy, setNotice };
  }

  globalThis.WXVideoPanel = { create };
})();
