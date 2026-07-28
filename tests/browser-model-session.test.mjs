import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Chromium may finish closing a context before its Web Lock release is visible
// to peers, so retry only the session's explicitly retryable blocked state.
async function waitForModelOwnership({
  attemptAcquire,
  timeoutMs = 2_000,
  pollIntervalMs = 20,
}) {
  const startedAt = performance.now();
  let attempts = 0;
  let result;

  while (true) {
    attempts += 1;
    result = await attemptAcquire();
    if (result.acquired) return { attempts, result };

    assert.equal(
      result.sessionState,
      "blocked",
      `Model acquisition may retry only from blocked: ${JSON.stringify({ attempts, result })}`,
    );

    const elapsedMs = performance.now() - startedAt;
    if (elapsedMs >= timeoutMs) break;
    await new Promise((resolve) => {
      setTimeout(resolve, Math.min(pollIntervalMs, timeoutMs - elapsedMs));
    });
  }

  assert.fail(`Timed out waiting for model ownership: ${JSON.stringify({
    attempts,
    elapsedMs: Math.round(performance.now() - startedAt),
    result,
  })}`);
}

test("model ownership polling retries while the session remains blocked", async () => {
  let attempts = 0;

  const acquisition = await waitForModelOwnership({
    attemptAcquire: async () => {
      attempts += 1;
      return {
        acquired: attempts === 3,
        sessionState: attempts === 3 ? "owned" : "blocked",
        lockSnapshot: { held: [], pending: [] },
      };
    },
  });

  assert.equal(acquisition.attempts, 3);
  assert.equal(acquisition.result.sessionState, "owned");
});

test("model ownership polling timeout reports the last session and lock state", async () => {
  await assert.rejects(
    waitForModelOwnership({
      timeoutMs: 0,
      attemptAcquire: async () => ({
        acquired: false,
        sessionState: "blocked",
        lockSnapshot: {
          held: [{ name: "gemma-4-webgpu-model", mode: "exclusive" }],
          pending: [],
        },
      }),
    }),
    (error) => {
      assert.match(error.message, /Timed out waiting for model ownership/);
      assert.match(error.message, /"attempts":1/);
      assert.match(error.message, /"sessionState":"blocked"/);
      assert.match(error.message, /"name":"gemma-4-webgpu-model"/);
      return true;
    },
  );
});

test("real browser grants one model owner and releases it on context termination", async (t) => {
  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url, "http://localhost").pathname;
    const relative = pathname === "/"
      ? "tests/model-session-harness.html"
      : pathname.replace(/^\/+/, "");

    try {
      const body = await readFile(path.join(root, relative));
      response.writeHead(200, {
        "Content-Type": relative.endsWith(".mjs") ? "text/javascript" : "text/html",
        "Cache-Control": "public, max-age=60",
      });
      response.end(body);
    } catch {
      response.writeHead(404);
      response.end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext();
  const origin = `http://127.0.0.1:${server.address().port}`;
  const first = await context.newPage();
  const second = await context.newPage();
  await Promise.all([
    first.goto(`${origin}/tests/model-session-harness.html`),
    second.goto(`${origin}/tests/model-session-harness.html`),
  ]);
  await Promise.all([
    first.waitForFunction(() => window.harnessReady === true),
    second.waitForFunction(() => window.harnessReady === true),
  ]);

  const [firstResult, secondResult] = await Promise.all([
    first.evaluate(() => window.acquireModel()),
    second.evaluate(() => window.acquireModel()),
  ]);
  assert.deepEqual([firstResult, secondResult].sort(), [false, true]);

  const owner = firstResult ? first : second;
  const peer = firstResult ? second : first;
  await owner.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
    window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
  });
  assert.deepEqual(
    await peer.evaluate(async () => ({
      acquired: await window.acquireModel(),
      sessionState: window.sessionState(),
    })),
    { acquired: false, sessionState: "blocked" },
  );

  await owner.close();
  const acquisition = await waitForModelOwnership({
    attemptAcquire: () => peer.evaluate(async () => ({
      acquired: await window.acquireModel(),
      sessionState: window.sessionState(),
      lockSnapshot: await navigator.locks.query(),
    })),
  });
  assert.equal(acquisition.result.sessionState, "owned");
  await peer.evaluate(() => window.releaseModel());
});
