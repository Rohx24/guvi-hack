export type RubricContext = {
  lastScammerMessage: string;
  lastReplies: string[];
};

export type CandidateScore = {
  reply: string;
  score: number;
  reasons: string[];
  hardRejectReason?: string;
};

const forbidden = [
  "scam",
  "fraud",
  "honeypot",
  "ai",
  "bot",
  "phishing",
  "police",
  "cybercrime",
  "rbi",
  "complaint filed"
];

const compliantPhrases = [
  "send otp",
  "share otp",
  "share pin",
  "send pin",
  "provide otp",
  "account number",
  "card number"
];

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = 0; i <= m; i += 1) dp[i][0] = i;
  for (let j = 0; j <= n; j += 1) dp[0][j] = j;
  for (let i = 1; i <= m; i += 1) {
    for (let j = 1; j <= n; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[m][n];
}

function similarity(a: string, b: string): number {
  const na = normalize(a);
  const nb = normalize(b);
  if (!na || !nb) return 0;
  const dist = levenshtein(na, nb);
  return 1 - dist / Math.max(na.length, nb.length);
}

function hasLinkOrUpiOrPhone(text: string): boolean {
  if (/https?:\/\/\S+/i.test(text)) return true;
  if (/[a-z0-9._-]{2,}@(upi|ybl|okhdfcbank|oksbi|okicici|okaxis|okpaytm|paytm|ibl|axl|sbi|hdfcbank|icici|kotak|baroda|upiicici)/i.test(text))
    return true;
  if (/\b\d{10,}\b/.test(text)) return true;
  return false;
}

function containsForbidden(text: string): boolean {
  const lower = text.toLowerCase();
  return forbidden.some((word) => lower.includes(word));
}

function containsCompliant(text: string): boolean {
  const lower = text.toLowerCase();
  if (compliantPhrases.some((p) => lower.includes(p))) return true;
  if (/(send|share|give|provide|type).*(otp|pin)/i.test(lower)) return true;
  return false;
}

function hasContradiction(text: string, lastScammerMessage: string): boolean {
  const lower = text.toLowerCase();
  const asksLink = /link|upi|payment|transfer|click/.test(lower);
  if (!asksLink) return false;
  return !hasLinkOrUpiOrPhone(lastScammerMessage);
}

export function scoreCandidate(reply: string, context: RubricContext): CandidateScore {
  const reasons: string[] = [];
  if (!reply || reply.trim().length === 0) {
    return { reply, score: 0, reasons, hardRejectReason: "empty" };
  }
  if (containsForbidden(reply)) {
    return { reply, score: 0, reasons, hardRejectReason: "forbidden" };
  }
  if (/\d{3,}/.test(reply)) {
    return { reply, score: 0, reasons, hardRejectReason: "digits" };
  }
  if (reply.length > 120) {
    return { reply, score: 0, reasons, hardRejectReason: "too_long" };
  }
  const lines = reply.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length > 2) {
    return { reply, score: 0, reasons, hardRejectReason: "too_many_lines" };
  }
  if (containsCompliant(reply)) {
    return { reply, score: 0, reasons, hardRejectReason: "compliant" };
  }
  if (hasContradiction(reply, context.lastScammerMessage)) {
    return { reply, score: 0, reasons, hardRejectReason: "contradiction" };
  }
  const recent = context.lastReplies.slice(-3);
  for (const prev of recent) {
    if (prev === reply) {
      return { reply, score: 0, reasons, hardRejectReason: "repeat_exact" };
    }
    if (similarity(prev, reply) >= 0.8) {
      return { reply, score: 0, reasons, hardRejectReason: "repeat_similar" };
    }
  }

  let score = 0;
  const lower = reply.toLowerCase();
  if (/confus|not sure|don't understand|dont understand|not clear|worried/.test(lower)) {
    score += 2;
    reasons.push("confusion");
  }
  if (/verify|official|helpline|employee id|branch|callback/.test(lower)) {
    score += 2;
    reasons.push("official_detail");
  }
  if (/error|network|app|loading|meeting|busy|hold|later|call back/.test(lower)) {
    score += 2;
    reasons.push("friction");
  }
  if (/are you|who are|can you confirm|please confirm/.test(lower)) {
    score += 2;
    reasons.push("mild_suspicion");
  }
  if (/kindly|as per/.test(lower) || /(sir|madam).*(sir|madam)/.test(lower)) {
    score -= 2;
    reasons.push("too_formal");
  }

  const firstWords = normalize(reply).split(" ").slice(0, 3).join(" ");
  for (const prev of recent) {
    const prevFirst = normalize(prev).split(" ").slice(0, 3).join(" ");
    if (firstWords && prevFirst && firstWords === prevFirst) {
      score -= 2;
      reasons.push("repetitive_structure");
      break;
    }
  }

  return { reply, score, reasons };
}

export function pickBestCandidate(candidates: string[], context: RubricContext): CandidateScore | null {
  const scored = candidates.map((reply) => scoreCandidate(reply, context));
  const valid = scored.filter((item) => !item.hardRejectReason);
  if (valid.length === 0) return null;
  valid.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.reply.length - b.reply.length;
  });
  return valid[0];
}
