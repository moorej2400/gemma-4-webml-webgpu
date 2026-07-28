import { ModelLifecycle } from "./model-lifecycle.mjs";
import { ModelSession, UnsupportedModelSessionError } from "./model-session.mjs";
import { installPageLifecycle } from "./page-lifecycle.mjs";
import { getLoaderProfile } from "./platform-profile.mjs";
import { SubmissionFlow } from "./submission-flow.mjs";

// Streamed markdown → HTML via `marked`, loaded lazily. Falls back to a tiny inline renderer until
// (or if) it loads, so chat never hard-depends on the CDN.
let marked = null;
import("https://esm.sh/marked@17")
  .then((m) => { marked = m.marked; marked.use({ gfm: true, breaks: true }); })
  .catch((e) => { console.warn("[app] marked CDN failed, using fallback renderer:", e?.message ?? e); });

const $ = (id) => document.getElementById(id);
const els = {
  newBtn: $("newBtn"), loadBtn: $("loadBtn"), unloadBtn: $("unloadBtn"),
  statusbar: $("statusbar"), status: $("status"), statusText: $("statusText"),
  bar: $("bar"), scroll: $("scroll"), thread: $("thread"),
  input: $("input"), sendBtn: $("sendBtn"), stopBtn: $("stopBtn"), liveStat: $("liveStat"),
};
const barFill = els.bar.firstElementChild;

let model = null;
let messages = [];
let abortController = null;
let isGenerating = false;
let isLoading = false;
let generationPromise = null;
let disposalPromise = null;
// Capability failure is terminal for this page; later UI transitions must not re-enable submission.
const capabilitiesAvailable = Boolean(navigator.gpu && navigator.locks?.request);

// ---- progress bar easing (coalesce bursty byte events into one write/frame, never dip) ----
let targetProgress = 0, shownProgress = 0, progressRaf = 0;
function setProgressFraction(value) {
  if (!finite(value)) return;
  targetProgress = Math.max(clamp(value, 0, 1), targetProgress);
  // rAF doesn't fire in hidden/backgrounded tabs — write directly there so the bar
  // is accurate the moment the tab becomes visible again.
  if (document.hidden) { shownProgress = targetProgress; barFill.style.width = `${(shownProgress * 100).toFixed(2)}%`; return; }
  if (!progressRaf) progressRaf = requestAnimationFrame(stepBar);
}
function stepBar() {
  const gap = targetProgress - shownProgress;
  shownProgress += gap < 0.0015 ? gap : gap * 0.3;
  barFill.style.width = `${(shownProgress * 100).toFixed(2)}%`;
  progressRaf = shownProgress < targetProgress ? requestAnimationFrame(stepBar) : 0;
}
function setProgressImmediate(v) {
  if (progressRaf) { cancelAnimationFrame(progressRaf); progressRaf = 0; }
  targetProgress = shownProgress = clamp(v, 0, 1);
  barFill.style.width = `${(shownProgress * 100).toFixed(2)}%`;
}

function setStatus(state, text) {
  els.statusbar.classList.add("show");
  els.status.className = "status" + (state ? " " + state : "");
  if (text !== undefined) els.statusText.innerHTML = text;
}

const modelSession = new ModelSession();
const modelLifecycle = new ModelLifecycle({
  session: modelSession,
  loaderProfile: getLoaderProfile(),
  importRuntime: () => import("./gemma-4-e2b.pretty.js"),
  onStateChange(state) {
    if (state === "warming") setStatus("loading", "Warming up kernels…");
  },
});
const submissionFlow = new SubmissionFlow({
  isReady: () => Boolean(model),
  load: loadModel,
  generate: (prompt, options) => {
    generationPromise = generateMessage(prompt, options).finally(() => {
      generationPromise = null;
    });
    return generationPromise;
  },
});
installPageLifecycle({
  dispose() {
    abortController?.abort();
    return modelLifecycle.dispose();
  },
});

