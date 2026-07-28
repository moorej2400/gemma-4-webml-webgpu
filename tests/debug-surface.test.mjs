import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";

const root = new URL("../", import.meta.url);

async function runDebugClient(hostname) {
  const source = await readFile(new URL("debug-client.js", root), "utf8");
  const calls = {
    listeners: [],
    sockets: [],
  };
  const originalFetch = async () => ({
    ok: true,
    headers: { get: () => null },
  });
  class FakeWebSocket {
    constructor(url) {
      this.readyState = 0;
      calls.sockets.push(url);
    }
  }
  const window = {
    fetch: originalFetch,
    XMLHttpRequest: undefined,
    addEventListener(type) {
      calls.listeners.push(type);
    },
    isSecureContext: true,
    devicePixelRatio: 1,
    innerWidth: 1280,
    innerHeight: 720,
    crossOriginIsolated: false,
  };
  const context = {
    CustomEvent: class {},
    Date,
    Error,
    JSON,
    String,
    WebSocket: FakeWebSocket,
    console: Object.fromEntries(
      ["log", "info", "warn", "error", "debug"].map((level) => [level, () => {}]),
    ),
    location: {
      hostname,
      protocol: "https:",
      host: hostname,
      href: `https://${hostname}/`,
    },
    navigator: {
      userAgent: "test",
      platform: "test",
      hardwareConcurrency: 4,
    },
    screen: { width: 1280, height: 720 },
    setTimeout() {},
    window,
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  return {
    calls,
    debugActive: window.__WEBML_LOCAL_DEBUG__ === true,
    fetchWrapped: window.fetch !== originalFetch,
  };
}

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

test("public hosts install no diagnostics, wrappers, sockets, or commands", async () => {
  for (const hostname of [
    "moorej2400.github.io",
    "example.com",
    "172.15.255.255",
    "172.32.0.0",
    "192.169.0.1",
    "127.0.0.2",
    "localhost.example",
  ]) {
    const result = await runDebugClient(hostname);
    assert.equal(result.debugActive, false, `${hostname} enabled debug commands`);
    assert.equal(result.fetchWrapped, false, `${hostname} wrapped fetch`);
    assert.deepEqual(result.calls.sockets, [], `${hostname} opened WebSocket`);
    assert.deepEqual(result.calls.listeners, [], `${hostname} installed listeners`);
  }
});

test("loopback and RFC1918 IPv4 hosts retain local diagnostics", async () => {
  for (const hostname of [
    "localhost",
    "127.0.0.1",
    "::1",
    "[::1]",
    "10.0.0.1",
    "10.255.255.255",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.20",
  ]) {
    const result = await runDebugClient(hostname);
    assert.equal(result.debugActive, true, `${hostname} did not enable debug commands`);
    assert.equal(result.fetchWrapped, true, `${hostname} did not wrap fetch`);
    assert.equal(result.calls.sockets.length, 1, `${hostname} did not open WebSocket`);
    assert.ok(
      result.calls.listeners.includes("webml-debug-event"),
      `${hostname} did not install event forwarding`,
    );
  }
});
