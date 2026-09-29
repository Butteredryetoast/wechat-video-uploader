'use strict';
const CONTEXT_KEY = 'wxvu.inline.context.v3';
const QUEUE_KEY = 'wxvu.queue.v2';
const WORKERS_KEY = 'wxvu.workers.v1';
const ORIGIN = 'https://mp.weixin.qq.com';
const UI_COMMANDS = new Set(['state','file.begin','file.chunk','file.end','file.cancel','update','remove','retry','start','pause','inspect','export','configure']);
const PAGE_COMMANDS = new Set(['inspect','launchInfo','begin','chunk','attach','status','fillTitle','prepare','agree','save','verify','diagnostics']);
const READ_COMMANDS = new Set(['inspect','launchInfo','diagnostics']);
const MAX_CLOSED_WORKERS = 100;
let operation = Promise.resolve();
let workerOperation = Promise.resolve();
let creating;
function serialize(fn) { const next = operation.then(fn,fn); operation = next.catch(()=>{}); return next; }
function serializeWorkers(fn) { const next = workerOperation.then(fn,fn); workerOperation = next.catch(()=>{}); return next; }
function hostError(code,message) { const error = new Error(message); error.code = code; return error; }
function boundedClosedWorkers(items) {
  const closed = new Set(items.filter(item=>item.state==='closed').sort((a,b)=>(b.closedAt || 0)-(a.closedAt || 0)).slice(0,MAX_CLOSED_WORKERS));
  return items.filter(item=>item.state!=='closed' || closed.has(item));
}
function isWeChat(url) { try { return new URL(url).origin === ORIGIN; } catch { return false; } }
function isUploadUrl(value) {
  try {
    const url = new URL(value);
    return url.origin === ORIGIN && !url.username && !url.password && url.pathname === '/cgi-bin/appmsg' &&
      url.searchParams.get('t') === 'media/videomsg_edit' && url.searchParams.get('action') === 'video_edit' &&
      url.searchParams.get('type') === '15' && Boolean(url.searchParams.get('token'));
  } catch { return false; }
}
async function context() { return (await chrome.storage.session.get(CONTEXT_KEY))[CONTEXT_KEY] || null; }
async function workers(owner) {
  const data = (await chrome.storage.session.get(WORKERS_KEY))[WORKERS_KEY];
  return data?.sessionId === owner.sessionId && Array.isArray(data.items) ? data.items : [];
}
async function saveWorkers(owner, items) {
  await chrome.storage.session.set({[WORKERS_KEY]:{sessionId:owner.sessionId,items}});
}
async function offscreenExists() {
  return (await chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT'],documentUrls:[chrome.runtime.getURL('offscreen.html')]})).length > 0;
}
async function ensureOffscreen() {
  if(await offscreenExists()) return;
  if(!creating) {
    creating = (async()=>{
      // A lost Blob host cannot resume a previous page transaction. Keep those
      // pages available, but release their slots before restoring the queue.
      await serializeWorkers(async()=>{
        const owner = await context();
        if(!owner) return;
        const items = await workers(owner);
        if(items.some(item=>item.state==='active'))
          await saveWorkers(owner,items.map(item=>item.state==='active' ? {...item,state:'retained'} : item));
      });
      return chrome.offscreen.createDocument({url:'offscreen.html',reasons:['BLOBS'],
        justification:'Hold the user-selected video Blobs while independent WeChat pages upload in parallel and the controls stay in the source page.'});
    })();
  }
  try { await creating; } finally { creating = undefined; }
}
async function engine(command,payload={}) {
  const response = await chrome.runtime.sendMessage({namespace:'wxvu.engine',command,payload});
  if(!response?.ok) throw new Error(response?.error || '后台队列未响应，请重新点击扩展图标。');
  return response.result;
}
async function ownedTab(tabId, allowWorker = false) {
  const owner = await context();
  if(!owner) throw hostError('CONTEXT_CLOSED','上传任务入口已关闭。');
  if(owner.targetTabId !== tabId) {
    const worker = allowWorker && (await workers(owner)).find(item=>item.tabId===tabId);
    if(worker?.state === 'closed') throw hostError('TAB_CLOSED','上传标签页已关闭，无法继续读取当前视频状态。');
    if(!worker || worker.state !== 'active') throw hostError('WORKER_UNBOUND','此页面不是当前上传队列绑定的页面。');
  }
  let tab;
  try { tab = await chrome.tabs.get(tabId); }
  catch(error) {
    if(/^No tab with id\b/i.test(error?.message || '')) throw hostError('TAB_CLOSED','上传标签页已关闭，无法继续读取当前视频状态。');
    throw error;
  }
  if(allowWorker && tabId !== owner.targetTabId && tab.status === 'loading' &&
      (!tab.url || tab.url === 'about:blank') && isUploadUrl(tab.pendingUrl)) tab.url = tab.pendingUrl;
  if(!isWeChat(tab.url)) throw hostError('TAB_NAVIGATED','公众号操作页已离开微信域名或访问权限失效。');
  return tab;
}
async function injectSidebar(tabId) {
  await ownedTab(tabId);
  await chrome.scripting.executeScript({target:{tabId},files:['src/panel.js','src/sidebar.js']});
}
async function injectArticleEntry(tabId) {
  // This entry is independent of the video queue owner. Re-injection restores
  // the launcher on pages that were already open when the extension reloaded.
  await chrome.scripting.executeScript({target:{tabId},files:['src/article-format.js','src/article-editor.js','src/article-panel.js']});
}
async function disposeOwner() {
  await serializeWorkers(async()=>{
    const owner = await context();
    if(owner) await Promise.allSettled((await workers(owner)).filter(item=>item.state==='active').map(item=>renderInPage(item.tabId,true)));
    if(await offscreenExists()) await chrome.offscreen.closeDocument();
    // Unverified upload pages are left available for inspection, never discarded.
    await chrome.storage.session.remove([CONTEXT_KEY,WORKERS_KEY]);
  });
}

async function openWorker({itemId,foregroundSerial}) {
  return serializeWorkers(async()=>{
    if(foregroundSerial !== undefined && typeof foregroundSerial !== 'boolean') throw new Error('前台串行模式参数无效。');
    const owner = await context();
    if(!owner) throw hostError('CONTEXT_CLOSED','上传任务入口已关闭。');
    const items = await workers(owner);
    if(items.some(item=>item.itemId===itemId && item.state==='active')) throw new Error('该视频已有独立上传页。');
    if(items.filter(item=>item.state==='active').length >= 10) throw new Error('最多同时上传 10 个视频。');
    const snapshot = (await chrome.storage.local.get(QUEUE_KEY))[QUEUE_KEY];
    if(typeof itemId !== 'string' || snapshot?.items?.filter(item=>item.id===itemId && item.status==='opening').length !== 1)
      throw new Error('视频尚未写入待打开的任务记录。');
    const active = items.filter(item=>item.state==='active');
    if(active.some(item=>item.foregroundSerial)) throw new Error('前台串行视频尚未完成，不能同时打开下一项。');
    if(foregroundSerial === true) {
      const inProgress = snapshot.items.filter(item=>['opening','uploading','processing','saving','verifying'].includes(item.status));
      if(active.length || inProgress.length !== 1 || inProgress[0].id !== itemId)
        throw new Error('前台串行模式只能同时上传 1 个视频。');
    }
    await ownedTab(owner.targetTabId);
    await chrome.scripting.executeScript({target:{tabId:owner.targetTabId},files:['src/adapter.js']});
    const response = await chrome.tabs.sendMessage(owner.targetTabId,{namespace:'wxvu.page',command:'launchInfo',payload:{}});
    if(!response?.ok || !response.result?.ready || !isUploadUrl(response.result.launchUrl))
      throw new Error(response?.result?.reason || '请在任务入口打开“选择视频 → 素材库”或视频素材库页面。');
    const launchUrl = new URL(response.result.launchUrl);
    // A non-secret marker lets the document_start MAIN-world script run only
    // on upload pages created for this queue, before WeChat captures RAF.
    launchUrl.hash = `wxvu-worker=${crypto.randomUUID()}`;
    const tab = await chrome.tabs.create({url:launchUrl.href,active:foregroundSerial===true,openerTabId:owner.targetTabId});
    if(!Number.isInteger(tab.id)) throw new Error('未能创建独立上传页。');
    try { await saveWorkers(owner,[...items,{tabId:tab.id,itemId,state:'active',foregroundSerial:foregroundSerial===true}]); }
    catch(error) { try { await chrome.tabs.remove(tab.id); } catch {} throw error; }
    return {tabId:tab.id};
  });
}

async function releaseWorker({itemId,tabId,verified}) {
  return serializeWorkers(async()=>{
    const owner = await context();
    if(!owner) throw hostError('CONTEXT_CLOSED','上传任务入口已关闭。');
    const items = await workers(owner);
    const worker = items.find(item=>item.itemId===itemId && item.tabId===tabId);
    if(!worker || tabId === owner.targetTabId) throw hostError('WORKER_UNBOUND','无法释放未绑定的上传页。');
    // tabs.onRemoved may run before the final cleanup RPC. A known closed
    // worker needs no further action; closing alone never proves a saved video.
    if(worker.state === 'closed') return {released:true,alreadyClosed:true};
    if(worker.state !== 'active') throw hostError('WORKER_UNBOUND','无法释放未绑定的上传页。');
    const snapshot = (await chrome.storage.local.get(QUEUE_KEY))[QUEUE_KEY];
    const checkpoint = snapshot?.items?.find(item=>item.id===itemId)?.status;
    const canClose = verified === true && ['verifying','succeeded'].includes(checkpoint);
    if(verified === true && !canClose) throw new Error('缺少保存核对记录，保留上传页。');
    try { await renderInPage(tabId,true); } catch { /* A navigated or closed page has already disposed its helper. */ }
    if(canClose) {
      // Only a verified page created by this queue can be automatically closed.
      const tab = await chrome.tabs.get(tabId).catch(()=>null);
      let closed = true;
      if(tab && isWeChat(tab.url)) {
        try { await chrome.tabs.remove(tabId); } catch { closed = false; }
      }
      worker.state = 'retained';
      await saveWorkers(owner,closed ? items.filter(item=>item!==worker) : items);
    } else {
      worker.state = 'retained';
      await saveWorkers(owner,items);
    }
    return {released:true};
  });
}

async function renderInPage(tabId, stop = false) {
  const tab = await ownedTab(tabId,true);
  if(tab.frozen || tab.discarded) return {supported:false,frozen:Boolean(tab.frozen),discarded:Boolean(tab.discarded)};
  const results = await chrome.scripting.executeScript({target:{tabId},world:'MAIN',
    // Fixed packaged operations only: no page-provided code or caller function.
    func: shouldStop => {
      const bridge = globalThis.__WXVU_RENDER_BRIDGE_V1__;
      if(!bridge || typeof bridge.pulse !== 'function' || typeof bridge.stop !== 'function')
        return {supported:false,hidden:document.hidden};
      const value = shouldStop ? bridge.stop() : bridge.pulse();
      const numeric = key => Number.isFinite(value?.[key]) && value[key] >= 0 ? value[key] : 0;
      return {supported:true,hidden:document.hidden,stopped:value?.stopped===true,
        pending:numeric('pending'),assisted:numeric('assisted'),frames:numeric('frames'),
        pulses:numeric('pulses'),lastPulseAt:numeric('lastPulseAt'),lastFrameAt:numeric('lastFrameAt')};
    },args:[stop]});
  return results?.[0]?.result || {supported:false};
}

async function renderWorker({itemId,tabId}) {
  const owner = await context();
  if(!owner) throw hostError('CONTEXT_CLOSED','上传任务入口已关闭。');
  const worker = (await workers(owner)).find(item=>item.tabId===tabId && item.itemId===itemId);
  if(worker?.state==='closed') throw hostError('TAB_CLOSED','上传标签页已关闭，无法继续读取当前视频状态。');
  if(owner.targetTabId===tabId || !worker || worker.state!=='active')
    throw hostError('WORKER_UNBOUND','后台渲染辅助只能用于当前视频绑定的上传页。');
  return renderInPage(tabId);
}

chrome.action.onClicked.addListener(tab => {
  serialize(async()=>{
    if(!tab.id || !isWeChat(tab.url)) throw new Error('请先打开公众号的“选择视频”或视频素材库页面，再点击本扩展。');
    try { await injectArticleEntry(tab.id); } catch { /* Article UI must not interrupt an existing video workflow. */ }
    let owner = await context();
    if(owner && owner.targetTabId !== tab.id) {
      let old;
      try { old = await chrome.tabs.get(owner.targetTabId); } catch {}
      if(old && isWeChat(old.url)) throw new Error('另一个公众号页面已绑定上传队列，请先关闭那个页面，再在这里打开。');
      await disposeOwner();
      owner = null;
    }
    if(!owner) {
      owner = {targetTabId:tab.id,sessionId:crypto.randomUUID()};
      await chrome.storage.session.set({[CONTEXT_KEY]:owner});
    }
    await ensureOffscreen();
    await engine('init',owner);
    await injectSidebar(tab.id);
    await chrome.action.setBadgeText({tabId:tab.id,text:''});
    await chrome.action.setTitle({tabId:tab.id,title:'打开页面内的视频批量上传面板'});
  }).catch(async error=>{
    if(tab.id) {
      try {
        await chrome.action.setBadgeBackgroundColor({tabId:tab.id,color:'#b54708'});
        await chrome.action.setBadgeText({tabId:tab.id,text:'!'});
        await chrome.action.setTitle({tabId:tab.id,title:error.message});
      } catch {}
    }
  });
});

async function handleUI(message,sender) {
  if(!sender.tab?.id || sender.frameId !== 0 || !isWeChat(sender.url)) throw new Error('页面来源无效。');
  if(!UI_COMMANDS.has(message.command)) throw new Error('未知的面板操作。');
  await ownedTab(sender.tab.id);
  const owner = await context();
  await ensureOffscreen();
  // Idempotent init reconnects after a service-worker restart, without losing Files.
  await engine('init',owner);
  return engine(message.command,message.payload || {});
}

async function handleHost(command,payload={}) {
  const owner = await context();
  if(!owner) throw hostError('CONTEXT_CLOSED','上传页面已关闭。');
  if(command === 'read') return (await chrome.storage.local.get(QUEUE_KEY))[QUEUE_KEY] || null;
  if(command === 'write') {
    const snapshot = payload.snapshot;
    if(snapshot?.version !== 1 || !Array.isArray(snapshot.items) || snapshot.items.length > 500)
      throw new Error('队列记录格式不正确。');
    await chrome.storage.local.set({[QUEUE_KEY]:snapshot});
    return {saved:true};
  }
  if(command === 'push') {
    try {
      await chrome.tabs.sendMessage(owner.targetTabId,{namespace:'wxvu.sidebar',command:'state',payload:payload.state});
      return {delivered:true};
    } catch { return {delivered:false}; }
  }
  if(command === 'worker.open') return openWorker(payload);
  if(command === 'worker.release') return releaseWorker(payload);
  if(command === 'worker.render') return renderWorker(payload);
  const tabId = command === 'inject' ? payload.target?.tabId : payload.tabId;
  const tab = await ownedTab(tabId,true);
  if(command === 'tab.get') return {id:tab.id,url:tab.url,status:tab.status,
    ...(typeof tab.frozen === 'boolean' ? {frozen:tab.frozen} : {}),
    ...(typeof tab.discarded === 'boolean' ? {discarded:tab.discarded} : {})};
  if(command === 'tab.update') {
    const update = payload.update;
    if(tabId === owner.targetTabId || !update || Object.keys(update).length !== 1 || !isUploadUrl(update.url)) throw new Error('只能重开本任务的独立上传页面，任务入口保持不变。');
    return chrome.tabs.update(tabId,{url:update.url});
  }
  if(command === 'inject') {
    if(payload.target?.allFrames || payload.target?.frameIds || payload.func ||
       !Array.isArray(payload.files) || payload.files.length !== 1 || payload.files[0] !== 'src/adapter.js')
      throw new Error('不允许注入此脚本。');
    return chrome.scripting.executeScript({target:{tabId},files:['src/adapter.js']});
  }
  if(command === 'page') {
    const message = payload.message;
    if(message?.namespace !== 'wxvu.page' || !PAGE_COMMANDS.has(message.command)) throw new Error('不允许执行此页面操作。');
    if(!READ_COMMANDS.has(message.command)) {
      const worker = (await workers(owner)).find(item=>item.tabId===tabId && item.state==='active');
      if(!worker || worker.itemId !== message.payload?.id) throw new Error('视频任务与上传页不匹配。');
    }
    return chrome.tabs.sendMessage(tabId,{namespace:'wxvu.page',command:message.command,payload:message.payload || {}});
  }
  throw new Error('未知后台操作。');
}

chrome.runtime.onMessage.addListener((message,sender,respond)=>{
  if(sender.id !== chrome.runtime.id) return false;
  let task;
  if(message?.namespace === 'wxvu.ui') {
    if(!sender.tab?.id || sender.frameId !== 0 || !isWeChat(sender.url)) return false;
    // Keep owner replacement/closure behind already accepted UI operations.
    // Host RPC stays independent so engine initialization cannot deadlock.
    task = serialize(()=>handleUI(message,sender));
  } else if(message?.namespace === 'wxvu.host') {
    if(sender.tab || sender.url !== chrome.runtime.getURL('offscreen.html')) return false;
    task = handleHost(message.command,message.payload);
  } else return false;
  task.then(result=>respond({ok:true,result}),error=>respond({ok:false,error:error.message,
    ...(typeof error.code === 'string' ? {code:error.code} : {})}));
  return true;
});

chrome.tabs.onUpdated.addListener((tabId,changeInfo)=>{
  if(changeInfo.status !== 'complete') return;
  serialize(async()=>{
    const owner = await context();
    if(owner?.targetTabId !== tabId) return;
    let tab;
    try { tab = await chrome.tabs.get(tabId); } catch { await disposeOwner(); return; }
    if(!isWeChat(tab.url)) { await disposeOwner(); return; }
    await ensureOffscreen();
    await engine('init',owner);
    await injectSidebar(tabId);
  }).catch(()=>{});
});

chrome.tabs.onRemoved.addListener(tabId=>{
  serialize(async()=>{
    if((await context())?.targetTabId === tabId) await disposeOwner();
    else await serializeWorkers(async()=>{
      const owner = await context();
      if(!owner) return;
      const items = await workers(owner);
      if(items.some(item=>item.tabId===tabId)) {
        const closed = items.map(item=>item.tabId===tabId ? {...item,state:'closed',closedAt:Date.now()} : item);
        await saveWorkers(owner,boundedClosedWorkers(closed));
      }
    });
  }).catch(()=>{});
});
