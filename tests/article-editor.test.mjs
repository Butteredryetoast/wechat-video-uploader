import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

const source = await readFile(new URL('../src/article-editor.js', import.meta.url), 'utf8');
const ARTICLE = 'https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit&action=edit&type=77';
const ARTICLE_V2 = 'https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit_v2&action=edit&isNew=1&type=77';
const body = '<input id="title" value="标题不变"><textarea id="author">作者不变</textarea><div id="js_editorArea" contenteditable="true"><p>已有正文</p></div>';
const windows = new Set();
test.afterEach(() => { for (const window of windows) window.close(); windows.clear(); });
const plain = value => JSON.parse(JSON.stringify(value));
function layout(window) { window.HTMLElement.prototype.getClientRects = function () { return [{width:100,height:20}]; }; }
function setup(html = body, url = ARTICLE) {
  const dom = new JSDOM(html, { url, runScripts: 'outside-only', pretendToBeVisual: true });
  windows.add(dom.window);
  layout(dom.window);
  dom.window.eval(source);
  return { window: dom.window, doc: dom.window.document, api: dom.window.WXArticleEditor,
    root: dom.window.document.querySelector('#js_editorArea') };
}
function nativeInsert(doc, calls) {
  doc.execCommand = (command, showUI, html) => {
    calls.push({ command, showUI, html });
    assert.equal(command, 'insertHTML');
    const selection = doc.getSelection();
    const range = selection.getRangeAt(0);
    range.deleteContents();
    const fragment = range.createContextualFragment(html);
    range.insertNode(fragment);
    return true;
  };
}

function clipboardTypes(window) {
  window.DataTransfer = class {
    constructor() { this.data = new Map(); }
    setData(type, value) { this.data.set(type, String(value)); }
    getData(type) { return this.data.get(type) || ''; }
  };
  window.ClipboardEvent = class extends window.Event {
    constructor(type, options) { super(type, options); this.clipboardData = options.clipboardData; }
  };
}

function pasteEditor(h, transform = () => {}, delay = 0) {
  clipboardTypes(h.window);
  const calls = [];
  h.root.addEventListener('paste', event => {
    event.preventDefault();
    calls.push({html:event.clipboardData.getData('text/html'),text:event.clipboardData.getData('text/plain')});
    const range = h.doc.getSelection().getRangeAt(0).cloneRange();
    const apply = () => {
      range.deleteContents();
      range.insertNode(range.createContextualFragment(calls.at(-1).html));
      transform(h.root);
    };
    if (delay) h.window.setTimeout(apply, delay);
    else apply();
  });
  return calls;
}

const formatted = '<section style="font-size:16px;text-align:justify"><h2 style="margin-bottom:24px;font-size:20px;background-color:#ff8a00;color:#ffffff">标题</h2>' +
  '<p style="font-size:16px;text-align:justify;margin-bottom:24px;letter-spacing:normal;word-spacing:normal;text-align-last:left;white-space:normal">正文 GPT 5</p>' +
  '<p style="font-size:16px;text-align:justify;margin-bottom:24px">下一段</p></section>';
const inlineHeading = '<section><p style="font-size:16px;color:#333333;margin-bottom:24px;line-height:1.75;text-align:left;text-align-last:auto">' +
  '<span style="font-size:20px;color:#ffffff;background-color:#ff8a00">一、 功能介绍</span></p>' +
  '<p style="font-size:16px;color:#333333;margin-bottom:24px;text-align:justify">普通正文</p></section>';

test('inline heading text marks are verified independently of the ordinary paragraph typography', async () => {
  const h = setup(body, ARTICLE_V2);
  pasteEditor(h);
  assert.equal((await h.api.insert(inlineHeading)).formatVerified, true);
  const paragraph = h.root.querySelector('section > p');
  assert.equal(paragraph.style.fontSize, '16px');
  assert.equal(paragraph.style.backgroundColor, '');
  assert.equal(paragraph.firstElementChild.style.fontSize, '20px');
  assert.equal(paragraph.firstElementChild.style.backgroundColor, 'rgb(255, 138, 0)');
});

test('equivalent inline text marks may be split, merged or nested without requiring identical DOM wrappers', async () => {
  for (const mode of ['split', 'merge', 'nested', 'promoted-font', 'promoted-font-break', 'white-wrapper']) {
    const h = setup(body, ARTICLE_V2);
    const source = mode === 'merge' ? inlineHeading.replace('一、 功能介绍</span>', '一、 </span><span style="font-size:20px;color:white;background-color:rgb(255,138,0)">功能介绍</span>') :
      mode === 'promoted-font-break' ? inlineHeading.replace('一、 功能介绍', '一、<br>功能介绍') : inlineHeading;
    pasteEditor(h, root => {
      const paragraph = root.querySelector('section > p');
      const mark = paragraph.firstElementChild;
      if (mode === 'split') {
        const extra = mark.cloneNode(false);
        mark.textContent = '一、 ';
        extra.textContent = '功能介绍';
        paragraph.append(extra);
      } else if (mode === 'merge') {
        mark.textContent = paragraph.textContent;
        paragraph.replaceChildren(mark);
      } else if (mode === 'promoted-font' || mode === 'promoted-font-break') {
        paragraph.style.fontSize = mark.style.fontSize;
        mark.style.removeProperty('font-size');
      } else if (mode === 'white-wrapper') {
        const wrapper = h.doc.createElement('div');
        wrapper.style.backgroundColor = 'white';
        paragraph.replaceWith(wrapper);
        wrapper.append(paragraph);
        paragraph.style.backgroundColor = 'rgb(255,255,255)';
      } else {
        const nested = h.doc.createElement('span');
        nested.style.fontSize = mark.style.fontSize;
        nested.style.color = mark.style.color;
        nested.append(...mark.childNodes);
        mark.style.removeProperty('font-size');
        mark.style.removeProperty('color');
        mark.append(nested);
      }
    });
    assert.equal((await h.api.insert(source)).formatVerified, true, mode);
  }
});

test('inline runs preserve English word spaces and explicit line breaks across equivalent span boundaries', async () => {
  const h = setup(body, ARTICLE_V2);
  const source = '<p style="font-size:16px;color:#333333"><span style="font-size:20px;color:white;background-color:#ff8a00">GPT </span>' +
    '<span style="font-size:20px;color:#ffffff;background-color:rgb(255,138,0)">5 Pro<br> Next line</span></p>';
  pasteEditor(h, root => {
    const paragraph = root.lastElementChild;
    const spans = [...paragraph.querySelectorAll('span')];
    spans[0].append(...spans[1].childNodes);
    spans[1].remove();
  });
  assert.equal((await h.api.insert(source)).formatVerified, true);
  assert.equal(h.root.lastElementChild.textContent, 'GPT 5 Pro Next line');
  assert.equal(h.root.lastElementChild.querySelectorAll('br').length, 1);
});

test('a moved inline line break cannot pass solely because text and total break count are unchanged', async () => {
  const h = setup(body, ARTICLE_V2);
  pasteEditor(h, root => { root.lastElementChild.querySelector('span').innerHTML = 'GPT5 Pro<br>'; });
  await assert.rejects(() => h.api.insert('<p><span style="font-size:20px;color:#fff;background-color:#ff8a00">GPT<br>5 Pro</span></p>'),
    error => error.code === 'FORMAT_NOT_RETAINED');
});

