import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

const sources = await Promise.all(['article-format.js', 'article-editor.js', 'article-panel.js']
  .map(file => readFile(new URL(`../src/${file}`, import.meta.url), 'utf8')));
const ARTICLE_URL = 'https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit&action=edit&type=77';
const V2_ARTICLE_URL = 'https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit_v2&action=edit&type=77';
const tick = () => new Promise(resolve => setImmediate(resolve));
async function idle(h) {
  const deadline = Date.now() + 4000;
  while(h.$('#article-paste').disabled) {
    assert(Date.now() < deadline, 'article action did not settle');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  await tick();
}

function setup(url = ARTICLE_URL, { genericBody = false, sitePaste = false } = {}) {
  const dom = new JSDOM(`<!doctype html><main>
    <label for="title">文章标题</label><textarea id="title">独立文章标题</textarea>
    <label for="author">作者</label><input id="author" value="原作者">
    ${genericBody ? '<div data-field="title" contenteditable="true">新版标题栏</div><div aria-label="作者" contenteditable="true">新版作者栏</div>' : ''}
    <div ${genericBody ? 'class="arbitrary-editor" data-integration-body="true"' : 'id="js_editorArea"'} contenteditable="true"><p>原来的正文</p></div>
  </main>`, { runScripts: 'outside-only', url });
  const { window } = dom;
  window.HTMLElement.prototype.getClientRects = () => [{ width: 300, height: 30 }];
  window.DataTransfer = class {
    constructor() { this.data = new Map(); }
    setData(type, value) { this.data.set(type, value); }
    getData(type) { return this.data.get(type) || ''; }
    get types() { return [...this.data.keys()]; }
  };
  window.ClipboardEvent = class extends window.Event {
    constructor(type, options = {}) { super(type, options); this.clipboardData = options.clipboardData; }
  };
  for (const source of sources) window.eval(source);
  const body = window.document.querySelector(genericBody ? '[data-integration-body]' : '#js_editorArea');
  const calls = { paste: [], commands: [], clipboard: null };
  if(sitePaste) {
    body.addEventListener('paste', event => {
      event.preventDefault();
      const html = event.clipboardData.getData('text/html');
      calls.paste.push({ html, text: event.clipboardData.getData('text/plain') });
      const range = window.getSelection().getRangeAt(0);
      assert(body.contains(range.commonAncestorContainer), 'site handler receives a body-only selection');
      const fragment = range.createContextualFragment(html);
      if(sitePaste === 'strip-styles') fragment.querySelectorAll('[style]').forEach(node => node.removeAttribute('style'));
      range.deleteContents();
      range.insertNode(fragment);
      body.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    window.document.execCommand = command => {
      calls.commands.push(command);
      if(command !== 'copy') return false;
      const data = new window.DataTransfer();
      window.document.dispatchEvent(new window.ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData: data }));
      calls.clipboard = data;
      return true;
    };
  }
  const shadow = window.document.getElementById('wx-article-formatter')?.shadowRoot;
  const $ = selector => shadow?.querySelector(selector);
  const paste = (html, text = '') => {
    const event = new window.Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: { getData: type => type === 'text/html' ? html : text } });
    $('#article-paste').dispatchEvent(event);
    assert.equal(event.defaultPrevented, true);
  };
  return { dom, window, body, shadow, $, paste, calls };
}

