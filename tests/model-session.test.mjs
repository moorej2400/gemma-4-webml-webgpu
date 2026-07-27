import assert from "node:assert/strict";
import test from "node:test";

import {
  ModelSession,
  UnsupportedModelSessionError,
} from "../model-session.mjs";

class FakeLockManager {
  #owner = null;

  async request(name, options, callback) {
    assert.equal(options.mode, "exclusive");
    assert.equal(options.ifAvailable, true);

    if (this.#owner) return callback(null);

    const token = { name };
    this.#owner = token;
    try {
      return await callback(token);
    } finally {
      if (this.#owner === token) this.#owner = null;
    }
  }
}

test("fails closed when Web Locks are unavailable", async () => {
  const session = new ModelSession({ locks: null });

  await assert.rejects(
    session.acquire(),
    UnsupportedModelSessionError,
  );
  assert.equal(session.state, "idle");
});

test("grants exactly one owner during simultaneous acquisition", async () => {
  const locks = new FakeLockManager();
  const first = new ModelSession({ locks });
  const second = new ModelSession({ locks });

  const results = await Promise.all([first.acquire(), second.acquire()]);

  assert.deepEqual(results.sort(), [false, true]);
  assert.equal([first.state, second.state].filter((state) => state === "owned").length, 1);

  const owner = first.state === "owned" ? first : second;
  await owner.release(async () => {});
});

test("waits for cleanup before releasing ownership", async () => {
  const locks = new FakeLockManager();
  const owner = new ModelSession({ locks });
  const peer = new ModelSession({ locks });
  const cleanup = Promise.withResolvers();

  assert.equal(await owner.acquire(), true);
  const releasePromise = owner.release(async () => cleanup.promise);
  assert.equal(owner.state, "releasing");
  assert.equal(await peer.acquire(), false);

  cleanup.resolve();
  await releasePromise;
  assert.equal(owner.state, "idle");
  assert.equal(await peer.acquire(), true);
  await peer.release(async () => {});
});

test("retains ownership when cleanup fails", async () => {
  const locks = new FakeLockManager();
  const owner = new ModelSession({ locks });
  const peer = new ModelSession({ locks });

  assert.equal(await owner.acquire(), true);
  await assert.rejects(
    owner.release(async () => {
      throw new Error("GPU cleanup failed");
    }),
    /GPU cleanup failed/,
  );

  assert.equal(owner.state, "owned");
  assert.equal(await peer.acquire(), false);
  await owner.release(async () => {});
});

test("shares one in-flight release", async () => {
  const session = new ModelSession({ locks: new FakeLockManager() });
  const cleanup = Promise.withResolvers();
  let cleanupCalls = 0;

  assert.equal(await session.acquire(), true);
  const first = session.release(async () => {
    cleanupCalls += 1;
    await cleanup.promise;
  });
  const second = session.release(async () => {
    cleanupCalls += 1;
  });

  assert.equal(first, second);
  cleanup.resolve();
  await first;
  assert.equal(cleanupCalls, 1);
  assert.equal(session.state, "idle");
});

test("allows a blocked session to retry after the owner releases", async () => {
  const locks = new FakeLockManager();
  const owner = new ModelSession({ locks });
  const peer = new ModelSession({ locks });

  assert.equal(await owner.acquire(), true);
  assert.equal(await peer.acquire(), false);
  assert.equal(peer.state, "blocked");
  await owner.release(async () => {});

  assert.equal(await peer.acquire(), true);
  await peer.release(async () => {});
});