test('stripped inline heading styles and leftover full-width background paint never report formatted success', async () => {
  for (const mode of ['font-size', 'color', 'background-color', 'all', 'move-to-paragraph', 'extra-paragraph', 'extra-wrapper', 'block-mark']) {
    const h = setup(body, ARTICLE_V2);
    const before = h.root.innerHTML;
    pasteEditor(h, root => {
      const paragraph = root.querySelector('section > p');
      const mark = paragraph.firstElementChild;
      if (['font-size', 'color', 'background-color'].includes(mode)) mark.style.removeProperty(mode);
      if (mode === 'all') mark.removeAttribute('style');
      if (mode === 'move-to-paragraph') { paragraph.style.backgroundColor = mark.style.backgroundColor; mark.style.removeProperty('background-color'); }
      if (mode === 'extra-paragraph') paragraph.style.backgroundColor = mark.style.backgroundColor;
      if (mode === 'extra-wrapper') paragraph.parentElement.style.backgroundColor = mark.style.backgroundColor;
      if (mode === 'block-mark') { mark.style.display = 'block'; mark.style.width = '100%'; }
    });
    await assert.rejects(() => h.api.insert(inlineHeading), error => error.code === 'FORMAT_NOT_RETAINED' && error.articleChanged === true, mode);
    assert.equal((await h.api.undo()).ok, true);
    assert.equal(h.root.innerHTML, before);
  }
});

test('inline appearance is matched to ordered text positions even when adjacent runs contain the same words', async () => {
  const h = setup(body, ARTICLE_V2);
  const source = '<p style="font-size:16px;color:#333333"><span style="font-size:20px;color:white;background-color:#ff8a00">相同文字</span>' +
    '<span style="font-size:16px;color:black;background-color:#eeeeee">相同文字</span></p>';
  pasteEditor(h, root => {
    const marks = [...root.lastElementChild.querySelectorAll('span')];
    const firstStyle = marks[0].style.cssText;
    marks[0].style.cssText = marks[1].style.cssText;
    marks[1].style.cssText = firstStyle;
  });
  await assert.rejects(() => h.api.insert(source), error => error.code === 'FORMAT_NOT_RETAINED');
});

test('v2 lets the site paste importer consume HTML once and verifies stable paragraph styles', async () => {
  const h = setup(body, ARTICLE_V2);
  const original = h.root.innerHTML;
  const calls = pasteEditor(h);
  const nativeCalls = [];
  nativeInsert(h.doc, nativeCalls);
  const result = await h.api.insert(formatted);
  assert.equal(result.method, 'paste');
  assert.equal(result.formatVerified, true);
  assert.equal(result.saved, false);
  assert.equal(calls.length, 1);
  assert.match(calls[0].html, /text-align-last: left/);
  assert.match(calls[0].text, /正文 GPT 5/);
  assert.equal(nativeCalls.length, 0);
  assert.equal(h.root.querySelector('h2').style.fontSize, '20px');
  assert.equal(h.root.querySelectorAll('p')[1].style.marginBottom, '24px');
  assert.equal(h.doc.querySelector('#title').value, '标题不变');
  assert.equal((await h.api.undo()).ok, true);
  assert.equal(h.root.innerHTML, original);
});

test('async handled paste and harmless wrappers or equivalent colors do not trigger a second write', async () => {
  const h = setup(body, ARTICLE_V2);
  const calls = pasteEditor(h, root => {
    const section = root.querySelector('section');
    const wrapper = h.doc.createElement('div');
    section.replaceWith(wrapper);
    wrapper.append(section);
    section.querySelector('h2').style.backgroundColor = 'rgb(255,138,0)';
  }, 125);
  let nativeCalls = 0;
  h.doc.execCommand = () => { nativeCalls++; return false; };
  const result = await h.api.insert(formatted);
  assert.equal(result.formatVerified, true);
  assert.equal(result.method, 'paste');
  assert.equal(calls.length, 1);
  assert.equal(nativeCalls, 0);
  assert.equal(h.root.querySelectorAll('h2').length, 1);
});

test('equivalent inline font marks and one-paragraph spacing wrappers preserve the requested formatting', async () => {
  const h = setup(body, ARTICLE_V2);
  pasteEditor(h, root => {
    const section = root.querySelector('section');
    for (const block of section.querySelectorAll('h2,p')) {
      const span = h.doc.createElement('span');
      span.style.fontSize = block.style.fontSize;
      if (block.style.color) span.style.color = block.style.color;
      while (block.firstChild) span.append(block.firstChild);
      block.append(span);
      block.style.fontSize = '17px';
      if (block.style.color) block.style.color = 'black';
      const wrapper = h.doc.createElement('div');
      wrapper.style.marginBottom = block.style.marginBottom;
      block.style.marginBottom = '0px';
      block.replaceWith(wrapper);
      wrapper.append(block);
    }
  });
  assert.equal((await h.api.insert(formatted)).formatVerified, true);
});

test('a heading imported as a paragraph is equivalent only when its ordered text and visual heading styles survive', async () => {
  const h = setup(body, ARTICLE_V2);
  pasteEditor(h, root => {
    const heading = root.querySelector('h2');
    const paragraph = h.doc.createElement('p');
    paragraph.style.cssText = heading.style.cssText;
    paragraph.append(...heading.childNodes);
    heading.replaceWith(paragraph);
  });
  assert.equal((await h.api.insert(formatted)).formatVerified, true);
  assert.equal(h.root.querySelector('h2'), null);
  assert.equal(h.root.querySelector('section p').style.backgroundColor, 'rgb(255, 138, 0)');
});

test('v2 uses one native fallback only when the clipboard event cannot be constructed', async () => {
  const h = setup(body, ARTICLE_V2);
  let pastes = 0;
  h.root.addEventListener('paste', () => pastes++);
  const calls = [];
  nativeInsert(h.doc, calls);
  assert.equal((await h.api.insert(formatted)).method, 'execCommand');
  assert.equal(pastes, 0);
  assert.equal(calls.length, 1);
  assert.equal(h.root.querySelectorAll('h2').length, 1);
});

test('v2 native no-op and handled paste no-op never fall back to direct DOM writes', async () => {
  for (const mode of ['unhandled', 'handled', 'unavailable']) {
    const h = setup(body, ARTICLE_V2);
    if (mode !== 'unavailable') clipboardTypes(h.window);
    const before = h.root.innerHTML;
    h.root.addEventListener('paste', event => { if (mode === 'handled') event.preventDefault(); });
    let nativeCalls = 0;
    h.doc.execCommand = () => { nativeCalls++; return false; };
    await assert.rejects(() => h.api.insert(formatted), error => error.code === 'EDITOR_NOT_SUPPORTED' && !error.articleChanged);
    assert.equal(nativeCalls, mode === 'unavailable' ? 1 : 0);
    assert.equal(h.root.innerHTML, before);
    assert.equal(h.api.inspect().canUndo, false);
  }
});

test('a paste importer that does not preventDefault and writes after 150 ms can never be followed by a native duplicate', async () => {
  const h = setup(body, ARTICLE_V2);
  clipboardTypes(h.window);
  h.root.addEventListener('paste', event => {
    const range = h.doc.getSelection().getRangeAt(0).cloneRange();
    const html = event.clipboardData.getData('text/html');
    h.window.setTimeout(() => { range.deleteContents(); range.insertNode(range.createContextualFragment(html)); }, 150);
  });
  const nativeCalls = [];
  nativeInsert(h.doc, nativeCalls);
  assert.equal((await h.api.insert(formatted)).formatVerified, true);
  assert.equal(nativeCalls.length, 0);
  assert.equal(h.root.querySelectorAll('h2').length, 1);
});

