/* Browser-first queue. Files stay in memory; only snapshot() may be persisted. */
(function (global) {
  "use strict";

  const STATUSES = new Set([
    "queued", "opening", "uploading", "processing", "saving", "verifying",
    "succeeded", "submitted", "failed", "uncertain", "interrupted",
  ]);
  const ACTIVE = new Set(["opening", "uploading", "processing", "saving", "verifying"]);
  const TERMINAL = new Set(["succeeded", "submitted"]);
  const AFTER_SAVE = new Set(["saving", "verifying", "succeeded", "submitted", "uncertain"]);
  const BLOCKING = new Set(["failed", "interrupted"]);
  const NO_CHANGE = Symbol("no queue change");
  const NEXT = {
    opening: new Set(["uploading"]),
    uploading: new Set(["processing", "saving"]),
    processing: new Set(["saving"]),
    saving: new Set(["verifying", "submitted"]),
    verifying: new Set(["succeeded"]),
  };

  function messageOf(error) {
    return error instanceof Error ? error.message : String(error);
  }

  function uncertainMessage(reason) {
    const notice = "结果未确认，已跳过，不自动重传。";
    const detail = (reason ? messageOf(reason) : "")
      .replace(/保存结果需要人工核对[:：]?/g, "保存结果未确认：")
      .replace(/请先核对素材库是否已经入库。?/g, "")
      .replace(/请在素材库确认后再处理此项。?/g, "")
      .replace(/请人工核对。?/g, "")
      .trim();
    return detail.includes(notice) ? detail : detail ? `${notice} ${detail}` : notice;
  }

  function metadata(file) {
    if (!file || typeof file.name !== "string" || !file.name ||
        !Number.isSafeInteger(file.size) || file.size < 0 ||
        !Number.isSafeInteger(file.lastModified) || file.lastModified < 0) {
      throw new TypeError("请选择带有完整文件信息的视频文件。");
    }
    return { name: file.name, size: file.size, lastModified: file.lastModified, type: file.type || "" };
  }

  function keyOf(file) {
    return JSON.stringify([file.name, file.size, file.lastModified]);
  }

  function id() {
    return global.crypto?.randomUUID?.() || `video-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  class PersistenceError extends Error {
    constructor(cause) {
      super(`无法保存队列进度，已停止：${messageOf(cause)}`);
      this.name = "PersistenceError";
      this.cause = cause;
    }
  }

  class WXVideoQueue {
    constructor({ persist = async () => {}, onChange } = {}) {
      if (typeof persist !== "function") throw new TypeError("persist must be a function");
      this._persist = persist;
      this._items = [];
      this._listeners = new Set();
      this._running = false;
      this._pauseRequested = false;
      this._persistenceError = null;
      this._mutationTail = Promise.resolve();
      this._activeIds = new Set();
      this._concurrency = 1;
      if (onChange) this.subscribe(onChange);
    }

    get running() { return this._running; }

    _publicItem(item) {
      return {
        id: item.id, name: item.name, size: item.size, lastModified: item.lastModified,
        type: item.type, title: item.title, description: item.description,
        status: item.status, error: item.error || null, hasFile: Boolean(item.file),
      };
    }

    _snapshot(items = this._items) {
      return {
        version: 1,
        items: items.map((item) => this._publicItem(item)),
        running: this._running,
        pauseRequested: this._pauseRequested,
        persistenceError: this._persistenceError,
        activeCount: this._activeIds.size,
        concurrency: this._concurrency,
      };
    }

    snapshot() { return this._snapshot(); }

    subscribe(callback) {
      if (typeof callback !== "function") throw new TypeError("listener must be a function");
      this._listeners.add(callback);
      callback(this.snapshot());
      return () => this._listeners.delete(callback);
    }

    _notify() {
      for (const listener of this._listeners) {
        try { listener(this.snapshot()); }
        catch (error) { global.console?.error("Queue listener error", error); }
      }
    }

    _serialize(operation) {
      const result = this._mutationTail.then(operation);
      this._mutationTail = result.catch(() => {});
      return result;
    }

    _commit(change) {
      return this._serialize(async () => {
        if (this._persistenceError) throw new PersistenceError(this._persistenceError);
        const draft = this._items.map((item) => ({ ...item }));
        const result = change(draft);
        if (result === NO_CHANGE) return null;
        try {
          // Persist the next state before exposing it to code that can act on the page.
          await this._persist(this._snapshot(draft));
        } catch (error) {
          const failure = new PersistenceError(error);
          this._persistenceError = failure.message;
          this._pauseRequested = true;
          this._notify();
          throw failure;
        }
        this._items = draft;
        this._notify();
        return result;
      });
    }

    _find(items, itemId) {
      const item = items.find((entry) => entry.id === itemId);
      if (!item) throw new Error("找不到该队列项目。");
      return item;
    }

    _assertEditable(item) {
      if (ACTIVE.has(item.status) || this._activeIds.has(item.id)) {
        throw new Error("正在处理的视频不能修改或移除。");
      }
    }

    addFiles(files) {
      const additions = Array.from(files, (file) => ({
        ...metadata(file), id: id(), file,
        title: file.name.replace(/\.[^.]+$/, ""), description: "",
        status: "queued", error: null,
      }));
      return this._commit((items) => {
        const keys = new Set(items.map(keyOf));
        for (const item of additions) {
          if (keys.has(keyOf(item))) throw new Error(`文件重复或信息相同，无法区分：${item.name}`);
          keys.add(keyOf(item));
          items.push(item);
        }
        return additions.map((item) => item.id);
      });
    }

    updateItem(itemId, changes) {
      return this._commit((items) => {
        const item = this._find(items, itemId);
        this._assertEditable(item);
        for (const field of ["title", "description"]) {
          if (Object.prototype.hasOwnProperty.call(changes, field)) {
            if (typeof changes[field] !== "string") throw new TypeError(`${field} must be a string`);
            item[field] = changes[field];
          }
        }
      });
    }

    remove(itemId) {
      return this._commit((items) => {
        const item = this._find(items, itemId);
        this._assertEditable(item);
        items.splice(items.indexOf(item), 1);
      });
    }

    attachFiles(files) {
      const candidates = Array.from(files, (file) => ({ file, ...metadata(file) }));
      return this._commit((items) => {
        const seen = new Set();
        const attachments = [];
        for (const candidate of candidates) {
          const key = keyOf(candidate);
          if (seen.has(key)) throw new Error(`所选文件信息重复，无法区分：${candidate.name}`);
          seen.add(key);
          const matches = items.filter((item) => keyOf(item) === key);
          if (matches.length !== 1) {
            throw new Error(matches.length ? `队列文件信息重复，无法区分：${candidate.name}` : `文件与队列不匹配：${candidate.name}`);
          }
          this._assertEditable(matches[0]);
          attachments.push([matches[0], candidate.file]);
        }
        for (const [item, file] of attachments) item.file = file;
        return attachments.map(([item]) => item.id);
      });
    }

    requeue(itemId, { confirmedNotSaved = false } = {}) {
      return this._commit((items) => {
        const item = this._find(items, itemId);
        this._assertEditable(item);
        if (!["failed", "uncertain", "interrupted"].includes(item.status)) {
          throw new Error("只能重新排队失败、结果不明或中断的视频。");
        }
        if (!confirmedNotSaved) throw new Error("请先核对素材库，确认视频尚未入库后再重试。");
        item.status = "queued";
        item.error = null;
      });
    }

    restore(snapshot) {
      if (this._running) return Promise.reject(new Error("运行期间不能恢复队列。"));
      if (!snapshot || snapshot.version !== 1 || !Array.isArray(snapshot.items)) {
        return Promise.reject(new Error("队列记录格式无效。"));
      }
      return this._commit((items) => {
        if (this._running) throw new Error("运行期间不能恢复队列。");
        const ids = new Set();
        const keys = new Set();
        const restored = snapshot.items.map((saved) => {
          const info = metadata(saved);
          if (typeof saved.id !== "string" || !saved.id || ids.has(saved.id)) throw new Error("队列项目 ID 无效或重复。");
          if (keys.has(keyOf(info))) throw new Error(`队列文件信息重复，无法区分：${info.name}`);
          if (!STATUSES.has(saved.status)) throw new Error("队列项目状态无效。");
          ids.add(saved.id);
          keys.add(keyOf(info));
          let status = saved.status;
          let error = typeof saved.error === "string" ? saved.error : null;
          if (["saving", "verifying"].includes(status)) {
            status = "uncertain";
            error = uncertainMessage("上次保存过程被中断。");
          } else if (ACTIVE.has(status)) {
            status = "interrupted";
            error = "上次上传被中断，请核对素材库后重新排队。";
          } else if (status === "uncertain") {
            error = uncertainMessage(error);
          }
          return {
            ...info, id: saved.id, file: null,
            title: typeof saved.title === "string" ? saved.title : info.name.replace(/\.[^.]+$/, ""),
            description: typeof saved.description === "string" ? saved.description : "",
            status, error,
          };
        });
        items.splice(0, items.length, ...restored);
      });
    }

    pause() {
      this._pauseRequested = true;
      this._notify();
    }

    // Explicit recovery after the caller has repaired the storage problem.
    resumePersistence() {
      return this._serialize(async () => {
        if (this._running) throw new Error("请等待当前任务停止后再恢复进度保存。");
        try {
          await this._persist({ ...this.snapshot(), persistenceError: null });
        } catch (error) {
          this._persistenceError = new PersistenceError(error).message;
          this._notify();
          throw new PersistenceError(error);
        }
        this._persistenceError = null;
        this._notify();
      });
    }

    async _transition(itemId, next, { submittedResult = false } = {}) {
      return this._commit((items) => {
        const item = this._find(items, itemId);
        const valid = item.status === "queued" ? next === "opening" : NEXT[item.status]?.has(next);
        if (!valid || (next === "submitted" && !submittedResult)) throw new Error(`无效的队列状态变化：${item.status} → ${next}`);
        item.status = next;
        item.error = null;
      });
    }

    _claimNext() {
      // Selection and the opening checkpoint share the mutation queue. An edit
      // already being persisted must finish before we choose its upload data.
      return this._commit((items) => {
        if (this._pauseRequested) return NO_CHANGE;
        const blocked = items.find((item) => BLOCKING.has(item.status));
        if (blocked) throw new Error(`请先处理或移除异常项目“${blocked.name}”，核对素材库后才能继续。`);
        const item = items.find((entry) => entry.status === "queued" && entry.file);
        if (!item) return NO_CHANGE;
        this._activeIds.add(item.id);
        item.status = "opening";
        item.error = null;
        return item;
      });
    }

    async _runWorker(adapter) {
      while (!this._pauseRequested) {
        const item = await this._claimNext();
        if (!item) return;
        let acceptingTransitions = true;
        try {
          const result = await adapter.upload({ ...this._publicItem(item), file: item.file }, {
            // Each worker must persist its own saving checkpoint before its Save click.
            transition: (next) => {
              if (!acceptingTransitions) return Promise.reject(new Error("该项目的上传流程已经结束。"));
              return this._transition(item.id, next);
            },
            // Pause only stops new claims; every already active tab finishes safely.
            shouldPause: () => this._pauseRequested,
          });
          const current = this._find(this._items, item.id);
          if (!TERMINAL.has(current.status)) {
            if (current.status === "saving" && result?.submitted === true) {
              // A Save acknowledgement is distinct from verified library success.
              await this._transition(item.id, "submitted", { submittedResult: true });
            } else if (["saving", "verifying"].includes(current.status) && result?.uncertain === true) {
              await this._commit((items) => {
                const uncertain = this._find(items, item.id);
                uncertain.status = "uncertain";
                uncertain.error = uncertainMessage(result.reason);
              });
            } else {
              if (current.status !== "verifying" || result?.verified !== true)
                throw new Error("未能确认视频已保存到素材库。");
              await this._transition(item.id, "succeeded");
            }
          }
        } catch (error) {
          acceptingTransitions = false;
          if (error instanceof PersistenceError || this._persistenceError) {
            this._pauseRequested = true;
            throw error;
          }
          const current = this._find(this._items, item.id);
          if (!TERMINAL.has(current.status)) {
            const afterSave = AFTER_SAVE.has(current.status);
            // Pre-save failures stop new claims immediately. A completed Save
            // attempt is recorded without retrying it, then the next file may run.
            if (!afterSave) this._pauseRequested = true;
            await this._commit((items) => {
              const failed = this._find(items, item.id);
              failed.status = afterSave ? "uncertain" : "failed";
              failed.error = afterSave ? uncertainMessage(error) : messageOf(error);
            });
          }
        } finally {
          acceptingTransitions = false;
          // Keep interrupted IDs until every worker has settled. The last durable
          // save boundary determines whether each item may already be in the library.
          if (!this._persistenceError || TERMINAL.has(this._find(this._items, item.id).status))
            this._activeIds.delete(item.id);
          this._notify();
        }
      }
    }

    async start(adapter, { concurrency = 1 } = {}) {
      if (this._running) throw new Error("队列已经在运行。");
      if (!adapter || typeof adapter.upload !== "function") throw new TypeError("adapter.upload is required");
      if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 10)
        throw new Error("同时上传数量只能设为 1 至 10 之间的整数。");
      if (this._persistenceError) throw new PersistenceError(this._persistenceError);
      this._running = true;
      this._concurrency = concurrency;
      this._pauseRequested = false;
      this._notify();
      try {
        // Never reject early: other tabs may still be completing Save or verifying
        // an accepted upload, so retain the running lock until they all settle.
        const results = await Promise.allSettled(Array.from({ length: concurrency }, () => this._runWorker(adapter)));
        const failure = results.find(result => result.status === "rejected");
        if (failure) throw failure.reason;
      } catch (error) {
        if (this._persistenceError) {
          for (const itemId of this._activeIds) {
            const current = this._find(this._items, itemId);
            if (TERMINAL.has(current.status)) continue;
            current.status = AFTER_SAVE.has(current.status) ? "uncertain" : "interrupted";
            current.error = messageOf(error);
          }
          this._notify();
        }
        throw error;
      } finally {
        this._activeIds.clear();
        this._running = false;
        this._notify();
      }
      return this.snapshot();
    }
  }

  WXVideoQueue.PersistenceError = PersistenceError;
  WXVideoQueue.STATUSES = Object.freeze([...STATUSES]);
  global.WXVideoQueue = WXVideoQueue;
})(globalThis);