// Layout, clipboard primitives and the site's paste handler are fakes.
// Parsing, preview controls, insertion selection and verification use real modules.
test('rich document paste previews and inserts styled body, media and blank video positions without changing title', async t => {
  const h = setup(); t.after(() => h.dom.window.close());
  const { $, paste, body, window } = h;
  let inputEvents = 0;
  let titleEvents = 0;
  body.addEventListener('input', () => inputEvents++);
  window.document.querySelector('#title').addEventListener('input', () => titleEvents++);
  $('.launcher').click();
  paste('<h2 style="font-size:36px;color:red">一、功能介绍</h2>' +
    '<p class="old-format" style="font-size:14px;color:purple" onclick="alert(1)">中文 <span>GPT 5 Pro</span> 有 <strong>2</strong> 个案例</p>' +
    '<p><img src="https://example.test/document-image.png" alt="文档图片" onerror="alert(1)"></p>' +
    '<video src="https://example.test/demo.mp4"></video><p>英文 Open AI 保留空格</p><script>window.BAD=true</script>',
    '一、功能介绍\n中文 GPT 5 Pro 有 2 个案例\n文档图片\n[视频]\n英文 Open AI 保留空格');
  assert.equal($('.insert').disabled, true, 'pasting never inserts directly');
  assert.equal(body.textContent, '原来的正文');
  $('.format').click();
  const heading = $('.preview p[data-wxaf-kind="heading"] > span');
  assert(heading);
  assert.equal(heading.style.fontSize, '20px');
  assert.equal(heading.style.backgroundColor, 'rgb(255, 138, 0)');
  assert.equal(heading.style.color, 'rgb(255, 255, 255)');
  assert.equal(heading.parentElement.tagName, 'P');
  assert.equal(heading.parentElement.style.fontSize, '16px');
  assert.equal(heading.parentElement.style.backgroundColor, '');
  assert.equal(heading.parentElement.style.textAlign, 'left');
  assert.equal(heading.parentElement.style.textAlignLast, 'auto');
  assert.equal(heading.parentElement.style.marginBottom, '24px');
  for(const node of [heading,heading.parentElement]) {
    assert.equal(node.style.padding,'');
    assert.equal(node.style.width,'');
    assert.equal(node.style.display,'');
  }
  const paragraphs = [...h.shadow.querySelectorAll('.preview .content p')];
  const paragraph = paragraphs.find(node => node.textContent.includes('GPT'));
  assert.equal(paragraph.textContent, '中文GPT 5 Pro有2个案例');
  assert.equal(paragraph.style.fontSize, '16px');
  assert.equal(paragraph.style.textAlign, 'justify');
  assert.equal(paragraph.style.marginBottom, '24px');
  assert($('.video-slot'));
  assert.equal($('.insert').disabled, false);
  $('.insert').click(); await idle(h);
  assert.equal(body.firstElementChild.textContent, '原来的正文');
  const article = body.querySelector('section');
  assert(article);
  assert.equal(article.querySelector('p > span').style.fontSize, '20px');
  assert.equal(article.querySelector('h2'), null, 'inserted subheadings use editable inline text rather than a colored heading block');
  assert.equal(article.querySelector('img').getAttribute('src'), 'https://example.test/document-image.png');
  assert(article.textContent.includes('中文GPT 5 Pro有2个案例'));
  assert(article.textContent.includes('英文Open AI保留空格'));
  const parts = [...article.children];
  const imageAt = parts.findIndex(node => node.querySelector('img'));
  assert.equal(parts[imageAt + 1].tagName, 'P');
  assert.equal(parts[imageAt + 1].textContent, '');
  assert.equal(parts[imageAt + 1].innerHTML, '<br>');
  assert(parts[imageAt + 2].textContent.includes('Open AI'));
  assert.equal(article.querySelector('video,iframe,script,[onclick],[onerror],.old-format'), null);
  assert.equal(window.BAD, undefined);
  assert.equal(window.document.querySelector('#title').value, '独立文章标题');
  assert.equal(window.document.querySelector('#author').value, '原作者');
  assert.equal(titleEvents, 0);
  assert.equal(inputEvents, 1);
  assert.equal($('.insert').disabled, true, 'unchanged append cannot be clicked twice');
  assert.equal($('.undo').disabled, false);
  $('.undo').click(); await idle(h);
  assert.equal(body.innerHTML, '<p>原来的正文</p>');
  assert.equal(window.document.querySelector('#title').value, '独立文章标题');
});

