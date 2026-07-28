import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const buildScript = path.join(root, "scripts/build-pages.mjs");
const publicUrl = "https://moorej2400.github.io/gemma-4-webml-webgpu/";
const expectedFiles = [
  ".nojekyll",
  "README.md",
  "THIRD_PARTY_NOTICES.md",
  "app.js",
  "browser-runtime-loader.mjs",
  "debug-client.js",
  "disk-backed-embedding.mjs",
  "index.html",
  "manual-controls-preference.mjs",
  "model-lifecycle.mjs",
  "model-session.mjs",
  "page-lifecycle.mjs",
  "patches/gemma-ios-memory.patch",
  "platform-profile.mjs",
  "runtime-manifest.json",
  "runtime-patch.mjs",
  "submission-flow.mjs",
  "vendor/LICENSE.es-module-lexer",
  "vendor/LICENSE.js-beautify",
  "vendor/beautifier.min.js",
  "vendor/es-module-lexer.mjs",
  "weight-range-plan.mjs",
].sort();

async function listFiles(directory, prefix = "") {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = path.posix.join(prefix, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listFiles(path.join(directory, entry.name), relative));
    } else {
      files.push(relative);
    }
  }
  return files.sort();
}

function runBuild(output) {
  return spawnSync(process.execPath, [buildScript, "--output", output], {
    cwd: root,
    encoding: "utf8",
  });
}

test("Pages build contains exactly the reviewed public allowlist", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "gemma-pages-"));
  const output = path.join(temp, "site");

  const result = runBuild(output);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(await listFiles(output), expectedFiles);
  for (const relative of expectedFiles.filter((file) => file !== ".nojekyll")) {
    assert.deepEqual(
      await readFile(path.join(output, relative)),
      await readFile(path.join(root, relative)),
      `${relative} must be copied byte-for-byte`,
    );
  }
  assert.equal((await readFile(path.join(output, ".nojekyll"))).length, 0);
});

test("Pages build excludes runtime bundles and private development artifacts", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "gemma-pages-private-"));
  const output = path.join(temp, "site");

  const result = runBuild(output);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const files = await listFiles(output);
  const forbidden = /(^|\/)(gemma-4-e2b(?:\.pretty)?\.js|server\.js|certs|debug\.log|node_modules|tests|docs|settings-.*\.png)(\/|$)/;
  assert.equal(files.some((file) => forbidden.test(file)), false, files.join("\n"));
});

test("Pages build refuses a nonempty output without modifying it", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "gemma-pages-nonempty-"));
  const output = path.join(temp, "site");
  const sentinel = path.join(output, "keep.txt");
  await mkdir(output);
  await writeFile(sentinel, "preserve me");

  const result = runBuild(output);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /output.*empty/i);
  assert.equal(await readFile(sentinel, "utf8"), "preserve me");
  assert.deepEqual(await listFiles(output), ["keep.txt"]);
});

test("Pages build requires an explicit output path", () => {
  const result = spawnSync(process.execPath, [buildScript], {
    cwd: root,
    encoding: "utf8",
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--output/);
});

test("deployment workflow uses least privilege and the reviewed Pages pipeline", async () => {
  const workflow = await readFile(
    path.join(root, ".github/workflows/deploy-pages.yml"),
    "utf8",
  );

  assert.match(workflow, /^name: .+$/m);
  assert.match(workflow, /push:\s*\n\s+branches:\s*\[main\]/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /^permissions:\s*\n\s+contents: read$/m);
  assert.match(workflow, /^concurrency:\s*$/m);
  assert.match(workflow, /group: .*\$\{\{ github\.ref \}\}/);
  assert.match(workflow, /cancel-in-progress: true/);
  assert.match(workflow, /uses: actions\/checkout@v6/);
  assert.match(workflow, /uses: actions\/setup-node@v6/);
  assert.match(workflow, /node-version: ['"]24\.x['"]/);
  assert.match(workflow, /run: npm ci/);
  assert.match(workflow, /run: npm run prepare-runtime/);
  assert.match(workflow, /run: npm test/);
  assert.match(workflow, /run: npm run build:pages -- --output _site/);
  assert.match(workflow, /uses: actions\/configure-pages@v5/);
  assert.match(workflow, /uses: actions\/upload-pages-artifact@v4/);
  assert.match(workflow, /path: _site/);
  assert.match(workflow, /deploy:\s*\n\s+needs: build/);
  assert.match(workflow, /pages: write/);
  assert.match(workflow, /id-token: write/);
  assert.match(workflow, /name: github-pages/);
  assert.match(workflow, /url: \$\{\{ steps\.deployment\.outputs\.page_url \}\}/);
  assert.match(workflow, /uses: actions\/deploy-pages@v4/);
  assert.doesNotMatch(workflow, /path:.*gemma-4-e2b|cp .*gemma-4-e2b/);
});

test("package scripts and public documentation expose the Pages contract", async () => {
  const [packageJson, readme, notices, gitignore] = await Promise.all([
    readFile(path.join(root, "package.json"), "utf8").then(JSON.parse),
    readFile(path.join(root, "README.md"), "utf8"),
    readFile(path.join(root, "THIRD_PARTY_NOTICES.md"), "utf8"),
    readFile(path.join(root, ".gitignore"), "utf8"),
  ]);

  assert.equal(packageJson.scripts["build:pages"], "node scripts/build-pages.mjs");
  assert.match(packageJson.scripts.test, /tests\/pages-build\.test\.mjs/);
  assert.match(readme, new RegExp(publicUrl.replaceAll(".", "\\.")));
  assert.match(readme, /WebGPU/i);
  assert.match(readme, /sufficient|available memory/i);
  assert.match(readme, /~2\.4\s*GB/i);
  assert.match(readme, /does not collect prompts, generated text, or application telemetry/i);
  assert.match(readme, /localhost|private LAN/i);
  assert.match(notices, /js-beautify.*2\.0\.3/is);
  assert.match(notices, /es-module-lexer.*2\.3\.1/is);
  assert.match(notices, /MIT License/i);
  assert.match(notices, /does not currently declare a license/i);
  assert.match(gitignore, /^_site\/$/m);
});