test('implicit normal spacing and ordinary final-line alignment reject host distributed typography without changing the payload', async () => {
  const html = '<p style="font-size:16px;text-align:justify;margin-bottom:24px">应当自然排版</p>';
  for (const property of ['letterSpacing', 'wordSpacing', 'textAlignLast']) {
    const h = setup(body, ARTICLE_V2);
    h.root.style[property] = property === 'textAlignLast' ? 'justify' : '12px';
    pasteEditor(h);
    await assert.rejects(() => h.api.insert(html), error => error.code === 'FORMAT_NOT_RETAINED');
    assert.equal(h.root.lastElementChild.style[property], '', 'verification does not add new formatting to the payload');
  }
  for (const last of ['', 'auto', 'left', 'start']) {
    const h = setup(body, ARTICLE_V2);
    h.root.style.textAlignLast = last;
    pasteEditor(h);
    assert.equal((await h.api.insert(html)).formatVerified, true);
  }
});

test('auto, left and start final-line alignment are equivalent only for LTR justified or left-aligned paragraphs', async () => {
  for (const {expected, actual, direction, align, accepted} of [
    {expected:'left', actual:'auto', direction:'', align:'justify', accepted:true},
    {expected:'auto', actual:'left', direction:'ltr', align:'justify', accepted:true},
    {expected:'start', actual:'auto', direction:'ltr', align:'justify', accepted:true},
    {expected:'auto', actual:'left', direction:'ltr', align:'left', accepted:true},
    {expected:'left', actual:'auto', direction:'ltr', align:'left', accepted:true},
    {expected:'auto', actual:'start', direction:'ltr', align:'start', accepted:true},
    {expected:'left', actual:'auto', direction:'rtl', align:'justify', accepted:false},
    {expected:'left', actual:'auto', direction:'rtl', align:'left', accepted:false},
    {expected:'start', actual:'left', direction:'rtl', align:'justify', accepted:false},
    {expected:'left', actual:'auto', direction:'ltr', align:'center', accepted:false},
    {expected:'left', actual:'justify', direction:'ltr', align:'justify', accepted:false},
  ]) {
    const h = setup(body, ARTICLE_V2);
    h.root.style.direction = direction;
    pasteEditor(h, root => { root.lastElementChild.style.textAlignLast = actual; });
    const html = `<p style="font-size:16px;text-align:${align};text-align-last:${expected};margin-bottom:24px">末行保持自然排版</p>`;
    if (accepted) assert.equal((await h.api.insert(html)).formatVerified, true);
    else await assert.rejects(() => h.api.insert(html), error => error.code === 'FORMAT_NOT_RETAINED');
  }
});

test('synchronous styles stripped, paragraphs merged and delayed style loss never report formatted success', async () => {
  for (const mutation of ['strip', 'merge', 'delayed', 'child-font']) {
    const h = setup(body, ARTICLE_V2);
    const original = h.root.innerHTML;
    const calls = pasteEditor(h, root => {
      const section = root.querySelector('section');
      const strip = () => section.querySelectorAll('[style]').forEach(node => node.removeAttribute('style'));
      if (mutation === 'strip') strip();
      if (mutation === 'delayed') h.window.setTimeout(strip, 150);
      if (mutation === 'merge') section.innerHTML = '<p>标题正文 GPT 5下一段</p>';
      if (mutation === 'child-font') section.querySelector('p').innerHTML = '<span style="font-size:30px">正文 GPT 5</span>';
    });
    let nativeCalls = 0;
    h.doc.execCommand = () => { nativeCalls++; return false; };
    await assert.rejects(() => h.api.insert(formatted), error => error.code === 'FORMAT_NOT_RETAINED' && error.articleChanged === true);
    assert.equal(calls.length, 1);
    assert.equal(nativeCalls, 0);
    assert.equal(h.api.inspect().canUndo, true);
    assert.equal((await h.api.undo()).ok, true);
    assert.equal(h.root.innerHTML, original);
  }
});

test('host CSS overrides and body whitespace loss are detected despite intact inline markup', async () => {
  const styled = setup('<style>p { font-size:30px !important; }</style>' + body, ARTICLE_V2);
  // Model the browser cascade explicitly: jsdom does not implement this
  // important-selector cascade consistently.
  const computed = styled.window.getComputedStyle.bind(styled.window);
  styled.window.getComputedStyle = node => {
    const style = computed(node);
    if (node.tagName !== 'P' || !node.closest('section')) return style;
    return new Proxy(style, { get(target, key) {
      if (key === 'getPropertyValue') return property => property === 'font-size' ? '30px' : target.getPropertyValue(property);
      return Reflect.get(target, key);
    } });
  };
  pasteEditor(styled);
  await assert.rejects(() => styled.api.insert(formatted), error => error.code === 'FORMAT_NOT_RETAINED');
  const text = setup(body, ARTICLE_V2);
  pasteEditor(text, root => { root.querySelector('section p').textContent = '正文GPT5'; });
  await assert.rejects(() => text.api.insert(formatted), error => error.code === 'FORMAT_NOT_RETAINED');
});

test('user editing during settlement is never absorbed into an undo snapshot', async () => {
  const h = setup(body, ARTICLE_V2);
  pasteEditor(h);
  h.window.setTimeout(() => {
    h.root.append(h.doc.createTextNode('用户新增'));
    h.root.dispatchEvent(new h.window.InputEvent('input', {bubbles:true,inputType:'insertText'}));
  }, 150);
  await assert.rejects(() => h.api.insert(formatted), error => error.code === 'EDITOR_CHANGED' && error.articleChanged === true);
  assert.equal(h.api.inspect().canUndo, false);
  await assert.rejects(() => h.api.undo(), /没有本工具可撤销/);
  assert.match(h.root.textContent, /用户新增$/);
});

test('replaced editor nodes are not reported as success or given an unsafe undo snapshot', async () => {
  const h = setup(body, ARTICLE_V2);
  pasteEditor(h, root => h.window.setTimeout(() => root.replaceWith(root.cloneNode(true)), 125));
  await assert.rejects(() => h.api.insert(formatted), error => error.code === 'EDITOR_CHANGED' && error.articleChanged === true);
  assert.equal(h.api.inspect().canUndo, false);
  await assert.rejects(() => h.api.undo(), /没有本工具可撤销/);
});

test('append verifies existing and added identical paragraph text in order rather than matching an old paragraph', async () => {
  const h = setup('<div id="js_editorArea" contenteditable="true"><p style="font-size:14px">相同内容</p></div>', ARTICLE_V2);
  pasteEditor(h, root => {
    const paragraphs = [...root.querySelectorAll('p')];
    paragraphs[0].style.fontSize = '16px';
    paragraphs[1].style.fontSize = '14px';
  });
  await assert.rejects(() => h.api.insert('<p style="font-size:16px">相同内容</p>'), error => error.code === 'FORMAT_NOT_RETAINED');
  assert.equal(h.root.querySelectorAll('p').length, 2);
});

test('unhandled paste with transient mutation cannot cause a fallback duplicate', async () => {
  const h = setup(body, ARTICLE_V2);
  clipboardTypes(h.window);
  h.root.addEventListener('paste', () => { const span = h.doc.createElement('span'); h.root.append(span); span.remove(); });
  let nativeCalls = 0;
  h.doc.execCommand = () => { nativeCalls++; return false; };
  await assert.rejects(() => h.api.insert(formatted), error => error.code === 'TEXT_CHANGED' && error.articleChanged === true);
  assert.equal(nativeCalls, 0);
});

