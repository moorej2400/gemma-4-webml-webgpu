import assert from "node:assert/strict";
import test from "node:test";

import { ModelLifecycle } from "../model-lifecycle.mjs";

class FakeSession {
  constructor(results = [true]) {
    this.results = [...results];
    this.state = "idle";
    this.events = [];
  }

  async acquire() {
    this.events.push("acquire");
    const result = this.results.length ? this.results.shift() : true;
    this.state = result ? "owned" : "blocked";
    return result;
  }

  release(cleanup) {
    this.events.push("release:start");
    this.state = "releasing";
    return Promise.resolve()
      .then(cleanup)
      .then(() => {
        this.events.push("release:end");
        this.state = "idle";
      });
  }
}

function fakeModel(events, { warmupError = null, disposeGate = null } = {}) {
  return {
    async warmup() {
      events.push("warmup");
      if (warmupError) throw warmupError;
    },
    async dispose() {
      events.push("dispose:start");
      if (disposeGate) await disposeGate.promise;
      events.push("dispose:end");
    },
  };
}

test("does not import or load when another page owns the model", async () => {
  const session = new FakeSession([false]);
  let imports = 0;
  const lifecycle = new ModelLifecycle({
    session,
    importRuntime: async () => {
      imports += 1;
      return {};
    },
  });

  const result = await lifecycle.load();

  assert.deepEqual(result, { status: "blocked", model: null });
  assert.equal(imports, 0);
  assert.equal(lifecycle.state, "blocked");
});

test("imports only after ownership and publishes only after warmup", async () => {
  const session = new FakeSession();
  const events = session.events;
  const candidate = fakeModel(events);
  const lifecycle = new ModelLifecycle({
    session,
    loaderProfile: { concurrency: 1, chunkMaxBytes: 32 * 1024 * 1024 },
    importRuntime: async () => {
      events.push("import");
      return {
        Gemma4Mobile: {
          async load(modelId, options) {
            events.push("load");
            assert.equal(modelId, null);
            assert.equal(options.concurrency, 1);
            assert.equal(options.chunkMaxBytes, 32 * 1024 * 1024);
            assert.ok(options.signal);
            return candidate;
          },
        },
      };
    },
  });

  const result = await lifecycle.load();

  assert.deepEqual(events, ["acquire", "import", "load", "warmup"]);
  assert.equal(result.status, "ready");
  assert.equal(result.model, candidate);
  assert.equal(lifecycle.model, candidate);
  assert.equal(lifecycle.state, "ready");
  await lifecycle.dispose();
});

test("disposes a warmup candidate before releasing ownership", async () => {
  const session = new FakeSession();
  const events = session.events;
  const lifecycle = new ModelLifecycle({
    session,
    importRuntime: async () => ({
      Gemma4Mobile: {
        load: async () => fakeModel(events, { warmupError: new Error("warmup failed") }),
      },
    }),
  });

  await assert.rejects(lifecycle.load(), /warmup failed/);

  assert.deepEqual(events, [
    "acquire",
    "warmup",
    "release:start",
    "dispose:start",
    "dispose:end",
    "release:end",
  ]);
  assert.equal(lifecycle.model, null);
  assert.equal(session.state, "idle");
});

test("releases ownership after loader rejection and permits retry", async () => {
  const session = new FakeSession([true, true]);
  let attempts = 0;
  const lifecycle = new ModelLifecycle({
    session,
    importRuntime: async () => ({
      Gemma4Mobile: {
        async load() {
          attempts += 1;
          if (attempts === 1) throw new Error("weights failed after runtime cleanup");
          return fakeModel(session.events);
        },
      },
    }),
  });

  await assert.rejects(lifecycle.load(), /weights failed/);
  assert.equal(session.state, "idle");
  assert.equal((await lifecycle.load()).status, "ready");
  await lifecycle.dispose();
});

test("shares disposal and releases only after model cleanup", async () => {
  const session = new FakeSession();
  const gate = Promise.withResolvers();
  const lifecycle = new ModelLifecycle({
    session,
    importRuntime: async () => ({
      Gemma4Mobile: {
        load: async () => fakeModel(session.events, { disposeGate: gate }),
      },
    }),
  });
  await lifecycle.load();

  const first = lifecycle.dispose();
  const second = lifecycle.dispose();
  assert.equal(first, second);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(session.events.slice(-2), ["release:start", "dispose:start"]);

  gate.resolve();
  await first;
  assert.deepEqual(session.events.slice(-4), [
    "release:start",
    "dispose:start",
    "dispose:end",
    "release:end",
  ]);
  assert.equal(lifecycle.model, null);
  assert.equal(lifecycle.state, "idle");
});
