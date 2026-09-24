/**
 * Candidate extraction (code, not Jev). Jev never generates text: we over-generate
 * candidate spans from the transcript here, and Jev only *picks* one of them.
 * The chosen option is copied verbatim into the browser.
 * Ported from src/spans.js — pure, no Node deps.
 */

const TLDS = "com|org|net|io|ai|dev|co|edu|gov|de|uk|us|app|xyz|info|me|tv|ch|at|fr|nl|es|it";

const FILLER_RE = /\b(please|thanks|thank you|now|okay|ok|um|uh|and then)\b/gi;

const TEXT_VERBS = [
  /\b(?:search|look)\s+(?:for|up)\s+/i,
  /\bsearch\s+(?:on\s+)?(?:google|duckduckgo|wikipedia|youtube|github|amazon|reddit|twitter|x|hacker news|the web)\s+for\s+/i,
  /\bsearch\s+/i,
  /\bgoogle\s+/i,
  /\bfind\s+/i,
  /\btype\s+(?:in\s+)?/i,
  /\benter\s+/i,
  /\bwrite\s+/i,
  /\bput\s+/i,
  /\bfill\s+(?:in\s+)?/i,
  // Bahasa Melayu: cari/gelintar=search, gugel=google, taip/taipkan/masukkan=type, tulis=write, letak/isi=put/fill
  /\b(?:cari|gelintar)\s+(?:di\s+|pada\s+)?(?:google|youtube|wikipedia|github|amazon|reddit|twitter|x|hacker news|web)\s+(?:untuk\s+|tentang\s+)?/i,
  /\b(?:cari|gelintar|gugel)\s+(?:untuk\s+|tentang\s+)?/i,
  /\b(?:taip|taipkan|masukkan|tulis|letak|isi)\s+(?:dalam\s+)?/i,
  // read aloud (read / baca): prefer the phrase after "says/contains/ada", else the whole tail
  /\b(?:read|baca)\s+(?:aloud\s+|out\s+loud\s+)?(?:the\s+|bahagian\s+)?(?:part|area|section|text|content|bahagian|teks)\s+(?:that\s+|which\s+|yang\s+)?(?:says|contains|with|saying|ada|mengandungi)\s+/i,
  /\b(?:read|baca)\s+(?:aloud\s+|out\s+loud\s+)?/i,
];

// Trailing destination phrases to strip from a payload: English "... into the search box"
// and Malay "... dalam kotak carian" (dalam=in/into, ke dalam=into, kotak/ruang=box, carian=search).
const TRAILING_DEST_RE =
  /\s+(?:in|into|on|inside|to|ke dalam|dalam)\s+(?:the\s+)?(?:[\w-]+\s+){0,4}?(?:box|field|input|bar|form|textarea|search|kotak|ruang|medan|carian|wikipedia|youtube|google|duckduckgo|github|amazon|reddit|twitter|x|web)\b.*$/i;

// Leading site phrases: "wikipedia for cats" -> "cats", "youtube untuk lofi" -> "lofi"
const LEADING_SITE_RE =
  /^(?:on\s+|in\s+|di\s+)?(?:google|duckduckgo|wikipedia|youtube|github|amazon|reddit|twitter|x|hacker news|the web)\s+(?:for\s+|untuk\s+)/i;

export function cleanTranscript(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim();
}

function stripFiller(s) {
  return s.replace(FILLER_RE, " ").replace(/\s+/g, " ").replace(/[.,!?]+$/g, "").trim();
}

function pushUnique(list, value) {
  const v = stripFiller(value);
  if (!v) return;
  if (v.length > 120) return;
  if (list.some((x) => x.toLowerCase() === v.toLowerCase())) return;
  list.push(v);
}

