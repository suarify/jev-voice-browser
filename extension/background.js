/**
 * background.js — manifest-v3 service worker.
 *
 * Orchestrator (ported from src/controller.js): transcript updates → (debounce, cancel stale)
 * → one Jev request → policy → execute. Element actions are performed by content.js in the
 * current tab; tab-level actions (navigate, history, tabs) use the chrome.tabs API.
 *
 * Holds the config (base URL + API key + model) — the popup and content scripts never see the key.
 */
import {
  DEBOUNCE_MS,
  SILENCE_COMPLETE_MS,
  CANDIDATE_TTL_MS,
  MAX_INFLIGHT,
  MAX_CONTEXT_ACTIONS,
  T,
  DEFAULT_MODEL,
} from "./lib/constants.js";
import { decide, isAbortError } from "./lib/jev.js";
import { evaluatePolicy, describe } from "./lib/policy.js";
import { buildSnapshot, approxTokens } from "./lib/snapshot.js";
import { parseCandidatePick, cleanTranscript } from "./lib/spans.js";

const DEFAULT_CONFIG = { baseUrl: "https://api.typesafe.ai", apiKey: "", model: DEFAULT_MODEL, showHints: false, lang: "auto" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const avg = (xs) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
let config = { ...DEFAULT_CONFIG };

async function loadConfig() {
  const stored = await chrome.storage.local.get(["vbxConfig"]);
  config = { ...DEFAULT_CONFIG, ...(stored.vbxConfig || {}) };
  return config;
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

async function tabMessage(tabId, msg) {
  if (tabId == null) return null;
  try {
    return await chrome.tabs.sendMessage(tabId, msg);
  } catch {
    return null; // restricted page or content script not loaded
  }
}

async function toast(tabId, msg, ms) {
  return tabMessage(tabId, { type: "toast", msg, ms });
}

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------
let snapshot = null;
let snapshotAt = 0;

async function refreshSnapshot() {
  const tab = await activeTab();
  const raw = tab ? await tabMessage(tab.id, { type: "getSnapshot" }) : null;
  if (!raw || !raw.elements) {
    snapshot = {
      url: tab?.url || "about:blank",
      title: tab?.title || "",
      site: "blank",
      scrollY: 0,
      scrollHeight: 0,
      viewportHeight: 0,
      searchBoxId: null,
      elements: [],
      rawById: {},
      restricted: true,
    };
  } else {
    snapshot = buildSnapshot(raw);
  }
  snapshotAt = Date.now();
  return snapshot;
}

// ---------------------------------------------------------------------------
// Conversation context
// ---------------------------------------------------------------------------
let context = { previousPage: null, recentActions: [] };

// ---------------------------------------------------------------------------
// Utterance / decision state (same fields as the Node controller)
// ---------------------------------------------------------------------------
let utterance = null;
let consumed = null;
let pending = null;
let candidates = null;
let lastDecision = null;
let hints = []; // [{n,id}] from content when "show hints" is on
let debounceTimer = null;
let silenceTimer = null;
let inflight = [];
let busy = false;
let log = [];
let stats = { calls: 0, inputTokens: 0, costUsd: 0, latencies: [], actions: 0, model: DEFAULT_MODEL };

function _log(level, msg, extra = {}) {
  const entry = { t: Date.now(), level, msg, ...extra };
  log.push(entry);
  if (log.length > 200) log.shift();
  pushState();
}

function pushState() {
  const lat = stats.latencies;
  const sorted = [...lat].sort((a, b) => a - b);
  const p50 = sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
  const payload = {
    configStatus: {
      baseUrl: config.baseUrl,
      model: config.model,
      hasKey: Boolean(config.apiKey),
      showHints: config.showHints,
      lang: config.lang,
    },
    state: "idle",
    thresholds: T,
    stats: {
      calls: stats.calls,
      actions: stats.actions,
      inputTokens: stats.inputTokens,
      costUsd: stats.costUsd,
      lastLatencyMs: lat[lat.length - 1] ?? null,
      p50LatencyMs: p50,
      avgLatencyMs: lat.length ? Math.round(lat.reduce((a, b) => a + b, 0) / lat.length) : null,
    },
    transcript: utterance?.text ?? null,
    utteranceFinal: utterance?.final ?? false,
    snapshot: snapshot && { url: snapshot.url, title: snapshot.title, site: snapshot.site, restricted: !!snapshot.restricted },
    lastDecision: lastDecision
      ? {
          transcript: lastDecision.transcript,
          decision: lastDecision.policy.decision,
          summary: lastDecision.policy.summary,
          latencyMs: lastDecision.latencyMs,
          costUsd: lastDecision.costUsd,
          reasons: lastDecision.policy.reasons,
        }
      : null,
    pending: pending ? { summary: describe(pending) } : null,
    candidates: candidates?.list ?? null,
    hintsEnabled: config.showHints,
    hintCount: hints.length,
    log: log.slice(-40),
  };
  chrome.runtime.sendMessage({ type: "vbx-state", payload }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Transcript handling (ported from Controller)
// ---------------------------------------------------------------------------
function handleCommand(text) {
  return handleTranscript({ text, final: true, utteranceId: `typed-${Date.now()}` });
}

async function handleTranscript({ text, final = false, utteranceId }) {
  let clean = cleanTranscript(text);
  const now = Date.now();

  if (consumed && consumed.id === utteranceId) {
    if (!clean.toLowerCase().startsWith(consumed.prefix)) return;
    clean = clean.slice(consumed.prefix.length).trim();
    if (clean.split(/\s+/).filter(Boolean).length < 2) return;
    utteranceId = `${utteranceId}+${consumed.gen}`;
  }

  if (!utterance || utterance.id !== utteranceId) {
    utterance = {
      id: utteranceId,
      physicalId: utteranceId,
      prefix: "",
      gen: 0,
      text: clean,
      final,
      startedAt: now,
      updatedAt: now,
      actedOn: false,
      actedText: null,
    };
  } else {
    if (clean === utterance.text && final === utterance.final) return;
    utterance.text = clean;
    utterance.final = final || utterance.final;
    utterance.updatedAt = now;
  }
  pushState();
  if (!clean || utterance.actedOn) return;

  // Deterministic shortcut: numbered candidate overlays + a spoken number => no Jev needed.
  if (candidates && now - candidates.at < CANDIDATE_TTL_MS) {
    const n = parseCandidatePick(clean, candidates.list.length);
    if (n) {
      const c = candidates.list[n - 1];
      const intent = candidates.intent;
      _consume(utterance, clean);
      candidates = null;
      await _runAction({ ...intent, targetId: c.id, label: c.label }, { via: "candidate-pick" });
      return;
    }
  }

  // click-by-voice borrow: when "show hints" is on, a bare number picks that element directly.
  if (config.showHints && hints.length) {
    const n = parseCandidatePick(clean, hints.length);
    if (n) {
      const hit = hints.find((h) => h.n === n);
      if (hit) {
        _consume(utterance, clean);
        _log("info", `picked hint ${n} (${hit.id}) — no model call`);
        await _runAction({ type: "click_element", targetId: hit.id, label: hit.id }, { via: "hint-pick" });
        return;
      }
    }
  }

  clearTimeout(debounceTimer);
  clearTimeout(silenceTimer);
  debounceTimer = setTimeout(() => decideNow("debounce"), final ? 0 : DEBOUNCE_MS);
}

function _consume(utt, text) {
  utt.actedOn = true;
  utt.actedText = text;
  consumed = {
    id: utt.physicalId,
    prefix: `${utt.prefix} ${text}`.trim().toLowerCase(),
    gen: (utt.gen || 0) + 1,
  };
}

async function decideNow(trigger = "manual") {
  const utt = utterance;
  if (!utt || !utt.text || utt.actedOn) return;
  if (busy) {
    silenceTimer = setTimeout(() => decideNow("after-action"), 150);
    return;
  }
  while (inflight.length >= MAX_INFLIGHT) {
    const old = inflight.shift();
    old.ac.abort();
  }
  const ac = new AbortController();
  const req = { ac, text: utt.text, at: Date.now() };
  inflight.push(req);

  if (Date.now() - snapshotAt > 1500) await refreshSnapshot();

  const textAtRequest = utt.text;
  const tabs = await chrome.tabs.query({ currentWindow: true });
  let result;
  try {
    result = await decide(
      {
        transcript: textAtRequest,
        snapshot,
        pendingConfirmation: pending ? describe(pending) : null,
        tabs,
        context,
      },
      config,
      { signal: ac.signal },
    );
  } catch (err) {
    inflight = inflight.filter((r) => r !== req);
    if (isAbortError(err) || ac.signal.aborted) {
      _log("debug", `cancelled stale request for "${textAtRequest}"`);
      return;
    }
    _log("error", `Jev error: ${err.message || err}`);
    pushState();
    return;
  }
  inflight = inflight.filter((r) => r !== req);
  if (ac.signal.aborted || utterance !== utt || utt.actedOn) return;

  stats.calls += 1;
  stats.inputTokens += result.usage?.input_tokens ?? 0;
  stats.costUsd += result.costUsd;
  stats.latencies.push(result.latencyMs);
  if (stats.latencies.length > 200) stats.latencies.shift();
  if (result.model) stats.model = result.model;

  const stale = utt.text !== textAtRequest;
  const silentMs = stale ? 0 : Date.now() - utt.updatedAt;
  const policy = evaluatePolicy({
    answers: result.answers,
    candidates: result.candidates,
    snapshot,
    silentMs,
    isFinal: utt.final && !stale,
    pending,
    context,
  });

  lastDecision = {
    transcript: textAtRequest,
    trigger,
    latencyMs: result.latencyMs,
    usage: result.usage,
    costUsd: result.costUsd,
    questionCount: result.questionCount,
    stateTokens: approxTokens(result.state),
    policy,
    silentMs,
    at: Date.now(),
  };
  pushState();
  _log(
    policy.decision === "act" ? "act" : "info",
    `${result.latencyMs}ms · "${textAtRequest}" → ${policy.decision}: ${policy.summary}`,
  );

  switch (policy.decision) {
    case "act": {
      _consume(utt, textAtRequest);
      if (policy.action.confirmed) pending = null;
      candidates = null;
      await _runAction(policy.action, { decision: lastDecision, utterance: utt });
      break;
    }
    case "confirm": {
      _consume(utt, textAtRequest);
      pending = policy.action;
      const tab = await activeTab();
      await toast(tab?.id, `Say "confirm" to ${describe(policy.action)}`, 6000);
      pushState();
      break;
    }
    case "cancel": {
      _consume(utt, textAtRequest);
      pending = null;
      const tab = await activeTab();
      await toast(tab?.id, "cancelled");
      pushState();
      break;
    }
    case "disambiguate": {
      const list = policy.candidates.map((c, i) => ({ n: i + 1, id: c.id, label: c.label, p: c.p }));
      candidates = { list, intent: policy.pendingIntent, at: Date.now() };
      const tab = await activeTab();
      await tabMessage(tab?.id, { type: "candidates", list, ms: CANDIDATE_TTL_MS });
      await toast(tab?.id, "Which one? Say the number.", 3000);
      pushState();
      _scheduleSilenceRetry(utt);
      break;
    }
    case "wait":
      _scheduleSilenceRetry(utt, policy.retryInMs);
      break;
    default:
      break;
  }
}

function _scheduleSilenceRetry(utt, retryInMs = null) {
  clearTimeout(silenceTimer);
  const waitFor = retryInMs ?? Math.max(50, SILENCE_COMPLETE_MS - (Date.now() - utt.updatedAt));
  silenceTimer = setTimeout(() => {
    if (utterance === utt && !utt.actedOn) decideNow("silence");
  }, waitFor);
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------
async function _runAction(action, meta = {}) {
  busy = true;
  const t0 = Date.now();
  const utt = meta.utterance || utterance;
  const pageBefore = snapshot ? { url: snapshot.url, title: snapshot.title, site: snapshot.site } : null;
  try {
    const res = await execute(action);
    stats.actions += 1;
    _recordContext({ action, ok: res.ok, detail: res.detail, said: meta.decision?.transcript || utt?.actedText || "", pageBefore });
    _log(res.ok ? "act" : "warn", `${res.ok ? "✓" : "✗"} ${describe(action)} — ${res.detail || ""}`);
  } catch (err) {
    _log("error", `action failed: ${describe(action)} — ${err.message || err}`);
  } finally {
    busy = false;
    await refreshSnapshot().catch(() => {});
    pushState();
  }
}

async function execute(action) {
  const tab = await activeTab();
  if (!tab) return { ok: false, detail: "no active tab" };

  switch (action.type) {
    case "navigate_url": {
      await toast(tab.id, `→ ${action.label || action.url}`);
      await chrome.tabs.update(tab.id, { url: action.url });
      await sleep(700);
      const after = await chrome.tabs.get(tab.id);
      return { ok: true, detail: after.url };
    }

    case "go_back":
      await toast(tab.id, "← back");
      await chrome.tabs.goBack(tab.id).catch(() => {});
      await sleep(600);
      return { ok: true, detail: (await chrome.tabs.get(tab.id)).url };

    case "go_forward":
      await toast(tab.id, "→ forward");
      await chrome.tabs.goForward(tab.id).catch(() => {});
      await sleep(600);
      return { ok: true, detail: (await chrome.tabs.get(tab.id)).url };

    case "reload":
      await toast(tab.id, "↻ reload");
      await chrome.tabs.reload(tab.id);
      await sleep(600);
      return { ok: true, detail: tab.url };

    case "open_new_tab":
      await chrome.tabs.create({});
      await sleep(300);
      return { ok: true, detail: `tabs=${(await chrome.tabs.query({ currentWindow: true })).length}` };

    case "close_tab": {
      const tabs = await chrome.tabs.query({ currentWindow: true });
      if (tabs.length <= 1) await chrome.tabs.create({});
      await chrome.tabs.remove(tab.id);
      await sleep(300);
      return { ok: true, detail: `tabs=${(await chrome.tabs.query({ currentWindow: true })).length}` };
    }

    case "switch_tab": {
      const tabs = await chrome.tabs.query({ currentWindow: true });
      if (tabs.length < 2) return { ok: false, detail: "only one tab" };
      const idx = tabs.findIndex((t) => t.active);
      let next;
      if (action.direction === "previous") next = tabs[(idx - 1 + tabs.length) % tabs.length];
      else if (action.direction === "first") next = tabs[0];
      else next = tabs[(idx + 1) % tabs.length];
      await chrome.tabs.update(next.id, { active: true });
      await sleep(300);
      return { ok: true, detail: next.url || "switched tab" };
    }

    case "screenshot": {
      await toast(tab.id, "📸 screenshot");
      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const filename = `voicebrowser-${stamp}.png`;
      await chrome.downloads.download({ url: dataUrl, filename, saveAs: false });
      return { ok: true, detail: `saved ${filename}` };
    }

    case "print":
      await toast(tab.id, "🖨 print / save as PDF");
      await chrome.tabs.print();
      return { ok: true, detail: "print dialog opened" };

    // In-page actions → content script.
    case "click_element":
    case "type_into_field":
    case "select_option":
    case "press_enter":
    case "scroll_down":
    case "scroll_up":
    case "read_aloud": {
      const res = await tabMessage(tab.id, { type: "execute", action: { ...action, lang: config.lang } });
      return res || { ok: false, detail: "content script unavailable on this page" };
    }

    default:
      return { ok: false, detail: `unknown action ${action.type}` };
  }
}

function _recordContext({ action, ok, detail, said, pageBefore }) {
  const after = snapshot?.url ?? null;
  const navigated = pageBefore && after && after !== pageBefore.url;
  if (navigated) context.previousPage = pageBefore;
  let outcome = ok ? "done" : "failed";
  if (ok && navigated) outcome = `navigated to ${after.replace(/^https?:\/\/(www\.)?/, "").slice(0, 80)}`;
  else if (ok && typeof detail === "string" && detail && !detail.startsWith("http")) outcome = detail.slice(0, 80);
  context.recentActions.push({
    type: action.type,
    targetId: action.targetId ?? null,
    targetLabel: action.label ?? null,
    text: action.text ?? null,
    url: action.url ?? null,
    said,
    ok,
    outcome,
    at: Date.now(),
  });
  if (context.recentActions.length > MAX_CONTEXT_ACTIONS) context.recentActions.shift();
}

// ---------------------------------------------------------------------------
// Messaging
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    switch (msg?.type) {
      case "transcript":
        await handleTranscript({ text: msg.text, final: Boolean(msg.final), utteranceId: msg.utteranceId || "mic" });
        sendResponse({ ok: true });
        return;
      case "typed-command":
        await handleCommand(msg.text);
        sendResponse({ ok: true });
        return;
      case "get-state":
        sendResponse(buildUiState());
        return;
      case "config-updated":
        await loadConfig();
        await refreshSnapshot();
        // re-apply the "show hints" mode to the current tab
        const tab = await activeTab();
        const hintRes = await tabMessage(tab?.id, { type: "showHints", mode: config.showHints ? "on" : "off" });
        hints = hintRes?.hints ?? [];
        pushState();
        sendResponse({ ok: true });
        return;
      case "set-hints": {
        const mode = msg.enabled ? "on" : "off";
        const tab2 = await activeTab();
        const res = await tabMessage(tab2?.id, { type: "showHints", mode });
        hints = res?.hints ?? [];
        config.showHints = msg.enabled;
        await chrome.storage.local.set({ vbxConfig: config });
        pushState();
        sendResponse({ ok: true, hints });
        return;
      }
      case "clear-pending":
        pending = null;
        candidates = null;
        pushState();
        sendResponse({ ok: true });
        return;
      case "reset-context":
        context = { previousPage: null, recentActions: [] };
        sendResponse({ ok: true });
        return;
      default:
        sendResponse({ ok: false, detail: `unknown message ${msg?.type}` });
    }
  })();
  return true;
});

function buildUiState() {
  const lat = stats.latencies;
  const sorted = [...lat].sort((a, b) => a - b);
  const p50 = sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
  return {
    configStatus: {
      baseUrl: config.baseUrl,
      model: config.model,
      hasKey: Boolean(config.apiKey),
      showHints: config.showHints,
      lang: config.lang,
    },
    state: "idle",
    thresholds: T,
    stats: {
      calls: stats.calls,
      actions: stats.actions,
      inputTokens: stats.inputTokens,
      costUsd: stats.costUsd,
      lastLatencyMs: lat[lat.length - 1] ?? null,
      p50LatencyMs: p50,
      avgLatencyMs: avg(lat),
    },
    transcript: utterance?.text ?? null,
    utteranceFinal: utterance?.final ?? false,
    snapshot: snapshot && { url: snapshot.url, title: snapshot.title, site: snapshot.site, restricted: !!snapshot.restricted },
    lastDecision: lastDecision
      ? {
          transcript: lastDecision.transcript,
          decision: lastDecision.policy.decision,
          summary: lastDecision.policy.summary,
          latencyMs: lastDecision.latencyMs,
          costUsd: lastDecision.costUsd,
          reasons: lastDecision.policy.reasons,
        }
      : null,
    pending: pending ? { summary: describe(pending) } : null,
    candidates: candidates?.list ?? null,
    hintsEnabled: config.showHints,
    hintCount: hints.length,
    log: log.slice(-40),
  };
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
chrome.runtime.onInstalled.addListener(() => {
  loadConfig();
});
loadConfig().then(() => refreshSnapshot());