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

const mockRuntime = `
  const state = window.__mockRuntimeState;

  export class Gemma4Mobile {
    static async load(_modelId, { signal } = {}) {
      state.loadCalls += 1;
      if (state.loadMode === "fail") throw new Error("mock load failed");
      if (state.loadMode === "delayed") {
        await new Promise((resolve, reject) => {
          state.releaseLoad = resolve;
          const abort = () => reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
          if (signal?.aborted) abort();
          else signal?.addEventListener("abort", abort, { once: true });
        });
        state.releaseLoad = null;
      }
      return new Gemma4Mobile();
    }

    async warmup() {}
    async dispose() {}
    reset() {}
    deviceInfo() { return { vendor: "test", features: {} }; }

    async *generate(messages, options) {
      state.generateCalls += 1;
      state.prompts.push(messages.at(-1).content);
      state.maxNewTokens.push(options.maxNewTokens);
      yield { text: "mock reply" };
    }
  }
`;

test("real browser enforces chat-first submission state", async (t) => {
  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url, "http://localhost").pathname;
    const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    try {
      const body = await readFile(path.join(root, relative));
      const contentType = relative.endsWith(".js") || relative.endsWith(".mjs")
        ? "text/javascript"
        : "text/html";
      response.writeHead(200, { "Content-Type": contentType, "Cache-Control": "no-store" });
      response.end(body);
    } catch {
      response.writeHead(404);
      response.end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const browser = await chromium.launch({
    headless: true,
    executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  });
  t.after(() => browser.close());
  const origin = `http://127.0.0.1:${server.address().port}`;
  let debugRequestSequence = 0;

  async function openApp({ gpu = true, locks = true, loadMode = "immediate" } = {}) {
    const context = await browser.newContext();
    await context.addInitScript(({ hasGpu, hasLocks, initialLoadMode }) => {
      Object.defineProperty(navigator, "gpu", {
        value: hasGpu ? {} : undefined,
        configurable: true,
      });
      if (!hasLocks) {
        Object.defineProperty(navigator, "locks", {
          value: undefined,
          configurable: true,
        });
      }
      window.__mockRuntimeState = {
        loadMode: initialLoadMode,
        loadCalls: 0,
        generateCalls: 0,
        prompts: [],
        maxNewTokens: [],
        releaseLoad: null,
      };
    }, { hasGpu: gpu, hasLocks: locks, initialLoadMode: loadMode });
    await context.route("**/gemma-4-e2b.pretty.js", (route) => route.fulfill({
      status: 200,
      contentType: "text/javascript",
      body: mockRuntime,
    }));
    await context.route("**/browser-runtime-loader.mjs", (route) => route.fulfill({
      status: 200,
      contentType: "text/javascript",
      body: 'export const loadBrowserRuntime = () => import("./gemma-4-e2b.pretty.js");',
    }));
    await context.route("https://esm.sh/**", (route) => route.abort());
    const page = await context.newPage();
    await page.goto(origin);
    await page.locator("#input").waitFor();
    return { context, page };
  }

  async function dispatchDebugCommand(page, command) {
    const requestId = `${command}-${++debugRequestSequence}`;
    return page.evaluate(({ commandName, id }) => new Promise((resolve) => {
      const onResult = (event) => {
        if (event.detail?.type !== "command-result") return;
        if (event.detail.payload?.requestId !== id) return;
        window.removeEventListener("webml-debug-event", onResult);
        resolve(event.detail.payload);
      };
      window.addEventListener("webml-debug-event", onResult);
      window.dispatchEvent(new CustomEvent("webml-debug-command", {
        detail: { command: commandName, requestId: id },
      }));
    }), { commandName: command, id: requestId });
  }

  await t.test("first send loads once and repeated submission generates once", async () => {
    const { context, page } = await openApp({ loadMode: "delayed" });
    try {
      await page.locator("#input").fill("retained first prompt");
      await page.locator("#sendBtn").click();
      await page.waitForFunction(() => typeof window.__mockRuntimeState.releaseLoad === "function");

      assert.equal(await page.locator("#input").inputValue(), "retained first prompt");
      assert.equal(await page.locator("#input").isDisabled(), true);
      assert.equal(await page.locator("#sendBtn").isDisabled(), true);

      await page.evaluate(() => {
        document.querySelector("#input").dispatchEvent(new KeyboardEvent("keydown", {
          key: "Enter",
          bubbles: true,
        }));
        document.querySelector("#sendBtn").dispatchEvent(new MouseEvent("click", {
          bubbles: true,
        }));
        window.__mockRuntimeState.releaseLoad();
      });
      await page.waitForFunction(() => window.__mockRuntimeState.generateCalls === 1);

      const state = await page.evaluate(() => window.__mockRuntimeState);
      assert.equal(state.loadCalls, 1);
      assert.equal(state.generateCalls, 1);
      assert.deepEqual(state.prompts, ["retained first prompt"]);
      assert.equal(await page.locator("#input").inputValue(), "");
    } finally {
      await context.close();
    }
  });

  await t.test("load failure keeps the prompt available for a successful retry", async () => {
    const { context, page } = await openApp({ loadMode: "fail" });
    try {
      await page.locator("#input").fill("retry this exact prompt");
      await page.locator("#sendBtn").click();
      await page.waitForFunction(() => document.querySelector("#statusText").textContent.includes("mock load failed"));

      assert.equal(await page.locator("#input").inputValue(), "retry this exact prompt");
      assert.equal(await page.locator("#input").isEnabled(), true);
      assert.equal(await page.locator("#sendBtn").isEnabled(), true);

      await page.evaluate(() => { window.__mockRuntimeState.loadMode = "immediate"; });
      await page.locator("#sendBtn").click();
      await page.waitForFunction(() => window.__mockRuntimeState.generateCalls === 1);

      const state = await page.evaluate(() => window.__mockRuntimeState);
      assert.equal(state.loadCalls, 2);
      assert.deepEqual(state.prompts, ["retry this exact prompt"]);
    } finally {
      await context.close();
    }
  });

  await t.test("disposing an in-flight first load preserves the prompt", async () => {
    const { context, page } = await openApp({ loadMode: "delayed" });
    try {
      await page.locator("#input").fill("keep after cancel");
      await page.locator("#sendBtn").click();
      await page.waitForFunction(() => typeof window.__mockRuntimeState.releaseLoad === "function");

      const result = await dispatchDebugCommand(page, "dispose-model");

      assert.equal(result.ok, true);
      assert.equal(await page.locator("#input").inputValue(), "keep after cancel");
      assert.equal(await page.locator("#input").isEnabled(), true);
      assert.equal(await page.locator("#sendBtn").isEnabled(), true);
      assert.equal(await page.evaluate(() => window.__mockRuntimeState.generateCalls), 0);
    } finally {
      await context.close();
    }
  });

  await t.test("unsupported capabilities keep all submission controls disabled", async () => {
    for (const capabilities of [
      { gpu: false, locks: true, status: "WebGPU unavailable" },
      { gpu: true, locks: false, status: "Web Locks are unavailable" },
    ]) {
      const { context, page } = await openApp(capabilities);
      try {
        await page.waitForFunction((text) => (
          document.querySelector("#statusText").textContent.includes(text)
        ), capabilities.status);

        assert.equal(await page.locator("#input").isDisabled(), true);
        assert.equal(await page.locator("#sendBtn").isDisabled(), true);
        assert.equal(await page.locator("#loadBtn").isDisabled(), true);
        assert.equal(await page.locator(".seed").evaluateAll(
          (seeds) => seeds.every((seed) => seed.disabled),
        ), true);
      } finally {
        await context.close();
      }
    }
  });
});
