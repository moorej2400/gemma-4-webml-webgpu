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
  export class Gemma4Mobile {
    static async load() {
      await fetch("/__mock_weight");
      return new Gemma4Mobile();
    }
    async warmup() {}
    async dispose() {}
    reset() {}
    deviceInfo() { return { vendor: "test", features: {} }; }
    async *generate() { yield { text: "ok" }; }
  }
`;

test("two real app pages import and load the runtime only in the lock owner", async (t) => {
  let weightRequests = 0;
  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url, "http://localhost").pathname;
    if (pathname === "/__mock_weight") {
      weightRequests += 1;
      response.writeHead(200, { "Content-Type": "application/octet-stream" });
      response.end("weight");
      return;
    }

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
  const context = await browser.newContext();
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "gpu", { value: {}, configurable: true });
    localStorage.setItem("gemma.showManualModelControls", "true");
  });

  let runtimeImports = 0;
  await context.route("**/gemma-4-e2b.pretty.js", async (route) => {
    runtimeImports += 1;
    await route.fulfill({ status: 200, contentType: "text/javascript", body: mockRuntime });
  });
  await context.route("https://esm.sh/**", (route) => route.abort());

  const origin = `http://127.0.0.1:${server.address().port}`;
  const first = await context.newPage();
  const second = await context.newPage();
  await Promise.all([first.goto(origin), second.goto(origin)]);
  await Promise.all([
    first.locator("#loadBtn").waitFor(),
    second.locator("#loadBtn").waitFor(),
  ]);

  await Promise.all([
    first.locator("#loadBtn").click(),
    second.locator("#loadBtn").click(),
  ]);
  await Promise.all([
    first.waitForFunction(() => /Ready|another tab/.test(document.querySelector("#statusText").textContent)),
    second.waitForFunction(() => /Ready|another tab/.test(document.querySelector("#statusText").textContent)),
  ]);

  const statuses = await Promise.all([
    first.locator("#statusText").textContent(),
    second.locator("#statusText").textContent(),
  ]);
  assert.equal(statuses.filter((status) => status.includes("Ready")).length, 1);
  assert.equal(statuses.filter((status) => status.includes("another tab")).length, 1);
  assert.equal(runtimeImports, 1);
  assert.equal(weightRequests, 1);

  const owner = statuses[0].includes("Ready") ? first : second;
  const blocked = owner === first ? second : first;
  assert.equal(await blocked.locator("#unloadBtn").isVisible(), false);
  await owner.locator("#unloadBtn").click();
});
