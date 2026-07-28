import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  readdir,
  symlink,
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

async function createTemp(prefix) {
  // macOS exposes tmpdir() through /var, a symlink to /private/var.
  return realpath(await mkdtemp(path.join(tmpdir(), prefix)));
}

async function createSyntheticSource({ symlinkFile, symlinkParent } = {}) {
  const temp = await createTemp("gemma-pages-source-");
  const source = path.join(temp, "project");
  await mkdir(path.join(source, "scripts"), { recursive: true });
  await copyFile(buildScript, path.join(source, "scripts/build-pages.mjs"));

  for (const relative of expectedFiles.filter((file) => file !== ".nojekyll")) {
    if (relative === symlinkFile || relative.startsWith(`${symlinkParent}/`)) continue;
    const destination = path.join(source, relative);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, `fixture for ${relative}`);
  }

  if (symlinkFile) {
    const target = path.join(temp, "linked-file");
    await writeFile(target, "outside allowlisted source root");
    await symlink(target, path.join(source, symlinkFile), "file");
  }
  if (symlinkParent) {
    const target = path.join(temp, "linked-directory");
    await mkdir(target);
    for (const relative of expectedFiles.filter(
      (file) => file.startsWith(`${symlinkParent}/`),
    )) {
      const destination = path.join(target, path.relative(symlinkParent, relative));
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, `outside fixture for ${relative}`);
    }
    await symlink(target, path.join(source, symlinkParent), "dir");
  }

  return {
    output: path.join(temp, "site"),
    script: path.join(source, "scripts/build-pages.mjs"),
  };
}

test("Pages build contains exactly the reviewed public allowlist", async () => {
  const temp = await createTemp("gemma-pages-");
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
  const temp = await createTemp("gemma-pages-private-");
  const output = path.join(temp, "site");

  const result = runBuild(output);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const files = await listFiles(output);
  const forbidden = /(^|\/)(gemma-4-e2b(?:\.pretty)?\.js|server\.js|certs|debug\.log|node_modules|tests|docs|settings-.*\.png)(\/|$)/;
  assert.equal(files.some((file) => forbidden.test(file)), false, files.join("\n"));
});

test("Pages build refuses a nonempty output without modifying it", async () => {
  const temp = await createTemp("gemma-pages-nonempty-");
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

test("Pages build rejects a symlinked output directory", async () => {
  const temp = await createTemp("gemma-pages-output-link-");
  const target = path.join(temp, "target");
  const output = path.join(temp, "site");
  await mkdir(target);
  await symlink(target, output, "dir");

  const result = runBuild(output);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /output.*symlink/i);
  assert.deepEqual(await readdir(target), []);
});

test("Pages build rejects an existing parent-directory symlink", async () => {
  const temp = await createTemp("gemma-pages-output-parent-link-");
  const target = path.join(temp, "target");
  const linkedParent = path.join(temp, "linked-parent");
  const output = path.join(linkedParent, "site");
  await mkdir(target);
  await symlink(target, linkedParent, "dir");

  const result = runBuild(output);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /output.*parent.*symlink/i);
  assert.deepEqual(await readdir(target), []);
});

test("Pages build requires an explicit output path", () => {
  const result = spawnSync(process.execPath, [buildScript], {
    cwd: root,
    encoding: "utf8",
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--output/);
});

test("Pages build rejects an allowlisted final-file symlink", async () => {
  const fixture = await createSyntheticSource({ symlinkFile: "README.md" });

  const result = spawnSync(process.execPath, [
    fixture.script,
    "--output",
    fixture.output,
  ], { encoding: "utf8" });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /README\.md.*regular file.*symlink/i);
});

