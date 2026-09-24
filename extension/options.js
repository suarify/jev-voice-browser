/**
 * options.js — config: decision endpoint (TypeSafe base URL OR a full custom endpoint),
 * API key, model, voice language, "show hints" default; plus the tutorial carousel,
 * collapsible API-info panel, and the dark-mode toggle.
 */
(() => {
  const $ = (id) => document.getElementById(id);
  const DEFAULT = { baseUrl: "https://api.typesafe.ai", apiKey: "", model: "jev-1.13.0", showHints: false, lang: "auto" };
  const savedEl = $("saved");
  const statusEl = $("status");

  function flashSaved() {
    savedEl.classList.add("show");
    setTimeout(() => savedEl.classList.remove("show"), 1500);
  }

  function setStatus(text, ok) {
    statusEl.textContent = text;
    statusEl.className = ok ? "ok" : "err";
  }

  // Same resolution rule as lib/jev.js (kept tiny so the options page can preview it).
  const SYSTEM_ONE_PATH = "/v1/systemone";
  function resolveEndpoint(baseUrl) {
    const u = String(baseUrl || "").trim().replace(/\/+$/, "");
    if (!u) return `https://api.typesafe.ai${SYSTEM_ONE_PATH}`;
    try {
      const url = new URL(u);
      const hasPath = url.pathname && url.pathname !== "/";
      return hasPath ? u : `${u}${SYSTEM_ONE_PATH}`;
    } catch {
      return `${u}${SYSTEM_ONE_PATH}`;
    }
  }

  function updateHints() {
    const endpoint = resolveEndpoint($("baseUrl").value);
    $("endpointHint").textContent = `→ will POST ${endpoint}`;
    const key = $("apiKey").value.trim();
    const model = ($("model").value || DEFAULT.model).trim();
    $("apiEndpoint").textContent = endpoint;
    $("apiAuth").textContent = key ? `Bearer ${key.slice(0, 3)}…${key.slice(-3)}` : "Bearer <none>";
    $("apiModel").textContent = model;
    $("apiBody").textContent = `POST ${endpoint}\n{ "state": { "transcript": "…", "page": {…}, "elements": […] },\n  "questions": { "intent": {…}, "target": {…}, … },\n  "model": "${model}" }`;
  }
  ["baseUrl", "apiKey", "model"].forEach((id) => $(id).addEventListener("input", updateHints));

  async function load() {
    const { vbxConfig, vbxTheme } = await chrome.storage.local.get(["vbxConfig", "vbxTheme"]);
    const c = { ...DEFAULT, ...(vbxConfig || {}) };
    $("baseUrl").value = c.baseUrl;
    $("apiKey").value = c.apiKey;
    $("model").value = c.model;
    $("lang").value = c.lang || "auto";
    $("showHints").checked = Boolean(c.showHints);
    updateHints();
    const dark = vbxTheme === "dark";
    document.documentElement.classList.toggle("dark", dark);
    $("themeBtn").textContent = dark ? "☀️" : "🌙";
  }

  function readForm() {
    return {
      baseUrl: ($("baseUrl").value || DEFAULT.baseUrl).trim(),
      apiKey: $("apiKey").value.trim(),
      model: ($("model").value || DEFAULT.model).trim(),
      lang: ($("lang").value || "auto").trim().toLowerCase(),
      showHints: $("showHints").checked,
    };
  }

  async function save() {
    await chrome.storage.local.set({ vbxConfig: readForm() });
    await chrome.runtime.sendMessage({ type: "config-updated" }).catch(() => {});
    flashSaved();
    setStatus("", true);
  }

  $("saveBtn").addEventListener("click", save);

  $("themeBtn").addEventListener("click", async () => {
    const dark = !document.documentElement.classList.contains("dark");
    await chrome.storage.local.set({ vbxTheme: dark ? "dark" : "light" });
    document.documentElement.classList.toggle("dark", dark);
    $("themeBtn").textContent = dark ? "☀️" : "🌙";
  });

  // --- collapsible API information ---
  const apiInfo = $("apiInfo");
  $("apiToggle").addEventListener("click", () => {
    const open = apiInfo.classList.toggle("open");
    $("apiPanel").hidden = !open;
  });

  $("testBtn").addEventListener("click", async () => {
    const c = readForm();
    const endpoint = resolveEndpoint(c.baseUrl);
    setStatus("Testing…", true);
    try {
      const res = await fetch(endpoint, {
        method: "GET",
        headers: c.apiKey ? { Authorization: `Bearer ${c.apiKey}` } : {},
      });
      if (res.status === 401 || res.status === 403) {
        setStatus(`✓ Server reachable (HTTP ${res.status} — check the API key)`, true);
      } else if (res.status >= 400) {
        setStatus(`✓ Server reachable (HTTP ${res.status} — this endpoint expects POST)`, true);
      } else {
        setStatus(`✓ Connected (HTTP ${res.status})`, true);
      }
    } catch (err) {
      setStatus(`✗ Cannot reach ${endpoint}: ${err instanceof TypeError ? "offline or CORS blocked" : err.message}`, false);
    }
  });

  // --- tutorial carousel (swipe / buttons / dots) ---
  const track = $("track");
  const dotsEl = $("dots");
  const cards = Array.from(track.children);
  let index = 0;
  cards.forEach((_, i) => {
    const d = document.createElement("span");
    d.className = "dot" + (i === 0 ? " active" : "");
    d.addEventListener("click", () => go(i));
    dotsEl.appendChild(d);
  });
  const dots = Array.from(dotsEl.children);

  function go(i) {
    index = Math.max(0, Math.min(cards.length - 1, i));
    track.scrollTo({ left: cards[index].offsetLeft - 6, behavior: "smooth" });
    dots.forEach((d, j) => d.classList.toggle("active", j === index));
  }
  $("prevBtn").addEventListener("click", () => go(index - 1));
  $("nextBtn").addEventListener("click", () => go(index + 1));

  let downX = null;
  track.addEventListener("pointerdown", (e) => {
    downX = e.clientX;
    track.classList.add("dragging");
  });
  window.addEventListener("pointerup", () => {
    downX = null;
    track.classList.remove("dragging");
  });
  track.addEventListener("pointercancel", () => {
    downX = null;
    track.classList.remove("dragging");
  });
  track.addEventListener("pointermove", (e) => {
    if (downX == null) return;
    const dx = e.clientX - downX;
    if (Math.abs(dx) > 40) {
      go(index + (dx < 0 ? 1 : -1));
      downX = null;
    }
  });
  track.addEventListener("scroll", () => {
    const pos = Math.round(track.scrollLeft / (cards[0].offsetWidth + 12));
    const i = Math.max(0, Math.min(cards.length - 1, pos));
    dots.forEach((d, j) => d.classList.toggle("active", j === i));
    index = i;
  });

  load();
})();