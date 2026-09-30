import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {JSDOM} from 'jsdom';

const source = await readFile(new URL('../src/launcher.js',import.meta.url),'utf8');
const key = 'wxvu.launcher.position';
const tick = () => new Promise(resolve => setTimeout(resolve,0));
function setup({url='https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit&action=edit',stored={},get,send}={}) {
  const dom = new JSDOM('<!doctype html><html><body><button id="outside">页面按钮</button></body></html>',{url,runScripts:'outside-only'});
  const w = dom.window;
  const calls = {set:[],messages:[]};
  w.chrome = {storage:{local:{get:get || (async()=>stored),set:async value=>calls.set.push(value)}},runtime:{sendMessage:async message=>{calls.messages.push(message);return send ? send(message) : {ok:true};}}};
  w.eval(source);
  const host = w.document.getElementById('wx-tool-launcher');
  const shadow = host?.shadowRoot;
  const $ = selector => shadow?.querySelector(selector);
  function pointer(target,type,x,y,options={}) {
    const event = new w.MouseEvent(type,{bubbles:true,composed:true,cancelable:true,clientX:x,clientY:y,button:0,...options});
    Object.defineProperty(event,'pointerId',{value:options.pointerId ?? 1});
    target.dispatchEvent(event);
  }
  const keyboard = (target,key) => target.dispatchEvent(new w.KeyboardEvent('keydown',{key,bubbles:true,composed:true,cancelable:true}));
  return {dom,w,calls,host,shadow,$,pointer,keyboard};
}

test('single collapsed ball survives reinjection and remount without opening a panel',t=>{
  const h=setup();t.after(()=>h.w.close());
  let shown=0;
  h.w.WXToolLauncher.register('article',{show:()=>shown++});
  const api=h.w.WXToolLauncher;
  assert.equal(h.$('.menu').hidden,true);
  assert.equal(h.host.style.width,'48px');
  assert.equal(h.host.style.zIndex,'2147483647');
  h.w.eval(source);
  assert.equal(h.w.WXToolLauncher,api);
  assert.equal(h.w.document.querySelectorAll('#wx-tool-launcher').length,1);
  h.host.remove();api.mount();
  assert.equal(h.host.isConnected,true);
  assert.equal(shown,0);
  assert.equal(h.$('.menu').hidden,true);
});

test('foreign origins, worker upload pages, and child frames never gain a launcher',t=>{
  for(const url of ['https://example.test/','https://mp.weixin.qq.com/cgi-bin/appmsg#wxvu-worker=12345678-1234-1234-1234-123456789abc']) {
    const h=setup({url});t.after(()=>h.w.close());assert.equal(h.host,null);assert.equal(h.w.WXToolLauncher,undefined);
  }
  const h=setup();t.after(()=>h.w.close());
  const frame=h.w.document.createElement('iframe');h.w.document.body.append(frame);
  frame.contentWindow.eval(source);
  assert.equal(frame.contentDocument.querySelector('#wx-tool-launcher'),null);
});

test('the two entries open registered tools and collapse the other while leaving the ball visible',async t=>{
  const h=setup();t.after(()=>h.w.close());
  let articleOpen=false,videoOpen=false;
  h.w.WXToolLauncher.register('article',{show:()=>{articleOpen=true;h.w.WXToolLauncher.activate('article');},hide:()=>{articleOpen=false;h.w.WXToolLauncher.collapsed('article');}});
  h.w.WXToolLauncher.register('video',{show:()=>{videoOpen=true;h.w.WXToolLauncher.activate('video');},hide:()=>{videoOpen=false;h.w.WXToolLauncher.collapsed('video');}});
  h.$('.ball').click();h.$('[data-tool=article]').click();await tick();
  assert.equal(articleOpen,true);assert.equal(videoOpen,false);assert.equal(h.$('.menu').hidden,true);
  h.$('.ball').click();h.$('[data-tool=video]').click();await tick();
  assert.equal(articleOpen,false);assert.equal(videoOpen,true);assert.equal(h.host.style.display,'block');
  assert.equal(h.$('[data-tool=video]').getAttribute('aria-current'),'true');
  h.w.WXToolLauncher.collapsed('video');
  assert.equal(h.$('[data-tool=video]').hasAttribute('aria-current'),false);
});

