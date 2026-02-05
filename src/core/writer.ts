import { PersonaStage, SessionState, StorySummary } from "./planner";
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
  personaStage?: PersonaStage;
  askedQuestions?: Set<string>;
};

const stageRank: Record<PersonaStage, number> = {
  CONFUSED: 0,
  SUSPICIOUS: 1,
  ANNOYED: 2,
  DEFENSIVE: 3,
  DONE: 4
};

const CONFUSED_POOL = [
  "Why am I getting this suddenly?",
  "I'm confused. Which account is this?",
  "This is sudden. What happened?",
  "I'm not sure what's going on."
];

const CONFUSED_PRESSURE_POOL = [
  "Why OTP here? I'm getting scared.",
  "This feels risky. What's this about?",
  "I'm worried. Why are you asking this?",
  "I'm getting nervous. Can you explain?"
];

const SUSPICIOUS_POOL = [
  "You already said this before, why again?",
  "This doesn't sound right to me.",
  "Bank usually doesn't ask like this.",
  "Something feels off, can you explain?"
];

const ANNOYED_POOL = [
  "This is not making sense now.",
  "I'm not doing this over chat.",
  "Stop pushing me for this.",
  "I'm not comfortable with this."
];

const DEFENSIVE_POOL = [
  "I'm calling the bank myself now.",
  "Please stop messaging me.",
  "I'm not continuing this.",
  "I'll verify from the official number."
];

const DONE_POOL = [
  "I'm done with this.",
  "Do not contact me again.",
  "Ending this here.",
  "Please don't message me further."
];

