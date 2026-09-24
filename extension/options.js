/**
 * options.js — config: decision endpoint (TypeSafe base URL OR a full custom endpoint),
 * API key, model, and "show hints" default. Also the dark-mode toggle.
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

  function updateHint() {
    $("endpointHint").textContent = `→ will POST ${resolveEndpoint($("baseUrl").value)}`;
  }
  $("baseUrl").addEventListener("input", updateHint);

  async function load() {
    const { vbxConfig, vbxTheme } = await chrome.storage.local.get(["vbxConfig", "vbxTheme"]);
    const c = { ...DEFAULT, ...(vbxConfig || {}) };
    $("baseUrl").value = c.baseUrl;
    $("apiKey").value = c.apiKey;
    $("model").value = c.model;
    $("lang").value = c.lang || "auto";
    $("showHints").checked = Boolean(c.showHints);
    updateHint();
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

  load();
})();