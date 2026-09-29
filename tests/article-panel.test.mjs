import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {JSDOM} from 'jsdom';

const source=await readFile(new URL('../src/article-panel.js',import.meta.url),'utf8');
const DIAGNOSTIC={version:1,route:{pathname:'/cgi-bin/appmsg',template:'media/appmsg_edit_v2',action:'edit'},code:'EDITOR_NOT_FOUND',candidates:[]};
function setup({url='https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit&action=edit',failure=false,pageCss='',editorReady=true,insertAction=null,undoAction=null,copyFailure=false,diagnostic=DIAGNOSTIC,writeTextAction=null}={}) {
  const dom=new JSDOM('<!doctype html><html><body><textarea id="title">文章标题</textarea></body></html>',{url,runScripts:'outside-only'});
  const {window:w}=dom;
  if(pageCss) {const style=w.document.createElement('style');style.textContent=pageCss;w.document.head.append(style);}
  const calls={parse:[],insert:[],undo:0,inspect:0,clipboard:[],focus:[],diagnose:0,clipboardText:[]};
  let ready=editorReady;
  const intervals=new Map();let timerId=0;
  w.setInterval=(callback,milliseconds)=>{const id=++timerId;intervals.set(id,{callback,milliseconds});return id;};
  w.clearInterval=id=>intervals.delete(id);
  w.ClipboardItem=class {constructor(data){this.data=data;}};
  Object.defineProperty(w.navigator,'clipboard',{value:{write:async items=>{calls.clipboard.push(items);if(copyFailure)throw new Error('剪贴板不可用');},writeText:async text=>{calls.clipboardText.push(text);if(copyFailure)throw new Error('剪贴板不可用');return writeTextAction?.(text);}}});
  w.WXArticleFormat={
    parse(input){calls.parse.push(input);return{blocks:[{id:'a',kind:'paragraph',html:'测试 GPT 6 文章'}],warnings:[]};},
    render(blocks,{orange}){return{html:blocks.map(b=>b.kind==='video'?'<p><br></p>':`<p style="color:${b.kind==='heading'?orange:'#333'}">测试GPT 6文章</p>`).join(''),text:'测试GPT 6文章',stats:{}};}
  };
  w.WXArticleEditor={inspect:()=>{calls.inspect++;return{ready,hasContent:true,canUndo:calls.insert.length>calls.undo && !failure,reason:ready?'正文已就绪':'正文还在加载，请稍候'};},insert:async(html,options)=>{calls.insert.push({html,options});if(failure)throw new Error('没有找到唯一正文');return insertAction ? insertAction(html,options) : {ok:true,saved:false,formatVerified:true};},undo:async()=>{calls.undo++;return undoAction ? undoAction() : {ok:true};},focusPasteTarget:options=>{calls.focus.push(options);return{ok:true,mode:options.mode};}};
  if(diagnostic) w.WXArticleEditor.diagnose=()=>{calls.diagnose++;return diagnostic;};
  w.eval(source);
  const shadow=w.document.getElementById('wx-article-formatter')?.shadowRoot;
  const $=s=>shadow.querySelector(s);
  const paste=(html,text)=>{const e=new w.Event('paste',{bubbles:true,cancelable:true});Object.defineProperty(e,'clipboardData',{value:{getData:t=>t==='text/html'?html:text}});$('#article-paste').dispatchEvent(e);};
  const click=async s=>{$(s).click();await new Promise(resolve=>setTimeout(resolve,0));};
  return{dom,w,calls,shadow,$,paste,click,intervals,setEditorReady:value=>{ready=value;}};
}

test('paste keeps source HTML inert and passes it only on explicit format',async()=>{
  const h=setup();h.paste('<h2 onclick="evil()">原题</h2><img src="https://example.test/x.png">','原题');
  assert.equal(h.calls.parse.length,0);
  assert.equal(h.shadow.querySelector('img'),null);
  assert.equal(h.$('#article-paste').value,'原题');
  assert.equal(h.$('.insert').disabled,true);
  await h.click('.format');
  assert.match(h.calls.parse[0].html,/<h2/);
  assert.equal(h.$('.insert').disabled,false);
  assert.equal(h.w.document.querySelector('#title').value,'文章标题');
  h.dom.window.close();
});

