import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

const source = await readFile(new URL('../src/article-format.js', import.meta.url), 'utf8');
function harness(t) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { runScripts: 'outside-only', url: 'https://formatter.invalid/' });
  dom.window.eval(source);
  t.after(() => dom.window.close());
  const inspect = html => {
    const holder = dom.window.document.createElement('div');
    holder.innerHTML = html;
    return holder;
  };
  return { format: dom.window.WXArticleFormat, inspect, window: dom.window };
}
const values = iterable => Array.from(iterable);

test('semantic and document heading markers are recognized before source styles are discarded', t => {
  const { format, inspect } = harness(t);
  const input = `<h1 style="color:purple;font-size:42px">主标题</h1>
    <p role="heading" aria-level="2" style="background:red">语义标题</p>
    <p class="MsoHeading2" style="font-size:16px">Word 标题</p>
    <div data-type="heading1"><div><span>嵌套 AI 标题</span></div></div>
    <p style="mso-outline-level:2">大纲标题</p>
    <p style="color:red;font-size:13px;text-align:center;letter-spacing:10px">普通 AI 正文</p>`;
  const parsed = format.parse({ html: input });
  assert.deepEqual(values(parsed.blocks.map(block => block.kind)), ['heading', 'heading', 'heading', 'heading', 'heading', 'paragraph']);
  assert(parsed.blocks.every(block => !/style=|class=|aria-level=/.test(block.html)));
  const rendered = format.render(parsed.blocks);
  const result = inspect(rendered.html);
  assert.equal(result.querySelectorAll('p[data-wxaf-kind="heading"]').length, 5);
  assert.equal(result.querySelectorAll('h1,h2,h3').length, 0);
  for (const paragraph of result.querySelectorAll('p[data-wxaf-kind="heading"]')) {
    const heading = paragraph.querySelector('span');
    assert.equal(paragraph.style.backgroundColor, '');
    assert.equal(paragraph.style.padding, '');
    assert.equal(paragraph.style.textAlign, 'left');
    assert.equal(paragraph.style.marginBottom, '24px');
    assert.equal(heading.style.fontSize, '20px');
    assert.equal(heading.style.color, 'rgb(255, 255, 255)');
    assert.equal(heading.style.backgroundColor, 'rgb(255, 138, 0)');
    assert.equal(heading.style.fontWeight, '400');
    assert.equal(heading.style.display, '');
    assert.equal(heading.style.width, '');
    assert.equal(heading.style.padding, '');
  }
  const paragraph = result.querySelector('p[data-wxaf-kind="paragraph"]');
  assert.equal(paragraph.style.fontSize, '16px');
  assert.equal(paragraph.style.marginBottom, '24px');
  assert.equal(paragraph.style.textAlign, 'justify');
  assert.equal(paragraph.style.fontWeight, '400');
  assert.equal(paragraph.style.color, 'rgb(51, 51, 51)');
  assert.equal(paragraph.textContent, '普通AI正文');
  assert(!rendered.html.includes('purple'));
  assert.equal(rendered.stats.headings, 5);
});

test('a semantic heading survives a single neutral nested wrapper without promoting all multi-paragraph containers', t => {
  const { format } = harness(t);
  const single = format.parse({ html: '<h2><div>小标题</div></h2><div data-block-type="heading-2"><section><p>嵌套标题</p></section></div>' });
  assert.deepEqual(values(single.blocks.map(block => block.kind)), ['heading', 'heading']);
  const multiple = format.parse({ html: '<div class="title"><div>第一段</div><div>第二段</div></div>' });
  assert.deepEqual(values(multiple.blocks.map(block => block.kind)), ['paragraph', 'paragraph']);
});

