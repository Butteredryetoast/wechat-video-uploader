/* DOM-only article-body insertion. Does not save drafts or use WeChat private APIs. */
(function (global) {
  'use strict';
  if (global.WXArticleEditor) return;

  const MAX_HTML = 5 * 1024 * 1024;
  const MAX_NODES = 50000;
  const ALLOWED_TAGS = new Set('SECTION DIV P BR H1 H2 H3 H4 H5 H6 SPAN STRONG B EM I U S DEL MARK SMALL SUB SUP BLOCKQUOTE PRE CODE UL OL LI A IMG FIGURE FIGCAPTION HR TABLE THEAD TBODY TFOOT TR TH TD COLGROUP COL'.split(' '));
  const DROP_TAGS = new Set('SCRIPT STYLE IFRAME FRAME FRAMESET OBJECT EMBED APPLET BASE META LINK FORM INPUT TEXTAREA SELECT OPTION BUTTON SVG MATH VIDEO AUDIO SOURCE TRACK TEMPLATE NOSCRIPT'.split(' '));
  const STYLE_PROPERTIES = new Set(('color background-color font-family font-size font-weight font-style line-height letter-spacing word-spacing text-align text-align-last text-justify text-decoration text-indent white-space word-break overflow-wrap ' +
    'margin margin-top margin-right margin-bottom margin-left padding padding-top padding-right padding-bottom padding-left ' +
    'border border-top border-right border-bottom border-left border-color border-width border-style border-radius ' +
    'border-top-color border-right-color border-bottom-color border-left-color width height max-width max-height min-width min-height display vertical-align list-style-type opacity box-sizing border-collapse border-spacing').split(' '));
  let history = null;
  let pending = false;
  const compact = value => String(value || '').replace(/[\s\u200b\ufeff]+/g, '');

  function articleRoute() {
    const route = { pathname: null, template: null, action: null };
    const safePart = value => value !== null && /^[A-Za-z0-9_./-]{0,120}$/.test(value) ? value : null;
    try {
      const url = new URL(global.location.href);
      const templates = url.searchParams.getAll('t');
      const actions = url.searchParams.getAll('action');
      route.pathname = safePart(url.pathname);
      route.template = templates.length === 1 ? safePart(templates[0]) : null;
      route.action = actions.length === 1 ? safePart(actions[0]) : null;
      return { route, v2: templates.length === 1 && templates[0] === 'media/appmsg_edit_v2',
        allowed: global === global.top && url.origin === 'https://mp.weixin.qq.com' && url.pathname === '/cgi-bin/appmsg' &&
          templates.length === 1 && ['media/appmsg_edit', 'media/appmsg_edit_v2'].includes(templates[0]) &&
          actions.length <= 1 && (!actions.length || ['', 'edit'].includes(actions[0])) };
    } catch { return { route, allowed: false, v2: false }; }
  }

  function editorError(code, reason) {
    const error = new Error(reason);
    error.code = code;
    return error;
  }

  function visible(node) {
    if (!node?.isConnected || node.nodeType !== 1) return false;
    const view = node.ownerDocument.defaultView;
    if (!view) return false;
    for (let current = node; current; current = current.parentElement) {
      if (current.hidden || current.hasAttribute('inert') || current.getAttribute('aria-hidden') === 'true') return false;
      const style = view.getComputedStyle(current);
      if (['none'].includes(style.display) || ['hidden', 'collapse'].includes(style.visibility)) return false;
    }
    return node.getClientRects().length > 0;
  }

  function editable(node) {
    const value = node.getAttribute('contenteditable');
    return value !== null && ['', 'true'].includes(value.toLowerCase());
  }

  const BODY_SELECTORS = [
    '#js_editorArea[contenteditable]', '#js_editorArea [contenteditable]',
    '#js_content[contenteditable]', '#js_content [contenteditable]',
    '.edui-editor-body[contenteditable]', '[contenteditable][data-role="article-body"]',
    '[contenteditable][aria-label="正文"]', '[contenteditable][aria-label="正文编辑器"]'
  ].join(',');
  const BODY_ROOT_SELECTOR = '#js_editorArea, #js_content, .edui-editor-body, [data-role="article-body"], [aria-label="正文"], [aria-label="正文编辑器"]';
  const FIELD_PATTERN = /(?:title|author|digest|标题|作者|摘要)/i;
  const EXCLUSION_REASONS = ['hidden', 'unrecognized', 'nativeControl', 'fieldMetadata', 'placeholderMetadata', 'readOnly',
    'placeholderText', 'nestedField', 'labelledField', 'frameHidden', 'frameProtected'];

  function protectionReason(node, trustedBody = node.matches(BODY_ROOT_SELECTOR)) {
    const placeholderPrompt = element => !element.childElementCount &&
      /^(?:请(?:在这里)?输入标题|请输入作者|请(?:在这里)?输入摘要)$/.test(compact(element.textContent));
    for (let current = node; current; current = current.parentElement) {
      if (['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'LABEL'].includes(current.tagName)) return 'nativeControl';
      for (const name of ['id', 'name', 'data-field', 'data-role', 'aria-label']) {
        if (FIELD_PATTERN.test(current.getAttribute(name) || '')) return 'fieldMetadata';
      }
      for (const name of ['placeholder', 'data-placeholder', 'aria-placeholder']) {
        if (FIELD_PATTERN.test(current.getAttribute(name) || '')) return 'placeholderMetadata';
      }
      if (current.getAttribute('aria-readonly') === 'true') return 'readOnly';
    }
    if (!trustedBody && placeholderPrompt(node)) return 'placeholderText';
    // A trusted article root may quote ordinary prompts in its paragraphs.
    // Actual fields and placeholder metadata remain protected even there.
    for (const child of node.querySelectorAll('*')) {
      for (const name of ['placeholder', 'data-placeholder', 'aria-placeholder']) {
        if (FIELD_PATTERN.test(child.getAttribute(name) || '')) return 'placeholderMetadata';
      }
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(child.tagName)) return 'nestedField';
      if ((!trustedBody || editable(child)) && placeholderPrompt(child)) return 'placeholderText';
      if (editable(child)) {
        for (const name of ['id', 'name', 'data-field', 'data-role', 'aria-label']) {
          if (FIELD_PATTERN.test(child.getAttribute(name) || '')) return 'nestedField';
        }
      }
    }
    const labelledBy = (node.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean);
    return labelledBy.some(id => FIELD_PATTERN.test(node.ownerDocument.getElementById(id)?.textContent || '')) ? 'labelledField' : null;
  }

  function scanEditors({ allowed }) {
    const found = [];
    const documents = [];
    const iframes = { accessible: 0, inaccessible: 0, hidden: 0, protected: 0, depthLimited: 0 };
    const seen = new Set();
    function scan(doc, frame = null, depth = 0, frameHidden = false, frameProtected = false) {
      if (seen.has(doc)) return;
      seen.add(doc);
      const stats = { depth, richEditable: 0, visible: 0, protectedExcluded: 0, candidateCount: 0,
        exclusions: Object.fromEntries(EXCLUSION_REASONS.map(reason => [reason, 0])) };
      documents.push(stats);
      const trusted = new Set(doc.querySelectorAll(BODY_SELECTORS));
      const eligible = new Set(trusted);
      const rich = [...doc.querySelectorAll('[contenteditable]')].filter(editable);
      // Both observed article routes can host the newer top-document editor.
      // The URL template alone does not identify the editor implementation.
      // A frame's child editor
      // must have a recognized article-body selector, not any arbitrary field.
      if (allowed && depth === 0) rich.forEach(node => { if (!['HTML', 'BODY'].includes(node.tagName)) eligible.add(node); });
      if (frame && editable(doc.body)) eligible.add(doc.body);
      const knownFrame = frame?.matches('iframe#ueditor_0, #ueditor_0 iframe, .edui-editor-iframeholder iframe');
      for (const node of rich) {
        stats.richEditable++;
        const shown = !frameHidden && visible(node);
        if (shown) stats.visible++;
        const protectedBy = frameProtected ? 'frameProtected' : protectionReason(node, node.matches(BODY_ROOT_SELECTOR) || (knownFrame && node === doc.body));
        if (protectedBy) { stats.protectedExcluded++; stats.exclusions[protectedBy]++; continue; }
        if (frameHidden) { stats.exclusions.frameHidden++; continue; }
        if (!shown) { stats.exclusions.hidden++; continue; }
        if (!eligible.has(node) || node.getRootNode() !== doc) { stats.exclusions.unrecognized++; continue; }
        found.push({ node, frame, document: doc, stats, generic: depth === 0 && !trusted.has(node) });
      }
      for (const childFrame of doc.querySelectorAll('iframe')) {
        const hidden = frameHidden || !visible(childFrame);
        const protectedBy = frameProtected || Boolean(protectionReason(childFrame));
        if (hidden) iframes.hidden++;
        if (protectedBy) iframes.protected++;
        try {
          const childDoc = childFrame.contentDocument;
          if (!childDoc?.body || childFrame.contentWindow?.document !== childDoc) { iframes.inaccessible++; continue; }
          iframes.accessible++;
          if (depth >= 4 || seen.size >= 32) { iframes.depthLimited++; continue; }
          scan(childDoc, childFrame, depth + 1, hidden, protectedBy);
        } catch { iframes.inaccessible++; }
      }
    }
    scan(global.document);
    const unique = found.filter((item, index) => found.findIndex(other => other.node === item.node) === index);
    const candidates = unique.filter(item => !unique.some(other => other !== item && other.node.contains(item.node)));
    for (const item of candidates) item.stats.candidateCount++;
    return { found: candidates.map(({ stats, ...item }) => item), documents, iframes, candidateCount: candidates.length };
  }

  function candidates(context) {
    return scanEditors(context).found;
  }

  function diagnose() {
    const context = articleRoute();
    // Diagnostics use fixed route vocabulary only. Unknown query/path values
    // might themselves contain private text and must never be copied out.
    const known = (value, allowed) => allowed.includes(value) ? value : null;
    const result = { version: '0.4.7', code: 'NOT_ARTICLE', route: {
      pathname: known(context.route.pathname, ['/cgi-bin/appmsg', '/cgi-bin/home', '/cgi-bin/filepage', '/cgi-bin/loginpage']),
      template: known(context.route.template, ['media/appmsg_edit', 'media/appmsg_edit_v2', 'media/videomsg_edit']),
      action: known(context.route.action, ['', 'edit', 'video_edit', 'publish'])
    }, candidateCount: 0, documents: [], iframes: { accessible: 0, inaccessible: 0, hidden: 0, protected: 0, depthLimited: 0 } };
    if (!context.allowed) return result;
    try {
      const scan = scanEditors(context);
      result.documents = scan.documents;
      result.iframes = scan.iframes;
      result.candidateCount = scan.candidateCount;
      result.code = !scan.candidateCount ? 'EDITOR_NOT_FOUND' : scan.candidateCount > 1 ? 'AMBIGUOUS_EDITOR' : pending ? 'INSERT_IN_PROGRESS' : 'READY';
    } catch { result.code = 'DIAGNOSTIC_UNAVAILABLE'; }
    return result;
  }

  function resolve(context = articleRoute()) {
    if (!context.allowed) throw editorError('NOT_ARTICLE', '请在公众号图文文章编辑页使用排版工具，视频上传页不能写入正文。');
    const found = candidates(context);
    if (!found.length) throw editorError('EDITOR_NOT_FOUND', '没有找到可确认的文章正文编辑器。请打开正文编辑区域；当前编辑器暂未适配。');
    if (found.length !== 1) throw editorError('AMBIGUOUS_EDITOR', '找到多个可能的正文编辑器，无法确定写入位置，未修改内容。');
    return found[0];
  }

  function hasContent(node) {
    return Boolean(compact(node.textContent) || node.querySelector('img,video,audio,iframe,hr,table'));
  }

  function safeUrl(value, image = false) {
    const raw = String(value || '').trim();
    if (!raw || /[\u0000-\u0020\u007f]/.test(raw)) return null;
    if (image && /^data:image\/(?:png|jpe?g|gif|webp|avif|bmp);base64,[a-z0-9+/=]+$/i.test(raw)) return raw;
    try {
      const url = new URL(raw);
      if (url.username || url.password) return null;
      if (['https:', 'http:'].includes(url.protocol) || (!image && ['mailto:', 'tel:'].includes(url.protocol))) return raw;
    } catch { /* Relative and unsupported URLs are deliberately not promoted. */ }
    return null;
  }

  function sanitizedFragment(html, doc) {
    if (typeof html !== 'string' || !html.trim()) throw new Error('请先生成需要写入的正文内容。');
    if (html.length > MAX_HTML) throw new Error('正文内容超过 5 MB，请拆分后再写入；未截断或修改原文。');
    const template = doc.createElement('template');
    template.innerHTML = html;
    const nodes = [...template.content.querySelectorAll('*')];
    if (nodes.length > MAX_NODES) throw new Error('正文结构过于复杂，请拆分后再写入；未修改原文。');
    for (const node of nodes) {
      if (!template.content.contains(node)) continue;
      if (DROP_TAGS.has(node.tagName) || node.namespaceURI !== 'http://www.w3.org/1999/xhtml') { node.remove(); continue; }
      if (!ALLOWED_TAGS.has(node.tagName)) { node.replaceWith(...node.childNodes); continue; }
      const attrs = {};
      if (node.hasAttribute('style')) {
        const style = doc.createElement('span').style;
        for (let index = 0; index < node.style.length; index++) {
          const property = node.style.item(index);
          const value = node.style.getPropertyValue(property);
          if (STYLE_PROPERTIES.has(property) && !/url\s*\(|expression\s*\(|var\s*\(|@|javascript:|[\\<>]/i.test(value))
            style.setProperty(property, value);
        }
        if (style.cssText) attrs.style = style.cssText;
      }
      if (node.tagName === 'A') {
        const href = safeUrl(node.getAttribute('href'));
        if (href) { attrs.href = href; attrs.target = '_blank'; attrs.rel = 'noopener noreferrer'; }
      }
      if (node.tagName === 'IMG') {
        const src = safeUrl(node.getAttribute('src'), true);
        const dataSrc = safeUrl(node.getAttribute('data-src'), true);
        if (!src && !dataSrc) { node.remove(); continue; }
        if (src) attrs.src = src;
        if (dataSrc) attrs['data-src'] = dataSrc;
        attrs.alt = (node.getAttribute('alt') || '').slice(0,1000);
        for (const key of ['width','height']) if (/^\d{1,5}$/.test(node.getAttribute(key) || '')) attrs[key] = node.getAttribute(key);
      }
      for (const key of ['colspan','rowspan']) {
        if (['TH','TD'].includes(node.tagName) && /^\d{1,3}$/.test(node.getAttribute(key) || '')) attrs[key] = node.getAttribute(key);
      }
      if (node.tagName === 'OL' && /^-?\d{1,6}$/.test(node.getAttribute('start') || '')) attrs.start = node.getAttribute('start');
      for (const attribute of [...node.attributes]) node.removeAttribute(attribute.name);
      for (const [key,value] of Object.entries(attrs)) node.setAttribute(key,value);
    }
    const walker = doc.createTreeWalker(template.content, 128); // SHOW_COMMENT
    const comments = [];
    while (walker.nextNode()) comments.push(walker.currentNode);
    comments.forEach(node => node.remove());
    // A formatted video placeholder is an intentional empty paragraph. Keep
    // that structure even when the selected source contains no other blocks.
    if (!hasContent(template.content) && !template.content.querySelector('p > br, div > br'))
      throw new Error('清理不安全内容后没有可写入的正文。');
    return template.content;
  }

  function witness(node) {
    return { text: compact(node.textContent),
      images: [...node.querySelectorAll('img')].map(image => image.getAttribute('data-src') || image.getAttribute('src') || ''),
      rules: node.querySelectorAll('hr').length, tables: node.querySelectorAll('table').length,
      breaks: node.querySelectorAll('br').length };
  }

  function expectedWitness(before, added, mode) {
    if (mode === 'replace') return added;
    return { text: before.text + added.text, images: [...before.images,...added.images], rules: before.rules + added.rules,
      tables: before.tables + added.tables, breaks: before.breaks + added.breaks };
  }

  const BLOCK_SELECTOR = 'p,h1,h2,h3,h4,h5,h6';
  const FORMAT_PROPERTIES = ['font-size', 'text-align', 'margin-bottom', 'color', 'background-color',
    'letter-spacing', 'word-spacing', 'text-align-last', 'white-space'];
  const INHERITED_FORMAT = new Set(['font-size', 'text-align', 'color', 'letter-spacing', 'word-spacing', 'text-align-last', 'white-space', 'direction']);
  const textOfBlock = node => (node.textContent || '').replace(/[\u200b\ufeff]/g, '').replace(/\s+/g, ' ').trim();
  const blockKind = node => /^H[1-6]$/.test(node.tagName) ? 'heading' : 'paragraph';
  const NAMED_COLOR_EQUIVALENTS = { white: 'rgb(255, 255, 255)', black: 'rgb(0, 0, 0)', transparent: 'rgba(0, 0, 0, 0)' };

  function canonicalStyle(doc, property, value) {
    const style = doc.createElement('span').style;
    style.setProperty(property, value);
    let result = style.getPropertyValue(property).trim().toLowerCase();
    if (property.endsWith('color') && NAMED_COLOR_EQUIVALENTS[result]) result = NAMED_COLOR_EQUIVALENTS[result];
    if (['letter-spacing', 'word-spacing'].includes(property) && ['0px', '0'].includes(result)) result = 'normal';
    if (result === '0') result = '0px';
    return result;
  }

  function declaredStyle(node, property, boundary) {
    for (let current = node; current && current !== boundary && current.nodeType === 1; current = current.parentNode) {
      const value = current.style.getPropertyValue(property);
      if (value && value !== 'inherit') return canonicalStyle(node.ownerDocument, property, value);
      if (!INHERITED_FORMAT.has(property)) break;
    }
    return '';
  }

  function actualStyle(node, property) {
    const view = node.ownerDocument.defaultView;
    // Browsers return inherited computed values; the walk also supports DOM
    // implementations that leave inherited properties empty.
    for (let current = node; current?.nodeType === 1; current = current.parentElement) {
      const value = view.getComputedStyle(current).getPropertyValue(property);
      if (value && value !== 'inherit') return canonicalStyle(node.ownerDocument, property, value);
      if (!INHERITED_FORMAT.has(property)) break;
    }
    if (['letter-spacing', 'word-spacing'].includes(property)) return 'normal';
    if (property === 'text-align-last') return 'auto';
    return '';
  }

  function textParents(node) {
    const walker = node.ownerDocument.createTreeWalker(node, 4); // SHOW_TEXT
    const parents = new Set();
    while (walker.nextNode()) if (compact(walker.currentNode.nodeValue)) parents.add(walker.currentNode.parentElement);
    return [...parents];
  }

  function backgroundPaints(node, boundary, computed) {
    const paints = [];
    const blockTags = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'DIV', 'SECTION', 'BLOCKQUOTE', 'PRE', 'UL', 'OL', 'LI', 'TABLE', 'TR', 'TD', 'TH']);
    for (let current = node; current && current !== boundary && current.nodeType === 1; current = current.parentElement) {
      const color = computed ? actualStyle(current, 'background-color') : canonicalStyle(current.ownerDocument, 'background-color', current.style.backgroundColor);
      if (!color || color === 'transparent' || /^rgba\([^,]+,[^,]+,[^,]+,\s*0\)$/.test(color)) continue;
      const display = (computed ? actualStyle(current, 'display') : current.style.display) || (blockTags.has(current.tagName) ? 'block' : 'inline');
      if (display === 'contents') continue; // A display:contents element paints no background box.
      const paint = { color, scope: display === 'inline' ? 'inline' : 'block' };
      // Editors may supply a neutral white canvas wrapper. It does not widen
      // the requested colored inline highlight; colored wrappers still count.
      if (paint.scope === 'block' && color === 'rgb(255, 255, 255)') continue;
      // Splitting or merging equal inline marks is visually equivalent. A
      // colored block ancestor is separate paint and must never be hidden.
      if (paint.scope === 'inline' && paints.at(-1)?.scope === 'inline' && paints.at(-1).color === color) continue;
      paints.push(paint);
    }
    return paints;
  }

  function styledTextRuns(node, boundary, computed = false) {
    const walker = node.ownerDocument.createTreeWalker(node, 5); // SHOW_ELEMENT | SHOW_TEXT
    const runs = [];
    const cache = new Map();
    let pendingSpace = null;
    let lineHasText = false;
    const push = (text, appearance) => {
      if (runs.at(-1)?.key === appearance.key) runs.at(-1).text += text;
      else runs.push({ text, ...appearance });
    };
    while (walker.nextNode()) {
      if (walker.currentNode.nodeType === 1) {
        if (walker.currentNode.tagName === 'BR') {
          pendingSpace = null;
          lineHasText = false;
          push('\n', { styles: {}, backgrounds: [], key: 'line-break' });
        }
        continue;
      }
      const parent = walker.currentNode.parentElement;
      if (!cache.has(parent)) {
        const styles = {};
        for (const property of ['font-size', 'color']) {
          const value = computed ? actualStyle(parent, property) : declaredStyle(parent, property, boundary);
          if (value) styles[property] = value;
        }
        const backgrounds = backgroundPaints(parent, boundary, computed);
        cache.set(parent, { styles, backgrounds, key: JSON.stringify({ styles, backgrounds }) });
      }
      const appearance = cache.get(parent);
      for (const part of (walker.currentNode.nodeValue || '').replace(/[\u200b\ufeff]/g, '').split(/(\s+)/)) {
        if (!part) continue;
        if (/^\s+$/.test(part)) { if (lineHasText && !pendingSpace) pendingSpace = appearance; continue; }
        if (pendingSpace) { push(' ', pendingSpace); pendingSpace = null; }
        push(part, appearance);
        lineHasText = true;
      }
    }
    return runs;
  }

  function textRunsMatch(expected, actual) {
    let left = 0;
    let right = 0;
    let leftOffset = 0;
    let rightOffset = 0;
    while (left < expected.length && right < actual.length) {
      const requested = expected[left];
      const found = actual[right];
      const length = Math.min(requested.text.length - leftOffset, found.text.length - rightOffset);
      if (requested.text.slice(leftOffset, leftOffset + length) !== found.text.slice(rightOffset, rightOffset + length) ||
        Object.entries(requested.styles).some(([property, value]) => found.styles[property] !== value) ||
        JSON.stringify(requested.backgrounds) !== JSON.stringify(found.backgrounds)) return false;
      leftOffset += length;
      rightOffset += length;
      if (leftOffset === requested.text.length) { left++; leftOffset = 0; }
      if (rightOffset === found.text.length) { right++; rightOffset = 0; }
    }
    return left === expected.length && right === actual.length;
  }

  function formatWitness(root, added = false) {
    return [...root.querySelectorAll(BLOCK_SELECTOR)].map(node => {
      const styles = {};
      const uniform = [];
      for (const property of FORMAT_PROPERTIES) {
        let value = added ? declaredStyle(node, property, root) : actualStyle(node, property);
        if (added && !value && ['letter-spacing', 'word-spacing'].includes(property)) value = 'normal';
        if (added && !value && property === 'text-align-last' && declaredStyle(node, 'text-align', root) === 'justify') value = 'auto';
        if (value) styles[property] = value;
        // When the requested text has a uniform style, also check the actual
        // text descendants so a host span override cannot hide behind a good p.
        if (added && value && ['font-size', 'color', 'letter-spacing', 'word-spacing'].includes(property) &&
          textParents(node).every(parent => (declaredStyle(parent, property, root) || (['letter-spacing', 'word-spacing'].includes(property) ? 'normal' : '')) === value)) uniform.push(property);
      }
      return { kind: blockKind(node), text: textOfBlock(node), styles, uniform,
        textRuns: added ? styledTextRuns(node, root) : null };
    });
  }

  function formatMatches(root, expected) {
    const blocks = [...root.querySelectorAll(BLOCK_SELECTOR)];
    if (blocks.length !== expected.length) return false;
    return blocks.every((node, index) => {
      const block = expected[index];
      const parents = textParents(node);
      const equivalentHeadingParagraph = block.kind === 'heading' && blockKind(node) === 'paragraph' &&
        ['font-size', 'background-color', 'color'].every(property => block.styles[property]);
      return (blockKind(node) === block.kind || equivalentHeadingParagraph) && textOfBlock(node) === block.text &&
        (!block.textRuns || textRunsMatch(block.textRuns, styledTextRuns(node, root, true))) &&
        Object.entries(block.styles).every(([property, value]) => {
          // Rich-text models often represent font and color as inline marks.
          // Their text may be correct even when the enclosing p has a default.
          if (['font-size', 'color'].includes(property) && block.textRuns?.some(run => run.styles[property]) &&
            block.textRuns.every(run => run.key === 'line-break' || run.styles[property])) return true;
          if (parents.length && block.uniform.includes(property)) return parents.every(parent => actualStyle(parent, property) === value);
          const actual = actualStyle(node, property);
          if (actual === value) return true;
          if (property === 'text-align-last' && ['auto', 'left', 'start'].includes(value) && ['auto', 'left', 'start'].includes(actual) &&
            ['justify', 'left', 'start'].includes(actualStyle(node, 'text-align')) && ['', 'ltr'].includes(actualStyle(node, 'direction'))) return true;
          if (property !== 'margin-bottom' || !['', '0px'].includes(actualStyle(node, property))) return false;
          // A single-block wrapper may own the paragraph's outer spacing. Do
          // not borrow spacing from a wrapper shared by multiple paragraphs.
          for (let wrapper = node.parentElement; wrapper && wrapper !== root; wrapper = wrapper.parentElement) {
            if (wrapper.querySelectorAll(BLOCK_SELECTOR).length !== 1 || textOfBlock(wrapper) !== block.text) break;
            if (['block', 'flow-root', 'flex', 'grid'].includes(actualStyle(wrapper, 'display')) && actualStyle(wrapper, property) === value) return true;
          }
          return false;
        });
    });
  }

  function trackInsertion(node) {
    const transaction = { own: false, externalEdit: false, changed: false };
    const events = ['beforeinput', 'input', 'keydown', 'paste', 'cut', 'drop', 'compositionstart'];
    const mark = () => { if (!transaction.own) transaction.externalEdit = true; };
    events.forEach(event => node.addEventListener(event, mark, true));
    const Observer = node.ownerDocument.defaultView.MutationObserver;
    const observer = Observer ? new Observer(records => { if (records.length) transaction.changed = true; }) : null;
    observer?.observe(node, { subtree: true, childList: true, characterData: true, attributes: true });
    transaction.readChanges = () => { if (observer?.takeRecords().length) transaction.changed = true; return transaction.changed; };
    transaction.run = operation => { transaction.own = true; try { return operation(); } finally { transaction.own = false; } };
    transaction.dispose = () => { observer?.disconnect(); events.forEach(event => node.removeEventListener(event, mark, true)); };
    return transaction;
  }

  const wait = (doc, ms) => new Promise(resolve => doc.defaultView.setTimeout(resolve, ms));

  async function verifyInsertion(node, expected, expectedFormat, transaction) {
    const now = () => node.ownerDocument.defaultView.performance.now();
    const started = now();
    let previous = null;
    let stable = 0;
    let samples = 0;
    let textMatches = false;
    do {
      if (transaction.externalEdit) throw editorError('EDITOR_CHANGED', '等待编辑器处理时检测到其他编辑，已停止核验；为保护后续修改，不自动撤销或重复写入。');
      if (!node.isConnected || resolve().node !== node)
        throw editorError('EDITOR_CHANGED', '正文编辑器已被替换，无法确认此次写入。请检查正文，未自动重复插入。');
      textMatches = JSON.stringify(witness(node)) === JSON.stringify(expected);
      const formatted = textMatches && formatMatches(node, expectedFormat);
      const signature = node.innerHTML;
      samples++;
      stable = signature === previous ? stable + 1 : 0;
      previous = signature;
      if (formatted && stable >= 2 && now() - started >= 250) return;
      // A suspended/background page may resume after the deadline.
      // Still take the minimum three observations instead of calling a correct
      // insertion a formatting failure solely because its timer was delayed.
      if (samples >= 3 && now() - started >= 1200) break;
      await wait(node.ownerDocument, 75);
    } while (true);
    if (!transaction.readChanges()) throw editorError('EDITOR_NOT_SUPPORTED', '当前编辑器未接受自动粘贴，请使用“复制并定位正文”后手动粘贴。未直接改写新版编辑器。');
    if (!textMatches) throw editorError('TEXT_CHANGED', '编辑器未保留完整正文，内容可能已部分写入。请先检查或撤销，再使用复制后手动粘贴；未自动重复插入。');
    throw editorError('FORMAT_NOT_RETAINED', '内容已写入，但编辑器没有保留段落或排版样式。请先检查或撤销，再使用复制后手动粘贴；未自动重复插入。');
  }

  function clearHistory() {
    if (!history) return;
    history.observer?.disconnect();
    for (const event of ['beforeinput','input','paste','cut','drop']) history.node.removeEventListener(event, history.markDirty, true);
    history = null;
  }

  function remember(node, before, after) {
    clearHistory();
    const record = { node, before, after, dirty: false };
    record.markDirty = () => { record.dirty = true; };
    for (const event of ['beforeinput','input','paste','cut','drop']) node.addEventListener(event, record.markDirty, true);
    const Observer = node.ownerDocument.defaultView.MutationObserver;
    if (Observer) {
      record.observer = new Observer(records => { if (records.length) record.dirty = true; });
      record.observer.observe(node, { subtree: true, childList: true, characterData: true, attributes: true });
    }
    history = record;
  }

  function unchanged(record) {
    if (!record || record.dirty || !record.node.isConnected) return false;
    if (record.observer?.takeRecords().length) { record.dirty = true; return false; }
    return record.node.innerHTML === record.after;
  }

  function notify(node, inputType) {
    const view = node.ownerDocument.defaultView;
    let event;
    try { event = new view.InputEvent('input', { bubbles: true, composed: true, inputType, data: null }); }
    catch { event = new view.Event('input', { bubbles: true, composed: true }); }
    node.dispatchEvent(event);
    node.dispatchEvent(new view.Event('change', { bubbles: true, composed: true }));
  }

  function selectBody(node, mode) {
    const doc = node.ownerDocument;
    node.focus({ preventScroll: true });
    const selection = doc.getSelection();
    if (!selection) return false;
    const range = doc.createRange();
    range.selectNodeContents(node);
    if (mode === 'append') range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
    return true;
  }

  function selectionInBody(node) {
    const doc = node.ownerDocument;
    const selection = doc.getSelection();
    if (!selection?.rangeCount || (doc.activeElement !== node && !node.contains(doc.activeElement))) return false;
    const range = selection.getRangeAt(0);
    return node.contains(range.startContainer) && node.contains(range.endContainer);
  }

  function inspect() {
    const context = articleRoute();
    try {
      const { node } = resolve(context);
      if (pending) return { ready: false, hasContent: hasContent(node), canUndo: false, code: 'INSERT_IN_PROGRESS',
        route: context.route, reason: '正在等待编辑器处理正文和核验排版，请稍候。' };
      return { ready: true, hasContent: hasContent(node), canUndo: history?.node === node && unchanged(history),
        code: 'READY', route: context.route,
        reason: '正文编辑器已就绪。写入只更新当前页面，不会自动保存或发表。' };
    } catch (error) { return { ready: false, hasContent: false, canUndo: false, code: error.code || 'EDITOR_UNAVAILABLE',
      route: context.route, reason: error.message }; }
  }

  async function insert(html, { mode = 'append' } = {}) {
    if (pending) throw editorError('INSERT_IN_PROGRESS', '正文正在写入，请等待本次操作完成。');
    if (!['append','replace'].includes(mode)) throw new Error('写入方式只能是追加或替换正文。');
    const context = articleRoute();
    const { node, document: doc, generic } = resolve(context);
    const fragment = sanitizedFragment(html, doc);
    const holder = doc.createElement('div');
    holder.appendChild(fragment.cloneNode(true));
    const cleanHtml = holder.innerHTML;
    const before = node.innerHTML;
    const expected = expectedWitness(witness(node), witness(fragment), mode);
    const addedFormat = formatWitness(fragment, true);
    const expectedFormat = mode === 'replace' ? addedFormat : [...formatWitness(node), ...addedFormat];
    const transaction = trackInsertion(node);
    const usePaste = context.v2 || generic;
    let method = usePaste ? 'paste' : 'execCommand';
    pending = true;
    try {
      if (mode === 'replace' && before === cleanHtml) {
        await verifyInsertion(node, expected, expectedFormat, transaction);
        return { ok: true, changed: false, domVerified: true, formatVerified: true, saved: false, reason: '正文内容及排版相同，无需重复写入。' };
      }
      if (!selectBody(node, mode)) throw editorError('EDITOR_NOT_SUPPORTED', '无法定位正文选区，请复制排版结果后手动粘贴。');
      let pasteDispatched = false;
      if (usePaste) {
        try {
          const view = doc.defaultView;
          const clipboard = new view.DataTransfer();
          clipboard.setData('text/html', cleanHtml);
          clipboard.setData('text/plain', holder.textContent || '');
          const event = new view.ClipboardEvent('paste', { bubbles: true, cancelable: true, composed: true, clipboardData: clipboard });
          pasteDispatched = true;
          transaction.run(() => node.dispatchEvent(event));
        } catch { /* Unsupported synthetic paste can only try native insert once. */ }
        // Some importers neither preventDefault nor update the DOM immediately.
        // Once dispatched, paste is the only write path for this operation.
        await wait(doc, 75);
      }
      if (transaction.externalEdit) throw editorError('EDITOR_CHANGED', '等待粘贴时检测到其他编辑，已停止自动写入，请检查正文。');
      if (!node.isConnected || resolve().node !== node) throw editorError('EDITOR_CHANGED', '正文编辑器已经变化，请重新定位正文后手动粘贴。');
      if (!pasteDispatched && !transaction.readChanges() && node.innerHTML === before && typeof doc.execCommand === 'function') {
        if (!selectionInBody(node)) throw editorError('EDITOR_CHANGED', '正文选区已被移动，已停止自动写入，请重新定位正文后手动粘贴。');
        method = 'execCommand';
        // Selecting again would erase a user's changed selection. The original
        // body range is retained, and external edit events abort above.
        try { transaction.run(() => doc.execCommand('insertHTML', false, cleanHtml)); }
        catch { /* Never repeat a native command that may already have written. */ }
      }
      if (!usePaste && !transaction.readChanges() && node.innerHTML === before) {
        method = 'dom';
        transaction.run(() => {
          if (mode === 'replace') node.replaceChildren(fragment);
          else node.appendChild(fragment);
        });
      }
      if (method !== 'paste' && transaction.readChanges()) transaction.run(() => notify(node, 'insertFromPaste'));
      await verifyInsertion(node, expected, expectedFormat, transaction);
      const after = node.innerHTML;
      remember(node, before, after);
      return { ok: true, changed: true, mode, method, domVerified: true, formatVerified: true, saved: false, canUndo: true,
        reason: '已写入当前正文，并核验当前段落及排版样式。请检查效果后保存草稿。' };
    } catch (error) {
      if (transaction.readChanges() || !node.isConnected || node.innerHTML !== before) {
        error.articleChanged = true;
        if (!transaction.externalEdit && node.isConnected) remember(node, before, node.innerHTML);
        else clearHistory();
      }
      throw error;
    } finally {
      transaction.dispose();
      pending = false;
    }
  }

  function focusPasteTarget({ mode = 'append' } = {}) {
    if (pending) throw editorError('INSERT_IN_PROGRESS', '正文正在写入，请等待本次操作完成后再定位。');
    if (!['append', 'replace'].includes(mode)) throw new Error('写入方式只能是追加或替换正文。');
    const { node } = resolve();
    if (!selectBody(node, mode)) throw editorError('EDITOR_NOT_SUPPORTED', '无法定位正文选区，请手动点击正文编辑区。');
    return { ok: true, mode };
  }

  async function undo() {
    if (pending) throw editorError('INSERT_IN_PROGRESS', '正文正在写入，请等待本次操作完成后再撤销。');
    if (!history) throw new Error('没有本工具可撤销的正文写入。');
    const { node } = resolve();
    const record = history;
    if (node !== record.node || !unchanged(record)) throw new Error('正文在写入后已经变化，为避免覆盖后续编辑，已停止撤销。');
    clearHistory();
    const transaction = trackInsertion(node);
    pending = true;
    try {
      transaction.run(() => { node.innerHTML = record.before; notify(node, 'historyUndo'); });
      const now = () => node.ownerDocument.defaultView.performance.now();
      const started = now();
      let stable = 0;
      let samples = 0;
      do {
        if (transaction.externalEdit) throw editorError('EDITOR_CHANGED', '撤销核验期间检测到其他编辑，已停止操作；不会覆盖后续修改。');
        if (!node.isConnected || resolve().node !== node) throw editorError('UNDO_NOT_RETAINED', '撤销时正文编辑器被替换，无法确认结果；请检查正文，未重复撤销。');
        const matches = node.innerHTML === record.before;
        stable = matches ? stable + 1 : 0;
        samples++;
        if (matches && stable >= 2 && now() - started >= 250)
          return { ok: true, undone: true, saved: false, reason: '已核验本工具最近一次正文写入已撤销，尚未保存草稿。' };
        if (samples >= 3 && now() - started >= 1200) break;
        await wait(node.ownerDocument, 75);
      } while (true);
      throw editorError('UNDO_NOT_RETAINED', '编辑器没有保留撤销结果，正文可能仍含本次内容。请先检查正文，未再次恢复或重复写入。');
    } catch (error) {
      error.articleChanged = true;
      throw error;
    } finally {
      transaction.dispose();
      pending = false;
    }
  }

  global.WXArticleEditor = Object.freeze({ inspect, insert, undo, focusPasteTarget, diagnose });
})(globalThis);
