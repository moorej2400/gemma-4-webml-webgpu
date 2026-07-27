import assert from "node:assert/strict";
import test from "node:test";

import {
  getLoaderProfile,
  IOS_CHUNK_MAX_BYTES,
  isIOSUserAgent,
} from "../platform-profile.mjs";

const iphoneSafari = "Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 Version/19.0 Mobile/15E148 Safari/604.1";

test("detects iPhone and iPad user agents", () => {
  assert.equal(isIOSUserAgent(iphoneSafari), true);
  assert.equal(isIOSUserAgent("Mozilla/5.0 (iPad; CPU OS 19_0 like Mac OS X)"), true);
  assert.equal(isIOSUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"), false);
});

test("uses one 32 MiB loading lane on iOS", () => {
  assert.deepEqual(getLoaderProfile(iphoneSafari), {
    concurrency: 1,
    chunkMaxBytes: IOS_CHUNK_MAX_BYTES,
    diskBackedPle: true,
  });
  assert.equal(IOS_CHUNK_MAX_BYTES, 32 * 1024 * 1024);
});

test("preserves runtime defaults off iOS", () => {
  assert.deepEqual(getLoaderProfile("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"), {});
});
