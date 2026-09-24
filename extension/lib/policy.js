/**
 * Execution policy: pure code that turns Jev's answers into ACT / WAIT / IGNORE / CONFIRM /
 * DISAMBIGUATE. Every gate is a number from constants.js so the UI can show WHY.
 * Ported from src/policy.js.
 */
import {
  T,
  TARGET_INTENTS,
  SITE_HOME,
  SITE_SEARCH,
  DEFAULT_SEARCH_ENGINE,
  SILENCE_COMPLETE_MS,
  PAYLOAD_SILENCE_MS,
  PAYLOAD_INTENTS,
} from "./constants.js";
import { toHttpUrl } from "./spans.js";

const r2 = (x) => Math.round(x * 100) / 100;

function check(reasons, name, value, threshold, pass, note) {
  reasons.push({ name, value: typeof value === "number" ? r2(value) : value, threshold, pass, note });
  return pass;
}

/** Top-N choice options by probability, excluding `none`. */
export function topChoices(choiceAnswer, n = 3) {
  if (!choiceAnswer?.probabilities) return [];
  return Object.entries(choiceAnswer.probabilities)
    .filter(([k]) => k !== "none")
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([id, p]) => ({ id, p: r2(p) }));
}

function pickSpan(answer, minConfidence, fallback) {
  if (!answer) return fallback ?? null;
  if (answer.choice === "none") return null;
  if (answer.confidence < minConfidence) return fallback ?? answer.choice;
  return answer.choice;
}

function fillTemplate(tpl, q) {
  return tpl.replace("%s", encodeURIComponent(q));
}

export function evaluatePolicy({ answers, candidates, snapshot, silentMs = 0, isFinal = false, pending = null, context = null }) {
  const reasons = [];
  const intent = answers.intent;
  const intentName = intent?.choice ?? "none";
  const lastAction = context?.recentActions?.length ? context.recentActions[context.recentActions.length - 1] : null;
  const correction = answers.is_correction?.noul ?? 0;
  const finishedPhrase = (answers.complete?.noul ?? 0) >= T.complete || silentMs >= SILENCE_COMPLETE_MS || isFinal;
  const isCorrection = Boolean(lastAction) && correction >= T.correction && finishedPhrase;

  if (pending) {
    if (intentName === "confirm" && intent.confidence >= T.intentConfidence) {
      check(reasons, "intent", `confirm (${r2(intent.confidence)})`, T.intentConfidence, true, "pending action confirmed");
      return { decision: "act", action: { ...pending, confirmed: true }, reasons, summary: `confirmed: ${describe(pending)}` };
    }
    if (intentName === "cancel" && intent.confidence >= T.intentConfidence) {
      check(reasons, "intent", `cancel (${r2(intent.confidence)})`, T.intentConfidence, true, "pending action cancelled");
      return { decision: "cancel", reasons, summary: "cancelled pending action" };
    }
  }

  if (isCorrection) {
    check(reasons, "is_correction", correction, T.correction, true, `rejects previous action: ${describe(lastAction)}`);
    const confidentIntent = intentName !== "none" && (intent?.confidence ?? 0) >= T.intentConfidence;
    const namesNewTarget =
      TARGET_INTENTS.has(intentName) && topChoices(answers.target, 2).some((c) => c.id !== lastAction.targetId && c.p >= T.targetTopProb);
    const reverse = lastAction.type !== "go_back" && (!confidentIntent || (TARGET_INTENTS.has(intentName) && !namesNewTarget));
    if (reverse) {
      const reversal = reverseAction(lastAction);
      return { decision: "act", action: reversal, reasons, summary: `correction → ${describe(reversal)}` };
    }
  }

  const isCmd = answers.is_command?.noul ?? 0;
  if (!check(reasons, "is_command", isCmd, T.isCommand, isCmd >= T.isCommand, "user is addressing the browser")) {
    return { decision: "ignore", reasons, summary: "not a browser command" };
  }

  const conf = intent?.confidence ?? 0;
  const intentOk = intentName !== "none" && conf >= T.intentConfidence;
  check(reasons, "intent", `${intentName} (${r2(conf)})`, T.intentConfidence, intentOk, "confident, non-none intent");
  if (!intentOk) return { decision: "wait", reasons, summary: intentName === "none" ? "no recognizable command yet" : "intent not confident yet" };

  const complete = answers.complete?.noul ?? 0;
  const silent = silentMs >= SILENCE_COMPLETE_MS || isFinal;
  const completeOk = complete >= T.complete || silent;
  check(
    reasons,
    "complete",
    complete,
    T.complete,
    completeOk,
    silent ? (isFinal ? "recognizer marked utterance final" : `silent for ${silentMs}ms`) : "command has verb + object",
  );
  if (!completeOk) return { decision: "wait", reasons, summary: "waiting for the rest of the command" };

  if (PAYLOAD_INTENTS.has(intentName)) {
    const payloadOk = isFinal || silentMs >= PAYLOAD_SILENCE_MS;
    check(
      reasons,
      "payload_final",
      isFinal ? "final" : `${silentMs}ms silence`,
      `final or ${PAYLOAD_SILENCE_MS}ms`,
      payloadOk,
      "free text (query / typed text) must be finished before it is copied",
    );
    if (!payloadOk) {
      return { decision: "wait", reasons, summary: "waiting for the end of the phrase (free text)", retryInMs: Math.max(50, PAYLOAD_SILENCE_MS - silentMs) };
    }
  }

  const excludeTargetId = isCorrection && TARGET_INTENTS.has(intentName) ? lastAction.targetId ?? null : null;
  const built = buildAction({ intentName, answers, candidates, snapshot, reasons, excludeTargetId });
  if (built.decision !== "act") return { ...built, reasons };
  const action = built.action;

  const destructive = answers.destructive?.noul ?? 0;
  const canBeDestructive = ["click_element", "press_enter", "select_option"].includes(action.type);
  if (canBeDestructive) {
    const safe = destructive < T.destructive;
    check(reasons, "destructive", destructive, T.destructive, safe, safe ? "reversible action" : "needs spoken confirmation");
    if (!safe) {
      return { decision: "confirm", action, reasons, summary: `say "confirm" to ${describe(action)}` };
    }
  }

  return { decision: "act", action, reasons, summary: describe(action) };
}

