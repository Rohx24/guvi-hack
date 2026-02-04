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
  "Wait, why OTP here? I'm scared.",
  "I don't understand. Which account is this?",
  "Why are you asking PIN on chat?",
  "This doesn't make sense. Who are you exactly?",
  "I'm confused. What is this about?"
];

const frictionPool = [
  "OTP not coming. Phone has no network.",
  "App stuck. It's not opening now.",
  "It says error. I can't proceed.",
  "Screen froze. I can't enter anything.",
  "The page keeps loading. Nothing happens.",
  "The code field is blank. I can't type.",
  "It's asking for a PIN. I don't have it."
];

const delayPool = [
  "Give me five minutes, I'm outside.",
  "I'm in a meeting. I'll check shortly.",
  "Hold on, I'll try again.",
  "I'm driving. I'll respond soon.",
  "Let me step aside and try again.",
  "I need a moment, I'm on another call."
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
  "complaint"
];

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function isValidReply(reply: string, lastReplies: string[]): boolean {
  if (!reply) return false;
  if (reply.includes("\n")) return false;
  if (wordCount(reply) > 12) return false;
  if (/\d{3,}/.test(reply)) return false;
  const lower = reply.toLowerCase();
  if (forbidden.some((word) => lower.includes(word))) return false;
  const recent = lastReplies.slice(-3);
  if (recent.includes(reply)) return false;
  return true;
}

function chooseBucket(message: string): string[] {
  const normalized = message.toLowerCase();
  const hasOtpOrPin = /\b(otp|pin)\b/.test(normalized);
  const hasPressure = /urgent|blocked|immediately/.test(normalized) || hasOtpOrPin;

  if (hasOtpOrPin) {
    return Math.random() < 0.5 ? confusionPool : frictionPool;
  }
  if (hasPressure) {
    return Math.random() < 0.5 ? confusionPool : delayPool;
  }
  const roll = Math.random();
  if (roll < 0.4) return delayPool;
  if (roll < 0.7) return frictionPool;
  return confusionPool;
}

function pickReply(pool: string[], lastReplies: string[]): string {
  const shuffled = [...pool].sort(() => Math.random() - 0.5);
  for (const candidate of shuffled) {
    if (isValidReply(candidate, lastReplies)) return candidate;
  }
  return "Hold on, I'll try again.";
}

export function writeReply(input: WriterInput): string {
  const bucket = chooseBucket(input.lastScammerMessage || "");
  const reply = pickReply(bucket, input.lastReplies || []);
  return reply;
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
