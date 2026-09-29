/* Standalone clipboard formatter. It does not read or alter the upload queue. */
(function (global) {
  'use strict';
  const MEDIA_LIMIT = '剪贴板未提供的图片、视频或占位标记无法定位；无法自动推断缺失媒体的位置。';
  const FLOW = new Set(['P', 'DIV', 'SECTION', 'ARTICLE', 'MAIN', 'HEADER', 'FOOTER', 'ASIDE', 'NAV', 'BLOCKQUOTE', 'FIGURE', 'FIGCAPTION', 'LI', 'UL', 'OL', 'DL', 'DT', 'DD', 'PRE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HR']);
  const INLINE = new Map([['SUB', 'sub'], ['SUP', 'sup'], ['CODE', 'code']]);
  const DROP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'MATH', 'OBJECT', 'EMBED', 'APPLET', 'LINK', 'META', 'BASE', 'FORM', 'INPUT', 'BUTTON', 'SELECT', 'TEXTAREA', 'CANVAS', 'AUDIO']);
  const TABLE = new Set(['TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'TD', 'TH', 'CAPTION', 'COLGROUP', 'COL']);
  const HORIZONTAL = '[\\t \\u00a0\\u1680\\u2000-\\u200a\\u202f\\u205f\\u3000]+';
  const JOIN = new RegExp(`([\\p{Script=Han}])(${HORIZONTAL})(?=[\\p{Script=Latin}\\p{N}])|([\\p{Script=Latin}\\p{N}])(${HORIZONTAL})(?=[\\p{Script=Han}])`, 'gu');
  const VIDEO_CLASSES = /(?:^|\s)(?:video_iframe|video-placeholder|video-container|video-wrapper|wx_video|js_video|rich_media_video)(?:\s|$)/i;
  const VIDEO_TEXT = /^(?:\[视频(?:占位(?:符)?)?(?:[:：][^\]\n]{1,100})?\]|【视频(?:占位(?:符)?)?(?:[:：][^】\n]{1,100})?】)$/;

  function context() {
    if (!global.document?.implementation) throw new Error('文章排版需要浏览器文档环境。');
    return { doc: global.document.implementation.createHTMLDocument(''), warnings: new Set([MEDIA_LIMIT]), heuristic: 0 };
  }

  function safeURL(value, image = false) {
    if (typeof value !== 'string') return null;
    const url = value.trim();
    if (!url || /[\u0000-\u001f\u007f]/.test(url)) return null;
    if (image && /^data:image\/(?:png|jpe?g|gif|webp|avif|bmp);base64,[A-Za-z0-9+/]+={0,2}$/i.test(url)) return url;
    try {
      const parsed = new URL(url);
      if (parsed.username || parsed.password) return null;
      if ((/^https?:\/\//i.test(url) && ['http:', 'https:'].includes(parsed.protocol)) || (!image && ['mailto:', 'tel:'].includes(parsed.protocol))) return url;
    } catch { /* Invalid URLs are never copied into the result. */ }
    return null;
  }

  function videoURL(value) {
    const safe = safeURL(value);
    if (!safe) return false;
    try {
      const url = new URL(safe, 'https://clipboard.invalid/');
      const host = url.hostname.toLowerCase();
      return /^(?:v|video)\.qq\.com$|^player\.youku\.com$|^player\.bilibili\.com$|^player\.vimeo\.com$|^(?:www\.)?youtube(?:-nocookie)?\.com$|^youtu\.be$/.test(host) ||
        (host === 'mp.weixin.qq.com' && /video[_/-]?player|video_player_tmpl/i.test(url.pathname + url.search)) ||
        /\.(?:mp4|m4v|mov|webm|ogv)$/i.test(url.pathname);
    } catch { return false; }
  }

  function isVideo(element) {
    if (element.nodeType !== 1 || element.tagName === 'A') return false;
    const tag = element.tagName;
    if (['VIDEO', 'MP-VIDEO', 'MPVIDEO', 'WX-VIDEO', 'QQVIDEO'].includes(tag)) return true;
    if (element.getAttribute('data-wxaf-kind') === 'video') return true;
    const type = [element.getAttribute('data-type'), element.getAttribute('data-block-type'), element.getAttribute('data-node-type')].filter(Boolean).join(' ');
    const marked = /(?:^|\s)video(?:\s|$)/i.test(type) || VIDEO_CLASSES.test(element.className || '') || element.hasAttribute('data-video-id') || element.hasAttribute('data-videoid');
    if (marked) return true;
    if (tag === 'IFRAME') return videoURL(element.getAttribute('src') || element.getAttribute('data-src')) || element.hasAttribute('data-vid');
    if (['EMBED', 'OBJECT', 'SOURCE'].includes(tag)) return /^video\//i.test(element.getAttribute('type') || '') || videoURL(element.getAttribute('src') || element.getAttribute('data'));
    return FLOW.has(tag) && VIDEO_TEXT.test(element.textContent.trim()) && !element.querySelector('img,table,a');
  }

  function cleanImage(element, ctx) {
    const values = ['src', 'data-src', 'data-original', 'data-lazy-src'].map(name => element.getAttribute(name));
    const src = values.map(value => safeURL(value, true)).find(Boolean);
    if (!src) {
      ctx.warnings.add('部分图片地址不安全或无法使用，已移除地址；可用的替代文字仍会保留。');
      return ctx.doc.createTextNode(element.getAttribute('alt') || '');
    }
    const image = ctx.doc.createElement('img');
    image.setAttribute('src', src);
    image.setAttribute('alt', element.getAttribute('alt') || '');
    return image;
  }

  function inlineShell(element, ctx) {
    if (INLINE.has(element.tagName)) return ctx.doc.createElement(INLINE.get(element.tagName));
    if (element.tagName !== 'A') return null;
    const href = safeURL(element.getAttribute('href'));
    if (!href) {
      if (element.hasAttribute('href')) ctx.warnings.add('部分链接地址不安全或无效，已保留文字并移除链接。');
      return null;
    }
    const anchor = ctx.doc.createElement('a');
    anchor.setAttribute('href', href);
    if (element.getAttribute('title')) anchor.setAttribute('title', element.getAttribute('title'));
    return anchor;
  }

  function sanitize(node, ctx) {
    if (node.nodeType === 3) return ctx.doc.createTextNode(node.data);
    const out = ctx.doc.createDocumentFragment();
    if (node.nodeType !== 1 && node.nodeType !== 11) return out;
    if (node.nodeType === 1) {
      if (node.namespaceURI !== 'http://www.w3.org/1999/xhtml') {
        ctx.warnings.add('已移除脚本、交互控件及不支持的嵌入内容。');
        return out;
      }
      if (isVideo(node)) return ctx.doc.createElement('br');
      if (node.tagName === 'IFRAME' || DROP.has(node.tagName)) {
        ctx.warnings.add('已移除脚本、交互控件及不支持的嵌入内容。');
        return out;
      }
      if (node.tagName === 'IMG') return cleanImage(node, ctx);
      if (node.tagName === 'BR') return ctx.doc.createElement('br');
      let shell = inlineShell(node, ctx);
      if (TABLE.has(node.tagName)) {
        shell = ctx.doc.createElement(node.tagName.toLowerCase());
        if (['TD', 'TH'].includes(node.tagName)) {
          for (const attribute of ['colspan', 'rowspan']) {
            const value = node.getAttribute(attribute);
            if (/^[1-9]\d{0,2}$/.test(value || '')) shell.setAttribute(attribute, value);
          }
        }
      }
      if (node.tagName === 'PRE') shell = ctx.doc.createElement('code');
      const target = shell || out;
      for (const child of node.childNodes) {
        if (child.nodeType === 1 && FLOW.has(child.tagName) && target.childNodes.length && target.lastChild?.nodeName !== 'BR') target.append(ctx.doc.createElement('br'));
        target.append(sanitize(child, ctx));
      }
      return shell || out;
    }
    for (const child of node.childNodes) out.append(sanitize(child, ctx));
    return out;
  }

  function normalizeSpacing(root) {
    const spans = [];
    let text = '';
    function visit(node, protectedText = false) {
      if (node.nodeType === 3) {
        const start = text.length;
        text += node.data;
        spans.push({ node, start, end: text.length, protectedText });
        return;
      }
      if (node.nodeType === 1 && ['BR', 'IMG'].includes(node.tagName)) { text += '\n'; return; }
      const protectedNext = protectedText || (node.nodeType === 1 && ['CODE', 'PRE'].includes(node.tagName));
      const boundary = node.nodeType === 1 && ['TD', 'TH', 'TR', 'TABLE', 'CAPTION'].includes(node.tagName);
      if (boundary) text += '\n';
      for (const child of node.childNodes || []) visit(child, protectedNext);
      if (boundary) text += '\n';
    }
    visit(root);
    const protectedIndexes = new Set();
    for (const span of spans) if (span.protectedText) for (let index = span.start; index < span.end; index++) protectedIndexes.add(index);
    for (const match of text.matchAll(/(?:https?:\/\/|mailto:|www\.)[^\s<>]+/gi)) {
      for (let index = match.index; index < match.index + match[0].length; index++) protectedIndexes.add(index);
    }
    const remove = new Set();
    for (const match of text.matchAll(JOIN)) {
      const prefix = match[1] || match[3];
      const whitespace = match[2] || match[4];
      const start = match.index + prefix.length;
      const end = start + whitespace.length;
      if (protectedIndexes.has(start - 1) || protectedIndexes.has(end)) continue;
      for (let index = start; index < end; index++) if (!protectedIndexes.has(index)) remove.add(index);
    }
    for (const span of spans) {
      let value = '';
      for (let index = span.start; index < span.end; index++) if (!remove.has(index)) value += text[index];
      span.node.data = value;
    }
    for (const inline of [...root.querySelectorAll('strong,em,u,s,sub,sup,code,a')].reverse()) {
      if (inline.textContent === '' && !inline.querySelector('img,br')) inline.remove();
    }
  }

  function fontSize(element) {
    for (let current = element; current?.nodeType === 1; current = current.parentElement) {
      const value = current.style?.fontSize || (current.tagName === 'FONT' ? current.getAttribute('size') : '');
      const match = /^(\d+(?:\.\d+)?)(px|pt)$/i.exec(value || '');
      if (match) return Number(match[1]) * (match[2].toLowerCase() === 'pt' ? 4 / 3 : 1);
    }
    return 16;
  }

  function bold(element) {
    for (let current = element; current?.nodeType === 1; current = current.parentElement) {
      const value = current.style?.fontWeight;
      if (value) return value === 'bold' || value === 'bolder' || Number(value) >= 600;
      if (['B', 'STRONG'].includes(current.tagName)) return true;
    }
    return false;
  }

  function headingKind(element, ctx, baseline) {
    const ownKind = element.getAttribute('data-wxaf-kind');
    if (ownKind === 'paragraph') return 'paragraph';
    if (ownKind === 'heading' || /^H[1-6]$/.test(element.tagName) || element.getAttribute('role')?.toLowerCase() === 'heading') return 'heading';
    const markers = ['class', 'data-type', 'data-block-type', 'data-node-type', 'data-custom-style', 'data-style-name'].map(name => element.getAttribute(name) || '').join(' ');
    const semantic = /(?:^|\s)(?:Mso(?:Title|Subtitle|Heading\d*)|heading(?:[-_ ]?[1-6])?|title|subtitle|标题(?:[一二三四五六1-6])?)(?:\s|$)/i.test(markers) ||
      /mso-outline-level\s*:\s*[1-9](?:\s*[;"']|\s*$)/i.test(element.getAttribute('style') || '');
    if (semantic) return 'heading';
    const text = element.textContent.trim();
    if (!text || [...text].length > 64 || /[\r\n]/.test(text) || element.querySelector('br,img,video,iframe,table,pre,code') ||
        [...element.querySelectorAll('*')].some(child => FLOW.has(child.tagName))) return 'paragraph';
    const meaningful = [];
    const walker = element.ownerDocument.createTreeWalker(element, 4);
    while (walker.nextNode()) if (walker.currentNode.data.trim()) meaningful.push(walker.currentNode);
    if (meaningful.length && (meaningful.every(node => bold(node.parentElement)) || meaningful.every(node => fontSize(node.parentElement) >= Math.max(20, baseline * 1.2)))) {
      ctx.heuristic++;
      return 'heading';
    }
    return 'paragraph';
  }

  function plainText(node) {
    if (node.nodeType === 3) return node.data;
    if (node.nodeType === 1 && node.tagName === 'BR') return '\n';
    if (node.nodeType === 1 && node.tagName === 'IMG') return node.getAttribute('alt') || '';
    if (node.nodeType === 1 && node.tagName === 'TABLE') {
      return [...node.rows].map(row => [...row.cells].map(cell => [...cell.childNodes].map(plainText).join('')).join('\t')).join('\n');
    }
    return [...(node.childNodes || [])].map(plainText).join('');
  }

  function parse({ html = '', text = '' } = {}) {
    const ctx = context();
    const source = ctx.doc.createElement('div');
    const blocks = [];
    if (typeof html === 'string' && html.trim()) source.innerHTML = html;
    else {
      if (!String(text || '').length) return { blocks, warnings: [...ctx.warnings] };
      for (const line of String(text || '').replace(/\r\n?/g, '\n').split('\n')) {
        const paragraph = ctx.doc.createElement('p');
        paragraph.textContent = line;
        if (!line) paragraph.append(ctx.doc.createElement('br'));
        source.append(paragraph);
      }
    }
    const longParagraphs = [...source.querySelectorAll('p,li')].filter(node => node.textContent.trim().length >= 80);
    const sizes = longParagraphs.map(fontSize).sort((a, b) => a - b);
    const baseline = sizes.length ? sizes[Math.floor(sizes.length / 2)] : 16;
    function add(kind, fragment) {
      const holder = ctx.doc.createElement('div');
      holder.append(fragment);
      normalizeSpacing(holder);
      if (!holder.textContent.trim() && !holder.querySelector('img,br,table') && kind !== 'video') return;
      blocks.push({ id: `block-${blocks.length + 1}`, kind, html: holder.innerHTML, text: plainText(holder) });
    }
    function flow(container, defaultKind = 'paragraph', wrappers = []) {
      let buffer = ctx.doc.createDocumentFragment();
      const flush = () => {
        if (buffer.childNodes.length) add(defaultKind, buffer);
        buffer = ctx.doc.createDocumentFragment();
      };
      const append = (node, shells) => {
        let wrapped = node;
        for (let index = shells.length - 1; index >= 0; index--) {
          const copy = shells[index].cloneNode(false);
          copy.append(wrapped);
          wrapped = copy;
        }
        buffer.append(wrapped);
      };
      function child(node, shells) {
        if (node.nodeType === 3) { append(ctx.doc.createTextNode(node.data), shells); return; }
        if (node.nodeType !== 1) return;
        if (node.namespaceURI !== 'http://www.w3.org/1999/xhtml') {
          ctx.warnings.add('已移除脚本、交互控件及不支持的嵌入内容。');
          return;
        }
        if (isVideo(node)) { flush(); add('video', ctx.doc.createElement('br')); return; }
        if (node.tagName === 'IFRAME' || DROP.has(node.tagName)) {
          ctx.warnings.add('已移除脚本、交互控件及不支持的嵌入内容。');
          return;
        }
        if (node.tagName === 'IMG') {
          flush();
          const image = cleanImage(node, ctx);
          add(image.nodeType === 1 ? 'image' : 'paragraph', image);
          return;
        }
        if (node.tagName === 'TABLE') { flush(); add('table', sanitize(node, ctx)); return; }
        if (FLOW.has(node.tagName)) {
          flush();
          if (node.tagName === 'HR') { add('paragraph', ctx.doc.createElement('br')); return; }
          const singleChild = [...container.childNodes].filter(entry => entry.nodeType === 1 || (entry.nodeType === 3 && entry.data.trim())).length === 1;
          const inheritHeading = defaultKind === 'heading' && singleChild && ['DIV', 'SECTION', 'P'].includes(node.tagName) && node.getAttribute('data-wxaf-kind') !== 'paragraph';
          const kind = inheritHeading ? 'heading' : headingKind(node, ctx, baseline);
          const codeShell = node.tagName === 'PRE' ? [ctx.doc.createElement('code')] : shells;
          let bullet = '';
          if (node.tagName === 'LI') {
            const parent = node.parentElement;
            const index = [...(parent?.children || [])].filter(sibling => sibling.tagName === 'LI').indexOf(node);
            const start = /^\d+$/.test(parent?.getAttribute('start') || '') ? Number(parent.getAttribute('start')) : 1;
            bullet = parent?.tagName === 'OL' ? `${start + index}. ` : '• ';
          }
          const before = blocks.length;
          flow(node, kind, codeShell);
          if (bullet) {
            const first = blocks.slice(before).find(block => ['paragraph', 'heading'].includes(block.kind));
            if (first) {
              const marked = ctx.doc.createElement('div');
              marked.innerHTML = first.html;
              marked.prepend(ctx.doc.createTextNode(bullet));
              first.html = marked.innerHTML;
              first.text = plainText(marked);
            }
          }
          return;
        }
        if (node.tagName === 'BR') { append(ctx.doc.createElement('br'), shells); return; }
        const shell = inlineShell(node, ctx);
        for (const descendant of node.childNodes) child(descendant, shell ? [...shells, shell] : shells);
      }
      for (const node of container.childNodes) child(node, wrappers);
      flush();
    }
    flow(source);
    if (ctx.heuristic) ctx.warnings.add(`${ctx.heuristic} 个短段落根据全粗体或明显较大字号识别为小标题，可手动调整。`);
    return { blocks, warnings: [...ctx.warnings] };
  }

  function render(blocks, { orange = '#ff8a00' } = {}) {
    const ctx = context();
    const color = /^#[0-9a-f]{6}$/i.test(orange) ? orange.toLowerCase() : '#ff8a00';
    const article = ctx.doc.createElement('section');
    article.setAttribute('data-wxaf-article', '1');
    article.setAttribute('style', 'font-size:16px;font-weight:400;font-style:normal;color:#333333;text-align:justify;');
    const stats = { blocks: 0, headings: 0, paragraphs: 0, images: 0, videos: 0, tables: 0, characters: 0 };
    const textParts = [];
    const paragraphStyle = 'margin:0 0 24px;font-size:16px;font-weight:400;font-style:normal;color:#333333;text-decoration:none;line-height:1.75;text-align:justify;';
    for (const block of Array.isArray(blocks) ? blocks : []) {
      if (!block || typeof block !== 'object') continue;
      const kind = ['heading', 'paragraph', 'image', 'video', 'table'].includes(block.kind) ? block.kind : 'paragraph';
      const raw = ctx.doc.createElement('div');
      if (typeof block.html === 'string') raw.innerHTML = block.html;
      else raw.textContent = typeof block.text === 'string' ? block.text : '';
      const clean = ctx.doc.createElement('div');
      for (const child of raw.childNodes) clean.append(sanitize(child, ctx));
      normalizeSpacing(clean);
      let output;
      if (kind === 'video') {
        output = ctx.doc.createElement('p');
        output.append(ctx.doc.createElement('br'));
        output.setAttribute('style', paragraphStyle);
        stats.videos++;
      } else if (kind === 'table' && clean.querySelector('table')) {
        output = clean.querySelector('table');
        output.setAttribute('style', 'margin:0 0 24px;width:100%;border-collapse:collapse;font-size:16px;font-weight:400;font-style:normal;color:#333333;line-height:1.75;text-align:justify;');
        for (const cell of output.querySelectorAll('td,th')) cell.setAttribute('style', 'padding:8px;border:1px solid #dddddd;font-size:16px;font-weight:400;font-style:normal;color:#333333;text-align:justify;');
        stats.tables++;
      } else {
        output = ctx.doc.createElement('p');
        output.setAttribute('style', kind === 'heading'
          ? paragraphStyle.replace('text-align:justify;', 'text-align:left;text-align-last:auto;')
          : paragraphStyle);
        // The editor's text-color and highlight tools operate on inline marks.
        // Keep the paragraph transparent; never leave an orange block behind
        // when the user recolors, resizes or clears the selected heading text.
        const text = kind === 'heading' ? ctx.doc.createElement('span') : output;
        if (kind === 'heading') {
          text.setAttribute('style', `font-size:20px;color:#ffffff;background-color:${color};font-weight:400;font-style:normal;text-decoration:none;`);
          output.append(text);
        }
        while (clean.firstChild) text.append(clean.firstChild);
        if (!text.childNodes.length) text.append(ctx.doc.createElement('br'));
        if (kind === 'heading') stats.headings++;
        else if (kind !== 'image') stats.paragraphs++;
      }
      output.setAttribute('data-wxaf-kind', kind);
      for (const image of output.querySelectorAll('img')) image.setAttribute('style', 'max-width:100%;height:auto;');
      for (const code of output.querySelectorAll('code')) code.setAttribute('style', 'white-space:pre-wrap;');
      if (kind === 'heading') for (const anchor of output.querySelectorAll('a')) anchor.setAttribute('style', 'color:inherit;text-decoration:underline;');
      stats.images += output.querySelectorAll('img').length;
      const plain = kind === 'video' ? '' : plainText(output);
      textParts.push(plain);
      stats.characters += [...plain].length;
      stats.blocks++;
      article.append(output);
    }
    return { html: article.outerHTML, text: textParts.join('\n\n'), stats };
  }

  global.WXArticleFormat = Object.freeze({ parse, render });
})(globalThis);