test('short all-bold and visibly large paragraphs become editable heuristic headings with a warning', t => {
  const { format } = harness(t);
  const parsed = format.parse({ html: `<p><b>第一节</b><strong> 开始</strong></p>
    <p><span style="font-size:18pt">第二节</span></p>
    <p><strong>重点</strong>与普通正文</p>
    <p><strong>${'很长的正文'.repeat(20)}</strong></p>` });
  assert.deepEqual(values(parsed.blocks.map(block => block.kind)), ['heading', 'heading', 'paragraph', 'paragraph']);
  assert(parsed.warnings.some(warning => /2 个短段落/.test(warning)));
  parsed.blocks[0].kind = 'paragraph';
  const rendered = format.render(parsed.blocks);
  const roundTrip = format.parse({ html: rendered.html });
  assert.equal(roundTrip.blocks[0].kind, 'paragraph', 'manual heading correction survives a later formatting pass');
});

test('uniform large body text does not make every shorter paragraph a heading', t => {
  const { format } = harness(t);
  const parsed = format.parse({ html: `<p style="font-size:20px">${'正文内容'.repeat(30)}</p><p style="font-size:20px">短正文</p><p style="font-size:26px">真正大字号</p>` });
  assert.deepEqual(values(parsed.blocks.map(block => block.kind)), ['paragraph', 'paragraph', 'heading']);
});

test('Han-Latin and Han-number horizontal gaps are removed across inline nodes while English word spacing remains', t => {
  const { format } = harness(t);
  const parsed = format.parse({ html: '<p>中文 <strong>AI</strong> <em>模型</em>&nbsp;<span>2026</span> 版本。Open AI keeps spaces。</p><p>中<span> </span><a href="https://example.com">A</a><em> </em>文</p><p>中文　AI\t模型</p>' });
  assert.deepEqual(values(parsed.blocks.map(block => block.text)), [
    '中文AI模型2026版本。Open AI keeps spaces。', '中A文', '中文AI模型',
  ]);
  assert(parsed.blocks[1].html.includes('href="https://example.com"'));
  assert(!parsed.blocks[1].html.includes('<em></em>'));
});

test('cross-node spacing never joins different paragraphs or crosses line breaks', t => {
  const { format } = harness(t);
  const parsed = format.parse({ html: '<p>中文 </p><p>AI 模型</p><p>中文<br> AI</p><p>中文\nAI</p>' });
  assert.equal(parsed.blocks.length, 4);
  assert.equal(parsed.blocks[0].text, '中文 ');
  assert.equal(parsed.blocks[1].text, 'AI模型');
  assert.equal(parsed.blocks[2].text, '中文\n AI');
  assert.equal(parsed.blocks[3].text, '中文\nAI');
});

test('code and URL spacing is preserved, including URLs broken across inline nodes', t => {
  const { format, inspect } = harness(t);
  const parsed = format.parse({ html: '<p>代码 <code>中文 AI 2026</code> 保持</p><pre>const 名称 = "中文 AI";\n  return Open AI;</pre><p>中文 <span>https://example.</span><strong>com/a</strong> 中文</p><p><a href="https://example.com/?q=中文%20AI">https://example.com/a 中文</a></p>' });
  assert.equal(parsed.blocks[0].text, '代码 中文 AI 2026 保持');
  assert.equal(parsed.blocks[1].text, 'const 名称 = "中文 AI";\n  return Open AI;');
  assert.equal(parsed.blocks[2].text, '中文 https://example.com/a 中文');
  assert.equal(parsed.blocks[3].text, 'https://example.com/a 中文');
  const output = inspect(format.render(parsed.blocks).html);
  assert.equal(output.querySelector('code').style.whiteSpace, 'pre-wrap');
  assert.equal(output.querySelector('a').getAttribute('href'), 'https://example.com/?q=中文%20AI');
});