// ---- boot ----
if (!navigator.gpu) {
  els.loadBtn.disabled = true;
  setStatus("error", "WebGPU unavailable here. On iOS this usually means the page isn’t a <strong>secure context</strong> — it must be served over HTTPS (or localhost).");
  console.error("[app] navigator.gpu is undefined — no WebGPU. secureContext:", window.isSecureContext, "proto:", location.protocol);
} else if (!navigator.locks?.request) {
  els.loadBtn.disabled = true;
  setStatus("error", "This browser cannot safely own the model because Web Locks are unavailable.");
  console.error("[app] Web Locks unavailable; refusing to risk a duplicate model load.");
} else {
  console.log("[app] navigator.gpu present. secureContext:", window.isSecureContext);
}

els.loadBtn.addEventListener("click", loadModel);
els.unloadBtn.addEventListener("click", disposeModel);
els.newBtn.addEventListener("click", newSession);
els.sendBtn.addEventListener("click", () => send());
els.stopBtn.addEventListener("click", () => abortController?.abort());
els.input.addEventListener("input", () => { autoGrow(); refreshSend(); });
els.input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); if (!els.sendBtn.disabled) send(); }
});
els.thread.addEventListener("click", (e) => {
  const seed = e.target.closest(".seed");
  if (!seed || seed.disabled || isLoading || isGenerating) return;
  els.input.value = seed.textContent;
  autoGrow();
  refreshSend();
  send();
});
window.addEventListener("webml-debug-command", handleDebugCommand);

renderWelcome();
els.input.disabled = !capabilitiesAvailable;
refreshSend();

async function loadModel() {
  if (!capabilitiesAvailable || model || isLoading) return;
  setLoading(true);
  els.loadBtn.disabled = true;
  els.loadBtn.textContent = "Loading…";
  els.bar.classList.remove("done");
  setProgressImmediate(0.02);
  setStatus("loading", "Requesting WebGPU device…");

  const started = performance.now();
  try {
    console.log("[app] requesting exclusive model ownership…");
    const result = await modelLifecycle.load({ onProgress: onLoadProgress });
    if (result.status === "blocked") {
      console.warn("[app] Model active in another tab.");
      setStatus("error", "Model active in another tab. Unload it there before loading here.");
      els.loadBtn.disabled = false;
      els.loadBtn.textContent = "Try again";
      setLoading(false);
      return;
    }
    model = result.model;

    const seconds = ((performance.now() - started) / 1000).toFixed(1);
    console.log(`[app] model ready in ${seconds}s`);
    setStatus("ready", `Ready in <strong>${seconds}s</strong> · on-device`);
    setProgressImmediate(1);
    els.bar.classList.add("done");
    els.loadBtn.classList.add("hidden");
    els.unloadBtn.classList.remove("hidden");
    reportDebugEvent("gpu", model.deviceInfo());
    enableChat();
    // Collapse the status bar shortly after ready so the thread gets the space.
    setTimeout(() => { if (!isGenerating && model) els.statusbar.classList.remove("show"); }, 2500);
  } catch (error) {
    console.error("[app] load failed:", error?.stack || error?.message || error);
    const message = error instanceof UnsupportedModelSessionError
      ? "This browser cannot safely own the model because Web Locks are unavailable."
      : `Failed to load: ${escapeHtml(String(error?.message ?? error))}`;
    setStatus("error", message);
    els.bar.classList.add("done");
    els.loadBtn.disabled = false;
    els.loadBtn.textContent = "Retry load";
    setLoading(false);
  }
}