test('unregistered video launches through the extension and failures remain visible and retryable',async t=>{
  let fail=true;
  const h=setup({send:async()=>fail ? {ok:false,error:'连接断开，请刷新页面'} : {ok:true}});t.after(()=>h.w.close());
  await h.w.WXToolLauncher.open('video');
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls.messages)),[{namespace:'wxvu.launcher',command:'openVideo'}]);
  assert.equal(h.$('.error').hidden,false);assert.match(h.$('.error').textContent,/连接断开/);assert.equal(h.$('.menu').hidden,false);
  fail=false;await h.w.WXToolLauncher.open('video');
  assert.equal(h.$('.error').hidden,true);assert.equal(h.$('.menu').hidden,true);
});

test('late launch failure does not reopen a menu after a different tool has opened',async t=>{
  let reject;
  const h=setup({send:()=>new Promise((resolve,no)=>{reject=no;})});t.after(()=>h.w.close());
  let shown=0;h.w.WXToolLauncher.register('article',{show:()=>shown++});
  const first=h.w.WXToolLauncher.open('video');
  await h.w.WXToolLauncher.open('article');
  reject(new Error('旧连接失败'));await first;
  assert.equal(shown,1);assert.equal(h.$('.menu').hidden,true);assert.equal(h.$('.error').hidden,true);
});

test('drag clamps to the viewport, stores position, and does not accidentally open the menu',async t=>{
  const h=setup();t.after(()=>h.w.close());await tick();
  h.pointer(h.$('.ball'),'pointerdown',980,710);
  h.pointer(h.w.document,'pointermove',-1500,-1500);
  h.pointer(h.w.document,'pointerup',-1500,-1500);
  assert.equal(h.host.style.left,'8px');assert.equal(h.host.style.top,'8px');assert.equal(h.calls.set.length,1);
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls.set[0])),{[key]:{x:8,y:8}});
  h.$('.ball').dispatchEvent(new h.w.MouseEvent('click',{bubbles:true,detail:1}));
  assert.equal(h.$('.menu').hidden,true);
  h.$('.ball').click();assert.equal(h.$('.menu').hidden,false,'keyboard activation remains usable after dragging');
});

test('small pointer movement remains a click without writing a position',t=>{
  const h=setup();t.after(()=>h.w.close());
  h.pointer(h.$('.ball'),'pointerdown',980,710);
  h.pointer(h.w.document,'pointermove',982,712);
  h.pointer(h.w.document,'pointerup',982,712);
  h.$('.ball').dispatchEvent(new h.w.MouseEvent('click',{bubbles:true,detail:1}));
  assert.equal(h.calls.set.length,0);assert.equal(h.$('.menu').hidden,false);
});

test('saved position is restored, clamped on resize and keeps menu inside the viewport',async t=>{
  const h=setup({stored:{[key]:{x:750,y:600}}});t.after(()=>h.w.close());await tick();
  assert.equal(h.host.style.left,'750px');assert.equal(h.host.style.top,'600px');
  h.w.innerWidth=320;h.w.innerHeight=400;h.w.dispatchEvent(new h.w.Event('resize'));
  assert.equal(h.host.style.left,'264px');assert.equal(h.host.style.top,'344px');
  h.$('.ball').click();
  assert.ok(parseFloat(h.$('.menu').style.left)>=8);
  assert.ok(parseFloat(h.$('.menu').style.left)+232<=320);
  assert.ok(parseFloat(h.$('.menu').style.top)>=8);
});

