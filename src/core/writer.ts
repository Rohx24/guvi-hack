import { EngagementStage, SessionState, StorySummary } from "./planner";
import type { Persona } from "./persona";
import type { ExtractedIntelligence } from "./extractor";
import type { SessionFacts } from "./sessionStore";
import { validateReply } from "./validator";

export type WriterInput = {
  nextIntent:
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
  "Be clear, I'm not convinced yet.",
  "Why are you pushing this so much?"
];

const ASSERTIVE_POOL = [
  "Answer clearly, I need proper details.",
  "Don't rush me, give official details.",
  "Be specific, I am verifying this."
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

function pickBase(stage: EngagementStage, lastReplies: string[]): string {
  const pool = stage === "ASSERTIVE" ? ASSERTIVE_POOL : stage === "SUSPICIOUS" ? SUSPICIOUS_POOL : CONFUSED_POOL;
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
  ask_employee_id: "What is your employee ID?",
  ask_designation: "What is your designation?",
  ask_callback_number: "Share the official callback or toll-free number.",
  ask_escalation_authority: "Who is the escalation authority for this?",
  ask_transaction_amount_time: "What transaction amount and time is this about?",
  ask_transaction_mode: "Which mode was used — UPI, IMPS, or netbanking?",
  ask_merchant_receiver: "Who is the merchant or receiver name?",
  ask_device_type: "Which device type was used?",
  ask_login_location: "Which city/location was this login from?",
  ask_ip_or_reason: "Why was this login flagged as unusual?",
  ask_otp_reason: "Why do you need OTP for this?",
  ask_no_notification_reason: "Why didn't the app show any alert?",
  ask_internal_system: "Which internal system flagged this?",
  ask_phone_numbers: "Which official number are you calling from?",
  ask_sender_id_or_email: "What is the official SMS sender ID or email domain?",
  ask_links: "Why are you sending a link for this?",
  ask_upi_or_beneficiary: "Give the UPI ID or beneficiary name.",
  ask_names_used: "What name was used in your system?",
  ask_keywords_used: "Which keywords or alerts were triggered?"
};

function pickQuestion(input: WriterInput): { key: string; question: string } {
  const key = input.nextIntent;
  const question = INTENT_QUESTIONS[key];
  if (question) return { key, question };
  return { key: "ask_keywords_used", question: INTENT_QUESTIONS.ask_keywords_used };
}

function buildReply(base: string, question: string): string {
  const trimmed = base.trim();
  if (trimmed.endsWith("?")) return trimmed;
  return `${trimmed} ${question}`;
}

export function writeReply(input: WriterInput): string {
  const stage: EngagementStage = input.engagementStage || "CONFUSED";
  const base = pickBase(stage, input.lastReplies);
  const nextQ = pickQuestion(input);
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
