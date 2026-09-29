/* Page-only adapter. Uses the existing WeChat form; never calls upload APIs. */
(() => {
  'use strict';
  if (globalThis.WXVideoAdapter) return;

  const MAX_CHUNK = 512 * 1024;
  const COVER_WAIT = 60000;
  const ORIGINAL_DIALOG_GRACE = 1500;
  const ORIGINAL_RULES = '微信公众平台原创声明及相关功能使用协议';
  let transfer = null;
  let observation = null;
  const documentHidden = () => document.hidden === true || document.visibilityState === 'hidden';
  const pageVisibility = () => ({ documentHidden: documentHidden(), visibilityState: document.visibilityState || 'unknown' });
  // UI callbacks can pause while Chrome keeps the upload tab hidden. Count
  // short form deadlines only while visible; the transport still bounds the
  // entire upload. The click checkpoints remain intact throughout the wait.
  function updateWaitBudget(budget, now, hidden, visibilityBoundary = false) {
    if (!budget.lastHidden && (!hidden || visibilityBoundary)) budget.visibleElapsed += Math.max(0, now - budget.lastAt);
    budget.lastAt = now;
    budget.lastHidden = hidden;
    return budget.visibleElapsed;
  }
  function visibleWait(flow, phase) {
    const now = Date.now();
    const hidden = documentHidden();
    flow.waitBudgets ||= {};
    const budget = flow.waitBudgets[phase] ||= { lastAt: flow[phase] ?? now, lastHidden: hidden, visibleElapsed: 0 };
    return updateWaitBudget(budget, now, hidden);
  }
  function beginWait(flow, phase) {
    flow[phase] = Date.now();
    visibleWait(flow, phase);
  }
  document.addEventListener('visibilitychange', () => {
    const now = Date.now();
    const hidden = documentHidden();
    for (const flow of [transfer?.coverFlow, transfer?.originalFlow, ...Object.values(transfer?.preparationClicks || {})]) {
      for (const budget of Object.values(flow?.waitBudgets || {})) updateWaitBudget(budget, now, hidden, true);
    }
  });
  const preparationWaitReason = (kind, reason) => documentHidden() ?
    `${kind === 'cover' ? '后台页面等待封面渲染' : '后台页面等待原创声明更新'}：${reason}` : reason;
  const refreshObservation = () => { observation = { visible: new WeakMap(), styles: new WeakMap(), text: new WeakMap(), exact: new WeakMap(), assets: new WeakMap() }; };
  const styleOf = (node) => {
    if (observation?.styles.has(node)) return observation.styles.get(node);
    const value = getComputedStyle(node);
    observation?.styles.set(node, value);
    return value;
  };
  const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
  const elements = (selector, root = document) => [...root.querySelectorAll(selector)];
  const visible = (node) => {
    if (!(node instanceof Element) || !node.isConnected) return false;
    if (observation?.visible.has(node)) return observation.visible.get(node);
    for (let current = node; current; current = current.parentElement) {
      if (current.hidden || current.getAttribute('aria-hidden') === 'true') return false;
      const style = styleOf(current);
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
    }
    const result = node.getClientRects().length > 0;
    observation?.visible.set(node, result);
    return result;
  };
  const text = (node) => {
    if (observation?.text.has(node)) return observation.text.get(node);
    const value = clean(node.innerText ?? node.textContent);
    observation?.text.set(node, value);
    return value;
  };
  const enabled = (node) => !node.disabled && node.getAttribute('aria-disabled') !== 'true' &&
    !/(^|[\s_-])disabled([\s_-]|$)/i.test(node.className || '');
  const unique = (list) => [...new Set(list)];
  const exactText = (label, root = document) => {
    let cache = observation?.exact.get(root);
    if (cache?.has(label)) return cache.get(label);
    const matches = elements('*', root).filter((node) =>
      !['SCRIPT', 'STYLE', 'OPTION'].includes(node.tagName) && visible(node) && text(node) === label);
    if (observation) {
      if (!cache) { cache = new Map(); observation.exact.set(root, cache); }
      cache.set(label, matches);
    }
    return matches;
  };
  const buttons = (root = document) => elements('button, input[type="button"], input[type="submit"], a, [role="button"]', root).filter(visible);
  const buttonLabel = (node) => clean(node.tagName === 'INPUT' ? node.value : (node.innerText ?? node.textContent) || node.getAttribute('aria-label'));
  const exactButtons = (label, root = document) => buttons(root).filter((node) => buttonLabel(node) === label);
  const messages = () => unique(elements('p, span, div, label, strong, button, a, [role="status"], [role="alert"]').filter(visible)
    .map(text).filter((value) => value && value.length <= 180));
  const addPage = () => exactText('添加视频').length > 0 && exactText('标题').length > 0 &&
    (exactText('上传视频').length > 0 || exactButtons('重新上传').length > 0);

  const validLaunchUrl = (value) => {
    try {
      const url = new URL(value, location.href);
      if (url.origin !== 'https://mp.weixin.qq.com' || url.username || url.password || url.pathname !== '/cgi-bin/appmsg' ||
          url.searchParams.get('t') !== 'media/videomsg_edit' || url.searchParams.get('action') !== 'video_edit' ||
          url.searchParams.get('type') !== '15' || !url.searchParams.get('token') ||
          ['appmsgid', 'media_id', 'vid'].some((name) => url.searchParams.has(name))) return null;
      // Copy only the navigation fields. An existing video ID or unrelated
      // editor parameters must never be carried into a new upload task.
      const target = new URL('/cgi-bin/appmsg', url.origin);
      for (const [name, value] of Object.entries({ t: 'media/videomsg_edit', action: 'video_edit', type: '15',
        token: url.searchParams.get('token'), lang: url.searchParams.get('lang') || 'zh_CN' })) target.searchParams.set(name, value);
      return target.href;
    } catch { return null; }
  };

  function launchInfo() {
    if (location.origin !== 'https://mp.weixin.qq.com') return { ready: false, pageKind: 'other', reason: '请在公众号后台页面使用视频上传入口。' };
    const picker = elements('[role="dialog"], dialog[open], .weui-desktop-dialog, .weui-desktop-dialog__wrp, .dialog, .dialog_wrp')
      .filter((node) => visible(node) && exactText('选择视频', node).length && exactText('素材库', node).length && exactButtons('本地上传', node).length);
    // The WeChat picker also appears without a dialog role in older layouts.
    for (const heading of exactText('选择视频')) {
      let node = heading.parentElement;
      for (let depth = 0; node && depth < 8; depth++, node = node.parentElement) {
        if (['HTML', 'BODY', 'MAIN', 'FORM'].includes(node.tagName)) break;
        if (exactText('素材库', node).length && exactButtons('本地上传', node).length) { picker.push(node); break; }
      }
    }
    const scopes = unique(picker).filter((node, index, all) => !all.some((inner, other) => other !== index && node.contains(inner)));
    const library = (exactText('素材库').length || exactText('视频素材').length) && exactText('视频').length && exactButtons('添加').length;
    const pageKind = scopes.length ? 'video-picker' : addPage() ? 'add-video' : library ? 'video-library' : 'other';
    if (pageKind === 'other') return { ready: false, pageKind, reason: '请在图文编辑页打开“视频 → 素材库”，或打开素材库的视频页面。' };
    if (scopes.length > 1) return { ready: false, pageKind, reason: '页面存在多个视频选择窗口，请保留一个上传入口。' };
    const launches = pageKind === 'video-picker' ? exactButtons('本地上传', scopes[0]) : pageKind === 'video-library' ? exactButtons('添加') : [];
    if (pageKind !== 'add-video' && launches.length !== 1) return { ready: false, pageKind, reason: '无法唯一定位视频上传入口。' };
    const anchor = launches[0]?.closest('a[href]');
    let launchUrl;
    if (anchor && anchor.getAttribute('href') && !/^(?:#|javascript:)/i.test(anchor.getAttribute('href').trim())) {
      launchUrl = validLaunchUrl(anchor.href);
      if (!launchUrl) return { ready: false, pageKind, reason: '上传入口地址不符合空白视频上传页，请重新打开“本地上传”入口。' };
    } else {
      const current = new URL(location.href);
      if (current.origin === 'https://mp.weixin.qq.com' && current.searchParams.get('token')) {
        const target = new URL('/cgi-bin/appmsg', current.origin);
        for (const [name, value] of Object.entries({ t: 'media/videomsg_edit', action: 'video_edit', type: '15',
          token: current.searchParams.get('token'), lang: current.searchParams.get('lang') || 'zh_CN' })) target.searchParams.set(name, value);
        launchUrl = validLaunchUrl(target.href);
      }
    }
    return launchUrl ? { ready: true, pageKind, reason: '入口已就绪，将在独立后台标签页中上传视频。', launchUrl } :
      { ready: false, pageKind, reason: '当前页面缺少有效登录信息，请重新打开公众号后台的上传入口。' };
  }

  function titleInputs() {
    const eligible = elements('input:not([type]), input[type="text"], textarea').filter(visible);
    const found = [];
    for (const input of eligible) {
      const labels = [...(input.labels || [])];
      if (clean(input.getAttribute('aria-label')) === '标题' || labels.some((label) => text(label) === '标题')) found.push(input);
    }
    if (found.length) return unique(found);
    for (const label of exactText('标题')) {
      let container = label.parentElement;
      for (let depth = 0; container && depth < 3; depth++, container = container.parentElement) {
        const matches = eligible.filter((input) => container.contains(input));
        if (matches.length === 1) { found.push(matches[0]); break; }
        if (matches.length > 1) break;
      }
    }
    return unique(found);
  }

  function uploadInputs() {
    const candidates = elements('input[type="file"]').filter((input) => {
      // Hidden native controls are expected; ambiguous controls are rejected below.
      if (input.disabled || !input.isConnected) return false;
      const accept = (input.accept || '').toLowerCase();
      if (/(?:image\/|\.(?:png|jpe?g|gif|webp|bmp|svg))/.test(accept) && !/video\//.test(accept)) return false;
      return true;
    });
    const video = candidates.filter((input) => /video\/|\.(?:mp4|mov|m4v|avi|wmv|mkv|webm|flv|mpeg|mpg)(?:\s|,|$)/i.test(input.accept));
    const associated = [];
    for (const label of [...exactText('上传视频'), ...exactText('重新上传')]) {
      let container = label;
      for (let depth = 0; container && depth < 4; depth++, container = container.parentElement) {
        const matches = candidates.filter((input) => container.contains(input));
        if (matches.length === 1) { associated.push(matches[0]); break; }
        if (matches.length > 1) break;
      }
    }
    if (unique(associated).length) return unique(associated);
    return video;
  }

  function agreementInputs() {
    const phrase = '公众平台视频上传服务规则';
    const candidates = elements('input[type="checkbox"], [role="checkbox"]');
    return candidates.filter((checkbox) => {
      const describesAgreement = (value) => value.includes('我已阅读并同意') && value.includes(phrase);
      const aria = clean(checkbox.getAttribute('aria-label'));
      if (visible(checkbox) && describesAgreement(aria)) return true;
      for (const label of [...(checkbox.labels || []), checkbox.closest('label')].filter(Boolean)) {
        if (visible(label) && describesAgreement(text(label)) &&
          label.querySelectorAll('input[type="checkbox"], [role="checkbox"]').length <= 1) return true;
      }
      let container = checkbox.parentElement;
      for (let depth = 0; container && depth < 3; depth++, container = container.parentElement) {
        const peers = candidates.filter((candidate) => container.contains(candidate));
        if (peers.length > 1) return false;
        if (visible(container) && describesAgreement(text(container))) return true;
      }
      return false;
    });
  }
  const checked = (node) => node.tagName === 'INPUT' ? node.checked === true : node.getAttribute('aria-checked') === 'true';

  function semanticRegions(labelText, matches) {
    const found = [];
    for (const label of exactText(labelText)) {
      let region = label.parentElement;
      for (let depth = 0; region && depth < 4; depth++, region = region.parentElement) {
        // A field-level operation must never widen into other form rows.
        if (['标题', '原创声明', '封面', '上传视频'].some((other) => other !== labelText && exactText(other, region).length)) break;
        if (matches(region)) { found.push(region); break; }
      }
    }
    return unique(found).filter((region, index, all) => !all.some((inner, other) => other !== index && region.contains(inner)));
  }

  function visualAssets(root) {
    if (observation?.assets.has(root)) return observation.assets.get(root);
    const assets = elements('*', root).filter((node) => visible(node) && !/(?:^|[\s_-])(?:icon|checkmark|tick)(?:[\s_-]|$)/i.test(node.className || '') &&
      ((node.tagName === 'IMG' && node.getAttribute('src')) || /url\(/.test(styleOf(node).backgroundImage)));
    observation?.assets.set(root, assets);
    return assets;
  }

  const coverSource = (node) => node.tagName === 'IMG' ? node.currentSrc || node.getAttribute('src') || '' : styleOf(node).backgroundImage;

  function confirmedCoverApplied(snapshot) {
    const flow = transfer?.coverFlow;
    if (!flow || flow.confirmedAt === null || !flow.before || coverEditors().length || !snapshot.sources.length) return false;
    const before = flow.before;
    // A completed crop can replace the thumbnail grid with plain previews;
    // those have no checked/selected class. Require a visible changed result
    // of our own confirmed editor, never just the modal disappearing.
    const newImage = snapshot.sources.some((source) => !before.sources.includes(source));
    const reducedGrid = before.count > snapshot.count && snapshot.count <= 3 &&
      (!before.first.isConnected || snapshot.appliedLabel);
    const replacedChoice = !before.first.isConnected && before.interactive && !snapshot.interactive &&
      snapshot.sources.some((source) => before.sources.includes(source));
    return snapshot.count <= 3 && (newImage || reducedGrid || replacedChoice ||
      snapshot.appliedLabel && (!before.appliedLabel || snapshot.first !== before.first));
  }

  function coverState() {
    const regions = semanticRegions('封面', (region) => visualAssets(region).length > 0);
    if (regions.length !== 1) return { first: null, candidateCount: 0, selected: false, reason: '等待页面生成推荐封面。' };
    let region = regions[0];
    // Prefer the explicitly named recommended group when the page also has a main preview.
    for (const label of ['推荐封面', '推荐封面图']) {
      const named = exactText(label, region);
      if (named.length === 1) {
        let candidate = named[0].parentElement;
        while (candidate && region.contains(candidate)) {
          if (visualAssets(candidate).length) { region = candidate; break; }
          candidate = candidate.parentElement;
        }
      }
    }
    const assets = visualAssets(region).filter((asset) => {
      let node = asset;
      for (let depth = 0; node && region.contains(node) && depth < 3; depth++, node = node.parentElement) {
        if (node === region || visualAssets(node).length > 1) break;
        if (/从图片库选择|图片库选择|上传封面|自定义封面/.test(text(node) + ' ' + (node.getAttribute('aria-label') || '') + ' ' + (node.getAttribute('alt') || ''))) return false;
        if (visualAssets(node).length > 1) break;
      }
      return true;
    });
    // A background thumbnail can contain an img; treat it as a single candidate.
    const thumbnails = assets.filter((asset) => !assets.some((inner) => inner !== asset && asset.contains(inner)));
    const first = thumbnails[0];
    if (!first) return { first: null, candidateCount: 0, selected: false, reason: '没有找到可选择的推荐封面，等待页面更新。' };
    const snapshot = { first, count: thumbnails.length, sources: thumbnails.map(coverSource),
      interactive: Boolean(first.closest('button, a, [role="button"], [role="radio"], [aria-pressed], [aria-checked], [onclick]')),
      appliedLabel: /修改封面|重新选择|编辑封面|更换封面|视频消息封面|视频封面\s*[（(]/.test(text(region)) };
    let selected = false;
    for (let node = first; node && region.contains(node); node = node.parentElement) {
      if (visualAssets(node).filter((asset) => !assets.some((inner) => inner !== asset && asset.contains(inner))).length > 1) break;
      if (node.getAttribute('aria-checked') === 'true' || node.getAttribute('aria-selected') === 'true' || node.getAttribute('aria-pressed') === 'true' ||
        ((node.tagName === 'INPUT') && node.checked) ||
        /(?:^|[\s_-])(?:select|selected|checked|active|current)(?:[\s_-]|$)/i.test(node.className || '') ||
        elements('input[type="radio"], input[type="checkbox"]', node).some((input) => input.checked)) selected = true;
    }
    selected ||= confirmedCoverApplied(snapshot);
    return { first, candidateCount: thumbnails.length, selected, snapshot, reason: selected ? '' : '等待选择并确认第一张推荐封面。' };
  }

  function hasAssetPreview() {
    if (elements('video').some((node) => visible(node) && (node.currentSrc || node.getAttribute('src') || node.querySelector('source[src]')))) return true;
    return semanticRegions('封面', (region) => visualAssets(region).length > 0).length > 0;
  }

  function originalControls() {
    const selector = 'input[type="checkbox"], [role="switch"], [role="checkbox"], .weui-desktop-switch, .weui-switch, [class*="weui-desktop-switch"]';
    const regions = semanticRegions('原创声明', (region) => elements(selector, region).length > 0);
    const dialogs = originalDialogs();
    const controls = unique(regions.flatMap((region) => elements(selector, region))).filter((node) =>
      !dialogs.some(dialog => dialog.contains(node)) && (visible(node) || (node.tagName === 'INPUT' && visible(node.parentElement))));
    const native = controls.filter((node) => node.tagName === 'INPUT');
    if (native.length) return native;
    const accessible = controls.filter((node) => ['switch', 'checkbox'].includes(node.getAttribute('role')));
    if (accessible.length) return accessible.filter((node) => !accessible.some((other) => other !== node && node.contains(other)));
    return controls.filter((node) => !controls.some((other) => other !== node && other.contains(node)));
  }

  function originalEnabled(node) {
    if (!node) return null;
    if (node.tagName === 'INPUT') return node.checked;
    if (node.hasAttribute('aria-checked')) return node.getAttribute('aria-checked') === 'true';
    if (/(?:weui-desktop-switch|weui-switch)/.test(node.className || '')) {
      return /(?:^|[\s_-])(?:on|checked|enabled)(?:[\s_-]|$)/i.test(node.className || '') ||
        /(?:^|[\s_-])(?:on|checked|enabled)(?:[\s_-]|$)/i.test(node.parentElement?.className || '');
    }
    return null;
  }

  function originalDialogs() {
    const candidates = elements('[role="dialog"], dialog[open], .weui-desktop-dialog, .weui-desktop-dialog__wrp, .weui_dialog, .dialog, .dialog_wrp').filter((node) =>
      visible(node) && /原创|声明/.test(text(node)));
    // Older WeChat layouts omit dialog roles. The exact notice heading and
    // agreement identify this popup without widening into the underlying form.
    for (const heading of exactText('视频原创须知')) {
      if (candidates.some(node => node.contains(heading))) continue;
      let node = heading.parentElement;
      let fallback = null;
      for (let depth = 0; node && depth < 8; depth++, node = node.parentElement) {
        if (['HTML','BODY','MAIN','FORM'].includes(node.tagName)) break;
        if (exactText('原创声明',node).length && text(node).includes(ORIGINAL_RULES)) {
          fallback ||= node;
          if (exactButtons('确定',node).length) { fallback = node; break; }
        }
      }
      if (fallback) candidates.push(fallback);
    }
    return unique(candidates).filter((node,index,all) => !all.some((inner,other) => other !== index && node.contains(inner)));
  }

  function knownOriginalDialog(node) {
    return exactText('原创声明',node).length > 0 && exactText('视频原创须知',node).length > 0 && text(node).includes(ORIGINAL_RULES);
  }

  function loadingOriginalDialog(node) {
    if (!exactText('原创声明',node).length) return false;
    const controls = elements('input[type="checkbox"], [role="checkbox"], a[href]',node).filter(element => visible(element) || visible(element.parentElement));
    if (controls.length) return false;
    if (buttons(node).some(button => !['确定','取消','关闭'].includes(buttonLabel(button)))) return false;
    if (exactText('视频原创须知',node).length) return true;
    return !text(node).replace(/原创声明|正在加载|加载中|请稍候|确定|取消|关闭|[.。…\s]/g,'');
  }

  function originalAgreementInputs(dialog) {
    const candidates = elements('input[type="checkbox"], [role="checkbox"]',dialog);
    const describes = value => value.includes('我已阅读并同意') && value.includes(ORIGINAL_RULES);
    return candidates.filter(checkbox => {
      if (visible(checkbox) && describes(clean(checkbox.getAttribute('aria-label')))) return true;
      for (const label of [...(checkbox.labels || []),checkbox.closest('label')].filter(Boolean)) {
        if (dialog.contains(label) && visible(label) && describes(text(label)) &&
            candidates.filter(peer => label.contains(peer)).length === 1) return true;
      }
      let container = checkbox.parentElement;
      for (let depth = 0; container && dialog.contains(container) && depth < 3; depth++,container = container.parentElement) {
        if (candidates.filter(peer => container.contains(peer)).length > 1) return false;
        if (visible(container) && describes(text(container))) return true;
      }
      return false;
    });
  }

  function originalDialogError(dialogs, state = transfer) {
    if (dialogs.length > 1) return '存在多个原创声明弹窗，无法唯一确认，请核对页面。';
    if (!dialogs.length) return null;
    if (!state?.originalFlow) return '页面已有手动打开的原创声明弹窗，请先完成或关闭该窗口。';
    if (!knownOriginalDialog(dialogs[0]) && !loadingOriginalDialog(dialogs[0])) return '原创声明出现未识别的额外确认弹窗，请在公众号页面核对。';
    return null;
  }

  function prepareOriginal(state) {
    const dialogs = originalDialogs();
    const error = originalDialogError(dialogs,state);
    if (error) throw new Error(error);
    const flow = state.originalFlow;
    const pending = reason => ({pending:true,reason:preparationWaitReason('original',reason)});
    if (!flow) return {pending:false};
    if (dialogs.length) {
      flow.completed = false;
      if (flow.openedAt === null) beginWait(flow,'openedAt');
      if (flow.confirmedAt !== null) {
        if (visibleWait(flow,'confirmedAt') > COVER_WAIT) throw new Error('原创声明已点击“确定”，但弹窗尚未关闭，请查看页面提示。');
        return pending('已确认原创声明，等待弹窗关闭。');
      }
      if (visibleWait(flow,'openedAt') > COVER_WAIT) throw new Error('原创声明的协议或“确定”按钮长时间未就绪，请查看页面。');
      if (!knownOriginalDialog(dialogs[0])) return pending('等待原创声明正文及协议加载。');
      if (exactButtons('确定',dialogs[0]).length > 1) throw new Error('原创声明弹窗内存在多个“确定”按钮，无法唯一确认。');
      let agreements = originalAgreementInputs(dialogs[0]);
      if (agreements.length > 1) throw new Error('原创声明弹窗内存在多个协议勾选框，无法唯一确认。');
      if (!agreements.length || !checked(agreements[0]) && !enabled(agreements[0])) return pending('等待原创声明协议勾选框就绪。');
      if (!checked(agreements[0])) {
        if (flow.agreementAt === null) {
          beginWait(flow,'agreementAt');
          agreements[0].click();
          refreshObservation();
        } else if (visibleWait(flow,'agreementAt') > 15000) throw new Error('原创声明协议已点击勾选，但页面尚未确认，请查看页面。');
        agreements = originalAgreementInputs(dialogs[0]);
        if (agreements.length !== 1 || !checked(agreements[0])) return pending('等待原创声明协议勾选生效。');
      }
      const confirm = exactButtons('确定',dialogs[0]);
      if (confirm.length > 1) throw new Error('原创声明弹窗内存在多个“确定”按钮，无法唯一确认。');
      if (confirm.length !== 1 || !enabled(confirm[0])) return pending('等待原创声明“确定”按钮可用。');
      beginWait(flow,'confirmedAt');
      confirm[0].click();
      refreshObservation();
      return pending('已点击原创声明“确定”，等待声明生效。');
    }
    if (flow.openedAt !== null) {
      if (flow.confirmedAt === null) throw new Error('原创声明弹窗尚未确认就已关闭，请核对原创状态。');
      if (flow.closedAt === null) beginWait(flow,'closedAt');
      const controls = originalControls();
      if (controls.length !== 1 || originalEnabled(controls[0]) !== true) {
        if (visibleWait(flow,'closedAt') > COVER_WAIT) throw new Error('原创声明弹窗已关闭，但原创开关尚未确认开启，请查看页面。');
        return pending('等待原创声明生效及开关状态更新。');
      }
    } else if (Date.now() - flow.startedAt < ORIGINAL_DIALOG_GRACE) {
      // Some versions turn the switch on before asynchronously opening the notice.
      return pending('等待原创声明开关及确认弹窗更新。');
    }
    flow.completed = true;
    return {pending:false};
  }

  function coverEditors() {
    const selector = '[role="dialog"], dialog[open], .weui-desktop-dialog, .weui-desktop-dialog__wrp, .weui_dialog, .dialog, .dialog_wrp';
    const candidates = elements(selector).filter((node) => visible(node) && exactText('编辑封面', node).length);
    // Some versions omit dialog roles. Find the smallest field-independent
    // container containing the screenshot's heading and crop/preview controls.
    for (const heading of exactText('编辑封面')) {
      if (candidates.some((node) => node.contains(heading))) continue;
      let node = heading.parentElement;
      for (let depth = 0; node && depth < 8; depth++, node = node.parentElement) {
        if (['HTML', 'BODY', 'MAIN', 'FORM'].includes(node.tagName)) break;
        if ((exactText('封面预览', node).length || exactText('裁剪封面', node).length) &&
          (exactButtons('完成', node).length || elements('canvas, img', node).some(visible))) {
          candidates.push(node);
          break;
        }
      }
    }
    return unique(candidates).filter((node, index, all) => !all.some((inner, other) => other !== index && node.contains(inner)));
  }

  function prepareCover(state) {
    const editors = coverEditors();
    const flow = state.coverFlow;
    if (editors.length && !flow) throw new Error('页面已有手动打开的封面编辑窗口，请先完成或关闭该窗口。');
    if (editors.length > 1) throw new Error('无法唯一定位“编辑封面”窗口，请核对页面。');
    const pending = reason => ({ pending: true, reason: preparationWaitReason('cover',reason) });
    if (editors.length) {
      const editor = editors[0];
      if (flow.openedAt == null) beginWait(flow,'openedAt');
      if (flow.confirmedAt !== null) {
        if (visibleWait(flow,'confirmedAt') > COVER_WAIT) throw new Error('封面已点击“完成”，但编辑窗口尚未关闭，请查看页面提示。');
        return pending('已确认封面，等待编辑窗口关闭。');
      }
      if (visibleWait(flow,'openedAt') > COVER_WAIT) throw new Error('封面编辑窗口的“完成”按钮长时间未就绪，请查看页面提示。');
      const done = exactButtons('完成', editor);
      if (done.length > 1) throw new Error('封面编辑窗口内存在多个“完成”按钮，无法唯一确认。');
      const hasPreview = elements('img, canvas', editor).some(visible) || visualAssets(editor).length > 0;
      if (done.length !== 1 || !enabled(done[0]) || !hasPreview ||
          !(exactText('封面预览', editor).length || exactText('裁剪封面', editor).length)) {
        return pending('等待封面预览和“完成”按钮就绪。');
      }
      // Checkpoint before the click: the crop editor can close synchronously.
      beginWait(flow,'confirmedAt');
      done[0].click();
      refreshObservation();
      return pending('已点击封面“完成”，等待封面应用。');
    }
    const cover = coverState();
    if (cover.selected) return { pending: false };
    if (flow) {
      if (flow.confirmedAt !== null) {
        if (flow.closedAt == null) beginWait(flow,'closedAt');
        if (visibleWait(flow,'closedAt') > COVER_WAIT) throw new Error('封面编辑窗口已关闭，但页面尚未显示封面应用成功，请查看页面。');
        return pending('等待已确认的封面应用到视频。');
      }
      if (visibleWait(flow,'startedAt') > COVER_WAIT) throw new Error('已选择第一张推荐封面，但尚未出现编辑窗口或选中状态，请查看页面。');
      return pending('等待第一张推荐封面的编辑窗口或选中状态。');
    }
    return { pending: false };
  }

  function preparationState() {
    const cover = coverState();
    const original = originalControls();
    const agreements = agreementInputs();
    const originalOn = original.length === 1 && originalEnabled(original[0]) === true;
    const agreed = agreements.length === 1 && checked(agreements[0]);
    const dialogs = originalDialogs();
    const dialog = dialogs.length > 0;
    const dialogError = originalDialogError(dialogs);
    const originalPending = Boolean(transfer?.originalFlow && !transfer.originalFlow.completed);
    const editors = coverEditors();
    let reason = '';
    if (dialog) reason = dialogError || '等待确认原创声明弹窗中的协议和“确定”。';
    else if (originalPending) reason = '等待原创声明确认及开关状态更新。';
    else if (editors.length) reason = transfer?.coverFlow?.confirmedAt !== null && transfer?.coverFlow ? '等待封面编辑窗口关闭。' : '等待确认封面编辑窗口中的“完成”。';
    else if (!cover.selected) reason = cover.reason;
    else if (original.length !== 1) reason = '无法唯一定位原创声明开关，请查看公众号页面。';
    else if (!originalOn) reason = '等待开启并确认原创声明。';
    else if (!agreed) reason = '等待勾选公众平台视频上传服务规则。';
    if (reason && !dialogError && (dialog || originalPending)) reason = preparationWaitReason('original',reason);
    else if (reason && (editors.length || !cover.selected && transfer?.coverFlow)) reason = preparationWaitReason('cover',reason);
    return { cover, original, originalOn, agreed, ready: !reason, reason, dialog, dialogs, dialogError, originalPending, editors };
  }

  function fileIdentity(state, uploadComplete, busy) {
    if (!state?.attached) return { valid: false, error: null };
    const inputs = unique([state.input, ...uploadInputs()]).filter((input) => input?.isConnected);
    const selected = inputs.flatMap((input) => [...(input.files || [])]);
    if (selected.length) {
      const matches = selected.length === 1 && selected.every((file) => file.name === state.name && file.size === state.size && file.lastModified === state.lastModified);
      return { valid: matches, error: matches ? null : '页面所选文件与队列视频不一致，请核对后重新开始。' };
    }
    // Some uploaders clear or replace the native input after consuming its File.
    // In that case require an exact visible filename plus independent upload evidence.
    const named = exactText(state.name).length > 0 || elements('[title], [aria-label]').some((node) => visible(node) &&
      (clean(node.getAttribute('title')) === state.name || clean(node.getAttribute('aria-label')) === state.name));
    if (named && uploadComplete && hasAssetPreview()) return { valid: true, error: null };
    return { valid: false, pending: true, error: null, reason: named && busy ? '文件已交给公众号，等待上传完成。' : '文件已交给公众号，等待文件名、上传进度和完成状态更新。' };
  }

  function assignTitle(state, input) {
    const prototype = input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
    if (!setter) throw new Error('当前页面标题控件暂不支持自动填写。');
    setter.call(input, state.title);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    state.titleInput = input;
    refreshObservation();
  }

  function titleState(state) {
    const inputs = titleInputs();
    if (inputs.length !== 1) return { error: '无法唯一定位素材标题输入框，请核对公众号页面。', needsSync: false };
    const value = inputs[0].value;
    if (value === state.title) return { error: null, needsSync: false };
    const defaultTitle = state.name.replace(/\.[^.]+$/, '');
    const maxLength = inputs[0].maxLength > 0 ? inputs[0].maxLength : 64;
    if (!value || [defaultTitle, state.name, defaultTitle.slice(0, maxLength), state.name.slice(0, maxLength)].includes(value)) return { error: null, needsSync: true };
    return { error: '页面标题已被修改且与队列标题不一致，请核对后重新开始。', needsSync: false };
  }

  function materialTimestamp(card) {
    const content = text(card);
    const full = content.match(/(20\d\d)[-/.年](\d{1,2})[-/.月](\d{1,2})(?:日)?\s+(\d{1,2})[:：](\d{2})(?::(\d{2}))?/);
    if (full) {
      const [, year, month, day, hour, minute, second = '0'] = full;
      const date = new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second));
      return date.getFullYear() === Number(year) && date.getMonth() === Number(month) - 1 && date.getDate() === Number(day) &&
        date.getHours() === Number(hour) && date.getMinutes() === Number(minute) && date.getSeconds() === Number(second) ? date.getTime() : null;
    }
    if (!exactText('素材库').length && !exactText('视频素材').length) return null;
    const cells = elements('time, td, p, span, div', card).filter(visible);
    if (!cells.some((node) => /^(?:转码中|审核中|已通过|已发表|原创声明失败|审核未通过|审核失败|已保存)$/.test(text(node)))) return null;
    const leaves = cells.filter((node) => !node.children.length);
    const relativePattern = /^(?:(今天|昨天|前天|星期[一二三四五六日天]|周[一二三四五六日天])\s*)?(\d{1,2})[:：](\d{2})(?::(\d{2}))?$/;
    const timeCells = leaves.filter((node) => {
      if (!relativePattern.test(text(node))) return false;
      // The duration overlay belongs to the thumbnail, not the update column.
      for (let parent = node.parentElement; parent && parent !== card; parent = parent.parentElement) {
        if (elements('img, video', parent).some(visible)) return false;
      }
      return true;
    });
    if (timeCells.length !== 1) return null;
    const [, relative, hours, minutes, seconds = '0'] = text(timeCells[0]).match(relativePattern);
    const hour = Number(hours), minute = Number(minutes), second = Number(seconds);
    if (hour > 23 || minute > 59 || second > 59) return null;
    const date = new Date(Date.now());
    if (relative === '昨天' || relative === '前天') date.setDate(date.getDate() - (relative === '昨天' ? 1 : 2));
    else if (/^(星期|周)/.test(relative || '')) {
      const weekday = '日一二三四五六'.indexOf(relative.slice(-1).replace('天', '日'));
      date.setDate(date.getDate() - (date.getDay() - weekday + 7) % 7);
    }
    date.setHours(hour, minute, second, 0);
    return date.getTime();
  }

  function materialCards() {
    const cards = [];
    const candidates = elements('article, li, [role="listitem"], tr, div').filter(visible);
    const timestamps = new Map();
    const timestamp = (node) => {
      if (!timestamps.has(node)) timestamps.set(node, materialTimestamp(node));
      return timestamps.get(node);
    };
    const credible = (node) => text(node).length <= 600 && elements('img, video', node).some(visible) && timestamp(node) !== null;
    for (const card of candidates) {
      const content = text(card);
      if (!content || !credible(card)) continue;
      if (candidates.some((inner) => inner !== card && card.contains(inner) && credible(inner))) continue;
      const titles = [];
      for (const node of elements('h1, h2, h3, h4, a, p, span, div, td', card)) {
        const value = text(node);
        if (visible(node) && value && value.length <= 64 && !node.children.length &&
          !/^20\d\d[-/.年]\d{1,2}[-/.月]\d{1,2}(?:日)?(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?$|^(?:(?:今天|昨天|前天|星期[一二三四五六日天]|周[一二三四五六日天])\s*)?\d{1,2}:\d{2}(?::\d{2})?$|^原创$|^原创声明|^审核|^转码|^已通过$|^已发表$|^已保存$/.test(value)) titles.push(value);
      }
      cards.push({ titles: unique(titles), createdAt: timestamp(card) });
    }
    return cards;
  }
  const materialTitles = () => unique(materialCards().flatMap((card) => card.titles)).slice(0, 300);

  function diagnostics() {
    const preparation = preparationState();
    const activeStatus = transfer?.attached ? status({ id: transfer.id }) : null;
    const safeLabel = (value) => {
      if (transfer && [transfer.name, transfer.title].some((privateValue) => privateValue && value.includes(privateValue))) return '[已省略任务内容]';
      return /(?:https?:|token\s*=|[?&]\w+=)/i.test(value) ? '[已省略链接信息]' : value.slice(0, 80);
    };
    return {
      ...pageVisibility(),
      pageKind: addPage() ? 'add-video' : 'other',
      buttons: unique(buttons().map(buttonLabel).filter(Boolean).map(safeLabel)).slice(0, 60),
      inputs: elements('input, textarea, [role="checkbox"]').map((node) => ({
        type: node.getAttribute('type') || (node.tagName === 'TEXTAREA' ? 'textarea' : node.getAttribute('role') || 'text'),
        accept: safeLabel(node.getAttribute('accept') || ''),
        maxLength: node.maxLength > 0 ? node.maxLength : null,
        visible: visible(node), disabled: Boolean(node.disabled)
      })).slice(0, 60),
      uploadInputCount: uploadInputs().length,
      titleInputCount: titleInputs().length,
      agreementInputCount: agreementInputs().length,
      saveButtonCount: exactButtons('保存').length,
      coverCandidateCount: preparation.cover.candidateCount,
      firstCoverSelected: preparation.cover.selected,
      coverEditorCount: preparation.editors.length,
      coverConfirmationSent: Boolean(transfer?.coverFlow && transfer.coverFlow.confirmedAt !== null),
      originalControlCount: preparation.original.length,
      originalEnabled: preparation.originalOn,
      originalDialogCount: preparation.dialogs.length,
      originalConfirmationSent: Boolean(transfer?.originalFlow && transfer.originalFlow.confirmedAt !== null),
      agreementChecked: preparation.agreed,
      ownedTransfer: Boolean(transfer?.attached && !transfer.verified),
      evidence: {
        fileHandedOff: Boolean(transfer?.attached),
        populatedFileInput: uploadInputs().some((input) => input.files?.length > 0),
        hasAssetPreview: hasAssetPreview(),
        uploadComplete: Boolean(activeStatus?.uploadComplete),
        preparationReady: preparation.ready,
        pending: Boolean(activeStatus?.pending),
        busy: Boolean(activeStatus?.busy),
        hasError: Boolean(activeStatus?.error)
      }
    };
  }

  function inspect() {
    const pageKind = addPage() ? 'add-video' : 'other';
    const files = uploadInputs();
    const titles = titleInputs();
    const agreements = agreementInputs();
    const ownedTransfer = Boolean(transfer?.attached && !transfer.verified);
    let reason = '';
    if (ownedTransfer) reason = '正在处理当前队列视频';
    else if (coverEditors().length) reason = '请先完成或关闭已有的封面编辑窗口。';
    else if (originalDialogs().length) reason = '请先完成或关闭已有的原创声明弹窗。';
    else if (pageKind !== 'add-video') reason = '请打开公众号素材库的“添加视频”页面。';
    else if (files.length !== 1) reason = '无法唯一定位视频文件控件；请导出页面诊断。';
    else if (titles.length !== 1) reason = '无法唯一定位素材标题输入框。';
    else if (agreements.length !== 1) reason = '无法唯一定位公众平台视频上传服务规则勾选框。';
    else if (exactButtons('保存').length !== 1) reason = '无法唯一定位“保存”按钮。';
    else if (titles[0].value.trim() || files[0].files?.length || hasAssetPreview()) reason = '当前表单已有标题或视频，请打开空白的“添加视频”页面。';
    return { ready: !reason, reason, needsAgreement: agreements.length !== 1 || !checked(agreements[0]),
      hasUploadInput: files.length === 1, titleMaxLength: titles[0]?.maxLength > 0 ? titles[0].maxLength : 64,
      pageKind, ownedTransfer, activeId: ownedTransfer ? transfer.id : null, existingTitles: materialTitles(), diagnostics: diagnostics() };
  }

  function requireTransfer(id) {
    if (!transfer || transfer.id !== id) throw new Error('当前视频传输不存在，请重新选择文件并开始。');
    return transfer;
  }

  function begin(payload = {}) {
    if (transfer && !transfer.verified) throw new Error('当前页面已有视频任务，请先完成核对或打开新的空白添加页。');
    const state = inspect();
    if (!state.ready) throw new Error(state.reason);
    const { id, name, size, type = '', lastModified, title } = payload;
    if (typeof id !== 'string' || !id || typeof name !== 'string' || !name || typeof title !== 'string' || !title.trim()) throw new Error('视频任务信息或标题不完整。');
    if (!Number.isSafeInteger(size) || size <= 0 || !Number.isSafeInteger(lastModified) || lastModified < 0) throw new Error('视频大小或文件时间信息无效。');
    if (title.length > state.titleMaxLength) throw new Error(`标题不得超过 ${state.titleMaxLength} 个字符。`);
    if (type && !type.startsWith('video/')) throw new Error('只能选择视频文件。');
    transfer = { id, name, size, type, lastModified, title, chunks: [], bytes: 0, nextIndex: 0, attached: false,
      saved: false, verified: false, initialSuccess: new Set(messages().filter((value) => /^保存成功[！!。.]?$/.test(value))) };
    return { id, receivedBytes: 0, nextIndex: 0 };
  }

  function chunk({ id, index, data } = {}) {
    const state = requireTransfer(id);
    if (state.attached || state.failed) throw new Error('视频已交给页面或传输已中断，不能继续追加数据。');
    if (!Number.isInteger(index) || index !== state.nextIndex) throw new Error('视频分片顺序不正确，请重新开始。');
    if (typeof data !== 'string' || data.length > Math.ceil(MAX_CHUNK / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw new Error('视频分片格式或大小无效。');
    let raw;
    try { raw = atob(data); } catch { throw new Error('无法读取视频分片。'); }
    if (!raw.length || raw.length > MAX_CHUNK || state.bytes + raw.length > state.size) throw new Error('视频分片大小与文件不一致。');
    const bytes = new Uint8Array(raw.length);
    for (let index = 0; index < raw.length; index++) bytes[index] = raw.charCodeAt(index);
    state.chunks.push(bytes);
    state.bytes += bytes.length;
    state.nextIndex++;
    return { receivedBytes: state.bytes, nextIndex: state.nextIndex };
  }

  function attach({ id } = {}) {
    const state = requireTransfer(id);
    if (state.attached || state.failed) throw new Error('此文件已交给页面或操作已中断，请先核对页面。');
    if (state.bytes !== state.size) throw new Error('视频文件尚未完整传输。');
    const page = inspect();
    if (!page.ready) throw new Error(page.reason);
    const input = uploadInputs()[0];
    const titleInput = titleInputs()[0];
    const file = new File(state.chunks, state.name, { type: state.type, lastModified: state.lastModified });
    const bag = new DataTransfer();
    bag.items.add(file);
    try {
      input.files = bag.files;
      if (input.files?.length !== 1 || input.files[0].size !== state.size) throw new Error('页面未接受所选文件。');
      state.input = input;
      state.titleInput = titleInput;
      state.attached = true;
      state.chunks = [];
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      refreshObservation();
      const currentTitles = titleInputs();
      if (currentTitles.length === 1) assignTitle(state, currentTitles[0]);
    } catch (error) {
      state.failed = true;
      state.chunks = [];
      throw error;
    }
    return { attached: true, id };
  }

  function status({ id } = {}) {
    const state = requireTransfer(id);
    const needsAgreement = agreementInputs().length !== 1 || !checked(agreementInputs()[0]);
    const values = messages();
    const errorText = values.find((value) => /^(?:视频)?(?:上传失败|保存失败|上传出错|文件过大|文件格式不支持|不支持的文件格式)|登录已过期|请重新登录|请完成验证|请先完成验证/.test(value));
    const progress = elements('[role="progressbar"], progress').filter(visible);
    const activeProgress = progress.some((node) => {
      if (node.tagName === 'PROGRESS') return !node.hasAttribute('value') || node.value < node.max;
      const current = node.getAttribute('aria-valuenow');
      const maximum = node.getAttribute('aria-valuemax') || '100';
      return current === null || Number(current) < Number(maximum);
    });
    const busy = activeProgress || values.some((value) => /^(?:视频)?(?:正在上传|上传中|正在处理|处理中|正在转码|转码中|正在保存|保存中)(?:\s|[.。…:：(（]|\d|$)/.test(value));
    const saveButtons = exactButtons('保存');
    const saveEnabled = saveButtons.length === 1 && enabled(saveButtons[0]);
    const completeMessage = values.some((value) => /^(?:视频)?(?:已)?上传(?:成功|完成)(?:[！!。.,，；;：:]|\s*100\s*%|$)/.test(value) && !/后可|后设置|完成后/.test(value));
    const completionEvidence = state.attached && !busy && !errorText &&
      (completeMessage || exactButtons('重新上传').length === 1) && (hasAssetPreview() || saveEnabled);
    const identity = fileIdentity(state, completionEvidence, busy);
    const titles = state.attached ? titleState(state) : { error: null, needsSync: false };
    const preparation = preparationState();
    // Opening the crop editor may hide the uploading form from accessibility.
    // Reuse only this task's already-proven upload while its cover is pending.
    const coverPending = Boolean(state.coverFlow?.uploadConfirmed && (preparation.editors.length || !preparation.cover.selected));
    const originalPending = Boolean(state.originalFlow?.uploadConfirmed && (preparation.dialog || preparation.originalPending));
    const uploadComplete = completionEvidence && identity.valid || (coverPending || originalPending) && !errorText && !identity.error;
    let reason = '';
    let error = null;
    if (state.failed) error = '文件交接发生错误，请检查公众号页面并重新开始。';
    else if (errorText) error = /登录|验证/.test(errorText) ? '页面要求重新登录或完成验证，请在公众号页面处理后再继续。' : '公众号页面报告上传或保存失败，请查看页面提示。';
    else if (preparation.dialogError) error = preparation.dialogError;
    else if (identity.error) error = identity.error;
    else if (titles.error && titleInputs().length === 1) error = titles.error;
    if (error) reason = error;
    else if (!state.attached) reason = '等待视频文件传输完成。';
    else if (preparation.dialog || preparation.originalPending) reason = preparation.reason;
    else if (preparation.editors.length) reason = preparation.reason;
    else if (!addPage() || titleInputs().length !== 1 || saveButtons.length !== 1) reason = '等待公众号表单更新。';
    else if (busy) reason = '等待公众号完成上传或转码。';
    else if (identity.pending) reason = identity.reason;
    else if (!uploadComplete) reason = '尚未识别到明确的上传完成状态；请查看公众号页面。';
    else if (titles.needsSync) reason = '等待将素材标题同步为队列中的标题。';
    else if (!preparation.ready) reason = preparation.reason;
    else if (!saveEnabled) reason = '公众号“保存”按钮尚不可用，请检查封面或页面提示。';
    return { readyToSave: !reason && !state.saved, uploadComplete, titleNeedsSync: !preparation.editors.length && !preparation.dialog && titles.needsSync, needsAgreement,
      needsPreparation: !preparation.ready, preparationReady: preparation.ready, preparationReason: preparation.reason,
      preparation: {
        coverCandidateCount: preparation.cover.candidateCount,
        firstCoverSelected: preparation.cover.selected,
        coverEditorCount: preparation.editors.length,
        coverConfirmationSent: Boolean(state.coverFlow && state.coverFlow.confirmedAt !== null),
        originalControlCount: preparation.original.length,
        originalEnabled: preparation.originalOn,
        originalDialogCount: preparation.dialogs.length,
        originalConfirmationSent: Boolean(state.originalFlow && state.originalFlow.confirmedAt !== null),
        agreementChecked: preparation.agreed,
        phase: preparation.dialog ? 'original-dialog' : preparation.originalPending ? 'original-apply' :
          preparation.editors.length ? 'cover-editor' : !preparation.cover.selected ? 'cover-select' :
          preparation.original.length !== 1 ? 'original-control' : !preparation.originalOn ? 'original-enable' :
          !preparation.agreed ? 'service-agreement' : 'ready'
      },
      pending: !error && Boolean(reason), busy, error, reason, ...pageVisibility() };
  }

  function fillTitle({ id } = {}) {
    const state = requireTransfer(id);
    if (!state.attached || state.saved) throw new Error('当前不处于可填写标题的视频上传阶段。');
    const pending = () => ({ filled: false, pending: true, reason: '等待公众号标题输入框更新。' });
    if (!addPage() || titleInputs().length !== 1) return pending();
    const current = titleState(state);
    if (current.error) throw new Error(current.error);
    if (current.needsSync) assignTitle(state, titleInputs()[0]);
    if (titleInputs().length !== 1) return pending();
    const updated = titleState(state);
    if (updated.error) throw new Error(updated.error);
    if (updated.needsSync) return pending();
    return { filled: true, pending: false };
  }

  function agree({ id } = {}) {
    const state = requireTransfer(id);
    if (!state.attached || state.saved || !addPage()) throw new Error('当前不处于可勾选服务规则的视频上传阶段。');
    if (originalDialogs().length || state.originalFlow && !state.originalFlow.completed) throw new Error('请等待原创声明确认完成后再勾选上传服务规则。');
    const candidates = agreementInputs();
    if (candidates.length !== 1) throw new Error('无法唯一定位公众平台视频上传服务规则勾选框，请手动处理。');
    const checkbox = candidates[0];
    if (!enabled(checkbox)) throw new Error('服务规则勾选框当前不可操作。');
    if (!checked(checkbox)) { checkbox.click(); refreshObservation(); }
    if (!checked(checkbox)) throw new Error('页面未确认服务规则已勾选，请查看公众号页面。');
    return { agreed: true };
  }

  function prepare({ id } = {}) {
    const state = requireTransfer(id);
    if (!state.attached || state.saved) throw new Error('当前不处于可准备保存的视频上传阶段。');
    const current = status({ id });
    if (current.error) throw new Error(current.error);
    const result = (prepared, reason = '') => ({ prepared, pending: !prepared, reason,
      needsPreparation: !prepared, preparationReady: prepared });
    if (state.originalFlow || originalDialogs().length) {
      const originalResult = prepareOriginal(state);
      if (originalResult.pending) return result(false,originalResult.reason);
    }
    if (state.coverFlow || coverEditors().length) {
      const coverResult = prepareCover(state);
      if (coverResult.pending) return result(false, coverResult.reason);
    }
    if (!current.uploadComplete) return result(false, current.reason || '等待上传完成后设置封面和原创声明。');
    if (current.titleNeedsSync) {
      const titleResult = fillTitle({ id });
      if (titleResult.pending) return result(false, titleResult.reason);
    }
    const clickOnce = (kind, node) => {
      state.preparationClicks ||= {};
      const previous = state.preparationClicks[kind];
      if (previous) {
        if (visibleWait(previous,'at') > 15000) throw new Error(kind === 'cover' ? '已选择第一张推荐封面，但页面尚未确认选中状态，请手动核对。' : kind === 'agreement' ? '已勾选视频服务规则，但页面尚未确认，请手动核对。' : '已开启原创声明，但页面尚未确认，请查看是否有额外提示。');
        return;
      }
      if (!enabled(node)) throw new Error(kind === 'cover' ? '推荐封面当前不可选择。' : '原创声明开关当前不可操作。');
      state.preparationClicks[kind] = { node, at: Date.now() };
      visibleWait(state.preparationClicks[kind],'at');
      node.click();
      refreshObservation();
    };
    let ready = preparationState();
    if (!ready.cover.first) return result(false, ready.cover.reason);
    if (!ready.cover.selected) {
      state.coverFlow = { startedAt: Date.now(), confirmedAt: null, uploadConfirmed: current.uploadComplete, before: ready.cover.snapshot };
      visibleWait(state.coverFlow,'startedAt');
      clickOnce('cover', ready.cover.first);
      const coverResult = prepareCover(state);
      if (coverResult.pending) return result(false, coverResult.reason);
      ready = preparationState();
      if (!ready.cover.selected) return result(false, ready.cover.reason);
    }
    if (!ready.original.length) return result(false, '等待原创声明开关加载。');
    if (ready.original.length !== 1) throw new Error('无法唯一定位原创声明开关，请查看公众号页面。');
    if (originalEnabled(ready.original[0]) === null) throw new Error('无法读取原创声明开关状态，请在公众号页面核对。');
    if (!ready.originalOn) {
      if (!enabled(ready.original[0])) return result(false, '等待原创声明开关可用。');
      state.originalFlow ||= { startedAt:Date.now(),openedAt:null,confirmedAt:null,closedAt:null,agreementAt:null,completed:false,uploadConfirmed:current.uploadComplete };
      clickOnce('original', ready.original[0]);
      const originalResult = prepareOriginal(state);
      if (originalResult.pending) return result(false,originalResult.reason);
      ready = preparationState();
      if (ready.dialogError) throw new Error(ready.dialogError);
      if (!ready.originalOn) return result(false, ready.reason);
    }
    if (!ready.agreed) {
      const agreements = agreementInputs();
      if (!agreements.length) return result(false, '等待视频服务规则勾选框加载。');
      if (agreements.length !== 1) throw new Error('无法唯一定位公众平台视频上传服务规则勾选框，请查看页面。');
      if (!enabled(agreements[0])) return result(false, '等待视频服务规则勾选框可用。');
      clickOnce('agreement', agreements[0]);
    }
    ready = preparationState();
    if (ready.dialogError) throw new Error(ready.dialogError);
    return result(ready.ready, ready.reason);
  }

  function save({ id } = {}) {
    const state = requireTransfer(id);
    if (state.saved) throw new Error('已经点击保存，必须先核对入库结果，不能重复保存。');
    const current = status({ id });
    if (!current.readyToSave) throw new Error(current.reason || '页面尚未达到保存条件。');
    const button = exactButtons('保存');
    if (button.length !== 1 || !enabled(button[0]) || !addPage()) throw new Error('无法安全定位唯一的“保存”按钮。');
    // Mark before clicking: navigation may immediately destroy this context.
    state.initialSuccess = new Set(messages().filter((value) => /^保存成功[！!。.]?$/.test(value)));
    state.saved = true;
    state.savedAt = Date.now();
    button[0].click();
    return { clicked: true };
  }

  function verify({ id, title, savedAt } = {}) {
    const state = transfer?.id === id ? transfer : null;
    const expected = state?.title || title;
    if (typeof expected !== 'string' || !expected) return { verified: false, reason: '缺少待核对的视频标题。' };
    if (state && !state.saved) return { verified: false, reason: '尚未点击保存，不能判定已入库。' };
    const explicit = state?.saved && messages().some((value) => /^保存成功[！!。.]?$/.test(value) && !state.initialSuccess.has(value));
    if (explicit) {
      state.verified = true;
      return { verified: true, reason: '公众号显示保存成功。' };
    }
    const saveTime = state?.savedAt || savedAt;
    if (!Number.isFinite(saveTime) || saveTime <= 0 || saveTime > Date.now() + 60000) return { verified: false, reason: '缺少有效的保存时间，无法确认素材列表中的视频是本次上传。' };
    const matches = addPage() ? [] : materialCards().filter((card) => card.titles.includes(expected));
    if (matches.length > 1) return { verified: false, reason: '素材列表有多个同名视频，请人工核对本次入库结果。' };
    const card = matches[0];
    const minuteStart = Math.floor(saveTime / 60000) * 60000;
    const verified = Boolean(card && card.createdAt !== null && card.createdAt >= minuteStart && card.createdAt <= Date.now() + 60000);
    if (verified && state) state.verified = true;
    return { verified, reason: verified ? '素材卡片的标题与本次保存时间一致。' : '尚未获得明确入库证据，请到素材库核对；不要直接重复上传。' };
  }

  const operations = { inspect, launchInfo, begin, chunk, attach, status, fillTitle, agree, prepare, save, verify, diagnostics };
  const api = Object.freeze(Object.fromEntries(Object.entries(operations).map(([name, operation]) => [name, (...args) => {
    refreshObservation();
    try { return operation(...args); } finally { observation = null; }
  }])));
  globalThis.WXVideoAdapter = api;
  if (globalThis.chrome?.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener((message, sender, respond) => {
      if (message?.namespace !== 'wxvu.page' || sender.id !== chrome.runtime.id) return false;
      if (!Object.prototype.hasOwnProperty.call(api, message.command)) {
        respond({ ok: false, error: '未知页面操作。' });
        return false;
      }
      try { respond({ ok: true, result: api[message.command](message.payload || {}) }); }
      catch (error) { respond({ ok: false, error: error instanceof Error ? error.message : '页面操作失败。' }); }
      return false;
    });
  }
})();