test('videos, video frames and explicit placeholders each become a single blank paragraph; ordinary links survive', t => {
  const { format, inspect } = harness(t);
  const parsed = format.parse({ html: `<p>开头</p><video src="https://example.com/video.mp4"><source src="fallback.mp4"></video>
    <iframe class="video_iframe" src="https://v.qq.com/iframe/player.html?vid=1"></iframe>
    <div data-type="video"><span>播放器说明</span></div><p>[视频占位符]</p>
    <p><a href="https://v.qq.com/x/page/1.html">视频链接</a></p><p>请看这个视频</p><p>结尾</p>` });
  assert.deepEqual(values(parsed.blocks.map(block => block.kind)), ['paragraph', 'video', 'video', 'video', 'video', 'paragraph', 'paragraph', 'paragraph']);
  const rendered = format.render(parsed.blocks);
  const output = inspect(rendered.html);
  assert.equal(output.querySelectorAll('[data-wxaf-kind="video"]').length, 4);
  for (const slot of output.querySelectorAll('[data-wxaf-kind="video"]')) {
    assert.equal(slot.innerHTML, '<br>');
    assert.equal(slot.children.length, 1);
  }
  assert.equal(output.querySelectorAll('video,iframe,source').length, 0);
  assert.equal(output.querySelector('a').textContent, '视频链接');
  assert(output.textContent.includes('请看这个视频'));
  assert.equal(rendered.stats.videos, 4);
});

test('unknown frames and active components are removed without turning normal text into a video', t => {
  const { format } = harness(t);
  const parsed = format.parse({ html: '<p>前文</p><iframe src="https://maps.example.com/embed"></iframe><object data="https://example.com/widget"></object><p>后文</p>' });
  assert.deepEqual(values(parsed.blocks.map(block => block.text)), ['前文', '后文']);
  assert(parsed.warnings.some(warning => warning.includes('不支持的嵌入内容')));
});

test('safe images retain src and alt at nested positions and receive only the fixed responsive style', t => {
  const { format, inspect } = harness(t);
  const parsed = format.parse({ html: '<div>前文<span><img src="https://images.example.com/a.png" alt="第一张" onerror="steal()" style="width:2000px;position:fixed"></span><div><p>中间</p><img data-src="https://images.example.com/b.jpg" alt="第二张"></div>后文</div>' });
  assert.deepEqual(values(parsed.blocks.map(block => block.kind)), ['paragraph', 'image', 'paragraph', 'image', 'paragraph']);
  assert.deepEqual(values(parsed.blocks.map(block => block.text)), ['前文', '第一张', '中间', '第二张', '后文']);
  const output = inspect(format.render(parsed.blocks).html);
  const images = [...output.querySelectorAll('img')];
  assert.deepEqual(images.map(image => image.getAttribute('src')), ['https://images.example.com/a.png', 'https://images.example.com/b.jpg']);
  for (const image of images) {
    assert.equal(image.style.maxWidth, '100%');
    assert.equal(image.style.height, 'auto');
    assert.equal(image.hasAttribute('onerror'), false);
    assert.equal(image.hasAttribute('data-src'), false);
    assert.equal(image.style.position, '');
  }
});

test('raster data images are retained; SVG data, script and local file addresses are removed with usable alt text', t => {
  const { format, inspect } = harness(t);
  const parsed = format.parse({ html: '<img src="data:image/png;base64,aGVsbG8=" alt="数据图片"><img src="data:image/svg+xml;base64,PHN2Zz4=" alt="SVG 替代"><img src="javascript:alert(1)" alt="非法地址"><img src="file:///private/photo.jpg" alt="本机图片">' });
  assert.equal(parsed.blocks.filter(block => block.kind === 'image').length, 1);
  assert(parsed.blocks.some(block => block.text === 'SVG替代'));
  assert(parsed.blocks.some(block => block.text === '非法地址'));
  assert(parsed.warnings.some(warning => warning.includes('图片地址')));
  const output = inspect(format.render(parsed.blocks).html);
  assert.equal(output.querySelectorAll('img').length, 1);
  assert.equal(output.querySelector('img').getAttribute('src'), 'data:image/png;base64,aGVsbG8=');
});

