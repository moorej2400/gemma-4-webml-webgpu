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
const { chromium, webkit } = require("playwright");
const { js: beautify } = require("js-beautify");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const runtimeSource = [
  'import { marker as weight } from "./weight-range-plan.mjs";',
  'import { marker as disk } from "./disk-backed-embedding.mjs";',
  'export const smokeValue = `verified:${weight}:${disk}`;',
  "",
].join("\n");
const sourceSha256 = createHash("sha256").update(runtimeSource).digest("hex");
const patchedSha256 = createHash("sha256")
  .update(normalizeTrailingNewline(beautify(runtimeSource, { indent_size: 2 })))
  .digest("hex");
const requestedEngine = process.env.BROWSER_ENGINE;

test("verified runtime Blob imports in Chromium and WebKit", async (t) => {
  const requests = new Map();
  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url, "http://localhost").pathname;
    requests.set(pathname, (requests.get(pathname) ?? 0) + 1);

    if (pathname === "/") {
      response.writeHead(200, { "Content-Type": "text/html" });
      response.end(`
        <script type="module">
          window.__runtimeSmoke = { state: "loading" };
          try {
            const { loadBrowserRuntime } = await import("/browser-runtime-loader.mjs");
            const runtime = await loadBrowserRuntime();
            window.__runtimeSmoke = { state: "ready", value: runtime.smokeValue };
          } catch (error) {
            window.__runtimeSmoke = {
              state: "error",
              message: error?.stack ?? String(error),
            };
          }
        </script>
      `);
      return;
    }
    if (pathname === "/runtime-manifest.json") {
      const sourceUrl = `http://127.0.0.1:${server.address().port}/__runtime.js`;
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        sourceUrl,
        sourceSha256,
        patch: "__runtime.patch",
        patchedSha256,
      }));
      return;
    }
    if (pathname === "/__runtime.js") {
      response.writeHead(200, { "Content-Type": "text/javascript" });
      response.end(runtimeSource);
      return;
    }
    if (pathname === "/__runtime.patch") {
      response.writeHead(200, { "Content-Type": "text/plain" });
      response.end("");
      return;
    }
    if (pathname === "/weight-range-plan.mjs") {
      response.writeHead(200, { "Content-Type": "text/javascript" });
      response.end('export const marker = "weight";');
      return;
    }
    if (pathname === "/disk-backed-embedding.mjs") {
      response.writeHead(200, { "Content-Type": "text/javascript" });
      response.end('export const marker = "disk";');
      return;
    }

    const relative = pathname.replace(/^\/+/, "");
    try {
      const body = await readFile(path.join(root, relative));
      const contentType = relative.endsWith(".js") || relative.endsWith(".mjs")
        ? "text/javascript"
        : "text/plain";
      response.writeHead(200, {
        "Content-Type": contentType,
        "Cache-Control": "no-store",
      });
      response.end(body);
    } catch {
      response.writeHead(404);
      response.end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const origin = `http://127.0.0.1:${server.address().port}`;
  const engines = [
    [
      "Chromium",
      "chromium",
      chromium,
      {
        headless: true,
        executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      },
    ],
    ["WebKit", "webkit", webkit, { headless: true }],
  ].filter(([, id]) => !requestedEngine || id === requestedEngine);
  assert.notEqual(engines.length, 0, `Unknown BROWSER_ENGINE: ${requestedEngine}`);

  for (const [name, , browserType, launchOptions] of engines) {
    await t.test(name, async () => {
      const beforeFormatter = requests.get("/vendor/beautifier.min.js") ?? 0;
      const beforeLexer = requests.get("/vendor/es-module-lexer.mjs") ?? 0;
      const browser = await browserType.launch(launchOptions);
      try {
        const page = await browser.newPage();
        await page.goto(origin);
        await page.waitForFunction(() => window.__runtimeSmoke?.state !== "loading");
        const result = await page.evaluate(() => window.__runtimeSmoke);

        assert.deepEqual(result, {
          state: "ready",
          value: "verified:weight:disk",
        });
        assert.equal(
          requests.get("/vendor/beautifier.min.js"),
          beforeFormatter + 1,
        );
        assert.equal(
          requests.get("/vendor/es-module-lexer.mjs"),
          beforeLexer + 1,
        );
      } finally {
        await browser.close();
      }
    });
  }
});
