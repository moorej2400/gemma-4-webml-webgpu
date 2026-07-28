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
  assert.equal(await peer.evaluate(() => window.acquireModel()), false);

  await owner.close();
  assert.equal(await peer.evaluate(() => window.acquireModel()), true);
  await peer.evaluate(() => window.releaseModel());
});
