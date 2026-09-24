/**
 * popup.js — hosts the microphone (Web Speech API) and renders live state from the
 * service worker. Listens only while this popup is open and the mic is started —
 * the same privacy posture as chrome-voice-actions.
 */
(() => {
  const $ = (id) => document.getElementById(id);
  const micBtn = $("micBtn");
  const pill = $("statusPill");
  const transcriptEl = $("transcript");
  const decisionCard = $("decisionCard");
  const decisionEl = $("decision");
  const gatesEl = $("gates");
  const pendingEl = $("pending");
  const candCard = $("candCard");
  const candsEl = $("cands");
  const hintsToggle = $("hintsToggle");
  const hintCountEl = $("hintCount");
  const typedEl = $("typed");
  const typedSend = $("typedSend");
  const cfgStatusEl = $("cfgStatus");
  const statsEl = $("stats");
  const errLine = $("errLine");

  let state = null;
  let recognition = null;
  let listening = false;
  let utteranceBase = 0;

  const send = (msg) => chrome.runtime.sendMessage(msg).catch(() => {});

  // ---------------------------------------------------------------------------
  // Microphone
  // ---------------------------------------------------------------------------
  function startMic() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      errLine.textContent = "Speech recognition is not available in this browser. Use Chrome or Edge.";
      return;
    }
    recognition = new SR();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = navigator.language || "en-US";
    recognition.maxAlternatives = 1;

    recognition.onresult = (e) => {
      // Results before e.resultIndex are finished. Each result index is a distinct
      // utterance; its interim and final updates share the same id, so the worker can
      // correctly continue ("go to wikipedia ... and click the first result").
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        const text = r[0].transcript;
        send({ type: "transcript", text, final: r.isFinal, utteranceId: `u${utteranceBase}-${i}` });
      }
    };
    recognition.onerror = (e) => {
      if (e.error === "no-speech" || e.error === "aborted") return;
      errLine.textContent = `Mic error: ${e.error}`;
      if (e.error === "not-allowed") {
        setListening(false);
        errLine.textContent = "Microphone permission denied. Click the mic icon in the address bar.";
      }
    };
    recognition.onend = () => {
      if (listening) {
        utteranceBase += 1;
        try {
          recognition.start(); // continuous restart
        } catch {
          /* already started */
        }
      } else {
        pill.textContent = "idle";
        pill.className = "pill";
      }
    };
    recognition.start();
    setListening(true);
    pill.textContent = "listening";
    pill.className = "pill listening";
    errLine.textContent = "";
  }

  function stopMic() {
    setListening(false);
    if (recognition) {
      recognition.onend = null;
      recognition.stop();
    }
    pill.textContent = "idle";
    pill.className = "pill";
  }

  function setListening(v) {
    listening = v;
    micBtn.textContent = v ? "Stop mic" : "Start mic";
    micBtn.classList.toggle("listening", v);
  }

  micBtn.addEventListener("click", () => (listening ? stopMic() : startMic()));

  // ---------------------------------------------------------------------------
  // Inputs
  // ---------------------------------------------------------------------------
  typedSend.addEventListener("click", () => {
    const t = typedEl.value.trim();
    if (!t) return;
    send({ type: "typed-command", text: t });
    typedEl.value = "";
  });
  typedEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") typedSend.click();
  });

  hintsToggle.addEventListener("change", () => {
    send({ type: "set-hints", enabled: hintsToggle.checked });
  });

  $("settingsBtn").addEventListener("click", () => chrome.runtime.openOptionsPage());

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------
  function render(next) {
    state = next || state;
    if (!state) return;

    const cfg = state.configStatus;
    cfgStatusEl.textContent = cfg && cfg.baseUrl
      ? `${cfg.hasKey ? "✓ key" : "no key"} · ${cfg.baseUrl.replace(/^https?:\/\//, "")} · ${cfg.model}`
      : "no config";

    if (state.stats) {
      statsEl.textContent = `${state.stats.calls} calls · ${state.stats.actions} actions · ${state.stats.costUsd.toFixed(4)}$`;
    }

    transcriptEl.textContent = state.transcript || "—";

    if (state.pending) {
      pendingEl.hidden = false;
      pendingEl.textContent = `⚠ Say "confirm" to: ${state.pending.summary}`;
    } else {
      pendingEl.hidden = true;
    }

    if (state.candidates && state.candidates.length) {
      candCard.hidden = false;
      candsEl.innerHTML = "";
      state.candidates.forEach((c) => {
        const row = document.createElement("div");
        row.className = "cand";
        const n = document.createElement("span");
        n.className = "n";
        n.textContent = String(c.n);
        const label = document.createElement("span");
        label.textContent = c.label || c.id;
        row.append(n, label);
        candsEl.appendChild(row);
      });
    } else {
      candCard.hidden = true;
    }

    hintsToggle.checked = Boolean(state.hintsEnabled);
    hintCountEl.textContent = state.hintCount ? `${state.hintCount} numbered` : "";

    if (state.lastDecision) {
      const d = state.lastDecision;
      decisionCard.hidden = false;
      decisionEl.textContent = `"${d.transcript}" → ${d.decision}: ${d.summary}`;
      decisionEl.className = "sum " + (d.decision === "err" ? "err" : d.decision);
      gatesEl.innerHTML = "";
      (d.reasons || []).forEach((r) => {
        const g = document.createElement("div");
        g.className = "gate";
        g.innerHTML = `<span>${r.name}</span><b>${r.note}</b><span class="${r.pass ? "pass" : "fail"}">${r.pass ? "✓" : "✗"} ${r.value ?? ""}</span>`;
        gatesEl.appendChild(g);
      });
      if (d.latencyMs) {
        const lat = document.createElement("div");
        lat.className = "gate";
        lat.innerHTML = `<span>latency</span><b>${d.latencyMs} ms</b>`;
        gatesEl.appendChild(lat);
      }
    } else {
      decisionCard.hidden = true;
    }
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === "vbx-state") {
      render(msg.payload);
      sendResponse({ ok: true }); // acknowledge synchronously so the worker's promise resolves
    }
  });

  chrome.runtime.sendMessage({ type: "get-state" }).then(render).catch(() => {});
})();