test('preview heading override and insertion mode apply to the real body with title kept separate', async t => {
  const h = setup(); t.after(() => h.dom.window.close());
  const { $, paste, body, window } = h;
  paste('', '可调整的小标题\n中文 English words 说明');
  $('.format').click();
  $('.block .toggle').click();
  $('.color').value = '#ed6b24';
  $('.color').dispatchEvent(new window.Event('input', { bubbles: true }));
  assert.equal($('.preview p[data-wxaf-kind="heading"] > span').textContent, '可调整的小标题');
  $('.insert').click(); await idle(h);
  assert(body.textContent.startsWith('原来的正文'));
  $('#article-mode').value = 'replace';
  $('#article-mode').dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.equal($('.insert').disabled, false, 'append and replace are distinct operations');
  $('.insert').click(); await idle(h);
  assert(!body.textContent.includes('原来的正文'));
  assert.equal(body.querySelectorAll('p > span').length, 1);
  assert.equal(body.querySelector('p > span').style.backgroundColor, 'rgb(237, 107, 36)');
  assert.equal(window.document.querySelector('#title').value, '独立文章标题');
});

test('partial editor insertion failure exposes the real safe undo without claiming success', async t => {
  const h = setup(); t.after(() => h.dom.window.close());
  const { $, paste, body, window } = h;
  window.document.execCommand = command => {
    assert.equal(command, 'insertHTML');
    body.insertAdjacentHTML('beforeend', '<p>不完整的写入</p>');
    return true;
  };
  paste('', '完整文章');
  $('.format').click();
  $('.insert').click(); await idle(h);
  assert(body.textContent.includes('不完整的写入'));
  assert($('.status').classList.contains('error'));
  assert.equal($('.status').closest('footer'),$('footer'));
  assert.equal($('.body .status'),null);
  assert.equal(window.WXArticleEditor.inspect().canUndo, true);
  assert.equal($('.undo').disabled, false, 'failed partial insertion still has a safe undo snapshot');
  $('.undo').click(); await idle(h);
  assert.equal(body.innerHTML, '<p>原来的正文</p>');
  assert.equal(window.document.querySelector('#title').value, '独立文章标题');
});

test('ordinary video and unknown editor routes allow preview and copy but disable body insertion', async t => {
  for(const url of [
    'https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/videomsg_edit&action=video_edit&type=15',
    'https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit_v999&action=edit&type=77'
  ]) {
    const h = setup(url); t.after(() => h.dom.window.close());
    assert(h.shadow);
    assert.equal(h.$('.launcher').hidden, false);
    assert.equal(h.$('.panel').hidden, true);
    assert.equal(h.window.WXArticleEditor.inspect().ready, false);
    h.$('.launcher').click();
    h.paste('<h2>可提前排版</h2><p>中文 GPT 6 测试</p>');
    h.$('.format').click();
    assert.equal(h.$('.preview p[data-wxaf-kind="heading"] > span').textContent, '可提前排版');
    assert.equal(h.$('.copy').disabled, false);
    assert.equal(h.$('.insert').disabled, true);
    h.$('.insert').click(); await idle(h);
    assert.match(h.$('.editor-state').textContent, /编辑页|入口|视频上传页/);
    await assert.rejects(() => h.window.WXArticleEditor.insert('<p>正文</p>'), /编辑页|入口|视频上传页/);
    assert.equal(h.body.innerHTML, '<p>原来的正文</p>');
    assert.equal(h.window.document.querySelector('#title').value, '独立文章标题');
  }
});

