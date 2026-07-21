#!/usr/bin/env node
/*
 * server.js — dependency-free HTTPS static server + raw WebSocket debug hub for on-device iOS testing.
 *
 *   • Serves the chat app over HTTPS (local CA-signed cert, auto-generated) so iOS Safari exposes WebGPU
 *     (navigator.gpu requires a secure context — plain http://<lan-ip> does not qualify).
 *   • Accepts WebSocket connections at /__debug from debug-client.js and prints the phone's console +
 *     errors + WebGPU capability dump to this terminal (and appends to debug.log).
 *   • Control endpoints for the developer (curl-able from another shell):
 *       GET /__cmd/reload            → tell every connected page to location.reload()
 *       GET /__cmd/eval?code=...     → eval a snippet on every page; result streams back as a log
 *       GET /__cmd/clients           → list connected pages
 *
 * Run:  node server.js   (listens on 0.0.0.0:8443)
 */
"use strict";

const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const os = require("os");
const { execFileSync } = require("child_process");

const ROOT = __dirname;
// PORT (set by tooling like Claude Preview) is the plain-HTTP localhost port; the phone-facing
// HTTPS listener has its own env var so the two never collide.
const PORT = Number(process.env.HTTPS_PORT) || 8443;
const HTTP_REDIRECT_PORT = Number(process.env.PORT) || 8080; // localhost app + http→https redirect
const CERT_DIR = path.join(ROOT, "certs");
const CA_CERT_FILE = path.join(CERT_DIR, "ios-webml-ca.pem");
const CA_KEY_FILE = path.join(CERT_DIR, "ios-webml-ca-key.pem");
const CA_DER_FILE = path.join(CERT_DIR, "ios-webml-ca.cer");
const CA_PROFILE_FILE = path.join(CERT_DIR, "ios-webml-ca.mobileconfig");
const CERT_FILE = path.join(CERT_DIR, "ios-webml-server.pem");
const KEY_FILE = path.join(CERT_DIR, "ios-webml-server-key.pem");
const CSR_FILE = path.join(CERT_DIR, "ios-webml-server.csr");
const CERT_EXT_FILE = path.join(CERT_DIR, "ios-webml-server-ext.cnf");
const LOG_FILE = path.join(ROOT, "debug.log");
const PUBLIC_CERT_PATHS = new Set([
  "/certs/ios-webml-ca.pem",
  "/certs/ios-webml-ca.cer",
  "/certs/ios-webml-ca.mobileconfig",
  "/certs/ios-webml-server.pem",
]);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".wasm": "application/wasm",
  ".map": "application/json",
  ".cer": "application/x-x509-ca-cert",
  ".mobileconfig": "application/x-apple-aspen-config",
};

// ---------------------------------------------------------------- LAN IPs
function lanIPs() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const ni of ifaces[name]) {
      if (ni.family === "IPv4" && !ni.internal) out.push(ni.address);
    }
  }
  return out;
}

function writeTrustProfile() {
  const certData = fs.readFileSync(CA_DER_FILE).toString("base64");
  const profile = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0"><dict>',
    '<key>PayloadContent</key><array><dict>',
    '<key>PayloadCertificateFileName</key><string>iOS WebML Development CA</string>',
    '<key>PayloadContent</key><data>' + certData + '</data>',
    '<key>PayloadDescription</key><string>Trusts the local WebML development server on this LAN.</string>',
    '<key>PayloadDisplayName</key><string>iOS WebML Development CA</string>',
    '<key>PayloadIdentifier</key><string>dev.webml.ios.ca</string>',
    '<key>PayloadType</key><string>com.apple.security.root</string>',
    '<key>PayloadUUID</key><string>8C5ED636-EBC8-46A0-A190-D142427E7196</string>',
    '<key>PayloadVersion</key><integer>1</integer>',
    '</dict></array>',
    '<key>PayloadDescription</key><string>Local certificate authority for iPhone WebGPU testing.</string>',
    '<key>PayloadDisplayName</key><string>iOS WebML Development CA</string>',
    '<key>PayloadIdentifier</key><string>dev.webml.ios.profile</string>',
    '<key>PayloadOrganization</key><string>Local WebML Development</string>',
    '<key>PayloadRemovalDisallowed</key><false/>',
    '<key>PayloadType</key><string>Configuration</string>',
    '<key>PayloadUUID</key><string>50656098-35F3-4FBC-A79B-EA27BDD10765</string>',
    '<key>PayloadVersion</key><integer>1</integer>',
    '</dict></plist>',
    '',
  ].join("\n");
  fs.writeFileSync(CA_PROFILE_FILE, profile);
}

