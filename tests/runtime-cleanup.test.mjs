import assert from "node:assert/strict";
import test from "node:test";

import { withOwnedRuntime } from "../gemma-4-e2b.pretty.js";

test("owned runtime destruction finishes before loader rejection", async () => {
  const events = [];
  const destroyGate = Promise.withResolvers();
  const runtime = {
    async destroy() {
      events.push("destroy:start");
      await destroyGate.promise;
      events.push("destroy:end");
    },
  };

  const loading = withOwnedRuntime(
    null,
    async () => runtime,
    async () => {
      events.push("allocate:gpu-buffer");
      throw new Error("failure after GPU allocation");
    },
  );
  let rejected = false;
  loading.catch(() => {
    rejected = true;
    events.push("rejected");
  });

  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(events, ["allocate:gpu-buffer", "destroy:start"]);
  assert.equal(rejected, false);

  destroyGate.resolve();
  await assert.rejects(loading, /failure after GPU allocation/);
  assert.deepEqual(events, [
    "allocate:gpu-buffer",
    "destroy:start",
    "destroy:end",
    "rejected",
  ]);
});

test("does not destroy a caller-owned runtime on failure", async () => {
  let destroyed = false;
  const runtime = {
    async destroy() {
      destroyed = true;
    },
  };

  await assert.rejects(
    withOwnedRuntime(runtime, async () => {
      throw new Error("must not create");
    }, async () => {
      throw new Error("load failed");
    }),
    /load failed/,
  );
  assert.equal(destroyed, false);
});
