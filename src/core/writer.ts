import { EngagementStage, SessionState, StorySummary } from "./planner";
import type { Persona } from "./persona";
import type { ExtractedIntelligence } from "./extractor";
import type { SessionFacts } from "./sessionStore";
import { validateReply } from "./validator";

export type WriterInput = {
  nextSlot:
    | "ask_ticket_or_case_id"
    | "ask_branch_city"
    | "ask_department_name"
    | "ask_employee_id"
    | "ask_designation"
    | "ask_callback_number"
    | "ask_escalation_authority"
    | "ask_transaction_amount_time"
    | "ask_transaction_mode"
    | "ask_merchant_receiver"
    | "ask_device_type"
    | "ask_login_location"
    | "ask_ip_or_reason"
    | "ask_otp_reason"
    | "ask_no_notification_reason"
    | "ask_internal_system"
    | "ask_phone_numbers"
    | "ask_sender_id_or_email"
    | "ask_links"
    | "ask_upi_or_beneficiary"
    | "ask_names_used"
    | "ask_keywords_used";
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
  level?: number;
};

const CONFUSED_POOL = [
  "I'm trying to check, but this screen is confusing me.",
  "I'm trying, but I'm not sure I'm doing this right.",
  "I'm worried and checking, the app looks different."
];

const SUSPICIOUS_POOL = [
  "I'm trying, but it asks for your details first.",
  "I'm trying to follow, but it needs caller info to move.",
  "I'm trying, but it won't go ahead without basics."
];

const ASSERTIVE_POOL = [
  "I want to sort this, but it needs your details to continue.",
  "I'm trying, but it's blocked until I add your info.",
  "I'm trying, but it won't accept without your details."
];

const CUNNING_POOL = [
  "I'm trying, but it asks for a step you should know.",
  "I'm trying, but it needs a system detail you can confirm.",
  "I'm trying, but it asks for the process name."
];

const HIGH_PRESSURE_POOL = [
  "I'm trying, but it needs exact case details to proceed.",
  "I'm trying, but it needs your ID to continue.",
  "I'm trying, but it won't move without your details."
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
  return recent.some((prev) => normalize(prev) === norm);
}

function poolForStage(stage: EngagementStage, level: number): string[] {
  let pool = stage === "ASSERTIVE" ? ASSERTIVE_POOL : stage === "SUSPICIOUS" ? SUSPICIOUS_POOL : CONFUSED_POOL;
  if (level >= 6 && level <= 8) pool = CUNNING_POOL;
  if (level >= 9) pool = HIGH_PRESSURE_POOL;
  return pool;
}

function pickBase(stage: EngagementStage, level: number, lastReplies: string[]): string {
  const pool = poolForStage(stage, level);
  const shuffled = [...pool].sort(() => Math.random() - 0.5);
  for (const candidate of shuffled) {
    if (!isRepeat(candidate, lastReplies)) return candidate;
  }
  return pool[0];
}

const INTENT_QUESTIONS: Record<string, string> = {
  ask_ticket_or_case_id: "It asks for the case/reference ID. What should I type there?",
  ask_branch_city: "It asks for branch or city. Which one is it?",
  ask_department_name: "It asks for department name. What should I enter?",
  ask_employee_id: "It is asking for your employee code. What is it?",
  ask_designation: "It asks for your designation. What should I put?",
  ask_callback_number: "It asks for a callback or toll-free number. What is it?",
  ask_escalation_authority: "It asks for supervisor/manager name. Who is it?",
  ask_transaction_amount_time: "It asks for the amount and time. What should I fill?",
  ask_transaction_mode: "It asks for the mode (UPI/IMPS/netbanking). Which is it?",
  ask_merchant_receiver: "It asks for beneficiary/receiver name. What is it?",
  ask_device_type: "It asks for device type. Which device is flagged?",
  ask_login_location: "It asks for login city/location. Which one is it?",
  ask_ip_or_reason: "It asks why login was flagged. What reason should I mention?",
  ask_otp_reason: "It asks why OTP is needed. What should I say?",
  ask_no_notification_reason: "It asks why no alert showed. What should I write?",
  ask_internal_system: "It asks which internal system flagged this. What is the name?",
  ask_phone_numbers: "It asks for the number you are calling from. What is it?",
  ask_sender_id_or_email: "It asks for SMS sender ID or email. What is it?",
  ask_links: "It asks for the link or domain. What is it?",
  ask_upi_or_beneficiary: "It asks for UPI handle or beneficiary name. What is it?",
  ask_names_used: "It asks for the name used in your system. What should I enter?",
  ask_keywords_used: "It asks what keyword or alert triggered this. What should I write?"
};

