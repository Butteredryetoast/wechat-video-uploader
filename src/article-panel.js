(() => {
  'use strict';
  const url = new URL(location.href);
  // Formatting is usable before the article editor opens. Only the body writer
  // requires an article-edit route; do not hide the launcher based on that URL.
  if (window !== window.top || url.origin !== 'https://mp.weixin.qq.com' ||
      /^#wxvu-worker=[0-9a-f-]{36}$/i.test(url.hash) || !globalThis.WXArticleFormat || !globalThis.WXArticleEditor) return;
  if (typeof globalThis.WXArticlePanel?.mount === 'function') { globalThis.WXArticlePanel.mount(); return; }
  document.getElementById('wx-article-formatter')?.remove();

  const host = document.createElement('div');
  host.id = 'wx-article-formatter';
  const shadow = host.attachShadow({mode:'open'});
  shadow.innerHTML = `
    <style>
      :host{all:initial;position:fixed;left:20px;bottom:22px;z-index:2147483600;font:14px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;color:#234337}
      *{box-sizing:border-box}button,input,select,textarea{font:inherit}button{cursor:pointer}button:disabled{cursor:default;opacity:.45}
      button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible{outline:3px solid #9adfc1;outline-offset:2px}
      [hidden]{display:none!important}.launcher{border:1px solid #c8e2d5;border-radius:14px;background:#fff;color:#07804b;padding:12px 20px;box-shadow:0 5px 24px #12382218;font-weight:650}
      .panel{width:min(900px,calc(100vw - 40px));height:min(830px,calc(100vh - 44px));background:#fff;border:1px solid #d5e5dc;border-radius:20px;box-shadow:0 14px 64px #0b352733;display:flex;flex-direction:column;overflow:hidden}
      header{padding:18px 24px;border-bottom:1px solid #e2ebe6;display:flex;align-items:center;gap:12px;flex-shrink:0}h2{font-size:22px;margin:0;color:#153e2e}header p{margin:1px 0 0;color:#788d81;font-size:12px}.close{margin-left:auto;border:0;background:transparent;font-size:26px;color:#7b9284;padding:0 8px}
      .body{overflow:auto;padding:18px 24px;flex:1;min-height:0}label{display:block;font-weight:600;margin-bottom:7px}.hint{font-size:12px;color:#7a8f84;margin:5px 0 12px}.paste{display:block;width:100%;height:128px;resize:vertical;border:1px solid #d9e5de;border-radius:12px;padding:12px;color:#284936;background:#fbfdfc;line-height:1.65}.row{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin:12px 0}.row label{margin:0;font-size:13px}.color{vertical-align:middle;width:34px;height:28px;padding:1px;border:1px solid #d6e4dc;border-radius:5px;background:white}.button{border:1px solid #c9dfd1;background:white;border-radius:8px;color:#0b8250;padding:8px 14px;font-weight:600}.primary{background:#05a761;border-color:#05a761;color:white}.muted{color:#82968a;font-size:12px}.status{padding:9px 12px;background:#eff8f3;border-radius:8px;margin:12px 0;white-space:pre-line;font-size:13px}.status.error{background:#fff3e9;color:#965b27}
      .preview-title{display:flex;align-items:center;justify-content:space-between;margin:18px 0 9px}.preview-title h3{margin:0;font-size:16px}.preview{background:#f5f8f6;border:1px solid #e1eae4;border-radius:12px;padding:15px;min-height:110px}.empty{text-align:center;color:#8d9e93;padding:22px}.block{display:grid;grid-template-columns:72px minmax(0,1fr);gap:10px;margin-bottom:8px;padding:6px 8px;border-radius:8px;background:white}.block:focus-within{box-shadow:0 0 0 1px #83caab}.block-tools{padding-top:3px;display:flex;flex-direction:column;align-items:flex-start;gap:7px;font-size:11px;color:#84978b}.toggle{font-size:11px;border:1px solid #dce8e0;background:#f7faf8;color:#41614e;border-radius:5px;padding:3px 5px}.toggle[aria-pressed=true]{background:#fff0dc;color:#a66512;border-color:#f6cd92}.content{min-width:0;overflow-wrap:anywhere;color:#333;font-size:16px;background:white}.content img{max-width:100%;height:auto}.content table{max-width:100%}.content a{color:#576b95}.video-slot{color:#91a195;border:1px dashed #d7e5db;border-radius:6px;font-size:12px;padding:6px;text-align:center}
      footer{border-top:1px solid #e2ebe6;padding:14px 24px;background:#fafcfb;flex-shrink:0}.destination{display:flex;gap:12px;align-items:center;flex-wrap:wrap}.destination label{margin:0;font-size:13px;font-weight:400}.destination select{background:white;border:1px solid #d1e3d7;border-radius:6px;padding:6px;color:#355845}.actions{display:flex;gap:9px;flex-wrap:wrap;margin-top:11px}.actions .primary{flex:1}.editor-state{font-size:12px;color:#7e9385;margin-top:7px}.editor-state.unavailable{color:#a0652b}footer .status{margin:8px 0 0;max-height:105px;overflow:auto}details{font-size:12px;color:#887b5e;margin-top:8px}details ul{margin:4px 0;padding-left:19px}.danger-note{color:#9b702e;font-size:12px;margin-top:5px}
      @media(max-width:600px){:host{left:8px;bottom:8px}.panel{width:calc(100vw - 16px);height:calc(100vh - 16px)}.body,footer,header{padding:14px}.block{grid-template-columns:58px minmax(0,1fr);padding:5px}.preview{padding:7px}}
    </style>
    <button class="launcher" type="button" title="文章排版 v0.4.6">✦ 文章排版</button>
    <section class="panel" role="dialog" aria-label="文章排版" hidden>
      <header><div><h2>文章排版</h2><p>v0.4.6 · 粘贴原文 · 整理预览 · 插入正文</p></div><button class="close" type="button" aria-label="收起文章排版">−</button></header>
      <div class="body">
        <label for="article-paste">从飞书或腾讯文档复制后，粘贴到这里</label>
        <textarea id="article-paste" class="paste" placeholder="在这里按 ⌘V / Ctrl+V 粘贴整篇文章。原文的标题和图片信息会一起读取。"></textarea>
        <div class="hint source-hint">正文16号 · 两端对齐 · 段后距24 · 小标题文字橙底白字20号</div>
        <div class="row"><button class="button primary format" type="button">整理并预览</button><label>标题底色 <input class="color" type="color" value="#ff8a00" aria-label="标题底色"></label><button class="button clear" type="button">清空</button></div>
        <details class="warnings" hidden><summary>识别提示</summary><ul></ul></details>
        <div class="preview-title"><h3>排版预览</h3><span class="muted stats">等待粘贴文章</span></div>
        <p class="hint">点击段落旁的“正文 / 小标题”可调整识别结果。视频位置会留一个空行；复制时未带过来的视频，可在原文中写“[视频]”占位。</p>
        <div class="preview"><div class="empty">整理后，文章会显示在这里</div></div>
      </div>
      <footer>
        <div class="destination"><label for="article-mode">插入方式</label><select id="article-mode"><option value="append">追加到正文末尾</option><option value="replace">替换当前正文</option></select><button class="button check" type="button">检查正文</button><button class="button diagnose" type="button" hidden>复制定位信息</button></div>
        <div class="danger-note" hidden>将替换编辑器里的正文；顶部文章标题不受影响。插入后可撤销本次操作。</div>
        <div class="actions"><button class="button primary insert" type="button" disabled>插入公众号正文</button><button class="button copy" type="button" disabled>复制排版结果</button><button class="button undo" type="button" disabled>撤销本次插入</button></div>
        <div class="row manual-paste" hidden><button class="button paste-helper" type="button">复制并定位正文</button><span class="muted">定位后按 ⌘V / Ctrl+V，让公众号处理粘贴。</span></div>
        <div class="editor-state">打开后检查正文编辑器</div>
        <div class="status" role="status" aria-live="polite" hidden></div>
      </footer>
    </section>`;
  function mount() {
    // Page CSS has priority over ordinary :host rules. Keep the small launcher
    // visible even if the host page styles generic divs or redraws its body.
    host.style.setProperty('all','initial','important');
    for (const [key,value] of Object.entries({display:'block',position:'fixed',left:'20px',bottom:'22px',
      'z-index':'2147483600',visibility:'visible',opacity:'1','pointer-events':'auto',
      font:'14px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif',color:'#234337'}))
      host.style.setProperty(key,value,'important');
    if (!host.isConnected) document.documentElement.append(host);
  }
  mount();
  const $ = selector => shadow.querySelector(selector);
  const format = globalThis.WXArticleFormat;
  const editor = globalThis.WXArticleEditor;
  const state = {html:'',text:'',blocks:[],warnings:[],result:null,dirty:false,busy:false,inserted:null,canUndo:false,partial:false,editorReady:false,editorReason:''};

  function notice(text, error = false) {
    $('.status').textContent = text;
    $('.status').hidden = !text;
    $('.status').classList.toggle('error', error);
  }
  function controls() {
    const unavailable = state.busy || !state.result || state.dirty;
    $('.insert').disabled = unavailable || !state.editorReady || state.partial || state.inserted === fingerprint();
    $('.insert').title = !state.editorReady ? state.editorReason || '正在检查正文编辑区' :
      state.dirty ? '原文已改动，请重新整理并预览' : !state.result ? '请先粘贴文章并整理预览' :
      state.partial ? '请先撤销上次未完整写入的内容' : state.inserted === fingerprint() ? '此排版结果已插入，避免重复添加' : '';
    $('.copy').disabled = unavailable;
    $('.format').disabled = state.busy;
    $('.clear').disabled = state.busy;
    $('.color').disabled = state.busy;
    $('#article-paste').disabled = state.busy;
    $('#article-mode').disabled = state.busy;
    $('.undo').disabled = state.busy || !state.canUndo;
    $('.diagnose').disabled = state.busy;
    $('.paste-helper').disabled = unavailable || !state.editorReady || (state.partial && $('#article-mode').value === 'append');
    $('.paste-helper').title = state.partial && $('#article-mode').value === 'append' ? '正文已变化，请先撤销本次插入，或选择替换当前正文，避免重复追加' : '';
  }
  function fingerprint() { return `${$('#article-mode').value}\n${state.result?.html || ''}`; }
  function checkEditor() {
    try {
      const result = editor.inspect();
      state.canUndo = Boolean(result.canUndo);
      state.editorReady = Boolean(result.ready);
      state.editorReason = result.reason || '未找到正文，可复制排版结果后手动粘贴。';
      $('.diagnose').hidden = state.editorReady;
      controls();
      $('.editor-state').textContent = result.ready ? `正文编辑器已找到${result.hasContent ? ' · 已有内容，可追加或选择替换' : ' · 当前为空'}` : state.editorReason;
      $('.editor-state').classList.toggle('unavailable',!state.editorReady);
      return result;
    } catch (error) {
      state.canUndo = false; state.editorReady = false; state.editorReason = error.message; controls();
      $('.diagnose').hidden = false;
      $('.editor-state').textContent = error.message;
      $('.editor-state').classList.add('unavailable');
      return {ready:false};
    }
  }
  function show() { mount(); $('.launcher').textContent = '✦ 文章排版'; $('.panel').hidden = false; $('.launcher').hidden = true; checkEditor(); $('#article-paste').focus(); }
  function hide() { $('.panel').hidden = true; $('.launcher').hidden = false; }
  function updatePreview() {
    state.result = state.blocks.length ? format.render(state.blocks,{orange:$('.color').value}) : null;
    const preview = $('.preview');
    preview.replaceChildren();
    if (!state.result) {
      const empty = document.createElement('div'); empty.className = 'empty'; empty.textContent = '整理后，文章会显示在这里'; preview.append(empty);
    }
    for (const block of state.blocks) {
      const row = document.createElement('div'); row.className = 'block'; row.dataset.blockId = block.id;
      const tools = document.createElement('div'); tools.className = 'block-tools';
      if (['paragraph','heading'].includes(block.kind)) {
        const toggle = document.createElement('button'); toggle.type = 'button'; toggle.className = 'toggle';
        toggle.textContent = block.kind === 'heading' ? '小标题' : '正文';
        toggle.setAttribute('aria-pressed',String(block.kind === 'heading'));
        toggle.setAttribute('aria-label',`切换第${state.blocks.indexOf(block)+1}段为${block.kind === 'heading' ? '正文' : '小标题'}`);
        toggle.addEventListener('click',()=>{
          if(state.busy) return;
          block.kind = block.kind === 'heading' ? 'paragraph' : 'heading';
          updatePreview();
        });
        tools.append(toggle);
      } else { const label = document.createElement('span'); label.textContent = {image:'图片',video:'视频空行',table:'表格'}[block.kind] || '内容'; tools.append(label); }
      const gap = document.createElement('button'); gap.type = 'button'; gap.className = 'toggle'; gap.textContent = '+ 空行'; gap.title = '在此段后留一个视频空行';
      gap.addEventListener('click',()=>{
        if(state.busy) return;
        state.blocks.splice(state.blocks.indexOf(block)+1,0,{id:`manual-${crypto.randomUUID()}`,kind:'video',html:'',text:''});
        updatePreview();
      }); tools.append(gap);
      if(block.kind === 'video') {
        const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'toggle'; remove.textContent = '移除空行';
        remove.addEventListener('click',()=>{ if(state.busy) return; state.blocks.splice(state.blocks.indexOf(block),1); updatePreview(); }); tools.append(remove);
      }
      const content = document.createElement('div'); content.className = 'content';
      // Only the formatter's whitelist output enters the live preview.
      content.innerHTML = format.render([block],{orange:$('.color').value}).html;
      if(block.kind === 'video') { content.replaceChildren(); const slot = document.createElement('div'); slot.className = 'video-slot'; slot.textContent = '视频位置 · 插入时保留一个空行'; content.append(slot); }
      row.append(tools,content); preview.append(row);
    }
    const headings = state.blocks.filter(b=>b.kind==='heading').length;
    const videos = state.blocks.filter(b=>b.kind==='video').length;
    $('.stats').textContent = state.result ? `${state.blocks.length} 段 · ${headings} 个小标题 · ${videos} 个视频空行` : '等待粘贴文章';
    controls();
  }
  function prepare() {
    try {
      const source = $('#article-paste').value;
      if(!source.trim() && !state.html) throw new Error('请先粘贴文章。');
      if(source.length + state.html.length > 5_000_000) throw new Error('文章过大，请分段粘贴，每次不超过 5 MB 文本。');
      const parsed = format.parse({html:state.html,text:source});
      state.blocks = parsed.blocks;
      state.warnings = parsed.warnings || [];
      if(!state.blocks.length) throw new Error('没有识别到文章内容，请复制正文后重试。');
      state.dirty = false;
      const warnings = $('.warnings ul'); warnings.replaceChildren();
      state.warnings.forEach(w=>{ const li=document.createElement('li'); li.textContent=typeof w==='string' ? w : w.message || String(w); warnings.append(li); });
      $('.warnings').hidden = !state.warnings.length;
      updatePreview();
      notice('排版已整理，可调整小标题后插入正文。');
      checkEditor();
    } catch(error) { notice(error.message,true); }
  }
  $('#article-paste').addEventListener('paste',event=>{
    if(state.busy || !event.clipboardData) return;
    event.preventDefault();
    const html = event.clipboardData.getData('text/html');
    const text = event.clipboardData.getData('text/plain');
    if(!html && !text) { notice('剪贴板中没有文章文字，请从文档复制整篇正文。',true); return; }
    state.html = html;
    state.text = text;
    // Keep source HTML inert: DOMParser is only used by the sanitizer, never displayed raw.
    $('#article-paste').value = text || new DOMParser().parseFromString(html,'text/html').body.textContent || '';
    state.dirty = true;
    $('.source-hint').textContent = html ? '已收到带格式原文，整理时将识别标题、图片和视频占位。' : '已收到纯文本；可在预览中将对应段落标为小标题。';
    notice('原文已粘贴，点击“整理并预览”。');
    controls();
  });
  $('#article-paste').addEventListener('input',()=>{
    state.html = ''; state.text = $('#article-paste').value; state.dirty = true;
    $('.source-hint').textContent = '当前使用编辑后的纯文本。需要保留原文图片和标题信息时，请重新粘贴整篇文章。';
    controls();
  });
  $('.format').addEventListener('click',prepare);
  $('.color').addEventListener('input',()=>{ if(state.result && !state.dirty) updatePreview(); });
  $('.launcher').addEventListener('click',show);
  $('.close').addEventListener('click',hide);
  $('.check').addEventListener('click',checkEditor);
  $('.diagnose').addEventListener('click',async()=>{
    if(state.busy) return;
    if(typeof editor.diagnose !== 'function') {
      notice('当前页面仍使用旧版正文脚本，请先保留文章和排版结果，再刷新公众号页面。',true);
      return;
    }
    state.busy=true; controls();
    try {
      const text=JSON.stringify(await editor.diagnose(),null,2);
      if(navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
      else {
        let copied=false;
        const listener=event=>{event.preventDefault();event.clipboardData.setData('text/plain',text);copied=true;};
        document.addEventListener('copy',listener,true);
        try {if(!document.execCommand('copy') || !copied) throw new Error('浏览器未允许复制，请重试。');}
        finally {document.removeEventListener('copy',listener,true);}
      }
      notice('已复制正文定位信息，可粘贴给我排查。内容不含文章文字和登录参数。');
    } catch(error) {notice(`定位信息复制失败：${error.message}`,true);}
    finally {state.busy=false;controls();}
  });
  $('#article-mode').addEventListener('change',()=>{ const replace = $('#article-mode').value==='replace'; $('.danger-note').hidden=!replace; $('.insert').textContent=replace?'替换公众号正文':'插入公众号正文'; controls(); });
  $('.clear').addEventListener('click',()=>{
    state.html=''; state.text=''; state.blocks=[]; state.result=null; state.dirty=false;
    $('#article-paste').value=''; $('.warnings').hidden=true; notice(''); updatePreview();
  });
  $('.insert').addEventListener('click',async()=>{
    if(state.busy || state.dirty || state.partial || !state.result || state.inserted===fingerprint()) return;
    // Recheck immediately before writing; the editor can be replaced while the
    // user reviews a long article in this panel.
    if(!checkEditor().ready) {notice(state.editorReason,true);return;}
    state.busy=true; controls();
    notice('正在交给编辑器处理，并检查段落、字号和颜色…');
    try {
      const result = await editor.insert(state.result.html,{mode:$('#article-mode').value});
      if(result?.ok===false) throw new Error(result.reason || '正文插入未完成。');
      if(result?.formatVerified !== true) {
        const error = new Error('未能确认正文保留了排版，请检查页面后使用复制粘贴。');
        error.articleChanged = result?.changed !== false;
        throw error;
      }
      state.inserted=fingerprint();
      $('.manual-paste').hidden = true;
      notice('已插入，当前正文的段落和关键排版已检查。请预览公众号显示效果，再保存草稿。');
    } catch(error) {
      state.partial = Boolean(error.articleChanged);
      $('.manual-paste').hidden = false;
      notice(state.partial ? `${error.message} 内容已发生变化；可先撤销本次插入，再使用“复制并定位正文”，不要重复追加。` : `${error.message} 可使用“复制并定位正文”，然后按 ⌘V / Ctrl+V 完成粘贴。`,true);
    }
    finally {state.busy=false;controls();checkEditor();}
  });
  $('.undo').addEventListener('click',async()=>{
    if(state.busy) return;
    state.busy=true;controls();
    try {
      const result = await editor.undo();
      if(result?.ok===false) throw new Error(result.reason || '撤销未完成。');
      state.inserted=null;state.partial=false;notice('本次插入已撤销。');
    } catch(error) {
      if(error.articleChanged) {
        state.partial=true;
        $('.manual-paste').hidden=false;
      }
      notice(error.message,true);
    }
    finally {state.busy=false;controls();checkEditor();}
  });
  async function writeClipboard() {
    if(navigator.clipboard?.write && globalThis.ClipboardItem) {
      await navigator.clipboard.write([new ClipboardItem({'text/html':new Blob([state.result.html],{type:'text/html'}),'text/plain':new Blob([state.result.text],{type:'text/plain'})})]);
    } else {
      let copied=false;
      const listener=event=>{event.preventDefault();event.clipboardData.setData('text/html',state.result.html);event.clipboardData.setData('text/plain',state.result.text);copied=true;};
      document.addEventListener('copy',listener,true);
      try { if(!document.execCommand('copy') || !copied) throw new Error('浏览器未允许复制，请在预览中选择内容后手动复制。'); }
      finally {document.removeEventListener('copy',listener,true);}
    }
  }
  async function copyResult() {
    if(state.busy || state.dirty || !state.result) return;
    state.busy=true; controls();
    try {
      await writeClipboard();
      notice('已复制带格式的文章，可粘贴到公众号正文编辑区。');
    } catch(error) { notice(`复制未完成：${error.message}`,true); }
    finally {state.busy=false;controls();}
  }
  $('.copy').addEventListener('click',copyResult);
  $('.paste-helper').addEventListener('click',async()=>{
    if(state.busy || state.dirty || !state.result || (state.partial && $('#article-mode').value==='append')) return;
    if(!checkEditor().ready) {notice(state.editorReason,true);return;}
    state.busy=true;controls();
    try {
      await writeClipboard();
      const result=await editor.focusPasteTarget({mode:$('#article-mode').value});
      if(result?.ok===false) throw new Error(result.reason || '未能定位正文，请手动点击正文后粘贴。');
      notice('排版结果已复制，正文已定位。按 ⌘V / Ctrl+V 粘贴；尚未自动写入或保存。');
      hide();
      $('.launcher').textContent='正文已定位 · 按 ⌘V / Ctrl+V 粘贴';
    } catch(error) {notice(`复制定位未完成：${error.message}`,true);}
    finally {state.busy=false;controls();checkEditor();}
  });
  // Previews show links as content; navigation would interrupt the user's draft.
  $('.preview').addEventListener('click',event=>{if(event.target.closest('a')) event.preventDefault();});
  const mountObserver = new MutationObserver(()=>{ if(!host.isConnected) mount(); });
  mountObserver.observe(document.documentElement,{childList:true});
  // The page may load its editor after this panel is opened. Re-enable the
  // action once that editor is ready instead of leaving a stale disabled state.
  setInterval(()=>{ if(!$('.panel').hidden && !state.busy) checkEditor(); },2500);
  globalThis.WXArticlePanel = Object.freeze({show,hide,mount});
  controls();
})();