function onLoadProgress(event) {
  if (event.status !== "weights") {
    setStatus("loading", labelFor(event.status));
    setPhaseProgress(event.status, event.fraction);
    return;
  }
  const kind = event.kind ?? (finite(event.total) && event.total > 1_000_000 ? "bytes" : "tensors");
  const fraction = finite(event.fraction) ? clamp(event.fraction, 0, 1) : null;
  if (kind !== "tensors") setPhaseProgress("weights", fraction); // drive bar off byte download only
  setStatus("loading", formatWeightProgress(event, kind, fraction));
}
function labelFor(status) {
  return { init: "Requesting WebGPU device…", tokenizer: "Loading tokenizer…", weights: "Downloading weights…", ready: "Ready." }[status] ?? status;
}
function setPhaseProgress(status, frac) {
  const [lo, hi] = status === "weights" ? [0.04, 1.0]
    : ({ init: [0, 0.02], tokenizer: [0.02, 0.04], ready: [1, 1] }[status] ?? [0, 1]);
  const f = finite(frac) ? clamp(frac, 0, 1) : 0;
  setProgressFraction(lo + (hi - lo) * f);
}
function formatWeightProgress(event, kind, fraction) {
  const pct = fraction === null ? "" : ` (${Math.round(fraction * 100)}%)`;
  const loaded = finite(event.loaded) ? event.loaded : null;
  const total = finite(event.total) ? event.total : null;
  if (kind === "bytes") {
    const verb = event.fromCache ? "Loading cached weights" : "Downloading weights";
    if (loaded !== null && total !== null) return `${verb}: ${fmtBytes(loaded)} / ${fmtBytes(total)}${pct}`;
    if (total !== null) return `${verb}: ${fmtBytes(total)} total`;
    return `${escapeHtml(event.message || verb)}…`;
  }
  if (loaded !== null && total !== null) return `Preparing GPU weights: ${fmtInt(loaded)} / ${fmtInt(total)} tensors${pct}`;
  return event.message ? `Preparing GPU weights: ${escapeHtml(event.message)}` : "Preparing GPU weights…";
}

function enableChat() {
  setLoading(false);
  els.newBtn.disabled = false;
  els.input.focus();
}

function setLoading(on) {
  isLoading = on;
  els.input.disabled = !capabilitiesAvailable || on || isGenerating;
  setSeedsEnabled(capabilitiesAvailable && !on && !isGenerating);
  refreshSend();
}

async function disposeModel() {
  if (disposalPromise) return disposalPromise;
  const hadLoadedConversation = Boolean(model);
  disposalPromise = (async () => {
    els.unloadBtn.disabled = true;
    abortController?.abort();
    if (generationPromise) await generationPromise.catch(() => {});
    await modelLifecycle.dispose();

    model = null;
    messages = [];
    isLoading = false;
    // A canceled first load has no conversation yet, so its prompt remains available for retry.
    if (hadLoadedConversation) els.input.value = "";
    els.input.disabled = !capabilitiesAvailable;
    els.input.placeholder = "Ask anything…";
    els.newBtn.disabled = true;
    els.loadBtn.disabled = !capabilitiesAvailable;
    els.loadBtn.textContent = "Load model";
    els.loadBtn.classList.remove("hidden");
    els.unloadBtn.classList.add("hidden");
    els.unloadBtn.disabled = false;
    setProgressImmediate(0);
    els.bar.classList.remove("done");
    setStatus("", "Model unloaded.");
    renderWelcome();
    setSeedsEnabled(capabilitiesAvailable);
    refreshSend();
    console.log("[app] model disposed; ownership released.");
  })().finally(() => {
    disposalPromise = null;
  });
  return disposalPromise;
}

function send(options = {}) {
  const text = els.input.value.trim();
  if (!text || isGenerating) return;
  return submissionFlow.submit(text, options);
}