test('relative media, credential URLs and embedded whitespace in data images are rejected before preview', t => {
  const { format, inspect } = harness(t);
  const parsed = format.parse({ html: '<img src="/relative.png" alt="相对图片"><img src="//example.com/protocol-relative.png" alt="协议相对"><img src="https://user:password@example.com/secret.png" alt="凭证图片"><img src="data:image/png;base64,aGVs bG8=" alt="空白数据"><img src="data:image/bmp;base64,aGVsbG8=" alt="BMP"><p><a href="https://user:password@example.com/">凭证链接</a><a href="/relative">相对链接</a></p>' });
  const output = inspect(format.render(parsed.blocks).html);
  assert.equal(output.querySelectorAll('img').length, 1);
  assert.equal(output.querySelector('img').getAttribute('src'), 'data:image/bmp;base64,aGVsbG8=');
  assert.equal(output.querySelectorAll('a').length, 0);
  assert(output.textContent.includes('相对图片'));
  assert(output.textContent.includes('凭证链接相对链接'));
  assert(parsed.warnings.some(warning => warning.includes('图片地址')));
});

test('original bold, italic, underline and strike formatting is cleared after heading detection', t => {
  const { format, inspect } = harness(t);
  const parsed = format.parse({ html: '<p><strong>原来全粗体标题</strong></p><p><b>粗体片段</b>和<i>斜体片段</i>、<u>下划线</u>、<strike>删除线</strike>，H<sub>2</sub>O 与 x<sup>2</sup>、<code>代码 AI</code></p>' });
  assert.equal(parsed.blocks[0].kind, 'heading');
  const output = inspect(format.render(parsed.blocks).html);
  assert.equal(output.querySelectorAll('strong,b,em,i,u,s,strike,del').length, 0);
  assert(output.textContent.includes('粗体片段和斜体片段、下划线、删除线'));
  assert.equal(output.querySelector('sub').textContent, '2');
  assert.equal(output.querySelector('sup').textContent, '2');
  assert.equal(output.querySelector('code').textContent, '代码 AI');
});

test('nested divs, list item paragraphs and table cells retain their text and order', t => {
  const { format, inspect } = harness(t);
  const parsed = format.parse({ html: '<div>前言<div><p>内层第一段</p><div>内层第二段</div></div>尾注</div><ul><li><p>列表一</p><ul><li>嵌套列表</li></ul></li><li>列表二</li></ul><ol start="3"><li><p>第三项</p></li></ol><table><tbody><tr><th>名称</th><th>说明</th></tr><tr><td rowspan="2">中文 AI</td><td><p>第一段</p><p>第二段</p><img src="https://example.com/t.png" alt="表格图片"></td></tr><tr><td>最后一格</td></tr></tbody></table>' });
  assert.deepEqual(values(parsed.blocks.slice(0, 4).map(block => block.text)), ['前言', '内层第一段', '内层第二段', '尾注']);
  assert(parsed.blocks.some(block => block.text === '• 列表一'));
  assert(parsed.blocks.some(block => block.text === '• 嵌套列表'));
  assert(parsed.blocks.some(block => block.text === '• 列表二'));
  assert(parsed.blocks.some(block => block.text === '3. 第三项'));
  const rendered = format.render(parsed.blocks);
  const output = inspect(rendered.html);
  assert.equal(output.querySelectorAll('table').length, 1);
  assert.equal(output.querySelectorAll('tr').length, 3);
  assert.equal(output.querySelector('td').getAttribute('rowspan'), '2');
  assert(output.querySelector('table').textContent.includes('中文AI'));
  assert(output.querySelector('table').textContent.includes('第一段第二段'));
  assert(rendered.text.includes('名称\t说明'));
  assert(rendered.text.includes('最后一格'));
  assert.equal(rendered.stats.tables, 1);
  assert.equal(rendered.stats.images, 1);
});