test('a delayed saved position cannot move the ball after the user has dragged it',async t=>{
  let resolve;
  const h=setup({get:()=>new Promise(yes=>{resolve=yes;})});t.after(()=>h.w.close());
  h.pointer(h.$('.ball'),'pointerdown',980,710);h.pointer(h.w.document,'pointermove',780,510);h.pointer(h.w.document,'pointerup',780,510);
  const before=h.host.style.left;
  resolve({[key]:{x:20,y:20}});await tick();
  assert.equal(h.host.style.left,before);
});

test('keyboard navigation, Escape and outside click dismiss only the menu',t=>{
  const h=setup();t.after(()=>h.w.close());
  h.keyboard(h.$('.ball'),'ArrowDown');
  assert.equal(h.shadow.activeElement,h.$('[data-tool=article]'));
  h.keyboard(h.shadow.activeElement,'ArrowDown');assert.equal(h.shadow.activeElement,h.$('[data-tool=video]'));
  h.keyboard(h.shadow.activeElement,'Escape');assert.equal(h.$('.menu').hidden,true);assert.equal(h.shadow.activeElement,h.$('.ball'));
  h.$('.ball').click();h.pointer(h.w.document.querySelector('#outside'),'pointerdown',0,0);
  assert.equal(h.$('.menu').hidden,true);assert.equal(h.host.isConnected,true);
});

test('video state updates compact progress without opening or obscuring the page',t=>{
  const h=setup();t.after(()=>h.w.close());
  h.w.WXToolLauncher.updateVideo({running:true,done:2,total:5,problem:0});
  assert.match(h.$('.video-progress').textContent,/上传中.*2\/5/);assert.equal(h.$('.badge').hidden,false);assert.equal(h.$('.badge').dataset.tone,'running');
  assert.match(h.$('.ball').getAttribute('aria-label'),/2\/5/);assert.equal(h.$('.menu').hidden,true);
  h.w.WXToolLauncher.updateVideo({running:false,done:3,total:5,problem:2});
  assert.equal(h.$('.badge').dataset.tone,'problem');assert.match(h.$('.video-progress').textContent,/2 项异常/);
  h.w.WXToolLauncher.updateVideo({running:false,done:5,total:5});assert.equal(h.$('.badge').hidden,true);
});


test('launcher clicks and keys stay isolated from page editor handlers',async t=>{
  const h=setup();t.after(()=>h.w.close());
  const received=[];
  for(const type of ['click','keydown','keyup','input','change'])
    h.w.document.addEventListener(type,event=>received.push(event.type));
  let opened=0;
  h.w.WXToolLauncher.register('article',{show:()=>opened++});
  h.$('.ball').click();
  h.keyboard(h.$('[data-tool=article]'),'ArrowDown');
  assert.equal(h.shadow.activeElement,h.$('[data-tool=video]'));
  h.keyboard(h.shadow.activeElement,'Escape');
  assert.equal(h.$('.menu').hidden,true);
  for(const type of ['keyup','input','change'])
    h.$('.ball').dispatchEvent(new h.w.Event(type,{bubbles:true,composed:true}));
  h.$('.ball').click();h.$('[data-tool=article]').click();await tick();
  assert.equal(opened,1);
  assert.deepEqual(received,[]);
  h.w.document.querySelector('#outside').click();
  assert.deepEqual(received,['click'],'normal page interaction must remain unaffected');
});

test('losing pointer capture ends dragging without letting later moves reposition the ball',t=>{
  const h=setup();t.after(()=>h.w.close());
  h.pointer(h.$('.ball'),'pointerdown',980,710);
  h.pointer(h.w.document,'pointermove',780,510);
  h.pointer(h.$('.ball'),'lostpointercapture',780,510);
  const position={left:h.host.style.left,top:h.host.style.top};
  h.pointer(h.w.document,'pointermove',20,20);
  h.pointer(h.w.document,'pointerup',20,20);
  assert.deepEqual({left:h.host.style.left,top:h.host.style.top},position);
  assert.equal(h.$('.ball').classList.contains('dragging'),false);
  assert.equal(h.calls.set.length,1);
});
