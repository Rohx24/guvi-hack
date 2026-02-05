const BANNED_PHRASES = [
  "be clear",
  "answer clearly",
  "be specific",
  "proper details",
  "i'm done",
  "im done",
  "stop messaging",
  "don't message",
  "do not message",
  "leave me alone",
  "calling the police",
  "police",
  "scam",
  "fraud",
  "honeypot",
  "ai",
  "bot"
];

const IMPERATIVE_PATTERNS = [
  /^be\s+/i,
  /^answer\s+/i,
  /^provide\s+/i,
  /^share\s+/i,
  /^send\s+/i,
  /^give\s+me\s+/i,
  /^tell\s+me\s+/i
];

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function wordCount(text: string): number {
  return normalize(text).split(" ").filter(Boolean).length;
}

export type AntiBotResult = {
  ok: boolean;
  reasons: string[];
};

export function analyzeAntiBot(reply: string, lastReplies: string[]): AntiBotResult {
  const reasons: string[] = [];
  const norm = normalize(reply);

  for (const phrase of BANNED_PHRASES) {
    if (norm.includes(phrase)) {
      reasons.push("banned_phrase");
      break;
    }
  }

  for (const pattern of IMPERATIVE_PATTERNS) {
    if (pattern.test(reply.trim())) {
      reasons.push("imperative");
      break;
    }
  }

  const wc = wordCount(reply);
  const isQuestion = reply.trim().endsWith("?");
  if (wc < 8 && !(isQuestion && wc >= 4)) {
    reasons.push("too_short");
  }

  const recent = lastReplies.slice(-3).map(normalize);
  if (recent.includes(norm)) {
    reasons.push("repeat");
  }

  return { ok: reasons.length === 0, reasons };
}
