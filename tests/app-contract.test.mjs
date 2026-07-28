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

test("composer and seed prompts are available before model loading", async () => {
  const [app, html] = await Promise.all([
    readFile(new URL("app.js", root), "utf8"),
    readFile(new URL("index.html", root), "utf8"),
  ]);

  assert.match(html, /<textarea id="input" rows="1" placeholder="Ask anything…"><\/textarea>/);
  assert.match(app, /setSeedsEnabled\(capabilitiesAvailable\)/);
  assert.match(
    app,
    /if \(!seed \|\| seed\.disabled \|\| isLoading \|\| isGenerating\) return;/,
  );
  assert.match(app, /els\.input\.value = seed\.textContent;\s*autoGrow\(\);\s*refreshSend\(\);\s*send\(\);/);
});

test("send delegates the retained prompt and generation options through SubmissionFlow", async () => {
  const source = await readFile(new URL("app.js", root), "utf8");

  assert.match(source, /import \{ SubmissionFlow \} from "\.\/submission-flow\.mjs";/);
  assert.match(source, /const submissionFlow = new SubmissionFlow\(\{/);
  assert.match(source, /isReady:\s*\(\) => Boolean\(model\)/);
  assert.match(source, /load:\s*loadModel/);
  assert.match(source, /generate:\s*\(prompt, options\) =>/);
  assert.match(source, /submissionFlow\.submit\(text, options\)/);
  assert.match(source, /async function generateMessage\(text, \{ maxNewTokens = 4096 \} = \{\}\)/);
  assert.match(source, /model\.generate\(messages, \{ maxNewTokens, signal: abortController\.signal \}\)/);
  assert.match(source, /await send\(\{ maxNewTokens \}\)/);
});

test("loading preserves the prompt and controls are retryable when loading stops", async () => {
  const source = await readFile(new URL("app.js", root), "utf8");

  assert.match(source, /const capabilitiesAvailable = Boolean\(navigator\.gpu && navigator\.locks\?\.request\)/);
  assert.match(source, /function setLoading\(on\)/);
  assert.match(source, /els\.input\.disabled = !capabilitiesAvailable \|\| on \|\| isGenerating/);
  assert.match(source, /function refreshSend\(\) \{\s*els\.sendBtn\.disabled = !capabilitiesAvailable \|\| isLoading \|\| isGenerating \|\| els\.input\.value\.trim\(\) === "";/);
  assert.match(source, /setLoading\(true\);/);
  assert.match(source, /setLoading\(false\);/);
  assert.match(source, /async function generateMessage\(text,[\s\S]*?els\.input\.value = "";/);
  assert.doesNotMatch(source, /function refreshSend\(\)[^{]*\{[^}]*!model/);
});

test("manual unload leaves chat ready for another first-send load", async () => {
  const source = await readFile(new URL("app.js", root), "utf8");
  const disposeModel = source.slice(
    source.indexOf("async function disposeModel"),
    source.indexOf("function send("),
  );

  assert.match(disposeModel, /els\.input\.disabled = !capabilitiesAvailable/);
  assert.match(disposeModel, /els\.input\.placeholder = "Ask anything…"/);
  assert.match(disposeModel, /setSeedsEnabled\(capabilitiesAvailable\)/);
});

test("welcome copy explains first-message on-device loading without implementation jargon", async () => {
  const source = await readFile(new URL("app.js", root), "utf8");

  assert.match(source, /Gemma runs on your device and gets ready when you send your first message\./);
  assert.doesNotMatch(source, /Load the model to begin/);
});

test("runtime disposal awaits owned GPU runtime destruction", async () => {
  const source = await readFile(new URL("gemma-4-e2b.pretty.js", root), "utf8");

  assert.match(source, /async dispose\(\)/);
  assert.match(source, /this\.#r && await this\.#e\.destroy\(\)/);
});