// This is the exact new template/action pair shown in the user's screenshot;
// the body intentionally has no legacy editor ID to exercise v2 discovery.
test('v2 article route pastes previews and inserts into the unique generic rich body while protecting title and author', async t => {
  const h = setup(V2_ARTICLE_URL, { genericBody: true, sitePaste: 'preserve' });
  t.after(() => h.dom.window.close());
  const { $, paste, body, window } = h;
  $('.launcher').click();
  assert.equal(window.WXArticleEditor.inspect().ready,true);
  paste('<h2>新版编辑器</h2><p>中文 GPT 6 正文</p><video src="https://example.test/video.mp4"></video><p>视频后正文</p>');
  $('.format').click();
  assert.equal($('.preview p[data-wxaf-kind="heading"] > span').textContent,'新版编辑器');
  assert.equal($('.insert').disabled,false);
  $('.insert').click();
  assert.equal($('#article-paste').disabled,true,'verification keeps the panel busy');
  assert.doesNotMatch($('footer .status').textContent,/已写入正文|已插入/);
  $('.insert').click();
  await idle(h);
  assert(body.textContent.startsWith('原来的正文'));
  const article=body.querySelector('section');
  assert(article);
  assert.equal(article.querySelector('p > span').style.fontSize,'20px');
  assert(article.textContent.includes('中文GPT 6正文'));
  assert([...article.children].some(node=>node.tagName==='P' && node.innerHTML==='<br>'));
  assert.equal(window.document.querySelector('#title').value,'独立文章标题');
  assert.equal(window.document.querySelector('#author').value,'原作者');
  assert.equal(window.document.querySelector('[data-field="title"]').textContent,'新版标题栏');
  assert.equal(window.document.querySelector('[aria-label="作者"]').textContent,'新版作者栏');
  assert.equal($('.status').closest('footer'),$('footer'));
  assert.equal($('.body .status'),null);
  assert.match($('footer .status').textContent,/已插入.*排版已检查/);
  assert.equal($('.status').hidden,false);
  assert.equal($('.status').classList.contains('error'),false);
  assert.equal(h.calls.paste.length,1,'one action dispatches exactly one paste');
  assert.equal(h.calls.commands.includes('insertHTML'),false,'handled paste never falls back to a second write');
  $('.insert').click();await tick();
  assert.equal(h.calls.paste.length,1,'the same verified article cannot be pasted twice');
  const paragraph=[...article.querySelectorAll('p')].find(node=>node.textContent.includes('GPT'));
  assert.equal(paragraph.style.marginBottom,'24px');
  assert.equal(paragraph.style.textAlign,'justify');
  assert.equal(paragraph.style.fontSize,'16px');
});

test('old article route discovers a generic rich body and uses one verified paste while protecting title and author',async t=>{
  const h=setup(ARTICLE_URL,{genericBody:true,sitePaste:'preserve'});
  t.after(()=>h.dom.window.close());
  const {$,paste,body,window}=h;
  $('.launcher').click();
  assert.equal(window.WXArticleEditor.inspect().ready,true);
  assert.equal(body.id,'','body has no legacy UEditor selector');
  paste('<h2>旧入口的新正文编辑器</h2><p>中文 GPT 6 正文</p><video src="https://example.test/video.mp4"></video>');
  $('.format').click();
  assert.equal($('.preview p[data-wxaf-kind="heading"] > span').textContent,'旧入口的新正文编辑器');
  assert.equal($('.insert').disabled,false);
  $('.insert').click();await idle(h);
  assert.equal($('.status').classList.contains('error'),false);
  assert.match($('footer .status').textContent,/已插入.*排版已检查/);
  assert.equal(h.calls.paste.length,1);
  assert.equal(h.calls.commands.includes('insertHTML'),false,'newly recognized generic editors must not use the legacy native path');
  assert.equal(body.firstElementChild.textContent,'原来的正文');
  const article=body.querySelector('section');
  assert(article);
  const heading=article.querySelector('p > span');
  assert.equal(heading.textContent,'旧入口的新正文编辑器');
  assert.equal(heading.style.fontSize,'20px');
  assert.equal(heading.style.color,'rgb(255, 255, 255)');
  assert.equal(heading.style.backgroundColor,'rgb(255, 138, 0)');
  assert.equal(heading.parentElement.style.backgroundColor,'');
  const paragraph=[...article.querySelectorAll('p')].find(node=>node.textContent==='中文GPT 6正文');
  assert.equal(paragraph.style.fontSize,'16px');
  assert.equal(paragraph.style.marginBottom,'24px');
  assert([...article.children].some(node=>node.tagName==='P' && node.innerHTML==='<br>'));
  assert.equal(window.document.querySelector('#title').value,'独立文章标题');
  assert.equal(window.document.querySelector('#author').value,'原作者');
  assert.equal(window.document.querySelector('[data-field="title"]').textContent,'新版标题栏');
  assert.equal(window.document.querySelector('[aria-label="作者"]').textContent,'新版作者栏');
  assert.equal($('.insert').disabled,true);
  $('.insert').click();await tick();
  assert.equal(h.calls.paste.length,1,'the same formatted article cannot be pasted twice');
});