test('moving focus outside the body while paste is pending cannot write into the title', async () => {
  const h = setup(body, ARTICLE_V2);
  let nativeCalls = 0;
  h.doc.execCommand = () => { nativeCalls++; return true; };
  h.window.setTimeout(() => h.doc.querySelector('#title').focus(), 25);
  await assert.rejects(() => h.api.insert(formatted), error => error.code === 'EDITOR_CHANGED');
  assert.equal(nativeCalls, 0);
  assert.equal(h.doc.querySelector('#title').value, '标题不变');
});

test('undo waits for editor settlement and rejects a model redraw that restores the inserted article', async () => {
  const h = setup(body, ARTICLE_V2);
  pasteEditor(h);
  await h.api.insert(formatted);
  const inserted = h.root.innerHTML;
  let restores = 0;
  h.root.addEventListener('input', event => {
    if (event.inputType !== 'historyUndo') return;
    restores++;
    h.window.setTimeout(() => { h.root.innerHTML = inserted; }, 100);
  });
  await assert.rejects(() => h.api.undo(), error => error.code === 'UNDO_NOT_RETAINED' && error.articleChanged === true);
  assert.equal(restores, 1);
  assert.equal(h.root.innerHTML, inserted);
  assert.equal(h.api.inspect().canUndo, false);
});

test('typing during asynchronous undo remains intact and cannot be claimed as a successful restore', async () => {
  const h = setup();
  await h.api.insert('<p>新增正文</p>');
  h.window.setTimeout(() => {
    h.root.append(h.doc.createTextNode('用户继续编辑'));
    h.root.dispatchEvent(new h.window.InputEvent('input', {bubbles:true,inputType:'insertText'}));
  }, 100);
  await assert.rejects(() => h.api.undo(), error => error.code === 'EDITOR_CHANGED' && error.articleChanged === true);
  assert.match(h.root.textContent, /用户继续编辑$/);
  assert.equal(h.api.inspect().canUndo, false);
});

test('manual paste target selects append or replace without changing body, title or author', async () => {
  const h = setup(body, ARTICLE_V2);
  const before = h.doc.body.innerHTML;
  assert.deepEqual(plain(h.api.focusPasteTarget()), {ok:true,mode:'append'});
  let range = h.doc.getSelection().getRangeAt(0);
  assert.equal(range.collapsed, true);
  assert.equal(range.startContainer, h.root);
  assert.equal(range.startOffset, h.root.childNodes.length);
  assert.deepEqual(plain(h.api.focusPasteTarget({mode:'replace'})), {ok:true,mode:'replace'});
  range = h.doc.getSelection().getRangeAt(0);
  assert.equal(range.toString(), '已有正文');
  assert.equal(range.startContainer, h.root);
  assert.equal(range.endContainer, h.root);
  assert.equal(h.doc.body.innerHTML, before);
  assert.equal(h.api.inspect().canUndo, false);
  pasteEditor(h);
  const pending = h.api.insert(formatted);
  assert.throws(() => h.api.focusPasteTarget(), error => error.code === 'INSERT_IN_PROGRESS');
  await assert.rejects(() => h.api.insert(formatted), error => error.code === 'INSERT_IN_PROGRESS');
  await pending;
  assert.equal(h.root.querySelectorAll('h2').length, 1);
  const absent = setup('', ARTICLE_V2);
  assert.throws(() => absent.api.focusPasteTarget(), error => error.code === 'EDITOR_NOT_FOUND');
  assert.throws(() => h.api.focusPasteTarget({mode:'other'}), /追加或替换/);
});

test('only the article editor route is eligible and video or other pages remain untouched', async () => {
  for (const url of [
    'https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/videomsg_edit&action=video_edit&type=15',
    'https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit&action=publish',
    'https://example.com/cgi-bin/appmsg?t=media/appmsg_edit',
    'https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit&t=media/videomsg_edit',
    'https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit_v2&action=publish',
    'https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit_v2&action=edit&action=publish',
    'https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit_v2&t=media/appmsg_edit',
    'https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit_v3&action=edit',
    'https://mp.weixin.qq.com/cgi-bin/appmsg?action=edit',
    'https://mp.weixin.qq.com/cgi-bin/appmsg2?t=media/appmsg_edit_v2&action=edit',
    'https://mp.weixin.qq.com/cgi-bin/filepage?type=15&action=select',
    'https://mp.weixin.qq.com/cgi-bin/home',
  ]) {
    const h = setup(body, url);
    const before = h.doc.body.innerHTML;
    assert.equal(h.api.inspect().ready, false);
    assert.equal(h.api.inspect().code, 'NOT_ARTICLE');
    await assert.rejects(() => h.api.insert('<p>新正文</p>'), error => error.code === 'NOT_ARTICLE' && /图文文章编辑页/.test(error.message));
    assert.equal(h.doc.body.innerHTML, before);
  }
  assert.equal(setup(body, 'https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit').api.inspect().ready, true);
});

test('the reported old route with three rich editables resolves its sole unprotected visible generic body and pastes once', async () => {
  const h = setup('<div contenteditable="true" data-placeholder="请在这里输入标题">原标题</div>' +
    '<div class="current-body" contenteditable="true"><p>已有正文</p></div>' +
    '<div contenteditable="true" hidden>隐藏编辑器</div><iframe hidden></iframe>', ARTICLE);
  h.root = h.doc.querySelector('.current-body');
  const original = h.root.innerHTML;
  const diagnostic = h.api.diagnose();
  assert.equal(diagnostic.code, 'READY');
  assert.equal(diagnostic.route.template, 'media/appmsg_edit');
  assert.equal(diagnostic.candidateCount, 1);
  assert.equal(diagnostic.documents[0].richEditable, 3);
  assert.equal(diagnostic.documents[0].visible, 2);
  assert.equal(diagnostic.documents[0].protectedExcluded, 1);
  assert.equal(diagnostic.documents[0].exclusions.placeholderMetadata, 1);
  assert.equal(diagnostic.documents[0].exclusions.hidden, 1);
  assert.equal(diagnostic.documents[0].exclusions.unrecognized, 0);
  assert.equal(diagnostic.iframes.hidden, 1);
  const pasteCalls = pasteEditor(h, () => {}, 150);
  const nativeCalls = [];
  nativeInsert(h.doc, nativeCalls);
  const result = await h.api.insert(inlineHeading);
  assert.equal(result.method, 'paste');
  assert.equal(result.formatVerified, true);
  assert.equal(pasteCalls.length, 1);
  assert.equal(nativeCalls.length, 0);
  assert.equal(h.doc.querySelector('[data-placeholder]').textContent, '原标题');
  assert.equal((await h.api.undo()).ok, true);
  assert.equal(h.root.innerHTML, original);
});

