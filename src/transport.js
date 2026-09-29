(function(global) {
  'use strict';
  const ORIGIN = 'https://mp.weixin.qq.com';
  const CHUNK_SIZE = 384 * 1024;
  const TERMINAL_CODES = new Set(['WORKER_UNBOUND','TAB_CLOSED','TAB_NAVIGATED','CONTEXT_CLOSED','TAB_FROZEN','TAB_DISCARDED']);
  function terminalCode(error) {
    if (TERMINAL_CODES.has(error?.code)) return error.code;
    return /^No tab with id\b/i.test(error?.message || '') ? 'TAB_CLOSED' : null;
  }
  class PageError extends Error {}
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  function encode(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 8192)
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
    return btoa(binary);
  }
  class WXVideoTransport {
    constructor({targetTabId, onNotice = () => {}, api = global.chrome, wait = sleep, now = Date.now,
      renderPulse = null, onRenderState = () => {}, onProgress = () => {}, verifyAfterSave = true}) {
      this.targetTabId = targetTabId;
      this.onNotice = onNotice;
      this.api = api;
      this.wait = wait;
      this.now = now;
      this.renderPulse = typeof renderPulse === 'function' ? renderPulse : null;
      this.onRenderState = onRenderState;
      this.onProgress = onProgress;
      this.verifyAfterSave = verifyAfterSave !== false;
      this._progressPhase = 'opening';
      this._renderTask = null;
      this._lastRenderPulseAt = -Infinity;
      this._renderStateKey = null;
      this._renderAssisted = false;
      this._renderUnavailableNotified = false;
      this.addUrl = null;
      this.lastVerified = false;
      this.lastVerifiedUrl = null;
      this.uploadTimeout = 45 * 60 * 1000;
      this.verifyTimeout = 90 * 1000;
    }
    _progress(phase, state = {}, fallback = '') {
      this._progressPhase = phase;
      const progress = { phase, reason: String(state.reason || fallback).slice(0,500) };
      for (const key of ['uploadComplete','titleNeedsSync','needsPreparation','preparationReady','needsAgreement','readyToSave','pending','prepared','verified','submitted','uncertain','busy','documentHidden'])
        if (typeof state[key] === 'boolean') progress[key] = state[key];
      if (typeof state.pageKind === 'string') progress.pageKind = state.pageKind.slice(0,50);
      if (typeof state.code === 'string') progress.code = state.code.slice(0,50);
      if (state.preparation && typeof state.preparation === 'object') {
        progress.preparation = {};
        for (const key of ['firstCoverSelected','coverConfirmationSent','originalEnabled','originalConfirmationSent','agreementChecked'])
          if (typeof state.preparation[key] === 'boolean') progress.preparation[key] = state.preparation[key];
        for (const key of ['coverCandidateCount','coverEditorCount','originalControlCount','originalDialogCount'])
          if (Number.isSafeInteger(state.preparation[key]) && state.preparation[key] >= 0) progress.preparation[key] = state.preparation[key];
        if (['original-dialog','original-apply','cover-editor','cover-select','original-control','original-enable','service-agreement','ready'].includes(state.preparation.phase))
          progress.preparation.phase = state.preparation.phase;
      }
      try { this.onProgress(progress); } catch { /* Diagnostics cannot interrupt an upload transaction. */ }
    }
    async tab() {
      let tab;
      try { tab = await this.api.tabs.get(this.targetTabId); }
      catch (error) {
        if (/^No tab with id\b/i.test(error?.message || '')) {
          const closed = new Error('上传标签页已关闭，无法继续读取当前视频状态。');
          closed.code = 'TAB_CLOSED';
          throw closed;
        }
        throw error;
      }
      if (!tab.url || new URL(tab.url).origin !== ORIGIN) {
        const error = new Error('公众号操作页已关闭、离开微信域名或权限已失效。请回到添加视频页，点击插件图标后重试。');
        error.code = 'TAB_NAVIGATED';
        throw error;
      }
      if (tab.frozen || tab.discarded) {
        const error = new Error(tab.discarded
          ? '上传标签页已被 Chrome 回收，请打开该标签页并核对素材库后重试，助手不会自动重新上传。'
          : '上传标签页已被 Chrome 冻结，请打开该标签页唤醒并核对当前上传状态后继续。');
        error.needsWake = true;
        error.code = tab.discarded ? 'TAB_DISCARDED' : 'TAB_FROZEN';
        throw error;
      }
      return tab;
    }
    async _pulseRender() {
      if (!this.renderPulse) return;
      if (this._renderTask) return this._renderTask;
      if (this.now() - this._lastRenderPulseAt < 250) return;
      this._lastRenderPulseAt = this.now();
      // The callback is restricted to this worker by the background host. It
      // advances pending page rendering without changing browser focus.
      const task = Promise.resolve().then(async () => {
        const tab = await this.tab();
        if (tab.status !== 'complete') return;
        const result = await this.renderPulse();
        const state = { supported: result?.supported === true, hidden: result?.hidden === true };
        this._renderAssisted ||= Number(result?.assisted) > 0;
        state.assisted = this._renderAssisted;
        const key = JSON.stringify(state);
        if (key !== this._renderStateKey) {
          this._renderStateKey = key;
          this.onRenderState(state);
        }
        if (!state.supported && !this._renderUnavailableNotified) {
          this._renderUnavailableNotified = true;
          this.onNotice('后台渲染辅助尚未加载。如果封面处理停住，请重新加载扩展后再试。');
        }
        return result;
      });
      this._renderTask = task;
      try { return await task; }
      finally { if (this._renderTask === task) this._renderTask = null; }
    }
    async _waitWithRendering(milliseconds) {
      if (!this.renderPulse) return this.wait(milliseconds);
      let remaining = milliseconds;
      while (remaining > 0) {
        const interval = Math.min(250, remaining);
        await this.wait(interval);
        await this._pulseRender();
        remaining -= interval;
      }
    }
    async inject() {
      await this.tab();
      await this.api.scripting.executeScript({target:{tabId:this.targetTabId},files:['src/adapter.js']});
    }
    async command(command, payload = {}) {
      try {
        await this.tab();
        const response = await this.api.tabs.sendMessage(this.targetTabId, {namespace:'wxvu.page',command,payload});
        if (!response || response.ok !== true) {
          const error = new PageError(response?.error || '公众号页面没有返回可确认的结果。');
          if (typeof response?.code === 'string') error.code = response.code;
          throw error;
        }
        return response.result;
      } catch (error) {
        this._progress(this._progressPhase,{reason:error.message,code:terminalCode(error) || error.code});
        throw error;
      }
    }
    async inspect() {
      await this.inject();
      const inspection = await this.command('inspect');
      if (inspection.pageKind === 'add-video' && inspection.ready && !this.lastVerified) this.addUrl = (await this.tab()).url;
      if (this.lastVerified && (await this.tab()).url === this.lastVerifiedUrl)
        return {...inspection,ready:true,reason:'上一条视频已入库。继续时会自动回到添加视频页。'};
      return inspection;
    }
    async diagnostics() { await this.inject(); return this.command('diagnostics'); }
    async waitUntilReady() {
      const deadline = this.now() + 45000;
      let reason = '等待独立上传页加载';
      while(this.now() < deadline) {
        // A closed tab or navigation outside WeChat must not cause retargeting.
        const tab = await this.tab();
        if(tab.status === 'complete') {
          await this._pulseRender();
          try {
            const inspection = await this.inspect();
            this._progress('opening',inspection,'独立上传页已就绪');
            if(inspection.ready && inspection.pageKind === 'add-video') return inspection;
            reason = inspection.reason || '添加视频表单尚未就绪';
          } catch(error) { if (terminalCode(error)) throw error; reason = error.message; }
        }
        this._progress('opening',{reason});
        this.onNotice(reason);
        await this._waitWithRendering(500);
      }
      throw new Error(`独立上传页加载超时：${reason}`);
    }
    async freshPage() {
      const currentTab = await this.tab();
      if(this.lastVerifiedUrl && currentTab.url !== this.lastVerifiedUrl)
        throw new Error('公众号页面已被手动切换。请先回到刚才保存后的页面，再继续队列。');
      if (!this.addUrl || new URL(this.addUrl).origin !== ORIGIN) throw new Error('尚未绑定添加视频页。');
      await this.api.tabs.update(this.targetTabId, {url:this.addUrl});
      const deadline = this.now() + 45000;
      let sawLoading = false;
      while (this.now() < deadline) {
        await this.wait(500);
        const tab = await this.tab();
        if (tab.status === 'loading') sawLoading = true;
        if (tab.status === 'complete' && tab.url === this.addUrl) {
          await this.inject();
          const result = await this.command('inspect');
          if (result.ready && result.pageKind === 'add-video') { this.lastVerified = false; return; }
          if (sawLoading && result.pageKind !== 'add-video') throw new Error(result.reason || '未能回到添加视频页。');
        }
      }
      throw new Error('打开下一条视频的上传页超时。请检查登录状态。');
    }
    async upload(item, hooks) {
      if (this.lastVerified) await this.freshPage();
      const inspection = await this.inspect();
      if (!inspection.ready) throw new Error(inspection.reason || '添加视频页未就绪。');
      if (!item.title.trim() || item.title.length > 64) throw new Error('标题不能为空，且最多 64 字。');
      const {id,name,size,type,lastModified,title} = item;
      await this.command('begin', {id,name,size,type,lastModified,title});
      await hooks.transition('uploading');
      this._progress('uploading',{},'正在准备并上传视频');
      let index = 0;
      for (let offset = 0; offset < item.file.size; offset += CHUNK_SIZE) {
        const data = encode(await item.file.slice(offset, offset + CHUNK_SIZE).arrayBuffer());
        await this.command('chunk', {id,index:index++,data});
        this.onNotice(`正在准备「${title}」：${Math.min(100,Math.round((offset+CHUNK_SIZE)/item.file.size*100))}%`);
      }
      await this.command('attach', {id});
      await hooks.transition('processing');
      let ready = false;
      let lastPreparationReason = '';
      const deadline = this.now() + this.uploadTimeout;
      while (this.now() < deadline) {
        // Let pending crop/modal rendering finish before the adapter evaluates
        // its deadline. A hidden tab cannot rely on native animation frames.
        await this._pulseRender();
        const state = await this.command('status', {id});
        const preparing = state.uploadComplete === true && !state.titleNeedsSync && (state.needsPreparation === true || state.preparationReady === false);
        this._progressPhase = preparing ? 'preparing' : 'processing';
        // Preparation returns a fresher snapshot. Emit one merged observation
        // per poll so an unchanged pending dialog does not alternate log phases.
        if (!preparing || state.error) this._progress(this._progressPhase,state,'等待上传完成');
        if (state.error) throw new Error(typeof state.error === 'string' ? state.error : state.reason || '公众号报告上传失败。');
        this.onNotice(`「${title}」：${state.reason || '等待上传完成'}`);
        if (state.uploadComplete && state.titleNeedsSync) await this.command('fillTitle', {id});
        else if (state.uploadComplete === true) {
          if (state.needsPreparation === true || state.preparationReady === false) {
            // Preparation is idempotent in the page adapter. Pending DOM updates
            // are polled within the same deadline, without attaching or saving again.
            const preparation = await this.command('prepare', {id});
            this._progress('preparing',{...state,...preparation,preparation:preparation?.preparation || state.preparation},'等待封面、原创和服务规则设置完成');
            if (preparation?.error) throw new Error(typeof preparation.error === 'string' ? preparation.error : preparation.reason || '视频保存准备失败。');
            lastPreparationReason = preparation?.reason || state.preparationReason || '等待封面、原创和服务规则设置完成';
            this.onNotice(`「${title}」：${lastPreparationReason}`);
          } else if (state.needsAgreement) await this.command('agree', {id});
          else if (state.readyToSave) { ready = true; break; }
        }
        await this._waitWithRendering(1000);
      }
      if (!ready) throw new Error(lastPreparationReason
        ? `等待视频保存准备完成超时：${lastPreparationReason}。请核对公众号页面上的封面、原创和协议提示。`
        : '等待上传完成超时。请核对公众号页面上的上传、转码或封面提示。');
      await hooks.transition('saving');
      this._progress('saving',{},'正在保存到素材库');
      const savedAt = this.now();
      let saveResult;
      let saveChannelError;
      try { saveResult = await this.command('save', {id}); }
      catch (error) {
        if (terminalCode(error)) { error.code = terminalCode(error); error.uncertain = true; throw error; }
        if (error instanceof PageError) throw error;
        saveChannelError = error;
      }
      if (!this.verifyAfterSave) {
        // Submission-only mode advances after one durable Save attempt. A
        // click acknowledgement is not evidence that the material was stored.
        if (saveResult?.clicked === true) {
          const reason = '保存已提交，将继续下一项。';
          this._progress('submitted',{submitted:true,verified:false,reason});
          this.onNotice(`「${title}」：${reason}`);
          return {submitted:true,verified:false};
        }
        const detail = saveChannelError?.message || '页面没有返回保存点击确认。';
        const reason = `保存响应未确认，已跳过此项并继续下一项。${detail}`.slice(0,500);
        this._progress('uncertain',{uncertain:true,verified:false,reason});
        this.onNotice(`「${title}」：${reason}`);
        return {uncertain:true,verified:false,reason};
      }
      // A navigation may close the response channel after Save. Never click twice.
      await hooks.transition('verifying');
      this._progress('verifying',{},'正在核对素材库保存结果');
      const verifyDeadline = this.now() + this.verifyTimeout;
      let lastReason = '没有观察到明确的入库结果。';
      while (this.now() < verifyDeadline) {
        await this.wait(750);
        try {
          await this.inject();
          const result = await this.command('verify', {id,title,savedAt});
          this._progress('verifying',result,'正在核对素材库保存结果');
          lastReason = result.reason || lastReason;
          if (result.verified === true) {
            const verifiedUrl = (await this.tab()).url;
            this.lastVerified = true;
            this.lastVerifiedUrl = verifiedUrl;
            this.onNotice(`「${title}」已保存到素材库。`);
            this._progress('succeeded',{verified:true},'已保存到素材库');
            return {verified:true};
          }
        } catch(error) {
          const code = terminalCode(error);
          if (code) {
            error.code = code;
            error.uncertain = true;
            this._progress('verifying',{reason:error.message,code});
            throw error;
          }
          lastReason = error.message || '页面核对通道没有返回结果。';
          this._progress('verifying',{reason:lastReason});
        }
      }
      const error = new Error(`保存结果需要人工核对：${lastReason} 请在素材库确认后再处理此项。`);
      error.uncertain = true;
      throw error;
    }
  }
  global.WXVideoTransport = WXVideoTransport;
})(globalThis);
