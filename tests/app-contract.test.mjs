import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("app defers runtime import until the lifecycle owns the lock", async () => {
  const source = await readFile(new URL("app.js", root), "utf8");

  assert.match(source, /import \{ ModelSession/);
  assert.match(source, /import \{ ModelLifecycle/);
  assert.match(source, /import \{ getLoaderProfile/);
  assert.match(source, /importRuntime:\s*\(\)\s*=>\s*import\("\.\/gemma-4-e2b\.pretty\.js"\)/);
  assert.doesNotMatch(source, /^import .*Gemma4Mobile/m);
  assert.doesNotMatch(source, /auto-loading model|setTimeout\(loadModel/);
  assert.doesNotMatch(source, /window\.__model/);
});

test("app distinguishes blocked ownership from unsupported Web Locks", async () => {
  const source = await readFile(new URL("app.js", root), "utf8");

  assert.match(source, /Model active in another tab/);
  assert.match(source, /This browser cannot safely own the model/);
  assert.match(source, /UnsupportedModelSessionError/);
});

test("UI exposes explicit model disposal", async () => {
  const [app, html] = await Promise.all([
    readFile(new URL("app.js", root), "utf8"),
    readFile(new URL("index.html", root), "utf8"),
  ]);

  assert.match(html, /id="unloadBtn"/);
  assert.match(app, /async function disposeModel/);
  assert.match(app, /modelLifecycle\.dispose\(\)/);
  assert.match(app, /generationPromise/);
});

test("runtime disposal awaits owned GPU runtime destruction", async () => {
  const source = await readFile(new URL("gemma-4-e2b.pretty.js", root), "utf8");

  assert.match(source, /async dispose\(\)/);
  assert.match(source, /this\.#r && await this\.#e\.destroy\(\)/);
});
