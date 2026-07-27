import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("debug client observes fetch metadata without consuming response bodies", async () => {
  const source = await readFile(new URL("debug-client.js", root), "utf8");

  assert.doesNotMatch(source, /ReadableStream|getReader\(|new Response\(/);
  assert.match(source, /return res;/);
  assert.match(source, /content-length/);
});

test("debug client does not allocate a GPU adapter before model ownership", async () => {
  const source = await readFile(new URL("debug-client.js", root), "utf8");

  assert.doesNotMatch(source, /requestAdapter\(/);
  assert.match(source, /webml-debug-event/);
});

test("debug channel accepts only allowlisted commands and no executable source", async () => {
  const [client, server] = await Promise.all([
    readFile(new URL("debug-client.js", root), "utf8"),
    readFile(new URL("server.js", root), "utf8"),
  ]);

  assert.doesNotMatch(client, /\beval\s*\(/);
  assert.doesNotMatch(server, /__cmd\/eval|cmd:\s*"eval"|searchParams\.get\("code"\)/);
  for (const command of ["load-model", "dispose-model", "run-prompt", "reload"]) {
    assert.match(client + server, new RegExp(command));
  }
  assert.match(client, /webml-debug-command/);
});

test("server supports targeting one connected client", async () => {
  const source = await readFile(new URL("server.js", root), "utf8");

  assert.match(source, /searchParams\.get\("client"\)/);
  assert.match(source, /clients:\s*\[\.\.\.clients\.keys\(\)\]/);
});
