import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { normalizeTrailingNewline } from "../runtime-patch.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const { js: beautify } = require("js-beautify");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const mockRuntime = `
  import "./weight-range-plan.mjs";
  import "./disk-backed-embedding.mjs";

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
  let manifestRequests = 0;
  let sourceRequests = 0;
  let patchRequests = 0;
  let formatterRequests = 0;
  const sourceSha256 = createHash("sha256").update(mockRuntime).digest("hex");
  const patchedSha256 = createHash("sha256")
    .update(normalizeTrailingNewline(beautify(mockRuntime, { indent_size: 2 })))
    .digest("hex");
  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url, "http://localhost").pathname;
    if (pathname === "/__mock_weight") {
      weightRequests += 1;
      response.writeHead(200, { "Content-Type": "application/octet-stream" });
      response.end("weight");
      return;
    }
    if (pathname === "/runtime-manifest.json") {
      manifestRequests += 1;
      const sourceUrl = `http://127.0.0.1:${server.address().port}/__mock_runtime.js`;
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        sourceUrl,
        sourceSha256,
        patch: "__mock_runtime.patch",
        patchedSha256,
      }));
      return;
    }
    if (pathname === "/__mock_runtime.js") {
      sourceRequests += 1;
      response.writeHead(200, { "Content-Type": "text/javascript" });
      response.end(mockRuntime);
      return;
    }
    if (pathname === "/__mock_runtime.patch") {
      patchRequests += 1;
      response.writeHead(200, { "Content-Type": "text/plain" });
      response.end("");
      return;
    }
    if (pathname === "/vendor/beautifier.min.js") {
      formatterRequests += 1;
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

  await context.route("https://esm.sh/**", (route) => route.abort());

  const origin = `http://127.0.0.1:${server.address().port}`;
  const first = await context.newPage();
  const second = await context.newPage();
  await Promise.all([first.goto(origin), second.goto(origin)]);
  await Promise.all([
    first.locator("#loadBtn").waitFor(),
    second.locator("#loadBtn").waitFor(),
  ]);
  assert.deepEqual(
    [manifestRequests, sourceRequests, patchRequests, formatterRequests],
    [0, 0, 0, 0],
    "app boot must not start browser runtime preparation",
  );

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
  assert.deepEqual(
    [manifestRequests, sourceRequests, patchRequests, formatterRequests],
    [1, 1, 1, 1],
  );
  assert.equal(weightRequests, 1);

  const owner = statuses[0].includes("Ready") ? first : second;
  const blocked = owner === first ? second : first;
  assert.equal(await blocked.locator("#unloadBtn").isVisible(), false);
  await owner.locator("#unloadBtn").click();
});
