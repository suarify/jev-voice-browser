/**
 * options.js — config: base URL (TypeSafe default or any compatible endpoint),
 * API key, model, and "show hints" default. Stored locally; the service worker
 * re-reads it on save and re-applies the hint mode to the current tab.
 */
(() => {
  const $ = (id) => document.getElementById(id);
  const DEFAULT = { baseUrl: "https://api.typesafe.ai", apiKey: "", model: "jev-1.13.0", showHints: false };
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

  async function load() {
    const { vbxConfig } = await chrome.storage.local.get("vbxConfig");
    const c = { ...DEFAULT, ...(vbxConfig || {}) };
    $("baseUrl").value = c.baseUrl;
    $("apiKey").value = c.apiKey;
    $("model").value = c.model;
    $("showHints").checked = Boolean(c.showHints);
  }

  function readForm() {
    return {
      baseUrl: ($("baseUrl").value || DEFAULT.baseUrl).trim(),
      apiKey: $("apiKey").value.trim(),
      model: ($("model").value || DEFAULT.model).trim(),
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

  $("testBtn").addEventListener("click", async () => {
    const c = readForm();
    setStatus("Testing…", true);
    try {
      const base = c.baseUrl.replace(/\/+$/, "");
      const res = await fetch(`${base}/v1/models`, {
        headers: c.apiKey ? { Authorization: `Bearer ${c.apiKey}` } : {},
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const names = (data.models || []).map((m) => m.id || m.name || m).join(", ");
      setStatus(`✓ Connected to ${base}. Models: ${names || "ok"}`, true);
    } catch (err) {
      setStatus(`✗ ${baseFailed(err)}`, false);
    }
  });

  function baseFailed(err) {
    if (err instanceof TypeError) return `Could not reach the server (CORS or offline): ${err.message}`;
    return err.message || String(err);
  }

  load();
})();