const FRICTION_POOL = [
  "Network is bad here, give me a minute.",
  "I'm in a meeting, wait a bit.",
  "App is stuck, I'll try later.",
  "I'm outside now, will check later."
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

function stageAtLeast(stage: PersonaStage, target: PersonaStage): boolean {
  return stageRank[stage] >= stageRank[target];
}

function hasLinkOrUpiOrPhone(text: string): boolean {
  if (/https?:\/\/\S+/i.test(text)) return true;
  if (
    /[a-z0-9._-]{2,}@(upi|ybl|okhdfcbank|oksbi|okicici|okaxis|okpaytm|paytm|ibl|axl|sbi|hdfcbank|icici|kotak|baroda|upiicici)/i.test(
      text
    )
  )
    return true;
  if (/\b\d{10,}\b/.test(text)) return true;
  return false;
}

function askedRecently(lastReplies: string[], keywords: string[]): boolean {
  const joined = normalize(lastReplies.slice(-4).join(" "));
  return keywords.some((k) => joined.includes(k));
}

function pickAskQuestion(input: WriterInput, stage: PersonaStage): string {
  const lastReplies = input.lastReplies || [];
  const extracted = input.extracted;
  const askedSet = input.askedQuestions;

  const canAsk = stage !== "DEFENSIVE" && stage !== "DONE";
  if (!canAsk) return "";

  const steps: Array<{
    key: string;
    keywords: string[];
    question: string;
    condition?: boolean;
    minStage?: PersonaStage;
    maxStage?: PersonaStage;
  }> = [
    {
      key: "reference",
      keywords: ["reference", "ticket", "case"],
      question: "Do you have any reference number?",
      maxStage: "CONFUSED"
    },
    {
      key: "designation",
      keywords: ["designation", "role", "post", "employee id", "staff id"],
      question:
        extracted && extracted.employeeIds && extracted.employeeIds.length > 0
          ? "What's your designation?"
          : "What's your employee ID?",
      minStage: "SUSPICIOUS"
    },
    {
      key: "branch",
      keywords: ["branch", "city"],
      question: "Which branch or city is this from?",
      minStage: "SUSPICIOUS"
    },
    {
      key: "callback",
      keywords: ["toll free", "callback", "helpline", "official number"],
      question: "Share an official callback or toll-free number.",
      minStage: "SUSPICIOUS"
    },
    {
      key: "transaction",
      keywords: ["transaction", "charge", "amount"],
      question: "Which transaction or amount is this about?",
      minStage: "ANNOYED"
    },
    {
      key: "device",
      keywords: ["device", "login", "location"],
      question: "Which device or login was flagged?",
      minStage: "ANNOYED"
    },
    {
      key: "link",
      keywords: ["link", "sms", "url"],
      question: "Why are you sending a link for this?",
      minStage: "SUSPICIOUS",
      condition: hasLinkOrUpiOrPhone(input.lastScammerMessage) || Boolean(input.facts?.hasLink)
    }
  ];

  for (const step of steps) {
    if (step.minStage && !stageAtLeast(stage, step.minStage)) continue;
    if (step.maxStage && stageRank[stage] > stageRank[step.maxStage]) continue;
    if (step.condition === false) continue;
    if (askedSet && askedSet.has(step.key)) continue;
    if (askedRecently(lastReplies, step.keywords)) continue;
    if (askedSet) askedSet.add(step.key);
    return step.question;
  }

  return "";
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

function isValid(reply: string, lastReplies: string[], stage: PersonaStage): boolean {
  if (!reply) return false;
  if (reply.includes("\n")) return false;
  if (reply.length > 140) return false;
  const lines = reply.split(/[.!?]+/).filter((s) => s.trim().length > 0);
  if (lines.length > 2) return false;
  if (/\d{3,}/.test(reply)) return false;
  const lower = reply.toLowerCase();
  if (forbidden.some((w) => lower.includes(w))) return false;
  if (isRepeat(reply, lastReplies)) return false;
  if ((stage === "DEFENSIVE" || stage === "DONE") && reply.includes("?")) return false;
  if (
    (stage === "CONFUSED" || stage === "SUSPICIOUS" || stage === "ANNOYED") &&
    (lower.includes("calling") || lower.includes("call the bank") || lower.includes("stop messaging") || lower.includes("i'm done"))
  ) {
    return false;
  }
  if (stage === "ANNOYED" && (lower.includes("confused") || lower.includes("not sure"))) {
    return false;
  }
  if (stage === "DONE" && /wait|hold|later|check/.test(lower)) return false;
  return true;
}

function pickFromPool(pool: string[], lastReplies: string[], stage: PersonaStage): string {
  const shuffled = [...pool].sort(() => Math.random() - 0.5);
  for (const candidate of shuffled) {
    if (isValid(candidate, lastReplies, stage)) return candidate;
  }
  return pool[0] || "I'm not sure. Can you explain?";
}

function maybeAddMemoryPrefix(
  reply: string,
  facts: SessionFacts | undefined,
  stage: PersonaStage,
  lastReplies: string[]
): string {
  if (!facts) return reply;
  if (stage === "CONFUSED" || stage === "DEFENSIVE" || stage === "DONE") return reply;
  const prefixes: string[] = [];
  if (facts.hasLink && Math.random() < 0.3) prefixes.push("You already sent a link.");
  if (facts.hasEmployeeId && Math.random() < 0.3)
    prefixes.push("You already shared employee ID.");
  if (facts.hasPhone && Math.random() < 0.2) prefixes.push("You already sent a number.");
  if (prefixes.length === 0) return reply;
  const candidate = `${prefixes[0]} ${reply}`;
  if (isValid(candidate, lastReplies, stage)) return candidate;
  return reply;
}

function pickBase(stage: PersonaStage, hasPressure: boolean, hasOtpOrPin: boolean, hasLink: boolean, lastReplies: string[]): string {
  if (stage === "DONE") return pickFromPool(DONE_POOL, lastReplies, stage);
  if (stage === "DEFENSIVE") return pickFromPool(DEFENSIVE_POOL, lastReplies, stage);
  if (stage === "ANNOYED") return pickFromPool(ANNOYED_POOL, lastReplies, stage);
  if (stage === "SUSPICIOUS") {
    if (hasOtpOrPin || hasLink) return pickFromPool(SUSPICIOUS_POOL, lastReplies, stage);
    if (Math.random() < 0.25) return pickFromPool(FRICTION_POOL, lastReplies, stage);
    return pickFromPool(SUSPICIOUS_POOL, lastReplies, stage);
  }
  if (hasOtpOrPin || hasLink || hasPressure) {
    return pickFromPool(CONFUSED_PRESSURE_POOL, lastReplies, stage);
  }
  if (Math.random() < 0.35) return pickFromPool(FRICTION_POOL, lastReplies, stage);
  return pickFromPool(CONFUSED_POOL, lastReplies, stage);
}

export function isReplySafe(reply: string, lastReplies: string[], stage: PersonaStage): boolean {
  return isValid(reply, lastReplies, stage);
}

export function writeReply(input: WriterInput): string {
  const message = input.lastScammerMessage || "";
  const normalized = normalize(message);
  const hasOtpOrPin = /\b(otp|pin|cvv|password)\b/.test(normalized);
  const hasPressure = /urgent|blocked|immediately|suspended|verify/.test(normalized);
  const hasLink = /link|click|upi|payment|pay/.test(normalized);
  let stage = input.personaStage || "CONFUSED";
  if (stage === "DEFENSIVE" && input.turnNumber < 6) {
    stage = "ANNOYED";
  }

  const lastReply = input.lastReplies[input.lastReplies.length - 1] || "";
  const lastWasQuestion = lastReply.trim().endsWith("?");

  const question = pickAskQuestion(input, stage);
  let base = pickBase(stage, hasPressure, hasOtpOrPin, hasLink, input.lastReplies);
  let candidate = buildReply(base, question);
  if (!isValid(candidate, input.lastReplies, stage)) {
    candidate = isValid(base, input.lastReplies, stage) ? base : pickFromPool(CONFUSED_POOL, input.lastReplies, stage);
  }

  candidate = maybeAddMemoryPrefix(candidate, input.facts, stage, input.lastReplies);
  candidate = addEmotionIfNeeded(candidate, lastWasQuestion);
  if (!isValid(candidate, input.lastReplies, stage)) {
    candidate = pickFromPool(stage === "DONE" ? DONE_POOL : CONFUSED_POOL, input.lastReplies, stage);
  }
  return candidate;
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