test('inline heading permits simulated toolbar font and color edits without a parent color bar or body changes', async t => {
  const h=setup(V2_ARTICLE_URL,{genericBody:true,sitePaste:'preserve'});
  t.after(()=>h.dom.window.close());
  const {$,paste,body,window}=h;
  $('.launcher').click();
  paste('<h2>可以修改的小标题</h2><p>正文 GPT 6 保持原样</p><p>第二段正文也不改</p>');
  $('.format').click();
  $('.insert').click();await idle(h);
  assert.equal($('.status').classList.contains('error'),false);
  assert.equal(h.calls.paste.length,1);
  const article=body.querySelector('section');
  const titleSpan=article.querySelector('p > span');
  assert.equal(titleSpan.textContent,'可以修改的小标题');
  const titleParagraph=titleSpan.parentElement;
  assert.equal(titleParagraph.tagName,'P');
  assert.equal(titleSpan.style.fontSize,'20px');
  assert.equal(titleSpan.style.color,'rgb(255, 255, 255)');
  assert.equal(titleSpan.style.backgroundColor,'rgb(255, 138, 0)');
  const otherParagraphs=[...body.querySelectorAll('p')].filter(node=>node!==titleParagraph);
  const bodyBefore=otherParagraphs.map(node=>node.outerHTML);
  // Model the toolbar's inline style operation on selected heading text. This
  // checks the output structure, not the real WeChat toolbar implementation.
  const range=window.document.createRange();range.selectNodeContents(titleSpan);
  const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);
  titleSpan.style.fontSize='24px';
  titleSpan.style.color='#223344';
  titleSpan.style.backgroundColor='#b8e986';
  body.dispatchEvent(new window.Event('input',{bubbles:true}));
  await tick();
  assert.equal(titleSpan.style.fontSize,'24px');
  assert.equal(titleSpan.style.color,'rgb(34, 51, 68)');
  assert.equal(titleSpan.style.backgroundColor,'rgb(184, 233, 134)');
  for(let ancestor=titleParagraph;ancestor && ancestor!==body;ancestor=ancestor.parentElement) {
    assert.equal(ancestor.style.backgroundColor,'','the original orange must not remain on a block ancestor');
  }
  assert.equal(titleParagraph.style.padding,'');
  assert.equal(titleParagraph.style.marginBottom,'24px');
  assert.equal(titleParagraph.style.textAlign,'left');
  assert.equal(titleSpan.style.width,'');
  assert.equal(titleSpan.style.display,'');
  assert.equal(titleSpan.style.padding,'');
  assert.deepEqual(otherParagraphs.map(node=>node.outerHTML),bodyBefore);
  assert.equal(window.document.querySelector('#title').value,'独立文章标题');
  assert.equal(window.document.querySelector('#author').value,'原作者');
  assert.equal(window.document.querySelector('[data-field="title"]').textContent,'新版标题栏');
  assert.equal(window.document.querySelector('[aria-label="作者"]').textContent,'新版作者栏');
  assert.equal(h.calls.paste.length,1,'toolbar edits do not trigger another plugin paste');
});

