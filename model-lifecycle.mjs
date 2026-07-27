/**
 * Publishes a model only after ownership, loading, and warmup all succeed.
 *
 * Runtime import is deliberately deferred until after the Web Lock is owned so
 * blocked tabs cannot allocate an adapter or initialize model resources.
 */
export class ModelLifecycle {
  #session;
  #importRuntime;
  #loaderProfile;
  #onStateChange;
  #state = "idle";
  #model = null;
  #candidate = null;
  #loadAbortController = null;
  #loadPromise = null;
  #disposePromise = null;

  constructor({
    session,
    importRuntime,
    loaderProfile = {},
    onStateChange = () => {},
  }) {
    this.#session = session;
    this.#importRuntime = importRuntime;
    this.#loaderProfile = loaderProfile;
    this.#onStateChange = onStateChange;
  }

  get state() {
    return this.#state;
  }

  get model() {
    return this.#model;
  }

  load({ onProgress } = {}) {
    if (this.#model) {
      return Promise.resolve({ status: "ready", model: this.#model });
    }
    if (this.#loadPromise) return this.#loadPromise;

    this.#loadPromise = this.#runLoad(onProgress);
    return this.#loadPromise;
  }

  dispose() {
    if (this.#disposePromise) return this.#disposePromise;
    this.#disposePromise = this.#runDispose();
    return this.#disposePromise;
  }

  async #runLoad(onProgress) {
    this.#setState("acquiring");
    try {
      if (!await this.#session.acquire()) {
        this.#setState("blocked");
        return { status: "blocked", model: null };
      }

      this.#setState("loading");
      this.#loadAbortController = new AbortController();
      const { Gemma4Mobile } = await this.#importRuntime();
      this.#candidate = await Gemma4Mobile.load(null, {
        ...this.#loaderProfile,
        signal: this.#loadAbortController.signal,
        onProgress,
      });

      this.#setState("warming");
      await this.#candidate.warmup();
      this.#model = this.#candidate;
      this.#candidate = null;
      this.#setState("ready");
      return { status: "ready", model: this.#model };
    } catch (error) {
      this.#loadAbortController?.abort(error);
      await this.#releaseResources();
      this.#setState("error");
      throw error;
    } finally {
      this.#loadAbortController = null;
      this.#loadPromise = null;
    }
  }

  async #runDispose() {
    try {
      this.#setState("releasing");
      this.#loadAbortController?.abort(new DOMException("Model disposed", "AbortError"));
      const activeLoad = this.#loadPromise;
      if (activeLoad) await activeLoad.catch(() => {});
      await this.#releaseResources();
      this.#setState("idle");
    } finally {
      this.#disposePromise = null;
    }
  }

  async #releaseResources() {
    const cleanup = async () => {
      const candidate = this.#candidate;
      const model = this.#model;
      if (candidate) await candidate.dispose();
      if (model && model !== candidate) await model.dispose();
      this.#candidate = null;
      this.#model = null;
    };

    if (this.#session.state === "owned") {
      await this.#session.release(cleanup);
    } else {
      await cleanup();
    }
  }

  #setState(state) {
    this.#state = state;
    this.#onStateChange(state);
  }
}
