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

test("applies a zero-count insertion at the declared source boundary", () => {
  const patch = "@@ -1,0 +2,1 @@\n+inserted\n";

  assert.equal(
    applyUnifiedPatch("alpha\nbeta\n", patch),
    "alpha\ninserted\nbeta\n",
  );
});

test("permits a terminal no-newline marker after the final operation", () => {
  const patch = [
    "@@ -1 +1 @@",
    "-alpha",
    "+replacement",
    "\\ No newline at end of file",
  ].join("\n");

  assert.equal(applyUnifiedPatch("alpha", patch), "replacement");
});

for (const [name, patch, expected] of [
  [
    "arbitrary preamble text",
    "not unified diff metadata\n@@ -1 +1 @@\n alpha\n",
    /Unsupported runtime patch metadata/,
  ],
  [
    "unsupported metadata",
    "rename from old.js\nrename to new.js\n@@ -1 +1 @@\n alpha\n",
    /Unsupported runtime patch metadata/,
  ],
  [
    "malformed hunk header",
    "@@ -1 +1\n alpha\n",
    /Malformed runtime patch hunk header/,
  ],
  [
    "out-of-range insertion",
    "@@ -9,0 +10,1 @@\n+late\n",
    /starts outside the source range/,
  ],
  [
    "incorrect old start",
    "@@ -2,1 +1,1 @@\n beta\n",
    /new start does not match produced output/,
  ],
  [
    "incorrect new start",
    "@@ -1,1 +2,1 @@\n alpha\n",
    /new start does not match produced output/,
  ],
  [
    "old count mismatch",
    "@@ -1,2 +1,1 @@\n-alpha\n+replacement\n",
    /old count mismatch/,
  ],
  [
    "new count mismatch",
    "@@ -1,1 +1,2 @@\n-alpha\n+replacement\n",
    /new count mismatch/,
  ],
  [
    "excess old operations",
    "@@ -1,1 +1,1 @@\n-alpha\n-beta\n+replacement\n",
    /old count mismatch/,
  ],
  [
    "excess new operations",
    "@@ -1,1 +1,1 @@\n-alpha\n+replacement\n+extra\n",
    /new count mismatch/,
  ],
  [
    "overlapping hunks",
    "@@ -1,1 +1,1 @@\n alpha\n@@ -1,1 +1,1 @@\n alpha\n",
    /overlapping hunks/,
  ],
]) {
  test(`rejects ${name}`, () => {
    assert.throws(
      () => applyUnifiedPatch("alpha\nbeta\n", patch),
      expected,
    );
  });
}

test("normalizes output to exactly one trailing newline", () => {
  assert.equal(normalizeTrailingNewline("runtime"), "runtime\n");
  assert.equal(normalizeTrailingNewline("runtime\n\n"), "runtime\n");
  assert.equal(normalizeTrailingNewline("runtime\r\n\r\n"), "runtime\n");
});