/** The action that undoes `action` as far as a browser can. */
export function reverseAction(action) {
  switch (action?.type) {
    case "type_into_field":
      return { type: "type_into_field", targetId: action.targetId, text: "", submit: false, label: `clear ${action.label || action.targetId}` };
    case "open_new_tab":
      return { type: "close_tab", label: "close the new tab" };
    case "close_tab":
      return { type: "go_back", label: "back (tab already closed)" };
    case "switch_tab":
      return { type: "switch_tab", direction: action.direction === "previous" ? "next" : "previous", label: "switch back" };
    case "scroll_down":
      return { type: "scroll_up", amount: action.amount || "page", label: "scroll back up" };
    case "scroll_up":
      return { type: "scroll_down", amount: action.amount || "page", label: "scroll back down" };
    default:
      return { type: "go_back", label: `undo ${describe(action)}` };
  }
}

function buildAction({ intentName, answers, candidates, snapshot, reasons, excludeTargetId = null }) {
  const site = answers.site?.choice ?? "none";
  const elements = snapshot?.elements ?? [];

  switch (intentName) {
    case "navigate_url": {
      const urlPick = pickSpan(answers.url_span, T.spanConfidence, candidates.url?.[0]);
      if (urlPick) {
        check(reasons, "url_span", urlPick, T.spanConfidence, true, "domain spoken verbatim");
        return { decision: "act", action: { type: "navigate_url", url: toHttpUrl(urlPick), label: urlPick } };
      }
      if (SITE_HOME[site]) {
        check(reasons, "site", `${site} (${r2(answers.site.confidence)})`, "-", true, "known site");
        return { decision: "act", action: { type: "navigate_url", url: SITE_HOME[site], label: site } };
      }
      check(reasons, "site", site, "known site or spoken domain", false, "no destination yet");
      return { decision: "wait", summary: "where to? (no site or domain recognised)" };
    }

    case "search_web": {
      const query = pickSpan(answers.text_span, T.spanConfidence, candidates.text?.[0]);
      if (!query) {
        check(reasons, "text_span", "none", T.spanConfidence, false, "no query text yet");
        return { decision: "wait", summary: "search for what?" };
      }
      check(reasons, "text_span", query, T.spanConfidence, true, "query copied verbatim");
      if (SITE_SEARCH[site]) {
        return { decision: "act", action: { type: "navigate_url", url: fillTemplate(SITE_SEARCH[site], query), label: `search ${site}: ${query}`, query } };
      }
      if (snapshot?.searchBoxId && snapshot.site !== "blank") {
        return { decision: "act", action: { type: "type_into_field", targetId: snapshot.searchBoxId, text: query, submit: true, label: `search this site: ${query}` } };
      }
      return { decision: "act", action: { type: "navigate_url", url: fillTemplate(SITE_SEARCH[DEFAULT_SEARCH_ENGINE], query), label: `search: ${query}`, query } };
    }

    case "click_element":
    case "select_option":
    case "type_into_field": {
      const target = answers.target;
      let top = topChoices(target, T.candidateCount + 1);
      let chosen = target?.choice;
      let chosenP = target?.probabilities?.[chosen] ?? 0;
      if (excludeTargetId && chosen === excludeTargetId) {
        top = top.filter((c) => c.id !== excludeTargetId);
        chosen = top[0]?.id ?? "none";
        chosenP = top[0]?.p ?? 0;
        check(reasons, "exclude_target", excludeTargetId, "-", true, `previous target excluded → ${chosen}`);
      }
      top = top.slice(0, T.candidateCount);
      const targetOk =
        chosen && chosen !== "none" && target.confidence >= T.targetConfidence && chosenP >= T.targetTopProb;
      const text = intentName === "click_element" ? null : pickSpan(answers.text_span, T.spanConfidence, candidates.text?.[0]);

      if (intentName !== "click_element" && !text) {
        check(reasons, "text_span", "none", T.spanConfidence, false, "no text to type yet");
        return { decision: "wait", summary: "type what?" };
      }

      if (targetOk) {
        check(reasons, "target", `${chosen} (${r2(target.confidence)})`, T.targetConfidence, true, elementLabel(elements, chosen));
        return { decision: "act", action: { type: intentName, targetId: chosen, text, label: elementLabel(elements, chosen) } };
      }

      if (intentName === "type_into_field" && snapshot?.searchBoxId) {
        check(reasons, "target", `${chosen} (${r2(target?.confidence ?? 0)})`, T.targetConfidence, false, "falling back to search box");
        return { decision: "act", action: { type: intentName, targetId: snapshot.searchBoxId, text, label: "search box" } };
      }

      check(reasons, "target", `${chosen ?? "none"} (${r2(target?.confidence ?? 0)})`, T.targetConfidence, false, "ambiguous target");
      let viable = top.filter((c) => c.p >= 0.08);
      if (viable.length === 1) viable = top.filter((c) => c.p >= 0.02).slice(0, 2);
      if (viable.length === 0) return { decision: "wait", summary: "no matching element on this page" };
      return {
        decision: "disambiguate",
        candidates: viable.map((c) => ({ ...c, label: elementLabel(elements, c.id) })),
        pendingIntent: { type: intentName, text },
        summary: `which one? ${viable.map((c, i) => `${i + 1}: ${elementLabel(elements, c.id)}`).join(" | ")}`,
      };
    }

    case "scroll_down":
    case "scroll_up": {
      const lvl = Math.round(answers.scroll_amount?.score ?? 1);
      const amount = ["little", "page", "end"][Math.min(2, Math.max(0, lvl))];
      check(reasons, "scroll_amount", answers.scroll_amount?.score ?? 1, "round", true, amount);
      return { decision: "act", action: { type: intentName, amount, label: `${intentName.replace("_", " ")} (${amount})` } };
    }

    case "switch_tab": {
      const dir = answers.tab_direction?.choice && answers.tab_direction.choice !== "none" ? answers.tab_direction.choice : "next";
      return { decision: "act", action: { type: "switch_tab", direction: dir, label: `switch tab (${dir})` } };
    }

    case "confirm":
    case "cancel":
      return { decision: "wait", summary: `nothing pending to ${intentName}` };

    default:
      return { decision: "act", action: { type: intentName, label: intentName.replace(/_/g, " ") } };
  }
}

export function elementLabel(elements, id) {
  const el = elements.find((e) => e.id === id);
  return el ? `${el.role} "${el.text || el.placeholder || ""}"` : id;
}

export function describe(action) {
  if (!action) return "";
  switch (action.type) {
    case "navigate_url":
      return `open ${action.label || action.url}`;
    case "type_into_field":
      return `type "${action.text}" into ${action.label || action.targetId}${action.submit ? " + enter" : ""}`;
    case "click_element":
      return `click ${action.label || action.targetId}`;
    case "select_option":
      return `select "${action.text}" in ${action.label || action.targetId}`;
    default:
      return action.label || action.type.replace(/_/g, " ");
  }
}

export { TARGET_INTENTS };