test('old-route generic recognition retains ambiguity and field protection and has no DOM fallback on ignored paste', async () => {
  for (const field of [
    '<div contenteditable="true" aria-placeholder="请输入作者">原作者</div>',
    '<div contenteditable="true"><span data-placeholder="摘要"></span></div>',
    '<div contenteditable="true" hidden>隐藏</div>',
    '<div contenteditable="plaintext-only">纯文本</div>',
  ]) assert.equal(setup(field, ARTICLE).api.inspect().code, 'EDITOR_NOT_FOUND');
  assert.equal(setup('<div contenteditable="true">一</div><div contenteditable="true">二</div>', ARTICLE).api.inspect().code, 'AMBIGUOUS_EDITOR');
  const h = setup('<div class="current-body" contenteditable="true"><p>原正文</p></div>', ARTICLE);
  h.root = h.doc.querySelector('.current-body');
  clipboardTypes(h.window);
  const before = h.root.innerHTML;
  const nativeCalls = [];
  nativeInsert(h.doc, nativeCalls);
  await assert.rejects(() => h.api.insert('<p>不接受的粘贴</p>'), error => error.code === 'EDITOR_NOT_SUPPORTED');
  assert.equal(h.root.innerHTML, before);
  assert.equal(nativeCalls.length, 0);
});

test('the observed v2 route accepts one visible rich editable body without old UEditor selectors', async () => {
  const h = setup('<div contenteditable="true" data-placeholder="请在这里输入标题">原标题</div>' +
    '<div contenteditable="true" aria-placeholder="请输入作者">原作者</div>' +
    '<div class="arbitrary-editor" role="textbox" contenteditable="true" data-placeholder="从这里开始写正文">' +
    '<p>已有正文</p><div contenteditable="true">嵌套段落</div></div>' +
    '<div contenteditable="true" hidden>隐藏编辑器</div>', ARTICLE_V2);
  const root = h.doc.querySelector('.arbitrary-editor');
  nativeInsert(h.doc, []);
  assert.equal(h.api.inspect().ready, true);
  assert.equal(h.api.inspect().code, 'READY');
  assert.equal((await h.api.insert('<p>追加正文</p>')).ok, true);
  assert.equal(root.textContent, '已有正文嵌套段落追加正文');
  assert.equal(h.doc.querySelector('[data-placeholder="请在这里输入标题"]').textContent, '原标题');
  assert.equal(h.doc.querySelector('[aria-placeholder="请输入作者"]').textContent, '原作者');
  assert.equal((await h.api.undo()).ok, true);
  assert.equal(root.textContent, '已有正文嵌套段落');
  for (const url of [ARTICLE.replace('appmsg_edit', 'appmsg_edit_v3')]) {
    const old = setup('<div class="arbitrary-editor" contenteditable="true">正文</div>', url);
    assert.equal(old.api.inspect().ready, false, 'generic candidates remain limited to the two allowed article templates');
  }
  for (const url of [ARTICLE_V2.replace('&action=edit', ''), ARTICLE_V2.replace('action=edit', 'action=')])
    assert.equal(setup('<div contenteditable="">正文</div>', url).api.inspect().ready, true);
});

test('v2 editable title and author containers with child placeholders stay untouched', async () => {
  for (const field of [
    '<div contenteditable="true" data-placeholder="请在这里输入标题">原有标题</div>',
    '<div contenteditable="true" aria-placeholder="请输入作者">原有作者</div>',
    '<div contenteditable="true"><span data-placeholder="请在这里输入标题"></span></div>',
    '<div contenteditable="true"><span aria-placeholder="请输入作者"></span></div>',
    '<div contenteditable="true"><span class="arbitrary-placeholder">请在这里输入标题</span></div>',
    '<div contenteditable="true"><p>请输入作者</p></div>',
    '<div contenteditable="true">请在这里输入标题</div>',
    '<div contenteditable="true">请输入作者</div>',
    '<div contenteditable="true"><span data-placeholder="摘要"></span></div>',
    '<div contenteditable="true" data-role="article-title">原有标题</div>',
    '<div contenteditable="true"><div contenteditable="true" data-role="article-title">原有标题</div></div>',
    '<div contenteditable="true"><input id="title" value="原有标题"></div>',
    '<div contenteditable="true" aria-labelledby="field-label"></div><span id="field-label">作者</span>',
  ]) {
    const alone = setup(field, ARTICLE_V2);
    const before = alone.doc.body.innerHTML;
    assert.equal(alone.api.inspect().code, 'EDITOR_NOT_FOUND');
    await assert.rejects(() => alone.api.insert('<p>正文</p>'), error => error.code === 'EDITOR_NOT_FOUND');
    assert.equal(alone.doc.body.innerHTML, before);
    const mixed = setup(field + '<div class="article-body" contenteditable="true">正文</div>', ARTICLE_V2);
    const protectedHtml = mixed.doc.body.firstElementChild.outerHTML;
    nativeInsert(mixed.doc, []);
    assert.equal((await mixed.api.insert('<h2>文章里的标题和作者</h2>')).ok, true);
    assert.equal(mixed.doc.body.firstElementChild.outerHTML, protectedHtml);
    assert.equal(mixed.doc.querySelector('.article-body').textContent, '正文文章里的标题和作者');
  }
});

test('v2 ambiguity, plaintext fields, native input elements and shadow editors are still rejected', async () => {
  const ambiguous = setup('<div contenteditable="true">正文一</div><div contenteditable="true">正文二</div>', ARTICLE_V2);
  const before = ambiguous.doc.body.innerHTML;
  assert.equal(ambiguous.api.inspect().code, 'AMBIGUOUS_EDITOR');
  await assert.rejects(() => ambiguous.api.insert('<p>正文</p>'), error => error.code === 'AMBIGUOUS_EDITOR');
  assert.equal(ambiguous.doc.body.innerHTML, before);
  for (const html of [
    '<div contenteditable="plaintext-only">纯文本</div>',
    '<input contenteditable="true" value="标题"><textarea contenteditable="true">作者</textarea>',
    '<label contenteditable="true">标签</label><button contenteditable="true">操作</button>',
    '<div contenteditable="true" style="display:none">隐藏</div>',
    '<div contenteditable="true" aria-readonly="true">只读</div>',
  ]) assert.equal(setup(html, ARTICLE_V2).api.inspect().code, 'EDITOR_NOT_FOUND');
  const shadow = setup('<div id="extension"></div>', ARTICLE_V2);
  shadow.doc.querySelector('#extension').attachShadow({mode:'open'}).innerHTML = '<div contenteditable="true">扩展内容</div>';
  assert.equal(shadow.api.inspect().code, 'EDITOR_NOT_FOUND');
  shadow.doc.body.setAttribute('contenteditable', 'true');
  assert.equal(shadow.api.inspect().code, 'EDITOR_NOT_FOUND', 'the entire page body is never a v2 fallback');
});

test('inspect exposes only bounded safe route components and never URL credentials or tokens', async () => {
  const h = setup(body, ARTICLE_V2 + '&token=never-expose-me&appmsgid=private-id#private-fragment');
  assert.deepEqual(plain(h.api.inspect().route), {pathname:'/cgi-bin/appmsg',template:'media/appmsg_edit_v2',action:'edit'});
  assert(!/never-expose-me|private-id|private-fragment|https:|token/.test(JSON.stringify(h.api.inspect())));
  const unsafe = setup(body, 'https://mp.weixin.qq.com/cgi-bin/appmsg?t=' + encodeURIComponent('media/appmsg_edit?token=secret') + '&action=' + encodeURIComponent('https://secret.test/?token=private'));
  assert.deepEqual(plain(unsafe.api.inspect().route), {pathname:'/cgi-bin/appmsg',template:null,action:null});
  assert.equal(unsafe.api.inspect().code, 'NOT_ARTICLE');
  const missing = setup('', ARTICLE_V2);
  assert.equal(missing.api.inspect().code, 'EDITOR_NOT_FOUND');
  assert.deepEqual(plain(missing.api.inspect().route), plain(h.api.inspect().route));
});