// ---------------------------------------------------------------- cert (auto-generate)
function ensureCert() {
  fs.mkdirSync(CERT_DIR, { recursive: true });
  const ips = lanIPs();
  const sans = ["DNS:localhost", "IP:127.0.0.1", ...ips.map((ip) => "IP:" + ip)].join(",");

  if (!fs.existsSync(CA_CERT_FILE) || !fs.existsSync(CA_KEY_FILE)) {
    console.log("[cert] generating local iOS development CA");
    execFileSync("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes",
      "-keyout", CA_KEY_FILE, "-out", CA_CERT_FILE,
      "-days", "3650", "-sha256", "-subj", "/CN=iOS WebML Development CA",
      "-addext", "basicConstraints=critical,CA:TRUE",
      "-addext", "keyUsage=critical,keyCertSign,cRLSign",
      "-addext", "subjectKeyIdentifier=hash",
    ], { stdio: "inherit" });
  }

  if (!fs.existsSync(CERT_FILE) || !fs.existsSync(KEY_FILE)) {
    console.log("[cert] generating iOS-compatible server certificate with SAN:", sans);
    fs.writeFileSync(CERT_EXT_FILE, [
      "[server_cert]",
      "basicConstraints=critical,CA:FALSE",
      "keyUsage=critical,digitalSignature,keyEncipherment",
      "extendedKeyUsage=serverAuth",
      "subjectAltName=" + sans,
      "authorityKeyIdentifier=keyid,issuer",
      "subjectKeyIdentifier=hash",
      "",
    ].join("\n"));
    execFileSync("openssl", [
      "req", "-new", "-newkey", "rsa:2048", "-nodes",
      "-keyout", KEY_FILE, "-out", CSR_FILE,
      "-subj", "/CN=gemma-webgpu-dev",
    ], { stdio: "inherit" });
    execFileSync("openssl", [
      "x509", "-req", "-in", CSR_FILE,
      "-CA", CA_CERT_FILE, "-CAkey", CA_KEY_FILE, "-CAcreateserial",
      "-out", CERT_FILE, "-days", "397", "-sha256",
      "-extfile", CERT_EXT_FILE, "-extensions", "server_cert",
    ], { stdio: "inherit" });
  }

  // OpenSSL inherits the process umask, so enforce private-key permissions on every start.
  fs.chmodSync(CA_KEY_FILE, 0o600);
  fs.chmodSync(KEY_FILE, 0o600);
  execFileSync("openssl", [
    "x509", "-in", CA_CERT_FILE, "-outform", "der", "-out", CA_DER_FILE,
  ]);
  writeTrustProfile();
}

// ---------------------------------------------------------------- logging
const C = { reset: "\x1b[0m", dim: "\x1b[2m", red: "\x1b[31m", yellow: "\x1b[33m", cyan: "\x1b[36m", green: "\x1b[32m", magenta: "\x1b[35m", gray: "\x1b[90m" };
function logToFile(line) { try { fs.appendFileSync(LOG_FILE, line + "\n"); } catch (e) {} }

let clientSeq = 0;
function clientTag(id) { return C.magenta + "[phone#" + id + "]" + C.reset; }