export function extractTextCandidates(transcript) {
  const t = cleanTranscript(transcript);
  if (!t) return [];
  const out = [];

  for (const m of t.matchAll(/["“”']([^"“”']{1,120})["“”']/g)) pushUnique(out, m[1]);

  // read-aloud: "read the part that says X" / "baca bahagian yang ada X" -> capture X (not the wrapper)
  const readMatch = /(?:read|baca)\b.*?(?:says|saying|contains|with|ada|mengandungi|bertulis)\s+([^.,!?]+)/i.exec(t);
  if (readMatch) pushUnique(out, readMatch[1]);

  const verbMatches = TEXT_VERBS.map((re) => re.exec(t))
    .filter(Boolean)
    .sort((a, b) => a.index - b.index || b[0].length - a[0].length);
  for (const m of verbMatches) {
    let tail = t.slice(m.index + m[0].length);
    tail = tail.replace(LEADING_SITE_RE, "");
    const stripped = tail.replace(TRAILING_DEST_RE, "");
    pushUnique(out, stripped);
    if (stripped !== tail) pushUnique(out, tail);
  }

  const forIdx = t.toLowerCase().indexOf(" for ");
  if (forIdx >= 0) pushUnique(out, t.slice(forIdx + 5).replace(TRAILING_DEST_RE, ""));

  const firstSpace = t.indexOf(" ");
  if (firstSpace > 0) pushUnique(out, t.slice(firstSpace + 1).replace(TRAILING_DEST_RE, ""));

  pushUnique(out, t);

  return out.slice(0, 8);
}

/** "example dot com" -> "example.com"; also lowercases and strips spaces around dots. Malay: "titik" = dot. */
export function normalizeSpokenUrl(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/\s+titik\s+/g, ".")
    .replace(/\s+dot\s+/g, ".")
    .replace(/\s*\.\s*/g, ".")
    .replace(/\s+slash\s+/g, "/")
    .replace(/\bwww\s+/g, "www.")
    .replace(/\bh\s*t\s*t\s*p\s*s?\s*:\s*\/\s*\//g, (m) => (m.includes("s") ? "https://" : "http://"));
}

export function extractUrlCandidates(transcript) {
  const t = normalizeSpokenUrl(cleanTranscript(transcript));
  if (!t) return [];
  const re = new RegExp(`(?:https?://)?(?:[a-z0-9-]+\\.)+(?:${TLDS})(?:/[^\\s]*)?`, "gi");
  const out = [];
  for (const m of t.matchAll(re)) {
    const v = m[0].replace(/[.,!?]+$/, "");
    if (!out.includes(v)) out.push(v);
  }
  return out.slice(0, 6);
}

export function toHttpUrl(domainish) {
  const v = String(domainish).trim();
  if (/^https?:\/\//i.test(v)) return v;
  return `https://${v}`;
}

const NUMBER_WORDS = {
  one: 1, first: 1, "1": 1, "1st": 1,
  two: 2, second: 2, "2": 2, "2nd": 2,
  three: 3, third: 3, "3": 3, "3rd": 3,
  four: 4, fourth: 4, "4": 4, "4th": 4,
  five: 5, fifth: 5, "5": 5, "5th": 5,
  // Bahasa Melayu: satu=1, dua=2, tiga=3, empat=4, lima=5; pertama/kedua/ketiga/keempat/kelima = ordinals
  satu: 1, pertama: 1,
  dua: 2, kedua: 2,
  tiga: 3, ketiga: 3,
  empat: 4, keempat: 4,
  lima: 5, kelima: 5,
};
const NUMBER_HOMOPHONES = { won: 1, to: 2, too: 2, for: 4 };

const PICK_STOPWORDS = new Set([
  "the", "number", "option", "pick", "choose", "select", "click", "take", "that", "please", "link", "item", "result", "go", "with", "on", "yes", "this", "um", "uh",
]);

export function parseCandidatePick(transcript, max = 5) {
  const t = cleanTranscript(transcript).toLowerCase().replace(/[.,!?]/g, "");
  if (!t) return null;
  const meaningful = t.split(" ").filter((w) => !PICK_STOPWORDS.has(w));
  if (meaningful.length === 0 || meaningful.length > 2) return null;
  for (const w of meaningful) {
    const n = NUMBER_WORDS[w];
    if (n && n <= max) return n;
  }
  if (meaningful.length === 1) {
    const n = NUMBER_HOMOPHONES[meaningful[0]];
    if (n && n <= max) return n;
  }
  return null;
}