async function generateMessage(text, { maxNewTokens = 4096 } = {}) {
  if (!text || !model || isGenerating) return;

  removeWelcome();
  els.input.value = ""; autoGrow(); refreshSend();
  appendUser(text);
  messages.push({ role: "user", content: text });

  const { msg, bubble } = appendAssistant();
  bubble.innerHTML = '<span class="thinking"><span></span><span></span><span></span></span>';
  scrollDown();

  setGenerating(true);
  abortController = new AbortController();

  let reply = "", startedAt = 0, firstTokenAt = 0, endedAt = 0, tokens = 0;
  try {
    const stream = model.generate(messages, { maxNewTokens, signal: abortController.signal });
    startedAt = performance.now();
    for await (const { text: full } of stream) {
      const now = performance.now();
      if (!firstTokenAt) firstTokenAt = now;
      tokens++; reply = full;
      scheduleRender(bubble, reply);
      updateLiveStat(startedAt, firstTokenAt, now, tokens);
    }
  } catch (error) {
    console.error("[app] generate error:", error?.stack || error?.message || error);
    if (!reply) reply = `_Stopped: ${escapeHtml(String(error?.message ?? error))}_`;
  } finally {
    endedAt = performance.now();
    pendingRender = null;
    renderAssistant(bubble, reply, false);
    appendMeta(msg, { startedAt, firstTokenAt, endedAt, tokens });
    scrollDown();
    messages.push({ role: "assistant", content: reply });
    setGenerating(false);
    els.liveStat.textContent = "";
    abortController = null;
    els.input.focus();
  }
}

function setGenerating(on) {
  isGenerating = on;
  els.input.disabled = !capabilitiesAvailable || on;
  els.newBtn.disabled = on;
  els.unloadBtn.disabled = on;
  els.sendBtn.classList.toggle("hidden", on);
  els.stopBtn.classList.toggle("hidden", !on);
  if (on) setStatus("busy", "Generating…");
  else if (model) setStatus("ready", "Ready · on-device");
  refreshSend();
}

function updateLiveStat(startedAt, firstTokenAt, now, tokens) {
  if (tokens <= 1) { els.liveStat.textContent = `TTFT ${(firstTokenAt - startedAt).toFixed(0)} ms`; return; }
  const tps = (tokens - 1) / Math.max((now - firstTokenAt) / 1000, 1e-9);
  els.liveStat.textContent = `${tps.toFixed(1)} tok/s`;
}

function newSession() {
  if (isGenerating) return;
  messages = [];
  model?.reset();
  renderWelcome();
  setSeedsEnabled(capabilitiesAvailable);
  els.input.focus();
}

async function handleDebugCommand(event) {
  const detail = event.detail ?? {};
  const command = detail.command;
  try {
    if (command === "load-model") {
      await loadModel();
    } else if (command === "dispose-model") {
      await disposeModel();
    } else if (command === "run-prompt") {
      if (!model) throw new Error("Model is not ready");
      const prompt = String(detail.prompt ?? "").trim();
      if (!prompt) throw new Error("Prompt is required");
      const maxNewTokens = clamp(Number(detail.maxNewTokens) || 64, 1, 512);
      newSession();
      els.input.value = prompt;
      await send({ maxNewTokens });
    } else {
      return;
    }
    reportDebugEvent("command-result", {
      requestId: detail.requestId,
      command,
      ok: true,
      state: modelLifecycle.state,
    });
  } catch (error) {
    reportDebugEvent("command-result", {
      requestId: detail.requestId,
      command,
      ok: false,
      state: modelLifecycle.state,
      error: String(error?.message ?? error),
    });
    console.error(`[app] debug command ${command} failed:`, error);
  }
}

function reportDebugEvent(type, payload) {
  window.dispatchEvent(new CustomEvent("webml-debug-event", {
    detail: { type, payload },
  }));
}

// ---- DOM builders ----
function appendUser(text) {
  const msg = document.createElement("div");
  msg.className = "msg user";
  msg.appendChild(role("You"));
  const bubble = document.createElement("div");
  bubble.className = "bubble user"; bubble.textContent = text;
  msg.appendChild(bubble); els.thread.appendChild(msg); scrollDown();
}
function appendAssistant() {
  const msg = document.createElement("div");
  msg.className = "msg assistant";
  msg.appendChild(role("Gemma"));
  const bubble = document.createElement("div");
  bubble.className = "bubble assistant";
  msg.appendChild(bubble); els.thread.appendChild(msg);
  return { msg, bubble };
}
function role(text) { const d = document.createElement("div"); d.className = "role"; d.textContent = text; return d; }
function appendMeta(msg, { startedAt, firstTokenAt, endedAt, tokens }) {
  if (tokens <= 0) return;
  const decodeTokens = Math.max(tokens - 1, 0);
  const decodeSec = Math.max((endedAt - firstTokenAt) / 1000, 1e-9);
  const tps = decodeTokens > 0 ? decodeTokens / decodeSec : 0;
  const ttft = firstTokenAt - startedAt;
  const meta = document.createElement("div");
  meta.className = "meta";
  const parts = [`${tokens} tok`, `TTFT ${ttft.toFixed(0)} ms`];
  if (tps > 0) parts.push(`${tps.toFixed(1)} tok/s`);
  meta.textContent = parts.join("  ·  ");
  msg.appendChild(meta);
}

