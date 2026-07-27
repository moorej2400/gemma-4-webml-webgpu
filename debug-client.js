/*
 * debug-client.js — streams this page's console + errors to the LAN dev server over WebSocket,
 * so a phone's Safari logs are visible on the Mac in real time. Also listens for a server "reload"
 * command to refresh the page after a code edit. Loaded as the very first <script> so it captures
 * the earliest errors (including module-load failures).
 *
 * No-ops gracefully if the socket can't connect — never breaks the app.
 */
(function () {
  "use strict";

  var WS_URL = (location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/__debug";
  var buffer = [];          // queued events before the socket is open
  var MAX_BUFFER = 500;
  var ws = null;
  var connected = false;
  var seq = 0;

  function nowISO() { try { return new Date().toISOString(); } catch (e) { return "" + Date.now(); } }

  function safeStringify(obj) {
    var seen = [];
    try {
      return JSON.stringify(obj, function (k, v) {
        if (typeof v === "bigint") return v.toString() + "n";
        if (v instanceof Error) return { __error: true, name: v.name, message: v.message, stack: v.stack };
        if (typeof v === "object" && v !== null) {
          if (seen.indexOf(v) !== -1) return "[Circular]";
          seen.push(v);
        }
        if (typeof v === "function") return "[fn " + (v.name || "anon") + "]";
        return v;
      });
    } catch (e) { return String(obj); }
  }

  function fmtArg(a) {
    if (a instanceof Error) return (a.stack || (a.name + ": " + a.message));
    if (typeof a === "string") return a;
    if (typeof a === "object" && a !== null) return safeStringify(a);
    return String(a);
  }

  function emit(level, args) {
    var parts = [];
    for (var i = 0; i < args.length; i++) parts.push(fmtArg(args[i]));
    send({ t: "log", seq: ++seq, level: level, ts: nowISO(), msg: parts.join(" ") });
  }

  function send(evt) {
    if (connected && ws && ws.readyState === 1) {
      try { ws.send(JSON.stringify(evt)); return; } catch (e) { /* fall through to buffer */ }
    }
    buffer.push(evt);
    if (buffer.length > MAX_BUFFER) buffer.shift();
  }

  function flush() {
    if (!connected || !ws || ws.readyState !== 1) return;
    while (buffer.length) {
      try { ws.send(JSON.stringify(buffer.shift())); } catch (e) { break; }
    }
  }

  // ---- patch fetch + XHR (diagnostic: reveal which network request fails, and how) ----
  // Runs before the module bundle (this script is a classic <script> in <head>; modules are deferred),
  // so every request the runtime makes is captured.
  function shortUrl(u) { try { u = String(u); return u.length > 160 ? u.slice(0, 160) + "…" : u; } catch (e) { return "?"; } }
  function humanMB(b) { return (b / 1048576).toFixed(1) + "MB"; }
  if (window.fetch) {
    var _fetch = window.fetch.bind(window);
    window.fetch = function (input, init) {
      var url = (input && input.url) ? input.url : input;
      var method = (init && init.method) || (input && input.method) || "GET";
      var range = (init && init.headers && (init.headers.range || init.headers.Range)) || "";
      send({ t: "log", seq: ++seq, level: "debug", ts: nowISO(), msg: "[fetch →] " + method + " " + shortUrl(url) + (range ? " range=" + range : "") });
      return _fetch(input, init).then(function (res) {
        var clen = res.headers.get("content-length");
        send({ t: "log", seq: ++seq, level: res.ok ? "debug" : "error", ts: nowISO(),
          msg: "[fetch ←] " + res.status + " " + (res.ok ? "OK" : res.statusText) + " " + shortUrl(url) +
               " type=" + res.type + " len=" + (clen || "?") + (clen ? " (" + humanMB(+clen) + ")" : "") });
        // Return Safari's exact Response so model loading keeps native
        // backpressure and never creates a second body-buffering pipeline.
        return res;
      }).catch(function (err) {
        send({ t: "log", seq: ++seq, level: "error", ts: nowISO(),
          msg: "[fetch ✗] " + method + " " + shortUrl(url) + " → " + (err && err.name ? err.name + ": " : "") + (err && err.message ? err.message : err) });
        throw err;
      });
    };
  }
  if (window.XMLHttpRequest) {
    var _open = XMLHttpRequest.prototype.open;
    var _send = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (m, u) { this.__m = m; this.__u = u; return _open.apply(this, arguments); };
    XMLHttpRequest.prototype.send = function () {
      var self = this;
      send({ t: "log", seq: ++seq, level: "debug", ts: nowISO(), msg: "[xhr →] " + self.__m + " " + shortUrl(self.__u) });
      self.addEventListener("load", function () { send({ t: "log", seq: ++seq, level: self.status >= 400 ? "error" : "debug", ts: nowISO(), msg: "[xhr ←] " + self.status + " " + shortUrl(self.__u) }); });
      self.addEventListener("error", function () { send({ t: "log", seq: ++seq, level: "error", ts: nowISO(), msg: "[xhr ✗] " + self.__m + " " + shortUrl(self.__u) + " → network error" }); });
      return _send.apply(this, arguments);
    };
  }

  // ---- patch console ----
  var LEVELS = ["log", "info", "warn", "error", "debug"];
  LEVELS.forEach(function (level) {
    var orig = console[level] ? console[level].bind(console) : function () {};
    console[level] = function () {
      try { emit(level, arguments); } catch (e) {}
      orig.apply(null, arguments);
    };
  });

  // ---- global error hooks ----
  window.addEventListener("error", function (e) {
    if (e && e.message) {
      send({ t: "log", seq: ++seq, level: "error", ts: nowISO(),
        msg: "[window.onerror] " + e.message + " @ " + (e.filename || "?") + ":" + (e.lineno || 0) + ":" + (e.colno || 0) +
             (e.error && e.error.stack ? "\n" + e.error.stack : "") });
    }
  }, true);

  window.addEventListener("unhandledrejection", function (e) {
    var r = e && e.reason;
    var msg = r && r.stack ? r.stack : (r && r.message ? r.message : safeStringify(r));
    send({ t: "log", seq: ++seq, level: "error", ts: nowISO(), msg: "[unhandledrejection] " + msg });
  });

  // ---- environment + WebGPU capability dump ----
  function dumpEnv() {
    var env = {
      t: "env", ts: nowISO(),
      ua: navigator.userAgent,
      platform: navigator.platform,
      secureContext: window.isSecureContext,
      protocol: location.protocol,
      href: location.href,
      dpr: window.devicePixelRatio,
      screen: (screen.width + "x" + screen.height),
      viewport: (window.innerWidth + "x" + window.innerHeight),
      deviceMemory: navigator.deviceMemory || null,
      hardwareConcurrency: navigator.hardwareConcurrency || null,
      hasWebGPU: !!navigator.gpu,
      crossOriginIsolated: window.crossOriginIsolated,
    };
    send(env);
    if (!navigator.gpu) {
      send({ t: "log", seq: ++seq, level: "error", ts: nowISO(), msg: "[webgpu] navigator.gpu is UNDEFINED (no WebGPU on this context)" });
    } else {
      send({ t: "log", seq: ++seq, level: "info", ts: nowISO(), msg: "[webgpu] available; adapter details deferred until model ownership" });
    }
  }

  window.addEventListener("webml-debug-event", function (event) {
    var detail = event.detail || {};
    var payload = detail.payload || {};
    send(Object.assign({ t: detail.type || "app-event", ts: nowISO() }, payload));
  });

  // ---- connect (with auto-reconnect) ----
  function connect() {
    try { ws = new WebSocket(WS_URL); } catch (e) { setTimeout(connect, 2000); return; }
    ws.onopen = function () {
      connected = true;
      send({ t: "hello", ts: nowISO(), ua: navigator.userAgent });
      flush();
      dumpEnv();
    };
    ws.onmessage = function (ev) {
      var cmd;
      try { cmd = JSON.parse(ev.data); } catch (e) { return; }
      if (cmd && cmd.cmd === "reload") { location.reload(); }
      if (cmd && ["load-model", "dispose-model", "run-prompt"].indexOf(cmd.cmd) !== -1) {
        window.dispatchEvent(new CustomEvent("webml-debug-command", { detail: {
          command: cmd.cmd,
          requestId: cmd.requestId,
          prompt: cmd.prompt,
          maxNewTokens: cmd.maxNewTokens,
        } }));
      }
    };
    ws.onclose = function () { connected = false; setTimeout(connect, 1500); };
    ws.onerror = function () { try { ws.close(); } catch (e) {} };
  }

  connect();
  // Report page lifecycle so the server can tell when the phone navigated away / backgrounded.
  window.addEventListener("pagehide", function () { send({ t: "log", level: "info", ts: nowISO(), msg: "[lifecycle] pagehide" }); flush(); });
  console.log("[debug-client] attached. streaming to " + WS_URL);
})();