function printClientEvent(id, evt) {
  const tag = clientTag(id);
  const plain = "[phone#" + id + "] ";
  if (evt.t === "log") {
    const color = evt.level === "error" ? C.red : evt.level === "warn" ? C.yellow : evt.level === "debug" ? C.gray : C.reset;
    const lvl = evt.level.toUpperCase().padEnd(5);
    process.stdout.write(tag + " " + color + lvl + C.reset + " " + evt.msg + "\n");
    logToFile(plain + lvl + " " + evt.msg);
  } else if (evt.t === "env") {
    const s = `ENV  ua=${evt.ua}\n     secureContext=${evt.secureContext} proto=${evt.protocol} hasWebGPU=${evt.hasWebGPU} viewport=${evt.viewport} dpr=${evt.dpr} cores=${evt.hardwareConcurrency} mem=${evt.deviceMemory}`;
    process.stdout.write(tag + " " + C.cyan + s + C.reset + "\n");
    logToFile(plain + s.replace(/\n/g, "\n" + plain));
  } else if (evt.t === "gpu") {
    const s = `GPU  vendor=${evt.vendor} arch=${evt.architecture} device=${evt.device} desc=${evt.description || ""}\n     fallback=${evt.isFallbackAdapter} shader-f16=${evt.hasShaderF16}\n     limits=${JSON.stringify(evt.limits)}\n     features=${(evt.features || []).join(",")}`;
    process.stdout.write(tag + " " + C.green + s + C.reset + "\n");
    logToFile(plain + s.replace(/\n/g, "\n" + plain));
  } else if (evt.t === "hello") {
    process.stdout.write(tag + " " + C.dim + "connected" + C.reset + "\n");
  } else {
    process.stdout.write(tag + " " + JSON.stringify(evt) + "\n");
  }
}

// ---------------------------------------------------------------- WebSocket (raw, RFC6455)
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const clients = new Map(); // id -> socket

function wsAccept(key) {
  return crypto.createHash("sha1").update(key + WS_GUID).digest("base64");
}

function wsSend(sock, str) {
  const payload = Buffer.from(str, "utf8");
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x81; // FIN + text
  try { sock.write(Buffer.concat([header, payload])); } catch (e) {}
}

function wsCloseFrame(sock) { try { sock.write(Buffer.from([0x88, 0x00])); } catch (e) {} }

function broadcast(obj) {
  const str = JSON.stringify(obj);
  for (const sock of clients.values()) wsSend(sock, str);
  return clients.size;
}

function handleUpgrade(req, socket) {
  const key = req.headers["sec-websocket-key"];
  if (!key || req.url !== "/__debug") { socket.destroy(); return; }
  const accept = wsAccept(key);
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
    "Upgrade: websocket\r\n" +
    "Connection: Upgrade\r\n" +
    "Sec-WebSocket-Accept: " + accept + "\r\n\r\n"
  );
  const id = ++clientSeq;
  clients.set(id, socket);
  socket.setNoDelay(true);
  process.stdout.write(clientTag(id) + " " + C.dim + "socket open (" + clients.size + " total)" + C.reset + "\n");

  let buf = Buffer.alloc(0);
  socket.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    // Parse as many complete frames as are buffered.
    while (buf.length >= 2) {
      const b0 = buf[0], b1 = buf[1];
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let offset = 2;
      if (len === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); offset = 4; }
      else if (len === 127) { if (buf.length < 10) break; len = Number(buf.readBigUInt64BE(2)); offset = 10; }
      const maskLen = masked ? 4 : 0;
      if (buf.length < offset + maskLen + len) break; // wait for the rest
      let payload = buf.slice(offset + maskLen, offset + maskLen + len);
      if (masked) {
        const mask = buf.slice(offset, offset + 4);
        const out = Buffer.alloc(len);
        for (let i = 0; i < len; i++) out[i] = payload[i] ^ mask[i & 3];
        payload = out;
      }
      buf = buf.slice(offset + maskLen + len);

      if (opcode === 0x8) { // close
        wsCloseFrame(socket); socket.end(); break;
      } else if (opcode === 0x9) { // ping → pong
        try { socket.write(Buffer.from([0x8a, 0x00])); } catch (e) {}
      } else if (opcode === 0x1 || opcode === 0x0) { // text / continuation
        const text = payload.toString("utf8");
        try { printClientEvent(id, JSON.parse(text)); }
        catch (e) { process.stdout.write(clientTag(id) + " " + text + "\n"); }
      }
    }
  });
  const drop = () => {
    if (clients.has(id)) {
      clients.delete(id);
      process.stdout.write(clientTag(id) + " " + C.dim + "socket closed (" + clients.size + " left)" + C.reset + "\n");
    }
  };
  socket.on("close", drop);
  socket.on("error", drop);
}