function applyFactContext(slot: string, question: string | undefined, facts?: SessionFacts): string {
  if (!question) return "";
  if (!facts) return question;
  if (slot === "ask_designation" && facts.employeeId) {
    return `You said your ID is ${facts.employeeId} - what's your designation?`;
  }
  if (slot === "ask_branch_city" && facts.city) {
    return `Which team or desk in ${facts.city} branch is handling this?`;
  }
  if (slot === "ask_callback_number" && facts.callbackNumber) {
    return `Is ${facts.callbackNumber} the official callback? Any alternate?`;
  }
  if (slot === "ask_transaction_amount_time" && facts.txnAmount) {
    return `You mentioned ${facts.txnAmount} - what's the exact time and mode?`;
  }
  if (slot === "ask_links" && facts.link) {
    return `You already sent a link - why is a link needed for this?`;
  }
  return question;
}

function pickQuestion(input: WriterInput): { key: string; question: string } {
  const key = input.nextSlot;
  const question = applyFactContext(key, INTENT_QUESTIONS[key], input.facts);
  if (question) return { key, question };
  return { key: "ask_keywords_used", question: INTENT_QUESTIONS.ask_keywords_used };
}

function buildReply(base: string, question: string): string {
  const trimmed = base.trim();
  if (!question) return trimmed;
  const normalizedBase = normalize(trimmed);
  const normalizedQuestion = normalize(question);
  if (normalizedBase.includes(normalizedQuestion)) return trimmed;
  if (trimmed.endsWith("?")) return `${trimmed} ${question}`;
  return `${trimmed} ${question}`;
}

export function writeReply(input: WriterInput): string {
  const stage: EngagementStage = input.engagementStage || "CONFUSED";
  const level = typeof input.level === "number" ? input.level : 0;
  const nextQ = pickQuestion(input);
  const pool = poolForStage(stage, level);
  const shuffled = [...pool].sort(() => Math.random() - 0.5);

  for (const base of shuffled) {
    if (isRepeat(base, input.lastReplies)) continue;
    const candidate = buildReply(base, nextQ.question);
    const validation = validateReply(candidate, {
      lastReplies: input.lastReplies,
      engagementStage: stage,
      facts: input.facts,
      lastScammerMessage: input.lastScammerMessage,
      turnIndex: input.turnNumber,
      maxTurns: input.maxTurns
    });
    if (validation.ok) return candidate;
  }

  const questionOnly = nextQ.question || "Do you have a reference number for this?";
  const qValidation = validateReply(questionOnly, {
    lastReplies: input.lastReplies,
    engagementStage: stage,
    facts: input.facts,
    lastScammerMessage: input.lastScammerMessage,
    turnIndex: input.turnNumber,
    maxTurns: input.maxTurns
  });
  if (qValidation.ok) return questionOnly;

  const safeFallback = "Do you have a ticket or case ID for this?";
  const safeValidation = validateReply(safeFallback, {
    lastReplies: input.lastReplies,
    engagementStage: stage,
    facts: input.facts,
    lastScammerMessage: input.lastScammerMessage,
    turnIndex: input.turnNumber,
    maxTurns: input.maxTurns
  });
  if (safeValidation.ok) return safeFallback;

  return pickBase(stage, level, input.lastReplies);
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
