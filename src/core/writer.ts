import { EngagementStage, SessionState, StorySummary } from "./planner";
import type { Persona } from "./persona";
import type { ExtractedIntelligence } from "./extractor";
import type { SessionFacts } from "./sessionStore";
import { validateReply } from "./validator";

export type WriterInput = {
  nextIntent:
    | "ask_ticket_or_case_id"
    | "ask_designation_and_branch"
    | "ask_official_callback_tollfree"
    | "ask_transaction_details"
    | "ask_device_location_details"
    | "ask_sender_id_or_email"
    | "ask_link_or_upi"
    | "ask_secure_process";
  state: SessionState;
  stressScore: number;
  lastScammerMessage: string;
  story: StorySummary;
  lastReplies: string[];
  turnNumber: number;
  extracted?: ExtractedIntelligence;
  facts?: SessionFacts;
  engagementStage?: EngagementStage;
  askedQuestions?: Set<string>;
  maxTurns?: number;
};

const CONFUSED_POOL = [
  "Why am I getting this suddenly?",
  "I'm confused about this.",
  "What exactly happened here?",
  "This sounds unusual to me."
];

const SUSPICIOUS_POOL = [
  "You already said that. Explain properly.",
  "This doesn't feel right to me.",
  "Bank usually doesn't ask like this.",
  "Please be clear, I'm not convinced."
];

const ASSERTIVE_POOL = [
  "Answer clearly, I need proper details.",
  "Don't rush me, give the official details.",
  "Be specific, I'm checking this myself."
];

const FORBIDDEN = ["honeypot", "ai", "bot", "scam", "fraud"];

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
  return recent.some((prev) => normalize(prev) === norm);
}

function hasLinkMention(text: string): boolean {
  if (/https?:\/\/\S+/i.test(text)) return true;
  if (/\blink\b|\bupi\b|\bpayment\b|\bpay\b/.test(text.toLowerCase())) return true;
  return false;
}

function pickBase(stage: EngagementStage, lastReplies: string[]): string {
  const pool = stage === "ASSERTIVE" ? ASSERTIVE_POOL : stage === "SUSPICIOUS" ? SUSPICIOUS_POOL : CONFUSED_POOL;
  const shuffled = [...pool].sort(() => Math.random() - 0.5);
  for (const candidate of shuffled) {
    if (!isRepeat(candidate, lastReplies) && !FORBIDDEN.some((w) => candidate.toLowerCase().includes(w))) {
      return candidate;
    }
  }
  return pool[0];
}

function pickQuestion(input: WriterInput, stage: EngagementStage): { key: string; question: string } | null {
  const asked = input.askedQuestions || new Set<string>();
  const extracted = input.extracted;
  const facts = input.facts;
  const ladder: Array<{ key: string; question: string; skip?: boolean }> = [
    { key: "ask_ticket_or_case_id", question: "Do you have a ticket or case ID?" },
    {
      key: "ask_designation_and_branch",
      question: "Give your designation and branch/city."
    },
    {
      key: "ask_official_callback_tollfree",
      question: "Share the official callback or toll-free number."
    },
    {
      key: "ask_transaction_details",
      question: "What transaction amount and time is this about?"
    },
    {
      key: "ask_device_location_details",
      question: "Which device and location was this login from?"
    },
    {
      key: "ask_sender_id_or_email",
      question: "What is the official SMS sender ID or email domain?"
    },
    {
      key: "ask_link_or_upi",
      question: "Why are you sending a link or UPI for this?",
      skip: Boolean(extracted && (extracted.phishingLinks.length > 0 || extracted.upiIds.length > 0))
    },
    {
      key: "ask_secure_process",
      question: "Explain the official process without OTP." // safe wrap-up question
    }
  ];

  for (const item of ladder) {
    if (item.skip) continue;
    if (item.key === "ask_link_or_upi" && !hasLinkMention(input.lastScammerMessage) && !facts?.hasLink && !facts?.hasUpi) {
      continue;
    }
    if (asked.has(item.key)) continue;
    asked.add(item.key);
    return { key: item.key, question: item.question };
  }

  return stage === "ASSERTIVE"
    ? { key: "ask_secure_process", question: "Explain the official process without OTP." }
    : null;
}

function buildReply(base: string, question?: string): string {
  if (!question) return base;
  if (base.trim().endsWith("?")) return base;
  return `${base} ${question}`;
}

export function writeReply(input: WriterInput): string {
  const stage: EngagementStage = input.engagementStage || "CONFUSED";
  const base = pickBase(stage, input.lastReplies);
  const nextQ = pickQuestion(input, stage);
  const candidate = buildReply(base, nextQ?.question);

  const validation = validateReply(candidate, {
    lastReplies: input.lastReplies,
    engagementStage: stage,
    facts: input.facts,
    lastScammerMessage: input.lastScammerMessage,
    turnIndex: input.turnNumber,
    maxTurns: input.maxTurns
  });
  if (validation.ok) return candidate;

  return base;
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

export function isReplySafe(
  reply: string,
  ctx: { lastReplies: string[]; engagementStage: EngagementStage; lastScammerMessage: string; facts?: SessionFacts; turnIndex: number; maxTurns: number }
): boolean {
  return validateReply(reply, {
    lastReplies: ctx.lastReplies,
    engagementStage: ctx.engagementStage,
    facts: ctx.facts,
    lastScammerMessage: ctx.lastScammerMessage,
    turnIndex: ctx.turnIndex,
    maxTurns: ctx.maxTurns
  }).ok;
}
