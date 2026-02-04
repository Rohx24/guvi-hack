import { SessionState, StorySummary } from "./planner";
import type { Persona } from "./persona";

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
};

const confusionPool = [
  "I'm confused. Which account is this about?",
  "This is sudden. What exactly happened?",
  "I'm not sure. Why do you need this now?",
  "I'm worried. Who should I call to verify this?",
  "Can you tell me the branch name?"
];

const frictionPool = [
  "My app shows an error, give me a minute.",
  "Network is bad here, I can't open the app.",
  "The screen is stuck, I'm trying again.",
  "The app keeps loading, nothing happens.",
  "I'm in a meeting, can you wait a bit?"
];

const verifyPool = [
  "Can you share your employee ID?",
  "Please send the official SMS sender ID.",
  "What's the callback number from your office?",
  "Can you confirm the branch and your employee ID?",
  "I will call the bank helpline from the website, okay?"
];

const refusalPool = [
  "I won't share OTP/PIN in chat. I can only verify via the official app/helpline.",
  "I won't share OTP/PIN in chat. Can you share your employee ID?",
  "I'm calling SBI now, please hold."
];

const suspicionPool = [
  "This feels off. Can you share your employee ID?",
  "I need to verify via the official helpline. Can you wait?",
  "Please send the official SMS sender ID.",
  "Can you confirm your branch details?"
];

const forbidden = [
  "scam",
  "fraud",
  "honeypot",
  "ai",
  "bot",
  "phishing",
  "police",
  "cybercrime"
];

function isValidReply(reply: string, lastReplies: string[]): boolean {
  if (!reply) return false;
  if (reply.includes("\n")) return false;
  const sentences = reply.split(/[.!?]+/).filter((s) => s.trim().length > 0);
  if (sentences.length > 2) return false;
  if (/\d{3,}/.test(reply)) return false;
  const lower = reply.toLowerCase();
  if (forbidden.some((word) => lower.includes(word))) return false;
  const recent = lastReplies.slice(-3);
  if (recent.includes(reply)) return false;
  return true;
}

function chooseBucket(message: string, turnNumber: number): string[] {
  const normalized = message.toLowerCase();
  const hasOtpOrPin = /\b(otp|pin)\b/.test(normalized);
  const hasPressure = /urgent|blocked|immediately|suspended|verify/.test(normalized) || hasOtpOrPin;
  const asksPayment = /upi|transfer|payment/.test(normalized);

  if (hasOtpOrPin) {
    return refusalPool;
  }
  if (hasPressure && turnNumber > 2) {
    return Math.random() < 0.6 ? suspicionPool : verifyPool;
  }
  if (asksPayment) {
    return Math.random() < 0.5 ? verifyPool : frictionPool;
  }
  if (hasPressure) {
    return Math.random() < 0.5 ? confusionPool : frictionPool;
  }
  const roll = Math.random();
  if (roll < 0.3) return confusionPool;
  if (roll < 0.6) return frictionPool;
  return verifyPool;
}

function pickReply(pool: string[], lastReplies: string[]): string {
  const shuffled = [...pool].sort(() => Math.random() - 0.5);
  for (const candidate of shuffled) {
    if (isValidReply(candidate, lastReplies)) return candidate;
  }
  return "I'm calling SBI now, please hold.";
}

export function writeReply(input: WriterInput): string {
  const bucket = chooseBucket(input.lastScammerMessage || "", input.turnNumber || 1);
  return pickReply(bucket, input.lastReplies || []);
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
