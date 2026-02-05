import { SessionState, StorySummary } from "./planner";
import type { Persona } from "./persona";
import type { ExtractedIntelligence } from "./extractor";
import type { SessionFacts } from "./sessionStore";

export type WriterInput = {
  nextIntent:
    | "clarify_procedure"
    | "seek_reassurance"
    | "delay_busy"
    | "pretend_technical_issue"
    | "partial_comply_fake_info"
    | "request_link_or_upi"
    | "ask_for_official_id_softly"
    | "confused_resistance";
  state: SessionState;
  stressScore: number;
  lastScammerMessage: string;
  story: StorySummary;
  lastReplies: string[];
  turnNumber: number;
  extracted?: ExtractedIntelligence;
  facts?: SessionFacts;
};

const humanResistancePool = [
  "I'm scared to do this. Do you have a ticket number?",
  "This feels risky. What's your designation?",
  "I'm not comfortable sharing that. Which branch is this?",
  "Why do you need this now? Do you have a reference number?",
  "I'm worried. Can you share an official callback number?"
];

const softCompliancePool = [
  "OTP not coming, I'm trying again. Do you have a case ID?",
  "The page is loading only. What's your designation?",
  "App is stuck here. Which branch is this from?",
  "It's asking PIN and I forgot. Can you share a reference number?"
];

const frictionPool = [
  "Network is bad here, I'm trying again.",
  "The app is slow, give me a minute.",
  "I'm in a meeting, can you wait a bit?",
  "I'm outside now, I'll check and reply."
];

const confusionPool = [
  "I'm not sure what's happening. Which account is this?",
  "This is sudden. What exactly happened?",
  "I don't understand. What is this about?"
];

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

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isRepeat(reply: string, lastReplies: string[]): boolean {
  const recent = lastReplies.slice(-3);
  const norm = normalize(reply);
  for (const prev of recent) {
    if (normalize(prev) === norm) return true;
  }
  return false;
}

function hasLinkOrUpiOrPhone(text: string): boolean {
  if (/https?:\/\/\S+/i.test(text)) return true;
  if (/[a-z0-9._-]{2,}@(upi|ybl|okhdfcbank|oksbi|okicici|okaxis|okpaytm|paytm|ibl|axl|sbi|hdfcbank|icici|kotak|baroda|upiicici)/i.test(text))
    return true;
  if (/\b\d{10,}\b/.test(text)) return true;
  return false;
}

function pickAskQuestion(input: WriterInput): string {
  const lastReplies = input.lastReplies || [];
  const extracted = input.extracted;
  const askedSet = input.facts?.asked;
  const asked = (key: string, keywords: string[]) => {
    if (askedSet && askedSet.has(key)) return true;
    return lastReplies.some((r) => keywords.some((k) => normalize(r).includes(k)));
  };

  const steps: Array<{ key: string; keywords: string[]; question: string; skip?: boolean }> = [
    {
      key: "ticket",
      keywords: ["ticket", "reference", "case id", "case"],
      question: "Do you have any ticket or reference number?"
    },
    {
      key: "designation",
      keywords: ["designation", "role", "post", "employee id", "staff id"],
      question:
        extracted && extracted.employeeIds && extracted.employeeIds.length > 0
          ? "What's your designation?"
          : "What's your employee ID?"
    },
    {
      key: "branch",
      keywords: ["branch"],
      question: "Which branch is this from?"
    },
    {
      key: "callback",
      keywords: ["toll free", "callback", "helpline", "official number"],
      question: "Share an official callback or toll-free number."
    },
    {
      key: "transaction",
      keywords: ["transaction", "charge", "amount"],
      question: "Which transaction is this about?"
    },
    {
      key: "link",
      keywords: ["link", "sms", "url"],
      question: "Why are you sending a link for this?"
    }
  ];

  for (const step of steps) {
    if (step.key === "callback" && extracted && extracted.phoneNumbers.length > 0) continue;
    if (step.key === "link" && !hasLinkOrUpiOrPhone(input.lastScammerMessage)) continue;
    if (asked(step.key, step.keywords)) continue;
    if (askedSet) askedSet.add(step.key);
    return step.question;
  }

  return "Can you share a reference number?";
}

