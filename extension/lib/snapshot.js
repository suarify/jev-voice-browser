/**
 * Perception: turn the current tab into a compact, Jev-friendly state.
 * Ported from src/snapshot.js. The DOM collector itself lives in content.js
 * (it runs inside the page); this module is the pure part: compaction, site
 * detection, search-box heuristic and the size guard.
 */
import { MAX_ELEMENTS, MAX_ELEMENT_TEXT, MAX_STATE_CHARS } from "./constants.js";

/** Coarse site detection from the URL (code, not Jev). */
export function detectSite(url) {
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "generic";
  }
  if (host.endsWith("google.com") || host.endsWith("google.co.uk")) return "google";
  if (host.endsWith("duckduckgo.com")) return "duckduckgo";
  if (host.endsWith("youtube.com")) return "youtube";
  if (host.endsWith("wikipedia.org")) return "wikipedia";
  if (host.endsWith("github.com")) return "github";
  if (host.endsWith("amazon.com") || host.endsWith("amazon.de") || host.endsWith("amazon.co.uk")) return "amazon";
  if (host.endsWith("reddit.com")) return "reddit";
  if (host === "x.com" || host.endsWith("twitter.com")) return "twitter_x";
  if (host.endsWith("news.ycombinator.com")) return "hacker_news";
  if (host === "example.com") return "example_com";
  if (!host || url.startsWith("about:")) return "blank";
  return "generic";
}

const SEARCHY = /(^|[^a-z])(q|query|search|s|keyword|k|search_query)($|[^a-z])/i;

/** Heuristic: which element id is the page's main search box? */
export function findSearchBox(elements) {
  const inputs = elements.filter((e) => ["searchbox", "textbox", "combobox"].includes(e.role));
  const scored = inputs.map((e) => {
    let s = 0;
    if (e.role === "searchbox" || e.type === "search") s += 5;
    if (SEARCHY.test(e.inputName || "")) s += 3;
    if (/search/i.test(e.placeholder || "") || /search/i.test(e.text || "")) s += 3;
    if (e.inViewport) s += 1;
    return { e, s };
  });
  scored.sort((a, b) => b.s - a.s || a.e.top - b.e.top);
  return scored.length && scored[0].s > 0 ? scored[0].e.id : null;
}

function truncate(s, n) {
  s = String(s || "");
  return s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s;
}

/**
 * Build the compact element list that goes into the Jev state.
 * Priority: viewport-visible first (top-to-bottom), then the rest. Dedupe on (role, text, href).
 * Drops nameless elements unless they are inputs. Enforces MAX_ELEMENTS and MAX_STATE_CHARS.
 */
export function compactElements(rawElements, opts = {}) {
  const maxElements = opts.maxElements ?? MAX_ELEMENTS;
  const maxText = opts.maxText ?? MAX_ELEMENT_TEXT;
  const maxChars = opts.maxChars ?? MAX_STATE_CHARS;

  const sorted = [...rawElements].sort((a, b) => {
    if (a.inViewport !== b.inViewport) return a.inViewport ? -1 : 1;
    return a.top - b.top || a.left - b.left;
  });

  const seen = new Set();
  const out = [];
  for (const e of sorted) {
    const isInput = ["textbox", "searchbox", "combobox", "select", "checkbox", "radio"].includes(e.role);
    const text = truncate(e.text || e.placeholder, maxText);
    if (!text && !isInput) continue;
    const key = `${e.role}|${text.toLowerCase()}|${e.href || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const rec = { id: e.id, role: e.role, text };
    if (e.placeholder && e.placeholder !== text) rec.placeholder = truncate(e.placeholder, 40);
    if (e.href) rec.href = truncate(e.href, 50);
    if (!e.inViewport) rec.below_fold = true;
    out.push(rec);
    if (out.length >= maxElements) break;
  }

  while (out.length > 5 && JSON.stringify(out).length > maxChars) {
    out.length = Math.max(5, Math.floor(out.length * 0.8));
  }
  return out;
}

/** Full snapshot record used by the controller: raw (for execution) + compact (for Jev). */
export function buildSnapshot(pageData, extra = {}) {
  const elements = compactElements(pageData.elements);
  const searchBoxId = findSearchBox(pageData.elements);
  const site = detectSite(pageData.url);
  return {
    url: pageData.url,
    title: pageData.title,
    site,
    scrollY: pageData.scrollY,
    scrollHeight: pageData.scrollHeight,
    viewportHeight: pageData.viewportHeight,
    searchBoxId,
    elements,
    rawById: Object.fromEntries(pageData.elements.map((e) => [e.id, e])),
    ...extra,
  };
}

/** Approximate token count for observability (~4 chars/token English). */
export function approxTokens(obj) {
  return Math.ceil(JSON.stringify(obj).length / 4);
}