test('a single trusted body accepts default append and protects title, author and existing paragraphs', async () => {
  const h = setup();
  assert.equal(h.api.inspect().hasContent, true);
  const events = [];
  h.root.addEventListener('input', event => events.push({type:event.type,inputType:event.inputType,bubbles:event.bubbles}));
  h.root.addEventListener('change', event => events.push({type:event.type}));
  const result = await h.api.insert('<h2 style="color:#c86422">新标题</h2><p>新正文</p>');
  assert.equal(result.ok, true);
  assert.equal(result.mode, 'append');
  assert.equal(result.method, 'dom');
  assert.equal(result.saved, false);
  assert.equal(result.domVerified, true);
  assert.equal(h.root.firstElementChild.textContent, '已有正文');
  assert.equal(h.root.lastElementChild.textContent, '新正文');
  assert.equal(h.doc.querySelector('#title').value, '标题不变');
  assert.equal(h.doc.querySelector('#author').value, '作者不变');
  assert.deepEqual(events, [{type:'input',inputType:'insertFromPaste',bubbles:true},{type:'change'}]);
  assert.equal(h.api.inspect().canUndo, true);
});

test('explicit replace changes only the body and one memory snapshot restores its original content', async () => {
  const h = setup();
  const original = h.root.innerHTML;
  assert.equal((await h.api.insert('<p>整篇替换</p>', {mode:'replace'})).ok, true);
  assert.equal(h.root.innerHTML, '<p>整篇替换</p>');
  assert.equal((await h.api.undo()).ok, true);
  assert.equal(h.root.innerHTML, original);
  assert.equal(h.doc.querySelector('#title').value, '标题不变');
  await assert.rejects(() => h.api.undo(), /没有本工具可撤销/);
  await assert.rejects(() => h.api.insert('<p>bad</p>', {mode:'overwrite'}), /追加或替换/);
});

test('native insertHTML is preferred and its selection is scoped to the body for append and replace', async () => {
  const h = setup();
  const calls = [];
  nativeInsert(h.doc, calls);
  const first = await h.api.insert('<p>追加内容</p>');
  assert.equal(first.method, 'execCommand');
  assert.equal(h.root.textContent, '已有正文追加内容');
  const second = await h.api.insert('<h1>替换内容</h1>', {mode:'replace'});
  assert.equal(second.method, 'execCommand');
  assert.equal(h.root.textContent, '替换内容');
  assert.equal(calls.length, 2);
  assert(calls.every(call => call.command === 'insertHTML' && call.showUI === false));
  assert.equal((await h.api.undo()).ok, true);
  assert.equal(h.root.textContent, '已有正文追加内容', 'undo keeps only the most recent insertion snapshot');
  assert.equal(calls.length, 2, 'tool undo must never target the document-wide undo history');
});

test('a no-op native insert permits one DOM fallback but a partial mutation never repeats the insert', async () => {
  const h = setup();
  let calls = 0;
  h.doc.execCommand = () => { calls++; return true; };
  assert.equal((await h.api.insert('<p>追加</p>')).method, 'dom');
  assert.equal(calls, 1);
  assert.equal(h.root.textContent, '已有正文追加');
  h.doc.execCommand = () => { calls++; h.root.appendChild(h.doc.createTextNode('部分')); return false; };
  await assert.rejects(() => h.api.insert('<p>完整内容</p>'), error => error.articleChanged === true && error.code === 'TEXT_CHANGED');
  assert.equal(h.root.textContent, '已有正文追加部分');
  assert.equal(calls, 2);
  assert.equal((await h.api.undo()).ok, true);
  assert.equal(h.root.textContent, '已有正文追加');
});

test('ambiguous bodies are rejected while nested nodes and hidden alternate bodies do not create false candidates', async () => {
  const h = setup('<div id="js_editorArea" contenteditable="true">一</div><div id="js_content" contenteditable="true">二</div>');
  const before = h.doc.body.innerHTML;
  assert.equal(h.api.inspect().ready, false);
  await assert.rejects(() => h.api.insert('<p>新内容</p>'), /多个可能/);
  assert.equal(h.doc.body.innerHTML, before);
  const nested = setup('<div id="js_editorArea" contenteditable="true"><p contenteditable="true">已有正文</p></div><div id="js_content" contenteditable="true" hidden>隐藏</div>');
  assert.equal(nested.api.inspect().ready, true);
  assert.equal((await nested.api.insert('<p>新内容</p>')).ok, true);
});

test('title, author, plaintext-only and extension shadow contenteditable fields are never selected as article bodies', async () => {
  for (const html of [
    '<div id="js_editorArea"><div contenteditable="true" data-field="title">标题</div></div>',
    '<div id="js_editorArea" contenteditable="true" aria-label="作者">作者</div>',
    '<div id="js_editorArea" contenteditable="plaintext-only">纯文本</div>',
    '<input id="js_editorArea" contenteditable="true" value="标题">',
    '<div id="js_editorArea" contenteditable="true" aria-labelledby="label"></div><span id="label">标题</span>',
  ]) {
    const h = setup(html);
    const before = h.doc.body.innerHTML;
    assert.equal(h.api.inspect().ready, false);
    await assert.rejects(() => h.api.insert('<p>正文</p>'), /没有找到/);
    assert.equal(h.doc.body.innerHTML, before);
  }
  const h = setup('<div id="extension-root"></div>');
  h.doc.querySelector('#extension-root').attachShadow({mode:'open'}).innerHTML = '<div id="js_editorArea" contenteditable="true">扩展内容</div>';
  assert.equal(h.api.inspect().ready, false);
});

test('same-origin UEditor iframe writes and notifies its own body, excluding unrelated top-level fields', async () => {
  const h = setup('<input id="title" value="原标题"><iframe id="ueditor_0"></iframe>');
  const frame = h.doc.querySelector('iframe');
  layout(frame.contentWindow);
  const doc = frame.contentDocument;
  doc.body.setAttribute('contenteditable','true');
  doc.body.innerHTML = '<p>框内正文</p>';
  const calls = [];
  nativeInsert(doc, calls);
  let inputEvents = 0;
  doc.body.addEventListener('input', () => inputEvents++);
  assert.equal(h.api.inspect().ready, true);
  assert.equal((await h.api.insert('<p>框内追加</p>')).method, 'execCommand');
  assert.equal(doc.body.textContent, '框内正文框内追加');
  assert.equal(h.doc.querySelector('#title').value, '原标题');
  assert.equal(inputEvents, 1);
  assert.equal(calls.length, 1);
  assert.equal((await h.api.undo()).ok, true);
  assert.equal(doc.body.textContent, '框内正文');
});