test('unsafe source content is never executed or retained, and render also sanitizes caller-supplied blocks', t => {
  const { format, inspect, window } = harness(t);
  const input = '<script>window.compromised=true</script><style>body{display:none}</style><p onclick="steal()" style="background:url(javascript:bad)"><a href="jav&#x61;script:alert(1)">链接文字</a><svg onload="steal()"><script>bad()</script></svg><form><input value="secret"></form>安全正文</p><a href="data:text/html;base64,PHNjcmlwdD4=">另一链接</a>';
  const parsed = format.parse({ html: input });
  assert.equal(window.compromised, undefined);
  const rendered = format.render([...parsed.blocks, { id: 'injected', kind: 'paragraph', html: '<img src="x" onload="bad()"><iframe srcdoc="<script>bad()</script>"></iframe><a href="vbscript:bad()">保留文字</a>' }], { orange: '#ff8a00;background-image:url(https://bad)' });
  const output = inspect(rendered.html);
  assert.equal(output.querySelectorAll('script,style,iframe,svg,form,input,object,embed').length, 0);
  for (const element of output.querySelectorAll('*')) {
    assert([...element.attributes].every(attribute => !/^on/i.test(attribute.name)));
    assert(!/javascript|vbscript|data:text\/html/i.test(element.getAttribute('href') || ''));
  }
  assert(!/background-image|position:|srcdoc|onclick|onload/.test(rendered.html));
  assert(output.textContent.includes('链接文字安全正文'));
  assert(output.textContent.includes('另一链接'));
  assert(output.textContent.includes('保留文字'));
});

test('safe hyperlinks survive and heading links inherit the required white text color', t => {
  const { format, inspect } = harness(t);
  const rendered = format.render(format.parse({ html: '<h2><a href="https://example.com/path?q=中文%20AI" title="引用">了解 OpenAI</a></h2><p><a href="mailto:user@example.com">邮件</a> <a href="tel:+8612345678">电话</a> <a href="#section">跳转</a></p>' }).blocks, { orange: '#F08000' });
  const output = inspect(rendered.html);
  assert.equal(output.querySelector('p[data-wxaf-kind="heading"] > span').style.backgroundColor, 'rgb(240, 128, 0)');
  assert.equal(output.querySelector('p[data-wxaf-kind="heading"] a').style.color, 'inherit');
  assert.equal(output.querySelector('p[data-wxaf-kind="heading"] a').textContent, '了解OpenAI');
  assert.equal(output.querySelector('p[data-wxaf-kind="heading"] a').getAttribute('title'), '引用');
  assert.equal(output.querySelector('a[href^="mailto:"]').getAttribute('href'), 'mailto:user@example.com');
  assert.equal(output.querySelector('a[href^="tel:"]').getAttribute('href'), 'tel:+8612345678');
  assert.equal(output.querySelector('a[href^="#"]'), null);
  assert(output.textContent.includes('跳转'));
});

test('plain text input keeps its paragraphs and explicit blank lines, and always explains missing-media limitations', t => {
  const { format } = harness(t);
  const parsed = format.parse({ text: '第一段 AI\r\n\r\n第二段 2026\nOpen AI words' });
  assert.deepEqual(values(parsed.blocks.map(block => block.text)), ['第一段AI', '\n', '第二段2026', 'Open AI words']);
  assert.equal(parsed.blocks.length, 4);
  assert(parsed.warnings.some(warning => /无法.*缺失媒体的位置/.test(warning)));
  assert.equal(format.parse().blocks.length, 0);
  assert.equal(format.render([]).stats.blocks, 0);
});

test('formatting is idempotent across headings, inline spacing, media placeholders, images, lists, code and tables', t => {
  const { format } = harness(t);
  const input = '<h2>标题 AI</h2><p>中<span> </span><b>A</b><em> </em>文，Open AI</p><p><code>代码 AI</code></p><ul><li>第一项</li><li>第二项</li></ul><img src="https://example.com/a.png" alt="图片"><p>[视频]</p><table><tbody><tr><td>中文 AI</td><td><a href="https://example.com">引用</a></td></tr></tbody></table>';
  const first = format.render(format.parse({ html: input }).blocks);
  const second = format.render(format.parse({ html: first.html }).blocks);
  assert.equal(second.html, first.html);
  assert.equal(second.text, first.text);
  assert.deepEqual(JSON.parse(JSON.stringify(second.stats)), JSON.parse(JSON.stringify(first.stats)));
});
