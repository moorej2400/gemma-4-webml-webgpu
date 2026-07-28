import assert from "node:assert/strict";
import test from "node:test";

import {
  applyUnifiedPatch,
  normalizeTrailingNewline,
} from "../runtime-patch.mjs";

test("applies unified patch hunks with context validation", () => {
  const source = "alpha\nbeta\ngamma\n";
  const patch = [
    "@@ -1,3 +1,4 @@",
    " alpha",
    "-beta",
    "+bravo",
    "+beta-two",
    " gamma",
    "",
  ].join("\n");

  assert.equal(
    applyUnifiedPatch(source, patch),
    "alpha\nbravo\nbeta-two\ngamma\n",
  );
});

test("rejects patch hunks whose source context does not match", () => {
  const patch = "@@ -1 +1 @@\n-wrong\n+replacement\n";

  assert.throws(
    () => applyUnifiedPatch("actual\n", patch),
    /context mismatch at source line 1/,
  );
});

test("normalizes output to exactly one trailing newline", () => {
  assert.equal(normalizeTrailingNewline("runtime"), "runtime\n");
  assert.equal(normalizeTrailingNewline("runtime\n\n"), "runtime\n");
  assert.equal(normalizeTrailingNewline("runtime\r\n\r\n"), "runtime\n");
});