test('same-origin iframe child article roots are found even when the iframe body itself is not editable', async () => {
  const h = setup('<input id="title" value="外部标题"><iframe id="article-frame"></iframe>');
  const frame = h.doc.querySelector('iframe');
  layout(frame.contentWindow);
  const doc = frame.contentDocument;
  doc.body.innerHTML = '<div data-role="article-body" contenteditable="true"><p>框内正文</p></div>';
  const root = doc.querySelector('[data-role="article-body"]');
  const calls = [];
  nativeInsert(doc, calls);
  assert.equal(h.api.inspect().ready, true);
  assert.equal((await h.api.insert('<p>正确追加</p>')).formatVerified, true);
  assert.equal(root.textContent, '框内正文正确追加');
  assert.equal(doc.body.hasAttribute('contenteditable'), false);
  assert.equal(h.doc.querySelector('#title').value, '外部标题');
  assert.equal(calls.length, 1);
  assert.equal((await h.api.undo()).ok, true);
  assert.equal(root.textContent, '框内正文');
  const diagnostic = plain(h.api.diagnose());
  assert.equal(diagnostic.code, 'READY');
  assert.deepEqual(diagnostic.documents.map(item => [item.depth, item.richEditable, item.visible, item.candidateCount]), [[0,0,0,0],[1,1,1,1]]);
  assert.equal(diagnostic.iframes.accessible, 1);
});

test('ordinary quoted title and author prompts inside an explicit article root do not make it a protected field', async () => {
  const h = setup('<div id="js_editorArea" aria-label="正文" contenteditable="true"><p>请输入标题</p><p>请输入作者</p></div>');
  assert.equal(h.api.inspect().ready, true);
  assert.equal((await h.api.insert('<p>这是正文中的操作示例。</p>')).formatVerified, true);
  assert.equal(h.root.textContent, '请输入标题请输入作者这是正文中的操作示例。');
  assert.equal(h.api.diagnose().documents[0].protectedExcluded, 0);
  const untrusted = setup('<div contenteditable="true"><p>请输入标题</p></div>', ARTICLE_V2);
  assert.equal(untrusted.api.inspect().code, 'EDITOR_NOT_FOUND');
  assert.equal(untrusted.api.diagnose().documents[0].exclusions.placeholderText, 1);
});

test('explicit article roots still reject real field controls and placeholder metadata', async () => {
  for (const inner of [
    '<span data-placeholder="请输入标题"></span>',
    '<p aria-placeholder="请输入作者"></p>',
    '<input value="某个字段">',
    '<div contenteditable="true" data-field="title">真实标题</div>',
    '<div contenteditable="true">请输入作者</div>',
  ]) {
    const h = setup(`<div id="js_editorArea" aria-label="正文" contenteditable="true">${inner}</div>`);
    const before = h.doc.body.innerHTML;
    assert.equal(h.api.inspect().code, 'EDITOR_NOT_FOUND');
    await assert.rejects(() => h.api.insert('<p>不可写入</p>'), error => error.code === 'EDITOR_NOT_FOUND');
    assert.equal(h.doc.body.innerHTML, before);
    assert(h.api.diagnose().documents[0].protectedExcluded >= 1);
  }
});

test('iframe discovery preserves hidden, protected, cross-origin and arbitrary-editable exclusions', async () => {
  for (const mode of ['hidden', 'protected', 'inaccessible', 'arbitrary', 'title']) {
    const h = setup('<iframe></iframe>', ARTICLE_V2);
    const frame = h.doc.querySelector('iframe');
    layout(frame.contentWindow);
    frame.contentDocument.body.innerHTML = mode === 'arbitrary' ? '<div contenteditable="true">其他控件</div>' :
      `<div contenteditable="true" data-role="article-body" ${mode === 'title' ? 'aria-label="作者"' : ''}>框内正文</div>`;
    if (mode === 'hidden') frame.hidden = true;
    if (mode === 'protected') frame.setAttribute('aria-label', '标题编辑器');
    if (mode === 'inaccessible') Object.defineProperty(frame, 'contentDocument', { get() { throw new Error('PRIVATE_CROSS_ORIGIN_DETAILS'); } });
    assert.equal(h.api.inspect().code, 'EDITOR_NOT_FOUND', mode);
    const diagnostic = h.api.diagnose();
    assert.equal(diagnostic.candidateCount, 0, mode);
    if (mode === 'hidden') { assert.equal(diagnostic.iframes.hidden, 1); assert.equal(diagnostic.documents[1].visible, 0); }
    if (mode === 'protected') { assert.equal(diagnostic.iframes.protected, 1); assert.equal(diagnostic.documents[1].exclusions.frameProtected, 1); }
    if (mode === 'inaccessible') assert.equal(diagnostic.iframes.inaccessible, 1);
    if (mode === 'arbitrary') assert.equal(diagnostic.documents[1].exclusions.unrecognized, 1);
    assert(!JSON.stringify(diagnostic).includes('PRIVATE_CROSS_ORIGIN_DETAILS'));
  }
});

test('nested same-origin documents report depth counts and multiple trusted bodies remain ambiguous', async () => {
  const h = setup('<iframe></iframe>');
  const outer = h.doc.querySelector('iframe');
  layout(outer.contentWindow);
  outer.contentDocument.body.innerHTML = '<iframe></iframe>';
  const inner = outer.contentDocument.querySelector('iframe');
  layout(inner.contentWindow);
  inner.contentDocument.body.innerHTML = '<div data-role="article-body" contenteditable="true">正文</div>';
  assert.equal(h.api.inspect().code, 'READY');
  assert.deepEqual(plain(h.api.diagnose().documents.map(item => item.depth)), [0,1,2]);
  assert.equal(h.api.diagnose().iframes.accessible, 2);
  outer.contentDocument.body.insertAdjacentHTML('afterbegin', '<div aria-label="正文" contenteditable="true">另一个正文</div>');
  assert.equal(h.api.inspect().code, 'AMBIGUOUS_EDITOR');
  assert.equal(h.api.diagnose().candidateCount, 2);
  await assert.rejects(() => h.api.insert('<p>不猜测目标</p>'), error => error.code === 'AMBIGUOUS_EDITOR');
});

test('diagnostics contain only fixed route vocabulary and numeric document counts without private page strings', () => {
  const secret = 'PRIVATE_DIAGNOSTIC_SENTINEL_92731';
  const h = setup(`<input id="title" value="${secret}"><textarea id="author">${secret}</textarea><div id="js_editorArea" contenteditable="true">${secret}</div>` +
    `<iframe src="about:blank" title="${secret}"></iframe>`, ARTICLE_V2 + `&token=${secret}&appmsgid=${secret}#${secret}`);
  h.doc.cookie = `private_cookie=${secret}`;
  const diagnostic = plain(h.api.diagnose());
  assert.equal(diagnostic.version, '0.4.7');
  assert.equal(diagnostic.code, 'READY');
  assert.deepEqual(diagnostic.route, {pathname:'/cgi-bin/appmsg',template:'media/appmsg_edit_v2',action:'edit'});
  assert(!JSON.stringify(diagnostic).includes(secret));
  assert(!/https?:|about:|cookie|innerHTML|textContent/.test(JSON.stringify(diagnostic)));
  for (const stats of diagnostic.documents) {
    assert(Object.values(stats).filter(value => typeof value !== 'object').every(value => Number.isInteger(value) && value >= 0));
    assert(Object.values(stats.exclusions).every(value => Number.isInteger(value) && value >= 0));
  }
  const unknown = setup(body, `https://mp.weixin.qq.com/cgi-bin/${secret}?t=${secret}&action=${secret}&token=${secret}`);
  assert.equal(unknown.api.diagnose().code, 'NOT_ARTICLE');
  assert.deepEqual(plain(unknown.api.diagnose().route), {pathname:null,template:null,action:null});
  assert(!JSON.stringify(unknown.api.diagnose()).includes(secret));
  const video = setup(body, 'https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/videomsg_edit&action=video_edit');
  assert.equal(video.api.diagnose().code, 'NOT_ARTICLE');
  assert.deepEqual(plain(video.api.diagnose().documents), []);
});

