import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

test("third-party runtime artifacts are not tracked", async () => {
  for (const artifact of ["gemma-4-e2b.js", "gemma-4-e2b.pretty.js"]) {
    const tracked = spawnSync("git", ["ls-files", "--error-unmatch", artifact], {
      cwd: root,
      encoding: "utf8",
    });
    assert.notEqual(tracked.status, 0, `${artifact} must remain untracked`);
  }

  const ignore = await readFile(new URL("../.gitignore", import.meta.url), "utf8");
  assert.match(ignore, /^gemma-4-e2b\.js$/m);
  assert.match(ignore, /^\*\.pretty\.js$/m);
});
