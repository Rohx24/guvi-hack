import type { EngagementStage } from "./planner";
import type { SessionFacts } from "./sessionStore";
import { analyzeAntiBot } from "./antiBot";

const FORBIDDEN_WORDS = [
  "honeypot",
  "ai",
  "bot",
  "scam detection",
  "fraud detection",
  "scam",
  "fraud"
];

const EXIT_PHRASES = [
  "i'm done",
  "im done",
  "ending this",
  "end this",
  "don't message",
  "do not message",
  "stop messaging",
  "stop this",
  "calling sbi",
  "call sbi",
  "call the bank",
  "police",
  "complaint"
];


const ALLOWED_FRICTION = [
  "confused",
  "worried",
  "error",
  "stuck",
  "loading",
  "app",
  "website",
  "passbook"
];

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function linesCount(text: string): number {
  return text.split("\n").filter((line) => line.trim().length > 0).length;
}

function repeatsLast(text: string, lastReplies: string[]): boolean {
  const norm = normalize(text);
  return lastReplies.slice(-3).some((r) => normalize(r) === norm);
}

function containsForbidden(text: string): boolean {
  const lower = text.toLowerCase();
  return FORBIDDEN_WORDS.some((w) => lower.includes(w));
}

function asksForSensitive(text: string): boolean {
  const lower = text.toLowerCase();
  if (/account number|acc no/.test(lower)) return true;
  return /(send|share|give|tell|type|enter)\s+\w*\s*(otp|pin|account|cvv|password)/.test(lower);
}

function asksForLinkWithoutContext(text: string, facts?: SessionFacts, lastScammerMessage?: string): boolean {
  const lower = text.toLowerCase();
  if (!/link/.test(lower)) return false;
  const hasContext =
    Boolean(facts?.hasLink) ||
    (lastScammerMessage ? /link|http|upi|payment|pay/.test(lastScammerMessage.toLowerCase()) : false);
  if (hasContext) return false;
  return /\b(send|share|resend|forward)\b.*\blink\b|\blink\b.*\b(send|share|resend|forward)\b/.test(
    lower
  );
}

function hasExitPhrase(text: string): boolean {
  const lower = text.toLowerCase();
  return EXIT_PHRASES.some((phrase) => lower.includes(phrase));
}


export type ValidationContext = {
  lastReplies: string[];
  engagementStage: EngagementStage;
  facts?: SessionFacts;
  lastScammerMessage?: string;
  turnIndex?: number;
  maxTurns?: number;
};

export type ValidationResult = { ok: boolean; reason?: string };

export function validateReply(reply: string, ctx: ValidationContext): ValidationResult {
  if (!reply || reply.trim().length === 0) return { ok: false, reason: "empty" };
  if (reply.length > 200) return { ok: false, reason: "too_long" };
  if (linesCount(reply) > 3) return { ok: false, reason: "too_many_lines" };
  if (containsForbidden(reply)) return { ok: false, reason: "forbidden" };
  if (asksForSensitive(reply)) return { ok: false, reason: "sensitive" };
  if (!reply.includes("?")) return { ok: false, reason: "no_question" };
  if (asksForLinkWithoutContext(reply, ctx.facts, ctx.lastScammerMessage)) {
    return { ok: false, reason: "link_without_context" };
  }
  if (repeatsLast(reply, ctx.lastReplies)) return { ok: false, reason: "repeat" };
  if (hasExitPhrase(reply)) return { ok: false, reason: "exit_phrase" };

  const antiBot = analyzeAntiBot(reply, ctx.lastReplies);
  if (!antiBot.ok) {
    return { ok: false, reason: antiBot.reasons[0] || "anti_bot" };
  }

  return { ok: true };
}

export function fallbackReplyForStage(stage: EngagementStage): string {
  switch (stage) {
    case "SUSPICIOUS":
      return "You already said that. What's the ticket number and your designation?";
    case "ASSERTIVE":
      return "What's the official callback number and branch/city?";
    case "CONFUSED":
    default:
      return "Why am I getting this suddenly? Do you have a reference number?";
  }
}
