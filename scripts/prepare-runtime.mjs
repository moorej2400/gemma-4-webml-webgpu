import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import beautifyPackage from "js-beautify";
import {
  applyUnifiedPatch,
  normalizeTrailingNewline,
} from "../runtime-patch.mjs";

const { js: beautify } = beautifyPackage;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value == null) {
      throw new Error(`Invalid argument near ${flag ?? "<end>"}`);
    }
    options[flag.slice(2)] = value;
  }
  return options;
}

async function readSource(sourcePath, sourceUrl) {
  if (sourcePath) return readFile(path.resolve(sourcePath));

  const response = await fetch(sourceUrl);
  if (!response.ok) {
    throw new Error(`Runtime download failed: HTTP ${response.status}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

async function requireAbsent(outputPath) {
  try {
    await stat(outputPath);
    throw new Error(`Runtime output already exists: ${outputPath}`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const manifest = JSON.parse(
    await readFile(path.join(root, "runtime-manifest.json"), "utf8"),
  );
  const outputPath = path.resolve(options.output ?? path.join(root, manifest.output));
  const sourceOutputPath = options["source-output"]
    ? path.resolve(options["source-output"])
    : null;
  if (sourceOutputPath === outputPath) {
    throw new Error("Runtime source and patched output paths must differ");
  }
  await requireAbsent(outputPath);
  if (sourceOutputPath) await requireAbsent(sourceOutputPath);

  const source = await readSource(options.source, manifest.sourceUrl);
  const sourceDigest = sha256(source);
  if (sourceDigest !== manifest.sourceSha256) {
    throw new Error(
      `Upstream runtime hash mismatch: expected ${manifest.sourceSha256}, got ${sourceDigest}`,
    );
  }

  const formatted = beautify(source.toString("utf8"), { indent_size: 2 });
  const patchText = await readFile(path.join(root, manifest.patch), "utf8");
  const patched = normalizeTrailingNewline(
    applyUnifiedPatch(formatted, patchText),
  );
  const patchedDigest = sha256(patched);
  if (
    manifest.patchedSha256 !== "__PENDING__" &&
    patchedDigest !== manifest.patchedSha256
  ) {
    throw new Error(
      `Patched runtime hash mismatch: expected ${manifest.patchedSha256}, got ${patchedDigest}`,
    );
  }

  await mkdir(path.dirname(outputPath), { recursive: true });
  if (sourceOutputPath) {
    await mkdir(path.dirname(sourceOutputPath), { recursive: true });
    await writeFile(sourceOutputPath, source, { flag: "wx" });
  }
  await writeFile(outputPath, patched, { flag: "wx" });
  process.stdout.write(`Prepared ${outputPath}\nsha256 ${patchedDigest}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exitCode = 1;
});
