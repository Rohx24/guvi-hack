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
  "Why am I getting this suddenly?",
  "I'm a bit confused about this.",
  "This doesn't match what I did.",
  "What exactly triggered this?"
];

const SUSPICIOUS_POOL = [
  "You already mentioned this once. Why again?",
  "Bank usually doesn't ask like this, right?",
  "Something feels off - can you clarify?",
  "Why is this so urgent again?"
];

const ASSERTIVE_POOL = [
  "I need the official details before I proceed.",
  "Let me verify with the exact details.",
  "I'm not comfortable yet, I need official verification."
];

const CUNNING_POOL = [
  "Earlier you said one thing, now it's different - which is correct?",
  "If this is genuine, the internal process should be clear.",
  "Which system flagged this on your end?"
];

const HIGH_PRESSURE_POOL = [
  "I can verify only with official case details.",
  "This needs exact case details before I move.",
  "If it's official, the ticket and designation should be easy."
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
  ask_ticket_or_case_id: "Do you have a ticket or case ID?",
  ask_branch_city: "Which branch or city is this from?",
  ask_department_name: "Which department is handling this?",
  ask_employee_id: "What's your employee ID?",
  ask_designation: "What's your designation?",
  ask_callback_number: "What's the official callback or toll-free number?",
  ask_escalation_authority: "Who is the escalation authority or manager here?",
  ask_transaction_amount_time: "What transaction amount and time is this about?",
  ask_transaction_mode: "Which mode was used - UPI, IMPS, or netbanking?",
  ask_merchant_receiver: "Who is the merchant or receiver name?",
  ask_device_type: "Which device type was used?",
  ask_login_location: "Which city/location was this login from?",
  ask_ip_or_reason: "Why was this login flagged as unusual?",
  ask_otp_reason: "Why do you need OTP for this?",
  ask_no_notification_reason: "Why didn't the app show any alert?",
  ask_internal_system: "Which internal system flagged this?",
  ask_phone_numbers: "Which official number are you calling from?",
  ask_sender_id_or_email: "What's the official SMS sender ID or email domain?",
  ask_links: "Why is a link needed for this?",
  ask_upi_or_beneficiary: "What's the UPI ID or beneficiary name?",
  ask_names_used: "What name was used in your system?",
  ask_keywords_used: "Which keywords or alerts were triggered?"
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
