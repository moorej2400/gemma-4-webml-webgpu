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

  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const origin = `http://127.0.0.1:${server.address().port}`;

  async function openApp({
    showManualControls = null,
    viewport = { width: 1280, height: 720 },
  } = {}) {
    const context = await browser.newContext({ viewport });
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
    await context.route("**/browser-runtime-loader.mjs", (route) => route.fulfill({
      status: 200,
      contentType: "text/javascript",
      body: 'export const loadBrowserRuntime = () => import("./gemma-4-e2b.pretty.js");',
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
      const toggle = page.locator("#manualControlsToggle");

      await settingsButton.click();
      assert.equal(await settingsButton.getAttribute("aria-expanded"), "true");
      assert.equal(await popover.isVisible(), true);
      assert.equal(await toggle.evaluate((element) => element === document.activeElement), true);

      await page.locator("#settingsRow").click();
      assert.equal(await popover.isVisible(), true);

      await page.keyboard.press("Escape");
      assert.equal(await settingsButton.getAttribute("aria-expanded"), "false");
      assert.equal(await popover.isVisible(), false);
      assert.equal(
        await settingsButton.evaluate((element) => element === document.activeElement),
        true,
      );

      await settingsButton.click();
      await page.locator("#thread").click({ position: { x: 4, y: 4 } });
      assert.equal(await settingsButton.getAttribute("aria-expanded"), "false");
      assert.equal(await popover.isVisible(), false);
    } finally {
      await context.close();
    }
  });

  await t.test("keeps manual header controls on one row at phone widths", async () => {
    for (const viewport of [
      { width: 320, height: 568 },
      { width: 375, height: 667 },
      { width: 440, height: 796 },
    ]) {
      const { context, page } = await openApp({
        showManualControls: true,
        viewport,
      });
      try {
        const layout = await page.evaluate(() => {
          const rect = (selector) => {
            const box = document.querySelector(selector).getBoundingClientRect();
            return {
              left: box.left,
              right: box.right,
              top: box.top,
              bottom: box.bottom,
              width: box.width,
              height: box.height,
            };
          };
          const header = rect("header");
          const brand = rect(".brand");
          const brandName = rect(".brand .name");
          const newSession = rect("#newBtn");
          const load = rect("#loadBtn");
          const settings = rect("#settingsBtn");
          return {
            documentWidth: document.documentElement.scrollWidth,
            header,
            brand,
            brandName,
            brandNameVisible: getComputedStyle(document.querySelector(".brand .name")).display !== "none",
            newSession,
            load,
            settings,
            loadWhiteSpace: getComputedStyle(document.querySelector("#loadBtn")).whiteSpace,
          };
        });

        assert.equal(layout.documentWidth, viewport.width);
        assert.ok(layout.header.height <= 65, JSON.stringify(layout));
        assert.equal(layout.newSession.height, 44);
        if (viewport.width <= 400) assert.equal(layout.newSession.width, 44);
        assert.equal(layout.loadWhiteSpace, "nowrap");
        assert.equal(layout.newSession.top, layout.load.top);
        assert.equal(layout.load.top, layout.settings.top);
        assert.ok(layout.brand.right <= layout.newSession.left);
        assert.ok(!layout.brandNameVisible || layout.brandName.right <= layout.newSession.left);
        assert.ok(layout.newSession.right <= layout.load.left);
        assert.ok(layout.load.right <= layout.settings.left);
        assert.ok(layout.settings.right <= viewport.width);
        assert.equal(await page.locator(".brand").getAttribute("aria-label"), "Gemma 4 E2B");
        assert.equal(await page.locator("#newBtn").getAttribute("title"), "New session");
        assert.equal(await page.locator("#newBtn").getAttribute("aria-label"), "New session");
      } finally {
        await context.close();
      }
    }
  });
});
