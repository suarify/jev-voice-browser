/**
 * The single Jev request per transcript update: build state + speculative question fan-out,
 * call the API, return typed answers with latency / usage / cost.
 *
 * Extension port of src/jev.js that talks to the SAME wire protocol as the Node SDK
 * (`POST {baseURL}/v1/systemone`, `Authorization: Bearer <key>`, body `{state, questions, model}`)
 * using plain fetch, so it runs in a manifest-v3 service worker.
 *
 * The endpoint is configurable: point it at the TypeSafe API (`https://api.typesafe.ai`) or at
 * any compatible local proxy / reimplementation (e.g. `http://localhost:8787`) — handy for
 * testing without spending credits or when running a self-hosted decision server.
 */
import {
  DEFAULT_MODEL,
  PRICE_PER_M_INPUT_TOKENS_USD,
  QUESTIONS,
  MAX_TRANSCRIPT_CHARS,
  MAX_CONTEXT_ACTIONS,
} from "./constants.js";
import { extractTextCandidates, extractUrlCandidates } from "./spans.js";

export function costUsd(usage) {
  const tokens = usage?.input_tokens ?? 0;
  return (tokens / 1_000_000) * PRICE_PER_M_INPUT_TOKENS_USD;
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** `e09 link "GitHub - typesafe-ai" → github.com` — short, human-readable, few tokens. */
export function encodeElement(el, pageHost = "") {
  let s = `${el.id} ${el.role}`;
  const text = el.text || "";
  if (text) s += ` "${text}"`;
  if (el.placeholder && el.placeholder !== text) s += ` (placeholder: ${el.placeholder})`;
  if (el.href) {
    const host = el.href.split("/")[0];
    if (host && host !== pageHost) s += ` → ${host}`;
  }
  if (el.below_fold) s += " [below fold]";
  return s;
}

/**
 * Compact conversation context: where the user just came from and the last few executed actions,
 * most recent first. `null` when nothing has happened yet.
 */
export function encodeContext(context) {
  if (!context) return null;
  const out = {};
  if (context.previousPage?.url) {
    out.previous_page = {
      url: String(context.previousPage.url).slice(0, 200),
      title: String(context.previousPage.title || "").slice(0, 120),
    };
  }
  const actions = (context.recentActions || []).slice(-MAX_CONTEXT_ACTIONS).reverse();
  if (actions.length) {
    const now = Date.now();
    out.recent_actions = actions.map((a) => {
      const e = { said: String(a.said || "").slice(0, 120), action: a.type };
      if (a.targetLabel) e.target = String(a.targetLabel).slice(0, 80);
      if (a.text) e.text = String(a.text).slice(0, 80);
      if (a.url) e.url = String(a.url).slice(0, 200);
      e.outcome = a.outcome || (a.ok === false ? "failed" : "done");
      if (a.at) e.seconds_ago = Math.max(0, Math.round((now - a.at) / 1000));
      return e;
    });
  }
  return Object.keys(out).length ? out : null;
}

export function buildRequest({ transcript, snapshot, pendingConfirmation = null, tabs = null, context = null }) {
  const text = String(transcript || "").slice(-MAX_TRANSCRIPT_CHARS);
  const textCandidates = extractTextCandidates(text);
  const urlCandidates = extractUrlCandidates(text);

  const elements = snapshot?.elements || [];
  const pageHost = hostOf(snapshot?.url);
  const state = {
    transcript: text,
    page: {
      url: (snapshot?.url || "about:blank").slice(0, 200),
      title: (snapshot?.title || "").slice(0, 120),
      site: snapshot?.site || "blank",
    },
    elements: elements.map((el) => encodeElement(el, pageHost)),
  };
  const ctx = encodeContext(context);
  if (ctx) state.context = ctx;
  if (pendingConfirmation) state.pending_confirmation = pendingConfirmation;
  if (tabs && tabs.length > 1) state.open_tabs = tabs.length;

  const targetCriteria = {};
  for (const el of elements) targetCriteria[el.id] = null;
  targetCriteria.none = "No element on this page is referred to";

  const questions = {
    intent: choice(QUESTIONS.intent.instructions, QUESTIONS.intent.criteria),
    target: choice(QUESTIONS.target.instructions, targetCriteria),
    site: choice(QUESTIONS.site.instructions, QUESTIONS.site.criteria),
    complete: noul(QUESTIONS.complete.instructions, QUESTIONS.complete.criteria),
    is_command: noul(QUESTIONS.is_command.instructions, QUESTIONS.is_command.criteria),
    destructive: noul(QUESTIONS.destructive.instructions, QUESTIONS.destructive.criteria),
    scroll_amount: score(QUESTIONS.scroll_amount.instructions, QUESTIONS.scroll_amount.criteria),
    tab_direction: choice(QUESTIONS.tab_direction.instructions, QUESTIONS.tab_direction.criteria),
  };
  if (ctx?.recent_actions?.length) {
    questions.is_correction = noul(QUESTIONS.is_correction.instructions, QUESTIONS.is_correction.criteria);
  }

  if (textCandidates.length) {
    const c = Object.fromEntries(textCandidates.map((s) => [s, null]));
    c.none = "Nothing should be typed or searched";
    questions.text_span = choice(QUESTIONS.text_span.instructions, c);
  }
  if (urlCandidates.length) {
    const c = Object.fromEntries(urlCandidates.map((s) => [s, null]));
    c.none = "No web address is mentioned";
    questions.url_span = choice(QUESTIONS.url_span.instructions, c);
  }

  return { state, questions, candidates: { text: textCandidates, url: urlCandidates } };
}

const choice = (instructions, criteria) => ({ type: "choice", instructions, criteria });
const noul = (instructions, criteria) => ({ type: "noul", instructions, criteria });
const score = (instructions, criteria) => ({ type: "score", instructions, criteria });

const stripTrailingSlashes = (url) => String(url || "").replace(/\/+$/, "");

/**
 * Ask Jev (or a compatible endpoint). Resolves to { answers, latencyMs, usage, costUsd, model,
 * requestId, candidates, state, questionCount } or rejects with an AbortError when `signal`
 * aborts (newer transcript arrived).
 *
 * @param {object} input        { transcript, snapshot, pendingConfirmation, tabs, context }
 * @param {object} config       { baseUrl, apiKey, model } from extension storage
 * @param {{signal?: AbortSignal}} opts
 */
export async function decide(input, config = {}, { signal } = {}) {
  const baseUrl = stripTrailingSlashes(config.baseUrl || "https://api.typesafe.ai");
  const apiKey = config.apiKey;
  const model = config.model || DEFAULT_MODEL;
  if (!apiKey) {
    throw new Error("No API key configured. Open the extension options and paste a TypeSafe API key, or point the base URL at a local proxy.");
  }

  const { state, questions, candidates } = buildRequest(input);
  const t0 = performance.now();

  let res;
  try {
    res = await fetch(`${baseUrl}/v1/systemone`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ state, questions, model }),
      signal,
    });
  } catch (err) {
    if (err?.name === "AbortError") throw err;
    throw new Error(`Could not reach ${baseUrl}: ${err?.message || err}`);
  }

  if (!res.ok) {
    let detail = "";
    try {
      const body = await res.json();
      detail = body?.error?.message || body?.message || "";
    } catch {
      /* ignore */
    }
    throw new Error(`Jev API ${res.status}: ${detail || res.statusText}`);
  }

  const data = await res.json();
  const latencyMs = Math.round(performance.now() - t0);
  return {
    answers: data.answers,
    latencyMs,
    usage: data.usage,
    costUsd: costUsd(data.usage),
    model: data.model || model,
    requestId: res.headers.get("x-typesafe-request-id") || undefined,
    candidates,
    state,
    questionCount: Object.keys(questions).length,
  };
}

export function isAbortError(err) {
  return err?.name === "AbortError";
}