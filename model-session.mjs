/**
 * Owns the single origin-wide model lease.
 *
 * The Web Lock callback stays pending for the complete GPU model lifetime.
 * Releasing on pagehide is unsafe because Safari may retain the page and its
 * GPU resources in the back-forward cache.
 */
export class ModelSession {
  #locks;
  #lockName;
  #state = "idle";
  #acquirePromise = null;
  #requestPromise = null;
  #releaseGate = null;
  #releasePromise = null;
  #onStateChange;

  constructor({
    locks = globalThis.navigator?.locks,
    lockName = "gemma-4-webgpu-model",
    onStateChange = () => {},
  } = {}) {
    this.#locks = locks;
    this.#lockName = lockName;
    this.#onStateChange = onStateChange;
  }

  get state() {
    return this.#state;
  }

  acquire() {
    if (!this.#locks?.request) {
      return Promise.reject(new UnsupportedModelSessionError());
    }
    if (this.#state === "owned") return Promise.resolve(true);
    if (this.#state === "acquiring") return this.#acquirePromise;
    if (this.#state === "releasing") return Promise.resolve(false);

    this.#setState("acquiring");
    const acquired = deferred();
    this.#acquirePromise = acquired.promise;

    this.#requestPromise = Promise.resolve().then(() => this.#locks.request(
      this.#lockName,
      { mode: "exclusive", ifAvailable: true },
      async (lock) => {
        if (!lock) {
          this.#setState("blocked");
          acquired.resolve(false);
          return;
        }

        this.#releaseGate = deferred();
        this.#setState("owned");
        acquired.resolve(true);
        await this.#releaseGate.promise;
      },
    )).catch((error) => {
      if (this.#state === "acquiring") {
        this.#setState("idle");
        acquired.reject(error);
      }
      throw error;
    });

    // Acquisition reports request failures through acquired.promise. After
    // ownership, the request only settles when release opens the gate.
    this.#requestPromise.catch(() => {});
    return this.#acquirePromise;
  }

  release(cleanup) {
    if (this.#releasePromise) return this.#releasePromise;
    if (this.#state !== "owned") return Promise.resolve();

    this.#setState("releasing");
    this.#releasePromise = (async () => {
      try {
        await cleanup();
      } catch (error) {
        // Retaining the lease is safer than allowing a peer to allocate a
        // second model while this document may still own GPU resources.
        this.#setState("owned");
        this.#releasePromise = null;
        throw error;
      }

      this.#releaseGate.resolve();
      await this.#requestPromise;
      this.#releaseGate = null;
      this.#requestPromise = null;
      this.#acquirePromise = null;
      this.#releasePromise = null;
      this.#setState("idle");
    })();
    return this.#releasePromise;
  }

  #setState(state) {
    this.#state = state;
    this.#onStateChange(state);
  }
}

export class UnsupportedModelSessionError extends Error {
  constructor() {
    super("This browser cannot safely own the model because Web Locks are unavailable.");
    this.name = "UnsupportedModelSessionError";
  }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