// ---------------------------------------------------------------- static + control HTTP
function serveStatic(req, res) {
  const url = new URL(req.url, "https://" + (req.headers.host || "localhost"));
  let pathname = decodeURIComponent(url.pathname);

  // Certificate private keys share the static root but must never cross the LAN trust boundary.
  if (pathname.startsWith("/certs/") && !PUBLIC_CERT_PATHS.has(pathname)) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    return res.end("404 Not Found");
  }

  // ---- developer control endpoints ----
  if (pathname === "/__cmd/reload") {
    const n = broadcast({ cmd: "reload" });
    console.log(C.cyan + `[cmd] reload → ${n} client(s)` + C.reset);
    return json(res, { ok: true, reloaded: n });
  }
  if (pathname === "/__cmd/eval") {
    const code = url.searchParams.get("code") || "";
    const n = broadcast({ cmd: "eval", code });
    console.log(C.cyan + `[cmd] eval → ${n} client(s): ${code}` + C.reset);
    return json(res, { ok: true, sent: n, code });
  }
  if (pathname === "/__cmd/clients") {
    return json(res, { clients: clients.size });
  }

  if (pathname === "/") pathname = "/index.html";
  const filePath = path.join(ROOT, path.normalize(pathname));
  if (!filePath.startsWith(ROOT)) { res.writeHead(403); return res.end("forbidden"); }

  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404, { "Content-Type": "text/plain" }); return res.end("404 Not Found"); }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Cache-Control": "no-store", // always serve fresh during debugging
    });
    res.end(data);
  });
}
function json(res, obj) {
  res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(JSON.stringify(obj));
}

// ---------------------------------------------------------------- boot
ensureCert();
const server = https.createServer(
  { cert: fs.readFileSync(CERT_FILE), key: fs.readFileSync(KEY_FILE) },
  serveStatic
);
server.on("upgrade", handleUpgrade);
server.listen(PORT, "0.0.0.0", () => {
  const ips = lanIPs();
  console.log("");
  console.log(C.green + "  Gemma WebGPU chat — HTTPS + live debug server" + C.reset);
  console.log("  " + C.dim + "─".repeat(50) + C.reset);
  console.log("  Local:   " + C.cyan + `https://localhost:${PORT}` + C.reset);
  for (const ip of ips) console.log("  Network: " + C.cyan + `https://${ip}:${PORT}` + C.reset + C.dim + "   ← open this on the iPhone" + C.reset);
  for (const ip of ips) console.log("  Trust:   " + C.cyan + `http://${ip}:${HTTP_REDIRECT_PORT}/certs/ios-webml-ca.mobileconfig` + C.reset);
  console.log("  " + C.dim + "─".repeat(50) + C.reset);
  console.log("  " + C.dim + `Push reload:  curl -sk https://localhost:${PORT}/__cmd/reload` + C.reset);
  console.log("  " + C.dim + `Debug log:    ${LOG_FILE}` + C.reset);
  console.log("");
});

// HTTP listener: serves the app directly for localhost (a secure context even over http,
// so WebGPU works — used for desktop regression testing); redirects everything else to
// https (non-localhost http is not a secure context and WebGPU would be hidden).
const httpServer = http.createServer((req, res) => {
  const host = (req.headers.host || "").replace(/:\d+$/, "");
  if (host === "localhost" || host === "127.0.0.1") return serveStatic(req, res);
  const pathname = new URL(req.url, "http://" + (req.headers.host || "localhost")).pathname;
  // The CA profile must remain reachable before iOS trusts the HTTPS listener.
  if (pathname === "/certs/ios-webml-ca.mobileconfig" || pathname === "/certs/ios-webml-ca.cer") {
    return serveStatic(req, res);
  }
  res.writeHead(301, { Location: `https://${host}:${PORT}${req.url}` });
  res.end();
});
httpServer.on("upgrade", handleUpgrade);
httpServer.listen(HTTP_REDIRECT_PORT, "0.0.0.0", () => {}).on("error", () => {});