// ---- streamed render (coalesced to 1/frame) ----
let renderScheduled = false, pendingRender = null;
function scheduleRender(bubble, raw) {
  pendingRender = { bubble, raw };
  if (renderScheduled) return;
  renderScheduled = true;
  requestAnimationFrame(() => {
    renderScheduled = false;
    if (!pendingRender) return;
    renderAssistant(pendingRender.bubble, pendingRender.raw, true);
    scrollDown();
  });
}
function renderAssistant(bubble, raw, caret) {
  if (marked) {
    try { bubble.innerHTML = sanitize(marked.parse(raw || "")); if (caret) addCaret(bubble); return; }
    catch { /* fall through */ }
  }
  const safe = escapeHtml(raw || "");
  const paras = safe.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  bubble.innerHTML = paras.map((p) => `<p>${p.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/`([^`]+?)`/g, "<code>$1</code>").replace(/\n/g, "<br>")}</p>`).join("");
  if (caret) addCaret(bubble);
}
function addCaret(bubble) {
  const c = document.createElement("span"); c.className = "caret";
  (bubble.querySelector("p:last-of-type") || bubble).appendChild(c);
}
function sanitize(html) {
  const tpl = document.createElement("template");
  tpl.innerHTML = html;
  tpl.content.querySelectorAll("script,style,iframe,object,embed,link,meta,form").forEach((el) => el.remove());
  tpl.content.querySelectorAll("*").forEach((el) => {
    for (const attr of [...el.attributes]) {
      const n = attr.name.toLowerCase();
      if (n.startsWith("on") || ((n === "href" || n === "src") && /^\s*(javascript|data):/i.test(attr.value))) el.removeAttribute(attr.name);
    }
  });
  return tpl.innerHTML;
}

// ---- welcome ----
function renderWelcome() {
  els.thread.replaceChildren();
  const w = document.createElement("div");
  w.className = "welcome"; w.id = "welcome";
  w.innerHTML = `
    <h2>What's on your mind?</h2>
    <p>Gemma runs on your device and gets ready when you send your first message.</p>
    <div class="seeds">
      <button class="seed" type="button">Write a haiku about on-device AI</button>
      <button class="seed" type="button">Explain WebGPU in two sentences</button>
      <button class="seed" type="button">Give me a quick pasta recipe</button>
    </div>`;
  els.thread.appendChild(w);
  setSeedsEnabled(capabilitiesAvailable);
}
function removeWelcome() { $("welcome")?.remove(); }
function setSeedsEnabled(on) { document.querySelectorAll(".seed").forEach((s) => { s.disabled = !on; }); }

// ---- utils ----
function refreshSend() { els.sendBtn.disabled = !capabilitiesAvailable || isLoading || isGenerating || els.input.value.trim() === ""; }
function autoGrow() { els.input.style.height = "auto"; els.input.style.height = `${Math.min(els.input.scrollHeight, 160)}px`; }
function scrollDown() { els.scroll.scrollTop = els.scroll.scrollHeight; }
function finite(v) { return typeof v === "number" && Number.isFinite(v); }
function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }
function fmtInt(v) { return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(v); }
function fmtBytes(bytes) {
  const u = ["B", "KB", "MB", "GB"]; let v = bytes, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  const d = i === 3 ? 2 : (v >= 10 || i === 0 ? 0 : 1);
  return `${v.toFixed(d)} ${u[i]}`;
}
function escapeHtml(v) { return String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