test('cross-origin or inaccessible frames are skipped and two editable frame bodies remain ambiguous', async () => {
  const h = setup('<iframe id="ueditor_0"></iframe><iframe id="other"></iframe>');
  const frames = [...h.doc.querySelectorAll('iframe')];
  for (const frame of frames) { layout(frame.contentWindow); frame.contentDocument.body.setAttribute('contenteditable','true'); }
  assert.equal(h.api.inspect().ready, false);
  Object.defineProperty(frames[1], 'contentDocument', {get() { throw new Error('cross-origin denied'); }});
  assert.equal(h.api.inspect().ready, true);
  assert.equal((await h.api.insert('<p>唯一正文</p>')).ok, true);
});

test('undo rejects subsequent user edits even if typing and deletion restore the same HTML', async () => {
  const h = setup();
  await h.api.insert('<p>新正文</p>');
  const after = h.root.innerHTML;
  h.root.dispatchEvent(new h.window.InputEvent('input', {bubbles:true,inputType:'insertText'}));
  assert.equal(h.root.innerHTML, after);
  await assert.rejects(() => h.api.undo(), /已经变化/);
  assert.equal(h.root.innerHTML, after);
  const other = setup();
  await other.api.insert('<p>新正文</p>');
  const same = other.root.innerHTML;
  other.root.appendChild(other.doc.createTextNode('x'));
  other.root.lastChild.remove();
  assert.equal(other.root.innerHTML, same);
  await assert.rejects(() => other.api.undo(), /已经变化/);
});

test('undo refuses replacement editor instances and route changes without overwriting new content', async () => {
  const h = setup();
  await h.api.insert('<p>追加</p>');
  h.root.replaceWith(h.root.cloneNode(true));
  await assert.rejects(() => h.api.undo(), /已经变化/);
  const route = setup();
  await route.api.insert('<p>追加</p>');
  route.window.history.replaceState(null,'','/cgi-bin/appmsg?t=media/videomsg_edit&action=video_edit&type=15');
  await assert.rejects(() => route.api.undo(), /图文文章编辑页/);
  assert.equal(route.root.textContent, '已有正文追加');
});

test('scriptable HTML, event handlers, unsafe URLs and CSS are stripped while headings and ordinary typography remain', async () => {
  const h = setup();
  await h.api.insert('<script>globalThis.bad=1</script><style>body{display:none}</style><svg onload="bad()"><text>危险</text></svg>' +
    '<h2 id="title" onclick="bad()" style="color:#c86422;font-weight:700;position:fixed;background-image:url(https://tracker.test/x)">保留标题</h2>' +
    '<p><a href="javascript:bad()">链接文字</a><a href="https://example.test/article" onmouseover="bad()">安全链接</a></p>' +
    '<img src="https://example.test/image.png" data-src="javascript:bad()" onerror="bad()"><img src="data:image/svg+xml;base64,PHN2Zz4="><iframe src="https://evil.test"></iframe>');
  assert.equal(h.root.querySelector('h2').textContent, '保留标题');
  assert.match(h.root.querySelector('h2').style.color, /rgb/);
  assert.equal(h.root.querySelector('h2').style.position, '');
  assert.equal(h.root.querySelector('h2').style.backgroundImage, '');
  assert.equal(h.root.querySelector('h2').id, '');
  assert.equal(h.root.querySelectorAll('img').length, 1);
  assert.equal(h.root.querySelector('img').getAttribute('data-src'), null);
  assert.equal(h.root.querySelector('a').getAttribute('href'), null);
  assert.equal(h.root.querySelectorAll('a')[1].rel, 'noopener noreferrer');
  assert(!h.root.querySelector('script,style,svg,iframe,[onclick],[onerror],[onmouseover]'));
  assert.equal(h.window.bad, undefined);
  assert.equal(h.doc.querySelector('#title').value, '标题不变');
});

test('large article insertion settles without requiring images to finish loading', async () => {
  const h = setup();
  const text = '长文章段落'.repeat(20);
  const html = '<h1>保持标题</h1>' + `<p>${text}</p>`.repeat(500) + '<img src="https://example.test/not-loaded.png" alt="封面">';
  const result = await h.api.insert(html);
  assert.equal(result.ok, true);
  assert.equal(result.saved, false);
  assert.equal(h.root.querySelectorAll('p').length, 501);
  assert.equal(h.root.querySelector('img').complete, false);
  h.root.querySelector('img').dispatchEvent(new h.window.Event('load'));
  assert.equal(h.api.inspect().canUndo, true, 'an image load event alone is not an editor-content change');
  assert.equal((await h.api.undo()).ok, true);
  assert.equal(h.root.textContent, '已有正文');
});

test('empty, oversized and unsafe-only input fail before the article is touched', async () => {
  const h = setup();
  const before = h.root.innerHTML;
  for (const html of ['', '<script>alert(1)</script>', '<p> </p>', 'x'.repeat(5*1024*1024+1)])
    await assert.rejects(() => h.api.insert(html));
  assert.equal(h.root.innerHTML, before);
  assert.equal(h.api.inspect().canUndo, false);
});

test('editor event handlers that reject the inserted content are reported as incompatibility, never saved success', async () => {
  const h = setup();
  h.root.addEventListener('input', () => { h.root.textContent = '编辑器拒绝了新内容'; }, {once:true});
  await assert.rejects(() => h.api.insert('<p>追加</p>'), error => error.articleChanged === true && error.code === 'TEXT_CHANGED');
  assert.equal(h.root.textContent, '编辑器拒绝了新内容');
  assert.equal((await h.api.undo()).saved, false);
  assert.equal(h.root.textContent, '已有正文');
});

test('an article containing only video placeholders preserves explicit blank paragraph structure', async () => {
  const h = setup();
  const original = h.root.innerHTML;
  const result = await h.api.insert('<section><p><br></p></section>');
  assert.equal(result.ok, true);
  assert.equal(h.root.textContent, '已有正文');
  assert.equal(h.root.querySelectorAll('section > p > br').length, 1);
  assert.equal((await h.api.undo()).ok, true);
  assert.equal(h.root.innerHTML, original);
  const empty = setup('<div id="js_editorArea" contenteditable="true"></div>');
  assert.equal((await empty.api.insert('<section><p><br></p></section>', {mode:'replace'})).ok, true);
  assert.equal(empty.root.querySelectorAll('p > br').length, 1);
});

test('safe URL policy accepts telephone links and raster BMP data while rejecting relative and credentialed URLs', async () => {
  const h = setup();
  await h.api.insert('<p><a href="tel:+861234567890">电话</a><a href="mailto:hello@example.test">邮箱</a>' +
    '<a href="/relative">相对链接</a><a href="https://name:password@example.test/page">凭据链接</a></p>' +
    '<img src="data:image/bmp;base64,Qk0="><img src="/relative.png">');
  const links = [...h.root.querySelectorAll('a')];
  assert.equal(links[0].getAttribute('href'), 'tel:+861234567890');
  assert.equal(links[1].getAttribute('href'), 'mailto:hello@example.test');
  assert.equal(links[2].getAttribute('href'), null);
  assert.equal(links[3].getAttribute('href'), null);
  assert.equal(h.root.querySelectorAll('img').length, 1);
  assert.equal(h.root.querySelector('img').getAttribute('src'), 'data:image/bmp;base64,Qk0=');
});
