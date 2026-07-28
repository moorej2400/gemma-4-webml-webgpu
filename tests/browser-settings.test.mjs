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
    static async load() {
      state.loadCalls += 1;
      return new Gemma4Mobile();
    }

    async warmup() {}
    async dispose() { state.disposeCalls += 1; }
    reset() {}
    deviceInfo() { return { vendor: "test", features: {} }; }
    async *generate() {
      state.generateCalls += 1;
      yield { text: "still running" };
    }
  }
`;

test("real browser Settings controls manual model control visibility", async (t) => {
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

  async function openApp({ showManualControls = null } = {}) {
    const context = await browser.newContext();
    await context.addInitScript((preference) => {
      Object.defineProperty(navigator, "gpu", { value: {}, configurable: true });
      window.__mockRuntimeState = {
        loadCalls: 0,
        disposeCalls: 0,
        generateCalls: 0,
      };
      if (preference !== null) {
        localStorage.setItem("gemma.showManualModelControls", String(preference));
      }
    }, showManualControls);
    await context.route("**/gemma-4-e2b.pretty.js", (route) => route.fulfill({
      status: 200,
      contentType: "text/javascript",
      body: mockRuntime,
    }));
    await context.route("https://esm.sh/**", (route) => route.abort());
    const page = await context.newPage();
    await page.goto(origin);
    await page.locator("#settingsBtn").waitFor();
    return { context, page };
  }

  await t.test("defaults hidden and exposes accessible closed Settings markup", async () => {
    const { context, page } = await openApp();
    try {
      assert.equal(await page.locator("#manualModelControls").isVisible(), false);
      assert.equal(await page.locator("#manualControlsToggle").isChecked(), false);
      assert.equal(await page.locator("#settingsPopover").isVisible(), false);
      assert.equal(await page.locator("#settingsBtn").getAttribute("title"), "Settings");
      assert.equal(await page.locator("#settingsBtn").getAttribute("aria-label"), "Settings");
      assert.equal(await page.locator("#settingsBtn").getAttribute("aria-expanded"), "false");
      assert.equal(await page.locator("#settingsBtn").getAttribute("aria-controls"), "settingsPopover");
      assert.equal(await page.locator("#manualControlsToggle").getAttribute("role"), "switch");
    } finally {
      await context.close();
    }
  });

  await t.test("restores true and persists visibility changes without loading", async () => {
    const { context, page } = await openApp({ showManualControls: true });
    try {
      assert.equal(await page.locator("#manualModelControls").isVisible(), true);
      assert.equal(await page.locator("#loadBtn").isVisible(), true);
      assert.equal(await page.locator("#manualControlsToggle").isChecked(), true);

      await page.locator("#settingsBtn").click();
      await page.locator("#manualControlsToggle").uncheck();

      assert.equal(await page.locator("#manualModelControls").isVisible(), false);
      assert.equal(
        await page.evaluate(() => localStorage.getItem("gemma.showManualModelControls")),
        "false",
      );
      assert.deepEqual(await page.evaluate(() => window.__mockRuntimeState), {
        loadCalls: 0,
        disposeCalls: 0,
        generateCalls: 0,
      });
    } finally {
      await context.close();
    }
  });

  await t.test("hiding loaded controls leaves the model running", async () => {
    const { context, page } = await openApp({ showManualControls: true });
    try {
      await page.locator("#loadBtn").click();
      await page.waitForFunction(() => window.__mockRuntimeState.loadCalls === 1);
      await page.waitForFunction(() => document.querySelector("#unloadBtn").offsetParent !== null);

      await page.locator("#settingsBtn").click();
      await page.locator("#manualControlsToggle").uncheck();

      assert.equal(await page.locator("#manualModelControls").isVisible(), false);
      assert.equal(await page.evaluate(() => window.__mockRuntimeState.disposeCalls), 0);

      await page.locator("#input").fill("prove the model remains ready");
      await page.locator("#sendBtn").click();
      await page.waitForFunction(() => window.__mockRuntimeState.generateCalls === 1);
      assert.equal(await page.evaluate(() => window.__mockRuntimeState.loadCalls), 1);
    } finally {
      await context.close();
    }
  });

  await t.test("opens and dismisses with Escape or an outside click", async () => {
    const { context, page } = await openApp();
    try {
      const settingsButton = page.locator("#settingsBtn");
      const popover = page.locator("#settingsPopover");

      await settingsButton.click();
      assert.equal(await settingsButton.getAttribute("aria-expanded"), "true");
      assert.equal(await popover.isVisible(), true);

      await page.locator("#settingsRow").click();
      assert.equal(await popover.isVisible(), true);

      await page.keyboard.press("Escape");
      assert.equal(await settingsButton.getAttribute("aria-expanded"), "false");
      assert.equal(await popover.isVisible(), false);

      await settingsButton.click();
      await page.locator("#thread").click({ position: { x: 4, y: 4 } });
      assert.equal(await settingsButton.getAttribute("aria-expanded"), "false");
      assert.equal(await popover.isVisible(), false);
    } finally {
      await context.close();
    }
  });
});