function buildReply(base: string, question?: string): string {
  if (!question) return base;
  const trimmed = base.trim();
  if (trimmed.endsWith("?")) return trimmed;
  return `${trimmed} ${question}`;
}

function addEmotionIfNeeded(reply: string, lastWasQuestion: boolean): string {
  if (!lastWasQuestion) return reply;
  const lower = reply.toLowerCase();
  if (/(worried|scared|confused|nervous|anxious)/.test(lower)) return reply;
  const candidate = `I'm worried. ${reply}`;
  return candidate.length <= 140 ? candidate : reply;
}

function isValid(reply: string, lastReplies: string[]): boolean {
  if (!reply) return false;
  if (reply.includes("\n")) return false;
  if (reply.length > 140) return false;
  const lines = reply.split(/[.!?]+/).filter((s) => s.trim().length > 0);
  if (lines.length > 2) return false;
  if (/\d{3,}/.test(reply)) return false;
  const lower = reply.toLowerCase();
  if (forbidden.some((w) => lower.includes(w))) return false;
  if (isRepeat(reply, lastReplies)) return false;
  return true;
}

function pickFromPool(pool: string[], lastReplies: string[]): string {
  const shuffled = [...pool].sort(() => Math.random() - 0.5);
  for (const candidate of shuffled) {
    if (isValid(candidate, lastReplies)) return candidate;
  }
  return pool[0] || "I'm not sure. Can you confirm your designation?";
}

export function writeReply(input: WriterInput): string {
  const message = input.lastScammerMessage || "";
  const normalized = normalize(message);
  const hasOtpOrPin = /\b(otp|pin)\b/.test(normalized);
  const hasPressure = /urgent|blocked|immediately|suspended|verify/.test(normalized);
  const linkPressure = /link|click|upi|payment/.test(normalized);
  const facts = input.facts;

  const askQuestion = pickAskQuestion(input);
  const lastReply = input.lastReplies[input.lastReplies.length - 1] || "";
  const lastWasQuestion = lastReply.trim().endsWith("?");

  let base = "";
  if (hasOtpOrPin) {
    base = pickFromPool(humanResistancePool, input.lastReplies);
    const withAsk = buildReply(base, askQuestion);
    const candidate = isValid(withAsk, input.lastReplies) ? withAsk : base;
    return addEmotionIfNeeded(candidate, lastWasQuestion);
  }

  if (linkPressure) {
    base = pickFromPool(humanResistancePool, input.lastReplies);
    const withAsk = buildReply(base, askQuestion);
    const candidate = isValid(withAsk, input.lastReplies) ? withAsk : base;
    return addEmotionIfNeeded(candidate, lastWasQuestion);
  }

  if (hasPressure || input.stressScore > 0.6) {
    base = pickFromPool(softCompliancePool, input.lastReplies);
    const withAsk = buildReply(base, askQuestion);
    const candidate = isValid(withAsk, input.lastReplies) ? withAsk : base;
    return addEmotionIfNeeded(candidate, lastWasQuestion);
  }

  const roll = Math.random();
  if (roll < 0.4) return pickFromPool(confusionPool, input.lastReplies);
  if (roll < 0.75) return pickFromPool(frictionPool, input.lastReplies);
  base = pickFromPool(humanResistancePool, input.lastReplies);
  const withAsk = buildReply(base, askQuestion);
  const candidate = isValid(withAsk, input.lastReplies) ? withAsk : base;
  if (facts?.hasLink && Math.random() < 0.35) {
    return addEmotionIfNeeded(`You already sent a link. ${candidate}`, lastWasQuestion);
  }
  if (facts?.hasEmployeeId && Math.random() < 0.35) {
    return addEmotionIfNeeded(`You already shared employee ID. ${candidate}`, lastWasQuestion);
  }
  return addEmotionIfNeeded(candidate, lastWasQuestion);
}

export type OpenAIWriter = (
  input: WriterInput,
  persona: Persona,
  conversationSummary: string
) => Promise<string>;

export async function writeReplySmart(
  input: WriterInput,
  _persona: Persona,
  _summary: string,
  _openaiWriter: OpenAIWriter
): Promise<string> {
  return writeReply(input);
}
