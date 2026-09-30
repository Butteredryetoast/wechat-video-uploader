(() => {
  'use strict';
  const url = new URL(location.href);
  if (window !== window.top || url.origin !== 'https://mp.weixin.qq.com' ||
      /^#wxvu-worker=[0-9a-f-]{36}$/i.test(url.hash)) return;
  if (typeof globalThis.WXToolLauncher?.mount === 'function') { globalThis.WXToolLauncher.mount(); return; }

  const HOST_ID = 'wx-tool-launcher';
  const POSITION_KEY = 'wxvu.launcher.position';
  const SIZE = 48;
  const GAP = 8;
  document.getElementById(HOST_ID)?.remove();
  const host = document.createElement('div');
  host.id = HOST_ID;
  const shadow = host.attachShadow({mode:'open'});
  shadow.innerHTML = `
    <style>
      :host{all:initial;color-scheme:light;font:13px/1.5 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;color:#204537}
      *,*::before,*::after{box-sizing:border-box}[hidden]{display:none!important}button{font:inherit;cursor:pointer;-webkit-tap-highlight-color:transparent}button:focus-visible{outline:3px solid #8ee0bc;outline-offset:3px}svg{display:block;pointer-events:none}
      .ball{position:relative;display:grid;place-items:center;width:48px;height:48px;padding:0;border:1px solid #ffffffc9;border-radius:50%;background:#07a861;color:#fff;box-shadow:0 4px 18px #154a3629,0 1px 4px #124a3620;touch-action:none;user-select:none;transition:background .15s,box-shadow .15s}
      .ball:hover,.ball[aria-expanded=true]{background:#078e54;box-shadow:0 5px 22px #154a3640}.ball.dragging{cursor:grabbing;transition:none}.badge{position:absolute;right:0;top:1px;width:10px;height:10px;border:2px solid white;border-radius:50%;background:#075e3a}.badge[data-tone=running]{background:#8bffb3}.badge[data-tone=problem]{background:#efab4d}
      .menu{position:fixed;display:flex;flex-direction:column;gap:4px;width:min(232px,calc(100vw - 16px));padding:8px;background:#fff;border:1px solid #dcebe3;border-radius:16px;box-shadow:0 10px 40px #153d2e26;overflow:auto;color:#234b38}
      .menu-title{margin:4px 9px 5px;color:#8a9c91;font-size:11px;letter-spacing:.5px}.item{display:flex;align-items:center;gap:11px;min-height:59px;width:100%;padding:10px;border:0;border-radius:10px;background:#fff;color:#264f39;text-align:left}.item:hover,.item:focus-visible{background:#eff8f3}.item[aria-current=true]{background:#eaf7ef}.item-icon{display:grid;place-items:center;width:31px;height:33px;flex-shrink:0;border-radius:9px;color:#07995a;background:#eaf7ef}.item-name{display:block;font-weight:650;font-size:13px}.item-hint{display:block;margin-top:2px;color:#8a9c90;font-size:11px}.error{margin:4px 3px 2px;padding:8px 10px;background:#fff4e8;color:#a0692c;border-radius:8px;font-size:12px;overflow-wrap:anywhere}.foot{margin:4px 9px;color:#a1b0a7;font-size:10px}
      @media(prefers-reduced-motion:reduce){.ball{transition:none}}
    </style>
    <button class="ball" type="button" aria-label="公众号助手：文章排版与视频上传，拖动可移动" aria-haspopup="menu" aria-expanded="false" aria-controls="wx-tools-menu" title="公众号助手 · 点击展开，拖动可移动">
      <svg width="25" height="25" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><path d="M17.5 14v7M14 17.5h7"/></svg>
      <span class="badge" hidden aria-hidden="true"></span>
    </button>
    <div class="menu" id="wx-tools-menu" role="menu" aria-label="公众号助手" hidden>
      <div class="menu-title" role="presentation">公众号助手</div>
      <button class="item" type="button" role="menuitem" data-tool="article" tabindex="-1"><span class="item-icon" aria-hidden="true"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M5 5h14M12 5v14M8 19h8M5 5v3M19 5v3"/></svg></span><span><span class="item-name">文章排版</span><span class="item-hint">粘贴原文，整理后插入正文</span></span></button>
      <button class="item" type="button" role="menuitem" data-tool="video" tabindex="-1"><span class="item-icon" aria-hidden="true"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="m10 8 6 4-6 4z"/></svg></span><span><span class="item-name">视频批量上传</span><span class="item-hint video-progress">上传视频到素材库</span></span></button>
      <p class="error" role="status" aria-live="polite" hidden></p>
      <div class="foot" role="presentation">拖动悬浮球，可调整位置</div>
    </div>`;
  const $ = selector => shadow.querySelector(selector);
  const ball = $('.ball');
  const menu = $('.menu');
  const items = Array.from(shadow.querySelectorAll('[data-tool]'));
  const panels = new Map();
  let active = null;
  let customPosition = false;
  let position = null;
  let drag = null;
  let suppressClickUntil = 0;
  let userMoved = false;
  let opening = 0;

  function clamp(value, minimum, maximum) { return Math.max(minimum, Math.min(value, Math.max(minimum, maximum))); }
  function viewport() { return {width:Math.max(SIZE, window.innerWidth || document.documentElement.clientWidth || 1024), height:Math.max(SIZE, window.innerHeight || document.documentElement.clientHeight || 768)}; }
  function placeMenu() {
    if (menu.hidden || !position) return;
    const {width,height} = viewport();
    const menuWidth = Math.min(232, width - GAP * 2);
    const menuHeight = menu.getBoundingClientRect().height || ($('.error').hidden ? 190 : 236);
    const left = clamp(position.x + SIZE - menuWidth, GAP, width - menuWidth - GAP);
    const above = position.y - menuHeight - 10;
    const top = above >= GAP ? above : clamp(position.y + SIZE + 10, GAP, height - menuHeight - GAP);
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    menu.style.maxHeight = `${Math.max(0,height - top - GAP)}px`;
  }
  function place(next) {
    const {width,height} = viewport();
    const insetX = Math.min(GAP, Math.max(0,(width - SIZE) / 2));
    const insetY = Math.min(GAP, Math.max(0,(height - SIZE) / 2));
    position = {x:clamp(next.x,insetX,width - SIZE - insetX),y:clamp(next.y,insetY,height - SIZE - insetY)};
    host.style.setProperty('left',`${position.x}px`,'important');
    host.style.setProperty('top',`${position.y}px`,'important');
    placeMenu();
  }
  function defaultPosition() { const {width,height} = viewport(); return {x:width - SIZE - 20,y:height - SIZE - 24}; }
  function mount() {
    host.style.setProperty('all','initial','important');
    for (const [key,value] of Object.entries({display:'block',position:'fixed',width:`${SIZE}px`,height:`${SIZE}px`,
      'z-index':'2147483647',visibility:'visible',opacity:'1','pointer-events':'auto',margin:'0',padding:'0',border:'0',
      font:'13px/1.5 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif',color:'#204537','color-scheme':'light'}))
      host.style.setProperty(key,value,'important');
    if (!host.isConnected) document.documentElement.append(host);
    place(position || defaultPosition());
  }
  function closeMenu(focusBall = false) {
    menu.hidden = true;
    ball.setAttribute('aria-expanded','false');
    items.forEach(item => { item.tabIndex = -1; });
    if (focusBall) ball.focus({preventScroll:true});
  }
  function showMenu(focus = false) {
    mount();
    menu.hidden = false;
    ball.setAttribute('aria-expanded','true');
    items.forEach((item,index) => { item.tabIndex = index === 0 ? 0 : -1; });
    placeMenu();
    if (focus) items[0].focus({preventScroll:true});
  }
  function activate(id) {
    if (!['article','video'].includes(id)) return;
    closeMenu();
    for (const [other,panel] of panels) if (other !== id) panel.hide?.();
    active = id;
    items.forEach(item => item.setAttribute('aria-current',String(item.dataset.tool === active)));
  }
  function collapsed(id) {
    if (active !== id) return;
    active = null;
    items.forEach(item => item.removeAttribute('aria-current'));
  }
  function register(id,panel) {
    if (['article','video'].includes(id) && typeof panel?.show === 'function') panels.set(id,panel);
  }
  async function open(id) {
    if (!['article','video'].includes(id)) return;
    const attempt = ++opening;
    $('.error').hidden = true;
    $('.error').textContent = '';
    try {
      const panel = panels.get(id);
      if (panel) { activate(id); await panel.show(); }
      else if (id === 'video') {
        closeMenu();
        const reply = await chrome.runtime.sendMessage({namespace:'wxvu.launcher',command:'openVideo'});
        if (!reply?.ok) throw new Error(reply?.error || '视频上传面板未能打开，请刷新公众号页面后重试。');
      } else throw new Error('文章排版面板尚未就绪，请刷新公众号页面后重试。');
    } catch (error) {
      if (attempt !== opening) return;
      collapsed(id);
      $('.error').textContent = typeof error?.message === 'string' ? error.message : '面板未能打开，请刷新公众号页面后重试。';
      $('.error').hidden = false;
      showMenu();
    }
  }
  function updateVideo({running = false,done = 0,total = 0,problem = 0} = {}) {
    const count = n => Number.isFinite(Number(n)) ? Math.max(0, Math.floor(Number(n))) : 0;
    done = count(done); total = count(total); problem = count(problem);
    const summary = total ? `${done}/${total} 已完成${problem ? ` · ${problem} 项异常` : ''}` : '上传视频到素材库';
    $('.video-progress').textContent = `${running ? '上传中 · ' : ''}${summary}`;
    const badge = $('.badge');
    badge.hidden = !running && !problem;
    badge.dataset.tone = problem ? 'problem' : 'running';
    const description = total || running || problem ? ` · 视频${running ? '上传中' : '队列'} ${done}/${total}${problem ? ` · ${problem} 项异常` : ''}` : '';
    ball.title = `公众号助手 · 点击展开，拖动可移动${description}`;
    ball.setAttribute('aria-label',`公众号助手：文章排版与视频上传，拖动可移动${description}`);
  }
  function savePosition() {
    try { Promise.resolve(chrome.storage.local.set({[POSITION_KEY]:{...position}})).catch(() => {}); }
    catch { /* Position still works for this page if extension storage is unavailable. */ }
  }

  ball.addEventListener('click',event => {
    if (event.detail !== 0 && Date.now() < suppressClickUntil) { event.preventDefault(); return; }
    $('.error').hidden = true;
    if (menu.hidden) showMenu(event.detail === 0); else closeMenu();
  });
  ball.addEventListener('keydown',event => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault(); showMenu(true);
      if (event.key === 'ArrowUp') items[items.length - 1].focus();
    }
  });
  items.forEach(item => item.addEventListener('click',() => { void open(item.dataset.tool); }));
  menu.addEventListener('keydown',event => {
    const current = items.indexOf(shadow.activeElement);
    let next;
    if (event.key === 'ArrowDown') next = (current + 1) % items.length;
    if (event.key === 'ArrowUp') next = (current + items.length - 1) % items.length;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = items.length - 1;
    if (next !== undefined) { event.preventDefault(); items.forEach((item,index) => { item.tabIndex = index === next ? 0 : -1; }); items[next].focus(); }
  });
  function dismissOnEscape(event) {
    if (event.key === 'Escape' && !menu.hidden) { event.preventDefault(); closeMenu(true); }
  }
  document.addEventListener('keydown',dismissOnEscape);
  shadow.addEventListener('keydown',dismissOnEscape);
  // Keep editor shortcuts and delegated page handlers out of the extension UI.
  // Pointer events continue bubbling so document-level drag tracking still works.
  for (const type of ['click','keydown','keyup','input','change'])
    shadow.addEventListener(type,event => event.stopPropagation());
  document.addEventListener('pointerdown',event => { if (!event.composedPath().includes(host)) closeMenu(); },true);
  shadow.addEventListener('focusout',event => {
    if (event.relatedTarget && !shadow.contains(event.relatedTarget)) closeMenu();
  });
  ball.addEventListener('pointerdown',event => {
    if (event.button !== 0 || event.isPrimary === false) return;
    drag = {id:event.pointerId,startX:event.clientX,startY:event.clientY,x:position.x,y:position.y,moved:false};
    try { ball.setPointerCapture(event.pointerId); } catch { /* Document listeners also support pointer capture being unavailable. */ }
  });
  document.addEventListener('pointermove',event => {
    if (!drag || event.pointerId !== drag.id) return;
    const dx = event.clientX - drag.startX, dy = event.clientY - drag.startY;
    if (!drag.moved && Math.hypot(dx,dy) < 6) return;
    event.preventDefault();
    drag.moved = true; customPosition = true; userMoved = true;
    ball.classList.add('dragging');
    closeMenu();
    place({x:drag.x + dx,y:drag.y + dy});
  },{passive:false});
  function finishDrag(event) {
    if (!drag || event.pointerId !== drag.id) return;
    const completed = drag;
    drag = null;
    if (completed.moved) { suppressClickUntil = Date.now() + 500; savePosition(); }
    ball.classList.remove('dragging');
    try { ball.releasePointerCapture(completed.id); } catch {}
  }
  document.addEventListener('pointerup',finishDrag);
  document.addEventListener('pointercancel',finishDrag);
  ball.addEventListener('lostpointercapture',finishDrag);
  window.addEventListener('resize',() => { place(customPosition ? position : defaultPosition()); });

  globalThis.WXToolLauncher = Object.freeze({mount,register,open,activate,collapsed,updateVideo});
  mount();
  try {
    Promise.resolve(chrome.storage.local.get(POSITION_KEY)).then(stored => {
      const saved = stored?.[POSITION_KEY];
      if (!userMoved && Number.isFinite(saved?.x) && Number.isFinite(saved?.y)) {
        customPosition = true;
        place(saved);
      }
    }).catch(() => {});
  } catch { /* The default position is enough when extension storage is unavailable. */ }
})();
