/**
 * content.js — runs in every page. Three jobs:
 *   1. Snapshot: tag interactive elements with stable `data-vb-id`s and report a compact raw list.
 *   2. Feedback: highlight / toast / numbered candidate overlays, plus an optional "show all
 *      hints" mode (borrowed from click-by-voice) that numbers every clickable element.
 *   3. Executor: perform in-page actions (click / type / select / scroll / press enter) via
 *      messages from the service worker. Tab-level actions (navigate, back, tabs) live in the
 *      worker and use the chrome.tabs API.
 *
 * Classic (non-module) content script — fully self-contained, no imports.
 */
(() => {
  if (window.__vbxContentLoaded) return;
  window.__vbxContentLoaded = true;

  const SELECTOR = [
    "a[href]",
    "button",
    "input:not([type=hidden])",
    "textarea",
    "select",
    "summary",
    "[role=button]",
    "[role=link]",
    "[role=tab]",
    "[role=menuitem]",
    "[role=option]",
    "[role=checkbox]",
    "[role=radio]",
    "[role=switch]",
    "[role=searchbox]",
    "[role=combobox]",
    "[role=textbox]",
    "[contenteditable=true]",
    "[onclick]",
  ].join(",");

  const clean = (s) => (s || "").replace(/\s+/g, " ").trim();

  function collectElements() {
    const win = window;
    const doc = document;
    if (!win.__vbNextId) win.__vbNextId = 1;

    const vw = win.innerWidth;
    const vh = win.innerHeight;
    const out = [];
    const nodes = doc.querySelectorAll(SELECTOR);

    for (const el of nodes) {
      if (out.length >= 400) break;
      let rect;
      try {
        rect = el.getBoundingClientRect();
      } catch {
        continue;
      }
      if (!rect || rect.width < 2 || rect.height < 2) continue;
      const style = win.getComputedStyle(el);
      if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0) continue;
      if (el.getAttribute("aria-hidden") === "true") continue;
      if (typeof el.checkVisibility === "function" && !el.checkVisibility()) continue;

      let id = el.getAttribute("data-vb-id");
      if (!id) {
        id = "e" + String(win.__vbNextId++).padStart(2, "0");
        el.setAttribute("data-vb-id", id);
      }

      const tag = el.tagName.toLowerCase();
      const type = (el.getAttribute("type") || "").toLowerCase();
      let role = el.getAttribute("role") || "";
      if (!role) {
        if (tag === "a") role = "link";
        else if (tag === "button" || type === "submit" || type === "button" || type === "reset") role = "button";
        else if (tag === "select") role = "select";
        else if (tag === "textarea") role = "textbox";
        else if (tag === "summary") role = "button";
        else if (tag === "input") {
          if (type === "search") role = "searchbox";
          else if (type === "checkbox") role = "checkbox";
          else if (type === "radio") role = "radio";
          else role = "textbox";
        } else if (el.isContentEditable) role = "textbox";
        else role = "clickable";
      }

      const img = el.querySelector && el.querySelector("img[alt]");
      const name =
        clean(el.getAttribute("aria-label")) ||
        clean(el.innerText) ||
        clean(el.value) ||
        clean(el.getAttribute("placeholder")) ||
        clean(el.getAttribute("title")) ||
        (img && clean(img.getAttribute("alt"))) ||
        clean(el.getAttribute("name")) ||
        "";

      const placeholder = clean(el.getAttribute("placeholder"));
      let href = "";
      if (tag === "a") {
        try {
          const u = new URL(el.href, location.href);
          href = u.hostname.replace(/^www\./, "") + (u.pathname !== "/" ? u.pathname : "");
        } catch {
          href = "";
        }
      }

      const inViewport = rect.bottom > 0 && rect.top < vh && rect.right > 0 && rect.left < vw;
      const inputName = clean(el.getAttribute("name")) || clean(el.getAttribute("id"));

      out.push({
        id,
        tag,
        role,
        text: name,
        placeholder,
        href,
        type,
        inputName,
        inViewport,
        top: Math.round(rect.top + win.scrollY),
        left: Math.round(rect.left + win.scrollX),
      });
    }

    return {
      url: location.href,
      title: doc.title,
      scrollY: win.scrollY,
      scrollHeight: doc.documentElement.scrollHeight,
      viewportHeight: vh,
      elements: out,
    };
  }

  // ---------------------------------------------------------------------------
  // Feedback overlay (port of src/overlay.js) + numbered hints
  // ---------------------------------------------------------------------------
  const Z = 2147483000;
  const css = `
    .__vbx-toast{position:fixed;left:50%;bottom:28px;transform:translateX(-50%);background:#111827;color:#f9fafb;
      font:600 15px/1.3 -apple-system,Segoe UI,Inter,sans-serif;padding:10px 16px;border-radius:10px;
      box-shadow:0 8px 30px rgba(0,0,0,.35);z-index:${Z};opacity:0;transition:opacity .15s;pointer-events:none;max-width:70vw}
    .__vbx-toast.__vbx-show{opacity:1}
    .__vbx-hl{position:absolute;border:3px solid #f59e0b;border-radius:6px;box-shadow:0 0 0 4px rgba(245,158,11,.25),0 0 24px rgba(245,158,11,.6);
      z-index:${Z};pointer-events:none;transition:opacity .3s}
    .__vbx-badge{position:absolute;background:#2563eb;color:#fff;font:700 13px/1 -apple-system,Segoe UI,Inter,sans-serif;
      padding:4px 7px;border-radius:999px;z-index:${Z};pointer-events:none;box-shadow:0 2px 10px rgba(0,0,0,.4);
      border:2px solid #fff}
    .__vbx-badge.__vbx-hint{background:#059669}
    .__vbx-cand{position:absolute;border:2px dashed #2563eb;border-radius:6px;z-index:${Z};pointer-events:none;
      background:rgba(37,99,235,.08)}
  `;

  function ensureStyle() {
    if (document.getElementById("__vbx-style")) return;
    const s = document.createElement("style");
    s.id = "__vbx-style";
    s.textContent = css;
    (document.head || document.documentElement).appendChild(s);
  }

  const byId = (id) => document.querySelector(`[data-vb-id="${id}"]`);
  const box = (el) => {
    const r = el.getBoundingClientRect();
    return { top: r.top + window.scrollY, left: r.left + window.scrollX, width: r.width, height: r.height };
  };

  let toastEl = null;
  let toastTimer = null;
  let candTimer = null;
  let hintMode = "off"; // off | on | all
  let hintBadges = [];

  function toast(msg, ms = 1800) {
    ensureStyle();
    if (!toastEl || !toastEl.isConnected) {
      toastEl = document.createElement("div");
      toastEl.className = "__vbx-toast";
      document.documentElement.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    requestAnimationFrame(() => toastEl.classList.add("__vbx-show"));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl && toastEl.classList.remove("__vbx-show"), ms);
  }

  function highlight(id, ms = 600) {
    ensureStyle();
    const el = byId(id);
    if (!el) return false;
    el.scrollIntoView({ block: "center", inline: "nearest" });
    const b = box(el);
    const h = document.createElement("div");
    h.className = "__vbx-hl";
    Object.assign(h.style, { top: b.top - 4 + "px", left: b.left - 4 + "px", width: b.width + 8 + "px", height: b.height + 8 + "px" });
    document.documentElement.appendChild(h);
    setTimeout(() => (h.style.opacity = "0"), ms);
    setTimeout(() => h.remove(), ms + 350);
    return true;
  }

  function candidates(list, ms = 8000) {
    ensureStyle();
    clearCandidates();
    let first = true;
    for (const c of list) {
      const el = byId(c.id);
      if (!el) continue;
      if (first) {
        el.scrollIntoView({ block: "center" });
        first = false;
      }
      const b = box(el);
      const frame = document.createElement("div");
      frame.className = "__vbx-cand __vbx-c";
      Object.assign(frame.style, { top: b.top - 3 + "px", left: b.left - 3 + "px", width: b.width + 6 + "px", height: b.height + 6 + "px" });
      const badge = document.createElement("div");
      badge.className = "__vbx-badge __vbx-c";
      badge.textContent = String(c.n);
      Object.assign(badge.style, { top: Math.max(0, b.top - 14) + "px", left: Math.max(0, b.left - 14) + "px" });
      document.documentElement.appendChild(frame);
      document.documentElement.appendChild(badge);
    }
    candTimer = setTimeout(clearCandidates, ms);
  }

  function clearCandidates() {
    clearTimeout(candTimer);
    document.querySelectorAll(".__vbx-c").forEach((n) => n.remove());
  }

  /** click-by-voice style: number every clickable element in viewport. Returns [{n,id}]. */
  function showHints(mode) {
    ensureStyle();
    hintMode = mode;
    hintBadges.forEach((b) => b.remove());
    hintBadges = [];
    if (mode === "off") return { hints: [], hintMode };
    const els = collectElements().elements;
    const visible = els.filter((e) => e.inViewport);
    const mapped = [];
    visible.forEach((e, i) => {
      const el = byId(e.id);
      if (!el) return;
      const n = i + 1;
      const b = box(el);
      const badge = document.createElement("div");
      badge.className = "__vbx-badge __vbx-hint";
      badge.textContent = String(n);
      Object.assign(badge.style, { top: Math.max(0, b.top - 14) + "px", left: Math.max(0, b.left - 14) + "px" });
      document.documentElement.appendChild(badge);
      hintBadges.push(badge);
      mapped.push({ n, id: e.id });
    });
    return { hints: mapped, hintMode };
  }

  // ---------------------------------------------------------------------------
  // In-page action executor
  // ---------------------------------------------------------------------------
  function setNativeValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(el, value);
    else el.value = value;
  }

  async function executeElementAction(action) {
    const label = action.label || action.type;
    const result = { ok: true, detail: "" };

    switch (action.type) {
      case "click_element": {
        clearCandidates();
        highlight(action.targetId, 700);
        toast(label);
        const el = byId(action.targetId);
        if (!el) return { ok: false, detail: "element not found (page changed?)" };
        el.scrollIntoView({ block: "center", inline: "nearest" });
        await new Promise((r) => setTimeout(r, 180));
        try {
          el.click();
        } catch {
          /* el.click may throw on some elements */
        }
        return result;
      }

      case "type_into_field": {
        clearCandidates();
        highlight(action.targetId, 1000);
        toast(label);
        const el = byId(action.targetId);
        if (!el) return { ok: false, detail: "element not found (page changed?)" };
        el.focus();
        if (action.text) {
          setNativeValue(el, action.text);
          el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: action.text }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
        } else {
          setNativeValue(el, "");
          el.dispatchEvent(new Event("input", { bubbles: true }));
        }
        if (action.submit) {
          const form = el.closest("form");
          if (form && typeof form.requestSubmit === "function") form.requestSubmit();
          else {
            el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true }));
            el.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true }));
          }
        }
        return result;
      }

      case "select_option": {
        highlight(action.targetId, 700);
        toast(label);
        const sel = byId(action.targetId);
        if (!sel || sel.tagName !== "SELECT") return { ok: false, detail: "not a select element" };
        const wanted = (action.text || "").toLowerCase();
        const opts = Array.from(sel.options || []);
        const hit = opts.find((o) => o.label.toLowerCase() === wanted) || opts.find((o) => o.label.toLowerCase().includes(wanted));
        if (!hit) return { ok: false, detail: "no matching option" };
        sel.value = hit.value;
        sel.dispatchEvent(new Event("change", { bubbles: true }));
        return { ok: true, detail: hit.label };
      }

      case "press_enter": {
        toast("⏎ enter");
        const el = document.activeElement;
        if (el && el.closest("form") && typeof el.closest("form").requestSubmit === "function") {
          el.closest("form").requestSubmit();
        } else {
          document.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true }));
        }
        return result;
      }

      case "scroll_down":
      case "scroll_up": {
        const dir = action.type === "scroll_down" ? 1 : -1;
        toast(label);
        const vh = window.innerHeight;
        if (action.amount === "end") {
          window.scrollTo({ top: dir > 0 ? document.documentElement.scrollHeight : 0, behavior: "smooth" });
        } else {
          const px = action.amount === "little" ? vh * 0.35 : vh * 0.85;
          window.scrollBy({ top: dir * px, behavior: "smooth" });
        }
        return { ok: true, detail: `scrollY=${Math.round(window.scrollY)}` };
      }

      case "read_aloud": {
        const needle = (action.text || "").toLowerCase();
        const el = findElementWithText(needle);
        if (!el) return { ok: false, detail: `no section on the page contains "${action.text}"` };
        el.scrollIntoView({ block: "center", inline: "nearest" });
        // highlight by temporary data-vb-id so the shared highlighter can flash it
        let id = el.getAttribute("data-vb-id");
        if (!id) {
          if (!window.__vbNextId) window.__vbNextId = 1;
          id = `e${String(window.__vbNextId++)}r`;
          el.setAttribute("data-vb-id", id);
        }
        highlight(id, 1500);
        const text = el.innerText || el.textContent || action.text;
        const spoken = speak(text, action.lang);
        return { ok: true, detail: spoken ? `reading ${text.length} chars` : "speech synthesis unavailable" };
      }

      default:
        return { ok: false, detail: `unknown in-page action ${action.type}` };
    }
  }

  // ---------------------------------------------------------------------------
  // Read-aloud helpers
  // ---------------------------------------------------------------------------
  /** Deepest element whose visible text contains `needle`; the smallest containing block wins. */
  function findElementWithText(needle) {
    if (!needle) return null;
    const sel = ["p", "li", "div", "article", "section", "blockquote", "td", "th", "h1", "h2", "h3", "h4", "h5", "h6", "dd", "dt", "label", "span", "summary", "a[href]", "button"].join(",");
    let best = null;
    let bestScore = Infinity;
    for (const el of document.querySelectorAll(sel)) {
      const t = (el.innerText || "").trim();
      if (!t || t.length > 12000) continue;
      if (!t.toLowerCase().includes(needle)) continue;
      const score = t.length;
      if (score < bestScore) {
        bestScore = score;
        best = el;
      }
    }
    return best;
  }

  /** Speak `text` aloud via the Web Speech synthesis API, preferring the configured voice. */
  function speak(text, lang) {
    const synth = window.speechSynthesis;
    if (!synth) return false;
    synth.cancel();
    const utter = new SpeechSynthesisUtterance(text);
    if (lang === "ms") utter.lang = "ms-MY";
    else if (lang === "en") utter.lang = "en-US";
    else utter.lang = navigator.language || "en-US";
    const want = lang === "ms" ? /^ms/i : lang === "en" ? /^en[-_]US/i : null;
    const voices = synth.getVoices();
    if (want) {
      const v = voices.find((x) => want.test(x.lang)) || voices.find((x) => /^en/i.test(x.lang));
      if (v) utter.voice = v;
    }
    synth.speak(utter);
    return true;
  }

  // ---------------------------------------------------------------------------
  // Messaging
  // ---------------------------------------------------------------------------
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    let handled = false;
    (async () => {
      switch (msg?.type) {
        case "getSnapshot":
          handled = true;
          sendResponse(collectElements());
          return;
        case "execute":
          handled = true;
          sendResponse(await executeElementAction(msg.action));
          return;
        case "highlight":
          handled = true;
          sendResponse({ ok: highlight(msg.id, msg.ms) });
          return;
        case "toast":
          handled = true;
          toast(msg.msg, msg.ms);
          sendResponse({ ok: true });
          return;
        case "candidates":
          handled = true;
          candidates(msg.list, msg.ms);
          sendResponse({ ok: true });
          return;
        case "clearCandidates":
          handled = true;
          clearCandidates();
          sendResponse({ ok: true });
          return;
        case "showHints":
          handled = true;
          sendResponse(showHints(msg.mode || "on"));
          return;
        default:
          return; // ignore broadcasts we don't own (e.g. worker→popup state)
      }
    })();
    // Only keep the channel open for messages we actually handle, so worker→popup
    // broadcasts don't reach across every tab.
    return handled;
  });
})();