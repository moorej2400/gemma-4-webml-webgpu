import assert from "node:assert/strict";
import test from "node:test";

import { SubmissionFlow } from "../submission-flow.mjs";

test("loads before generating the original prompt exactly once", async () => {
  let ready = false;
  const events = [];
  const flow = new SubmissionFlow({
    isReady: () => ready,
    load: async () => {
      events.push("load");
      ready = true;
    },
    generate: async (prompt) => {
      events.push(`generate:${prompt}`);
    },
  });

  const result = await flow.submit("hello");

  assert.deepEqual(result, { status: "sent", prompt: "hello" });
  assert.deepEqual(events, ["load", "generate:hello"]);
});

test("preserves the prompt when loading finishes without readiness", async () => {
  let loadCalls = 0;
  let generateCalls = 0;
  const flow = new SubmissionFlow({
    isReady: () => false,
    load: async () => {
      loadCalls += 1;
    },
    generate: async () => {
      generateCalls += 1;
    },
  });

  const result = await flow.submit("try again");

  assert.deepEqual(result, { status: "not-ready", prompt: "try again" });
  assert.equal(loadCalls, 1);
  assert.equal(generateCalls, 0);
});

test("shares one in-flight submission without duplicating work", async () => {
  let ready = false;
  let loadCalls = 0;
  const generated = [];
  let finishLoading;
  const loading = new Promise((resolve) => {
    finishLoading = resolve;
  });
  const flow = new SubmissionFlow({
    isReady: () => ready,
    load: async () => {
      loadCalls += 1;
      await loading;
      ready = true;
    },
    generate: async (prompt) => {
      generated.push(prompt);
    },
  });

  const first = flow.submit("original");
  const repeated = flow.submit("replacement");

  assert.strictEqual(repeated, first);
  assert.equal(loadCalls, 1);
  finishLoading();

  assert.deepEqual(await first, { status: "sent", prompt: "original" });
  assert.deepEqual(generated, ["original"]);
});

test("resets the in-flight guard after success", async () => {
  const generated = [];
  const flow = new SubmissionFlow({
    isReady: () => true,
    load: async () => {
      assert.fail("load should not run when already ready");
    },
    generate: async (prompt) => {
      generated.push(prompt);
    },
  });

  await flow.submit("first");
  await flow.submit("second");

  assert.deepEqual(generated, ["first", "second"]);
});

test("resets the in-flight guard after rejection so submission can retry", async () => {
  let attempts = 0;
  const flow = new SubmissionFlow({
    isReady: () => true,
    load: async () => {
      assert.fail("load should not run when already ready");
    },
    generate: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("generation failed");
    },
  });

  await assert.rejects(flow.submit("first"), /generation failed/);

  assert.deepEqual(
    await flow.submit("retry"),
    { status: "sent", prompt: "retry" },
  );
  assert.equal(attempts, 2);
});