test('v2 site that strips formatting fails verification, blocks another insertion and preserves formatted copying', async t => {
  const h = setup(V2_ARTICLE_URL, { genericBody: true, sitePaste: 'strip-styles' });
  t.after(() => h.dom.window.close());
  const { $, paste, body, window } = h;
  $('.launcher').click();
  paste('<h2>标题保留</h2><p>正文 GPT 6 段落</p><p>第二段正文</p>');
  $('.format').click();
  assert.equal($('.preview p[data-wxaf-kind="heading"] > span').style.fontSize,'20px');
  $('.insert').click();await idle(h);
  assert(body.textContent.includes('正文GPT 6段落'));
  assert.equal(h.calls.paste.length,1);
  assert.equal(h.calls.commands.includes('insertHTML'),false);
  assert.equal($('.status').classList.contains('error'),true);
  assert.equal($('.status').closest('footer'),$('footer'));
  assert.doesNotMatch($('.status').textContent,/已写入正文|已插入/);
  assert.equal($('.insert').disabled,true,'changed article must be restored before another automatic insertion');
  assert.equal($('.copy').disabled,false,'manual clipboard path remains available');
  assert.equal($('.undo').disabled,false);
  $('.insert').click();await tick();
  assert.equal(h.calls.paste.length,1);
  const beforeCopy=body.innerHTML;
  $('.copy').click();await tick();
  const copied=new window.DOMParser().parseFromString(h.calls.clipboard.getData('text/html'),'text/html');
  assert.equal(copied.querySelector('p').style.marginBottom,'24px');
  assert.equal(copied.querySelector('p > span').style.fontSize,'20px');
  assert.equal(body.innerHTML,beforeCopy,'copying never changes the article');
  assert.equal(h.calls.paste.length,1,'copying does not issue another synthetic paste');
  assert.equal(window.document.querySelector('#title').value,'独立文章标题');
  assert.equal(window.document.querySelector('#author').value,'原作者');
  assert.equal(window.document.querySelector('[data-field="title"]').textContent,'新版标题栏');
  assert.equal(window.document.querySelector('[aria-label="作者"]').textContent,'新版作者栏');
  assert.equal($('.manual-paste').hidden,false);
  assert.equal($('.paste-helper').disabled,true,'append helper must not duplicate a failed changed insertion');
  $('#article-mode').value='replace';
  $('#article-mode').dispatchEvent(new window.Event('change',{bubbles:true}));
  assert.equal($('.paste-helper').disabled,false);
  const beforeManual=body.innerHTML;
  $('.paste-helper').click();await idle(h);
  assert.equal(body.innerHTML,beforeManual,'copy and locate selects the body but never writes or clears it');
  assert.equal(window.document.activeElement,body);
  assert.equal(window.getSelection().toString(),body.textContent,'replace mode selects only the body');
  assert.equal(h.calls.paste.length,1,'manual helper waits for the user to paste');
  assert.equal($('.panel').hidden,true);
  assert.equal(window.document.querySelector('#title').value,'独立文章标题');
  assert.equal(window.document.querySelector('#author').value,'原作者');
  $('.launcher').click();
  $('.undo').click();await idle(h);
  assert.equal(body.innerHTML,'<p>原来的正文</p>');
  assert.equal($('.insert').disabled,false);
});

test('automatic upload workers still never mount the article UI or allow body writes', async t => {
  const h = setup('https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/videomsg_edit&action=video_edit&type=15#wxvu-worker=550e8400-e29b-41d4-a716-446655440000');
  t.after(() => h.dom.window.close());
  assert.equal(h.shadow, undefined);
  assert.equal(h.window.WXArticlePanel, undefined);
  assert.equal(h.window.WXArticleEditor.inspect().ready, false);
  await assert.rejects(() => h.window.WXArticleEditor.insert('<p>正文</p>'), /视频上传页/);
  assert.equal(h.body.innerHTML, '<p>原来的正文</p>');
  assert.equal(h.window.document.querySelector('#title').value, '独立文章标题');
});