test("Pages build rejects an allowlisted parent-directory symlink", async () => {
  const fixture = await createSyntheticSource({ symlinkParent: "patches" });

  const result = spawnSync(process.execPath, [
    fixture.script,
    "--output",
    fixture.output,
  ], { encoding: "utf8" });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /patches.*directory.*symlink/i);
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
  assert.match(workflow, /^\s+group: pages$/m);
  assert.match(workflow, /^\s+cancel-in-progress: false$/m);
  assert.doesNotMatch(workflow, /concurrency:[\s\S]*?github\.ref/);
  assert.equal((workflow.match(/runs-on: ubuntu-24\.04/g) ?? []).length, 2);
  assert.match(
    workflow,
    /uses: actions\/checkout@d23441a48e516b6c34aea4fa41551a30e30af803 # v6/,
  );
  assert.match(
    workflow,
    /uses: actions\/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4/,
  );
  assert.match(workflow, /node-version: ['"]24\.14\.0['"]/);
  assert.match(workflow, /run: npm ci/);
  assert.match(workflow, /run: npm run prepare-runtime/);
  assert.match(workflow, /run: npx playwright install --with-deps chromium webkit/);
  assert.match(workflow, /run: npm test/);
  assert.match(workflow, /run: npm run test:browser/);
  assert.match(workflow, /run: npm run build:pages -- --output _site/);
  assert.ok(
    workflow.indexOf("npx playwright install --with-deps chromium webkit")
      < workflow.indexOf("run: npm test"),
  );
  assert.ok(
    workflow.indexOf("run: npm test")
      < workflow.indexOf("run: npm run test:browser"),
  );
  assert.ok(
    workflow.indexOf("run: npm run test:browser")
      < workflow.indexOf("run: npm run build:pages -- --output _site"),
  );
  assert.ok(
    workflow.indexOf("run: npm run build:pages -- --output _site")
      < workflow.indexOf("actions/upload-pages-artifact@"),
  );
  assert.match(
    workflow,
    /uses: actions\/configure-pages@983d7736d9b0ae728b81ab479565c72886d7745b # v5/,
  );
  assert.match(
    workflow,
    /uses: actions\/upload-pages-artifact@7b1f4a764d45c48632c6b24a0339c27f5614fb0b # v4/,
  );
  assert.match(workflow, /path: _site/);
  assert.match(workflow, /deploy:\s*\n\s+needs: build/);
  assert.match(workflow, /pages: write/);
  assert.match(workflow, /id-token: write/);
  assert.match(workflow, /name: github-pages/);
  assert.match(workflow, /url: \$\{\{ steps\.deployment\.outputs\.page_url \}\}/);
  assert.match(
    workflow,
    /uses: actions\/deploy-pages@d6db90164ac5ed86f2b6aed7e0febac5b3c0c03e # v4/,
  );
  assert.doesNotMatch(workflow, /uses:\s+\S+@v\d/);
  assert.doesNotMatch(workflow, /path:.*gemma-4-e2b|cp .*gemma-4-e2b/);
});

test("package scripts and public documentation expose the Pages contract", async () => {
  const browserTestFiles = [
    "tests/browser-app-ownership.test.mjs",
    "tests/browser-chat-first.test.mjs",
    "tests/browser-model-session.test.mjs",
    "tests/browser-settings.test.mjs",
    "tests/browser-runtime-loader-smoke.test.mjs",
  ];
  const [
    packageJson,
    packageLock,
    browserTests,
    readme,
    notices,
    gitignore,
  ] = await Promise.all([
    readFile(path.join(root, "package.json"), "utf8").then(JSON.parse),
    readFile(path.join(root, "package-lock.json"), "utf8").then(JSON.parse),
    Promise.all(browserTestFiles.map((file) => readFile(path.join(root, file), "utf8"))),
    readFile(path.join(root, "README.md"), "utf8"),
    readFile(path.join(root, "THIRD_PARTY_NOTICES.md"), "utf8"),
    readFile(path.join(root, ".gitignore"), "utf8"),
  ]);

  assert.equal(packageJson.scripts["build:pages"], "node scripts/build-pages.mjs");
  assert.match(packageJson.scripts.test, /tests\/pages-build\.test\.mjs/);
  assert.match(packageJson.scripts.test, /tests\/browser-runtime-loader\.test\.mjs/);
  assert.doesNotMatch(packageJson.scripts.test, /tests\/browser-runtime-loader-smoke\.test\.mjs/);
  assert.equal(
    packageJson.scripts["test:browser"],
    `node --test ${browserTestFiles.join(" ")}`,
  );
  assert.equal(packageJson.devDependencies.playwright, "1.61.1");
  assert.equal(packageLock.packages[""].devDependencies.playwright, "1.61.1");
  assert.equal(packageLock.packages["node_modules/playwright"].version, "1.61.1");
  for (const browserTest of browserTests) {
    assert.doesNotMatch(
      browserTest,
      /executablePath|Google Chrome\.app|WEBKIT_EXECUTABLE_PATH/,
    );
  }
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