test('plain text edits invalidate rich paste and disable stale insertion',async()=>{
  const h=setup();h.paste('<h2>原题</h2>','原题');await h.click('.format');
  h.$('#article-paste').value='改后的文章';h.$('#article-paste').dispatchEvent(new h.w.Event('input'));
  assert.equal(h.$('.insert').disabled,true);assert.equal(h.$('.copy').disabled,true);
  await h.click('.format');assert.equal(h.calls.parse[1].html,'');assert.equal(h.calls.parse[1].text,'改后的文章');
  h.dom.window.close();
});

test('heading and video space edits affect output without leaking panel controls',async()=>{
  const h=setup();h.paste('','测试 GPT 6 文章');await h.click('.format');
  await h.click('.toggle[aria-pressed]');assert.equal(h.$('.toggle[aria-pressed]').textContent,'小标题');
  await h.click('.block-tools .toggle:nth-child(2)');assert.match(h.$('.stats').textContent,/1 个视频空行/);
  await h.click('.insert');assert.equal(h.calls.insert.length,1);assert.match(h.calls.insert[0].html,/#ff8a00/);assert.match(h.calls.insert[0].html,/<br>/);assert.doesNotMatch(h.calls.insert[0].html,/视频位置|button/);
  assert.equal(h.calls.insert[0].options.mode,'append');assert.equal(h.$('.insert').disabled,true);
  assert.equal(h.$('.status').closest('footer'),h.$('footer'));
  assert.match(h.$('footer .status').textContent,/已插入.*排版已检查/);
  assert.equal(h.$('.body .status'),null);
  await h.click('.undo');assert.equal(h.calls.undo,1);assert.equal(h.$('.insert').disabled,false);
  h.dom.window.close();
});

test('replacement is explicit and duplicate prevention permits a mode change',async()=>{
  const h=setup();h.paste('','测试');await h.click('.format');await h.click('.insert');
  h.$('#article-mode').value='replace';h.$('#article-mode').dispatchEvent(new h.w.Event('change'));
  assert.equal(h.$('.insert').disabled,false);assert.equal(h.$('.danger-note').hidden,false);
  await h.click('.insert');assert.equal(h.calls.insert[1].options.mode,'replace');
  h.dom.window.close();
});

test('failed insert stays retryable and offers a formatted copy',async()=>{
  const h=setup({failure:true});h.paste('','测试');await h.click('.format');await h.click('.insert');
  assert.equal(h.$('.insert').disabled,false);assert.equal(h.$('.undo').disabled,true);
  assert.match(h.$('.status').textContent,/没有找到唯一正文.*复制并定位正文/);
  assert.equal(h.$('.status').closest('footer'),h.$('footer'));
  assert.equal(h.shadow.querySelectorAll('.status').length,1);
  assert.equal(h.$('.status').getAttribute('aria-live'),'polite');
  h.dom.window.close();
});

test('insertion feedback waits for format verification and prevents repeated action while pending',async t=>{
  let resolveInsert;
  const pending=new Promise(resolve=>{resolveInsert=resolve;});
  const h=setup({insertAction:()=>pending});t.after(()=>h.dom.window.close());
  h.paste('','等待验证格式');await h.click('.format');
  await h.click('.insert');
  assert.equal(h.calls.insert.length,1);
  assert.equal(h.$('.insert').disabled,true);
  assert.equal(h.$('.copy').disabled,true);
  assert.equal(h.$('#article-paste').disabled,true);
  assert.equal(h.$('.diagnose').disabled,true);
  await h.click('.diagnose');
  assert.equal(h.calls.diagnose,0,'diagnostics cannot run in parallel with an active insert');
  assert.doesNotMatch(h.$('footer .status').textContent,/已写入正文|已插入/);
  assert.match(h.$('footer .status').textContent,/正在|处理|核验|检查/);
  await h.click('.insert');
  assert.equal(h.calls.insert.length,1);
  resolveInsert({ok:true,changed:true,saved:false,formatVerified:true});
  await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(h.$('#article-paste').disabled,false);
  assert.match(h.$('footer .status').textContent,/已插入.*排版已检查/);
  assert.equal(h.$('footer .status').classList.contains('error'),false);
  assert.equal(h.$('.insert').disabled,true);
});

test('unverified changed insertion cannot report success or automatically insert again',async t=>{
  for(const result of [{ok:true,changed:true,saved:false,formatVerified:false},{ok:true,changed:true,saved:false}]) {
    const h=setup({insertAction:()=>result});t.after(()=>h.dom.window.close());
    h.paste('','未通过格式验证');await h.click('.format');await h.click('.insert');
    assert.equal(h.$('footer .status').classList.contains('error'),true);
    assert.doesNotMatch(h.$('footer .status').textContent,/已写入正文|已插入/);
    assert.equal(h.$('.insert').disabled,true);
    assert.equal(h.$('.copy').disabled,false);
    assert.equal(h.$('.undo').disabled,false);
    await h.click('.insert');
    assert.equal(h.calls.insert.length,1);
    await h.click('.undo');
    assert.equal(h.$('.insert').disabled,false);
  }
});

test('a changed-body verification error remains blocked after preview edits until explicit undo',async t=>{
  const h=setup({insertAction:()=>{const error=new Error('段距未保留');error.articleChanged=true;throw error;}});
  t.after(()=>h.dom.window.close());
  h.paste('','格式发生变化');await h.click('.format');await h.click('.insert');
  assert.match(h.$('footer .status').textContent,/段距未保留/);
  assert.equal(h.$('.insert').disabled,true);
  assert.equal(h.$('.copy').disabled,false);
  await h.click('.toggle[aria-pressed]');
  assert.equal(h.$('.insert').disabled,true,'changing preview cannot erase a partial-write boundary');
  await h.click('.insert');
  assert.equal(h.calls.insert.length,1);
  await h.click('.undo');
  assert.equal(h.$('.insert').disabled,false);
});

test('undo verification failure keeps a changed body locked without claiming it was restored',async t=>{
  let rejectUndo;
  const pending=new Promise((resolve,reject)=>{rejectUndo=reject;});
  const h=setup({undoAction:()=>pending});t.after(()=>h.dom.window.close());
  h.paste('','等待撤销稳定');await h.click('.format');await h.click('.insert');
  await h.click('.undo');
  assert.equal(h.calls.undo,1);
  assert.equal(h.$('#article-paste').disabled,true);
  assert.equal(h.$('.insert').disabled,true);
  assert.doesNotMatch(h.$('footer .status').textContent,/本次插入已撤销/);
  const error=new Error('正文恢复后又被编辑器改写');error.articleChanged=true;
  rejectUndo(error);
  await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(h.$('#article-paste').disabled,false);
  assert.equal(h.$('footer .status').classList.contains('error'),true);
  assert.match(h.$('footer .status').textContent,/正文恢复后又被编辑器改写/);
  assert.doesNotMatch(h.$('footer .status').textContent,/本次插入已撤销/);
  assert.equal(h.$('.insert').disabled,true);
  assert.equal(h.$('.copy').disabled,false);
  await h.click('.toggle[aria-pressed]');
  assert.equal(h.$('.insert').disabled,true,'changing the preview cannot bypass a failed undo boundary');
  await h.click('.insert');
  assert.equal(h.calls.insert.length,1,'failed undo must not allow a second append');
});

test('manual helper copies then locates the body without repeating automatic insertion',async t=>{
  const h=setup({failure:true});t.after(()=>h.dom.window.close());
  await h.click('.launcher');
  h.paste('','手动粘贴正文');await h.click('.format');
  assert.equal(h.$('.manual-paste').hidden,true);
  await h.click('.insert');
  assert.equal(h.$('.manual-paste').hidden,false);
  assert.equal(h.$('.paste-helper').disabled,false);
  await h.click('.paste-helper');
  assert.equal(h.calls.clipboard.length,1);
  assert.deepEqual(Object.keys(h.calls.clipboard[0][0].data).sort(),['text/html','text/plain']);
  assert.equal(h.calls.focus.length,1);
  assert.equal(h.calls.focus[0].mode,'append');
  assert.equal(h.calls.insert.length,1,'helper never invokes automatic insertion');
  assert.equal(h.$('.panel').hidden,true);
  assert.match(h.$('.launcher').textContent,/粘贴/);
  assert.equal(h.w.document.querySelector('#title').value,'文章标题');
});

test('manual helper cannot focus the body when formatted clipboard copying fails',async t=>{
  const h=setup({failure:true,copyFailure:true});t.after(()=>h.dom.window.close());
  await h.click('.launcher');
  h.paste('','不能复制');await h.click('.format');await h.click('.insert');
  await h.click('.paste-helper');
  assert.equal(h.calls.focus.length,0);
  assert.equal(h.calls.insert.length,1);
  assert.equal(h.$('.panel').hidden,false);
  assert.equal(h.$('footer .status').classList.contains('error'),true);
});

test('manual helper blocks append after a changed-body error but permits explicitly chosen replacement',async t=>{
  const h=setup({insertAction:()=>{const error=new Error('格式丢失');error.articleChanged=true;throw error;}});
  t.after(()=>h.dom.window.close());
  h.paste('','已写入但格式丢失');await h.click('.format');await h.click('.insert');
  assert.equal(h.$('.manual-paste').hidden,false);
  assert.equal(h.$('.paste-helper').disabled,true);
  await h.click('.paste-helper');
  assert.equal(h.calls.clipboard.length,0);
  h.$('#article-mode').value='replace';h.$('#article-mode').dispatchEvent(new h.w.Event('change'));
  assert.equal(h.$('.paste-helper').disabled,false);
  assert.equal(h.$('.insert').disabled,true,'replace does not reset failed automatic insertion');
  await h.click('.paste-helper');
  assert.equal(h.calls.focus[0].mode,'replace');
  assert.equal(h.calls.insert.length,1);
});

test('ordinary WeChat backend routes expose the collapsed article launcher before an editor is open',()=>{
  for(const url of [
    'https://mp.weixin.qq.com/',
    'https://mp.weixin.qq.com/cgi-bin/home?t=home/index',
    'https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/video_list&type=15',
    'https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/videomsg_edit&action=video_edit&type=15'
  ]) {
    const h=setup({url});
    assert(h.shadow,url);
    assert.equal(h.$('.launcher').hidden,false,url);
    assert.equal(h.$('.panel').hidden,true,url);
    assert.equal(h.calls.insert.length,0);
    assert.equal(h.w.document.querySelector('#title').value,'文章标题');
    h.dom.window.close();
  }
});

test('automatic upload workers and foreign sites do not mount article UI',()=>{
  for(const url of [
    'https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/videomsg_edit&action=video_edit&type=15#wxvu-worker=550e8400-e29b-41d4-a716-446655440000',
    'https://example.test/cgi-bin/appmsg?t=media/appmsg_edit&action=edit'
  ]) {
    const h=setup({url});
    assert.equal(h.shadow,undefined,url);
    assert.equal(h.w.WXArticlePanel,undefined,url);
    h.dom.window.close();
  }
});

test('reinjection reconnects the same detached panel and preserves pasted content without opening it',()=>{
  const h=setup();
  h.paste('<h2>保留原题</h2>','保留原题');
  const host=h.w.document.querySelector('#wx-article-formatter');
  const api=h.w.WXArticlePanel;
  host.remove();
  assert.equal(host.isConnected,false);
  h.w.eval(source);
  assert.equal(h.w.document.querySelector('#wx-article-formatter'),host);
  assert.equal(h.w.document.querySelectorAll('#wx-article-formatter').length,1);
  assert.equal(h.w.WXArticlePanel,api);
  assert.equal(h.$('#article-paste').value,'保留原题');
  assert.equal(h.$('.panel').hidden,true);
  assert.equal(h.calls.parse.length,0);
  h.dom.window.close();
});

test('document redraw automatically reconnects a detached article launcher',async()=>{
  const h=setup();
  const host=h.w.document.querySelector('#wx-article-formatter');
  host.remove();
  await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(host.isConnected,true);
  assert.equal(h.w.document.querySelectorAll('#wx-article-formatter').length,1);
  assert.equal(h.$('.panel').hidden,true);
  h.dom.window.close();
});

test('host uses inline important visibility and placement to resist page CSS and repairs it on reinjection',()=>{
  const h=setup({pageCss:'#wx-article-formatter { display:none!important; visibility:hidden!important; opacity:0!important; position:static!important; z-index:-1!important; pointer-events:none!important; }'});
  const host=h.w.document.querySelector('#wx-article-formatter');
  const expected={all:'initial',display:'block',position:'fixed',left:'20px',bottom:'22px',
    'z-index':'2147483600',visibility:'visible',opacity:'1','pointer-events':'auto'};
  for(const [property,value] of Object.entries(expected)) {
    assert.equal(host.style.getPropertyValue(property),value,property);
    assert.equal(host.style.getPropertyPriority(property),'important',property);
  }
  host.style.setProperty('display','none','important');
  host.style.setProperty('visibility','hidden','important');
  h.w.eval(source);
  assert.equal(host.style.getPropertyValue('display'),'block');
  assert.equal(host.style.getPropertyValue('visibility'),'visible');
  assert.equal(h.$('.launcher').hidden,false);
  assert.equal(h.$('.panel').hidden,true);
  h.dom.window.close();
});

test('re-executing script does not create duplicate UI',()=>{
  const h=setup();h.w.eval(source);assert.equal(h.w.document.querySelectorAll('#wx-article-formatter').length,1);h.dom.window.close();
});


test('unavailable editor disables insertion while preserving preview and formatted copy',async()=>{
  const h=setup({editorReady:false});
  h.paste('','可提前排版');await h.click('.format');
  assert.equal(h.$('.insert').disabled,true);
  assert.equal(h.$('.copy').disabled,false);
  assert.match(h.$('.editor-state').textContent,/正文还在加载/);
  await h.click('.insert');
  assert.equal(h.calls.insert.length,0);
  h.dom.window.close();
});

test('missing editor permits read-only diagnostic copying without pasted content',async t=>{
  const h=setup({editorReady:false});t.after(()=>h.dom.window.close());
  const body=h.w.document.createElement('div');body.id='existing-body';body.innerHTML='<p>保留正文</p>';
  h.w.document.body.append(body);
  await h.click('.launcher');
  assert.equal(h.$('.diagnose').hidden,false);
  assert.equal(h.$('.diagnose').disabled,false);
  assert.equal(h.$('.copy').disabled,true);
  assert.equal(h.calls.diagnose,0,'readiness checks do not copy or collect diagnostics automatically');
  await h.click('.diagnose');
  assert.equal(h.calls.diagnose,1);
  assert.deepEqual(h.calls.clipboardText,[JSON.stringify(DIAGNOSTIC,null,2)]);
  assert.equal(h.calls.parse.length,0);
  assert.equal(h.calls.insert.length,0);
  assert.equal(h.calls.undo,0);
  assert.equal(h.calls.focus.length,0);
  assert.equal(body.innerHTML,'<p>保留正文</p>');
  assert.equal(h.w.document.querySelector('#title').value,'文章标题');
  assert.match(h.$('footer .status').textContent,/已复制正文定位信息.*不含文章文字和登录参数/s);
  h.setEditorReady(true);await h.click('.check');
  assert.equal(h.$('.diagnose').hidden,true,'diagnostics hide once the editor becomes ready');
});

test('diagnostic clipboard contains only the editor report rather than source, formatted content or page login parameters',async t=>{
  const h=setup({editorReady:false,url:'https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit_v2&action=edit&token=FAKE_LOGIN_SECRET'});
  t.after(()=>h.dom.window.close());
  h.paste('<p>FAKE_ARTICLE_SECRET</p>','FAKE_ARTICLE_SECRET');await h.click('.format');
  const preview=h.$('.preview').innerHTML;
  await h.click('.diagnose');
  assert.equal(h.calls.clipboardText[0],JSON.stringify(DIAGNOSTIC,null,2));
  assert.doesNotMatch(h.calls.clipboardText[0],/FAKE_ARTICLE_SECRET|FAKE_LOGIN_SECRET|测试GPT|<p|https:\/\/mp\.weixin/);
  assert.equal(h.calls.clipboard.length,0,'diagnostics do not use the formatted article copy path');
  assert.equal(h.$('#article-paste').value,'FAKE_ARTICLE_SECRET');
  assert.equal(h.$('.preview').innerHTML,preview);
  assert.equal(h.calls.insert.length,0);
});

test('diagnostic copying holds the busy lock until the clipboard operation completes',async t=>{
  let finishCopy;
  const pending=new Promise(resolve=>{finishCopy=resolve;});
  const h=setup({editorReady:false,writeTextAction:()=>pending});t.after(()=>h.dom.window.close());
  await h.click('.launcher');
  await h.click('.diagnose');
  assert.equal(h.$('.diagnose').disabled,true);
  assert.equal(h.$('.format').disabled,true);
  await h.click('.diagnose');
  assert.equal(h.calls.diagnose,1);
  assert.equal(h.calls.clipboardText.length,1);
  assert.doesNotMatch(h.$('footer .status').textContent,/已复制正文定位信息/);
  finishCopy();await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(h.$('.diagnose').disabled,false);
  assert.match(h.$('footer .status').textContent,/已复制正文定位信息/);
});

test('older editor script requests a page refresh without copying article content as diagnostics',async t=>{
  const h=setup({editorReady:false,diagnostic:null});t.after(()=>h.dom.window.close());
  h.paste('<p>FAKE_PRIVATE_SOURCE</p>','FAKE_PRIVATE_SOURCE');await h.click('.format');
  await h.click('.diagnose');
  assert.match(h.$('footer .status').textContent,/刷新/);
  assert.equal(h.calls.clipboardText.length,0);
  assert.equal(h.calls.clipboard.length,0);
  assert.equal(h.calls.insert.length,0);
  assert.equal(h.$('#article-paste').value,'FAKE_PRIVATE_SOURCE');
  assert.equal(h.$('.diagnose').disabled,false);
});

test('diagnostic fallback copies plain text only and removes its temporary copy listener',async t=>{
  const h=setup({editorReady:false});t.after(()=>h.dom.window.close());
  delete h.w.navigator.clipboard.writeText;
  const writes=[];
  h.w.document.execCommand=command=>{
    assert.equal(command,'copy');
    const event=new h.w.Event('copy',{bubbles:true,cancelable:true});
    Object.defineProperty(event,'clipboardData',{value:{setData:(type,value)=>writes.push({type,value})}});
    h.w.document.dispatchEvent(event);
    assert.equal(event.defaultPrevented,true);
    return true;
  };
  await h.click('.launcher');await h.click('.diagnose');
  assert.deepEqual(writes,[{type:'text/plain',value:JSON.stringify(DIAGNOSTIC,null,2)}]);
  const subsequent=new h.w.Event('copy',{bubbles:true,cancelable:true});
  Object.defineProperty(subsequent,'clipboardData',{value:{setData:()=>assert.fail('diagnostic listener must be removed')}});
  h.w.document.dispatchEvent(subsequent);
  assert.equal(subsequent.defaultPrevented,false);
  assert.equal(h.calls.clipboard.length,0);
  assert.equal(h.calls.insert.length,0);
});

test('visible panel polls readiness every 2500 ms and restores insertion without new paste or duplicate timers',async()=>{
  const h=setup({editorReady:false});
  await h.click('.launcher');
  h.paste('','等待编辑器加载的文章');await h.click('.format');
  assert.equal(h.$('.insert').disabled,true);
  assert.equal(h.$('.copy').disabled,false);
  assert.equal(h.intervals.size,1);
  const timer=[...h.intervals.values()][0];
  assert.equal(timer.milliseconds,2500);
  h.setEditorReady(true);timer.callback();
  assert.equal(h.$('.insert').disabled,false);
  assert.equal(h.calls.parse.length,1,'readiness polling must not parse the article again');
  h.setEditorReady(false);timer.callback();
  assert.equal(h.$('.insert').disabled,true,'lost readiness relocks insertion');
  await h.click('.close');
  const before=h.calls.inspect;timer.callback();
  assert.equal(h.calls.inspect,before,'hidden panels must not inspect editors');
  h.setEditorReady(true);await h.click('.launcher');
  assert.equal(h.intervals.size,1);
  assert.equal(h.$('.insert').disabled,false);
  await h.click('.insert');
  assert.equal(h.calls.insert.length,1);
  assert.equal(h.$('.insert').disabled,true,'completed insertion remains deduplicated after later checks');
  timer.callback();
  assert.equal(h.$('.insert').disabled,true);
  h.dom.window.close();
});
