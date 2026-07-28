import { constants } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  realpath,
  readdir,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const artifactFiles = [
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
const forbiddenPath = /(^|\/)(gemma-4-e2b(?:\.pretty)?\.js|server\.js|certs|debug\.log|node_modules|tests|docs)(\/|$)|(^|\/)[^/]*(?:screenshot|settings-)[^/]*\.(?:png|jpe?g|webp)$/i;

function parseOutput(argv) {
  if (argv.length !== 2 || argv[0] !== "--output" || !argv[1]) {
    throw new Error("Usage: npm run build:pages -- --output <path>");
  }
  return path.resolve(argv[1]);
}

async function ensureSafeEmptyOutput(output) {
  const filesystemRoot = path.parse(output).root;
  const components = path.relative(filesystemRoot, output)
    .split(path.sep)
    .filter(Boolean);
  let current = filesystemRoot;

  for (let index = 0; index <= components.length; index += 1) {
    if (index > 0) current = path.join(current, components[index - 1]);
    let outputStats;
    try {
      outputStats = await lstat(current);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      try {
        await mkdir(current);
      } catch (mkdirError) {
        if (mkdirError.code !== "EEXIST") throw mkdirError;
      }
      outputStats = await lstat(current);
    }

    const isOutput = index === components.length;
    const label = isOutput ? "output directory" : "output parent";
    if (outputStats.isSymbolicLink() || !outputStats.isDirectory()) {
      throw new Error(
        `Pages ${label} must be a real directory, not a symlink: ${current}`,
      );
    }
  }

  const canonicalOutput = await realpath(output);
  if (canonicalOutput !== output) {
    throw new Error(
      `Pages output resolved outside its intended path: ${output} -> ${canonicalOutput}`,
    );
  }
  if ((await readdir(output)).length !== 0) {
    throw new Error(`Pages output must be an absent or empty directory: ${output}`);
  }
}

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

function assertReviewedFiles(files) {
  for (const relative of files) {
    if (forbiddenPath.test(relative)) {
      throw new Error(`Forbidden Pages artifact path: ${relative}`);
    }
  }
  if (
    files.length !== artifactFiles.length
    || files.some((file, index) => file !== artifactFiles[index])
  ) {
    const expected = new Set(artifactFiles);
    const actual = new Set(files);
    const missing = artifactFiles.filter((file) => !actual.has(file));
    const unexpected = files.filter((file) => !expected.has(file));
    throw new Error(
      `Pages artifact mismatch; missing=[${missing.join(", ")}] unexpected=[${unexpected.join(", ")}]`,
    );
  }
}

async function assertRealSourceFile(relative) {
  const rootStats = await lstat(root);
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw new Error(`Pages source root must be a real directory, not a symlink: ${root}`);
  }

  const components = relative.split("/");
  let current = root;
  for (let index = 0; index < components.length; index += 1) {
    current = path.join(current, components[index]);
    const sourceStats = await lstat(current);
    const isFinal = index === components.length - 1;
    if (!isFinal && (sourceStats.isSymbolicLink() || !sourceStats.isDirectory())) {
      throw new Error(
        `Pages source parent ${components.slice(0, index + 1).join("/")} must be a real directory, not a symlink`,
      );
    }
    if (isFinal && (sourceStats.isSymbolicLink() || !sourceStats.isFile())) {
      throw new Error(
        `Pages source ${relative} must be a real regular file, not a symlink`,
      );
    }
  }
}

async function main() {
  const output = parseOutput(process.argv.slice(2));
  // Create one component at a time so recursive mkdir cannot traverse an output-side symlink.
  await ensureSafeEmptyOutput(output);
  // The public redistribution boundary is the allowlist above, never the repository tree.
  assertReviewedFiles(artifactFiles);

  for (const relative of artifactFiles) {
    const destination = path.join(output, relative);
    await mkdir(path.dirname(destination), { recursive: true });
    if (relative === ".nojekyll") {
      await writeFile(destination, "", { flag: "wx" });
    } else {
      // Revalidate every component at copy time; allowlisted names do not make symlink targets public.
      await assertRealSourceFile(relative);
      await copyFile(path.join(root, relative), destination, constants.COPYFILE_EXCL);
    }
  }

  const finalFiles = await listFiles(output);
  assertReviewedFiles(finalFiles);
  process.stdout.write(`${finalFiles.join("\n")}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exitCode = 1;
});
