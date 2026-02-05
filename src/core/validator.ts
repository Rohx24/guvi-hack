import type { EngagementStage } from "./planner";
import type { SessionFacts } from "./sessionStore";

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

const DELAY_EXCUSES = [
  "network",
  "otp not received",
  "otp not coming",
  "app stuck",
  "app is stuck",
  "meeting",
  "battery",
  "busy",
  "later",
  "will check",
  "not now"
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

function containsLongDigits(text: string): boolean {
  return /\d{3,}/.test(text);
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

function hasDelayExcuse(text: string): boolean {
  const lower = text.toLowerCase();
  return DELAY_EXCUSES.some((phrase) => lower.includes(phrase));
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
  if (reply.length > 160) return { ok: false, reason: "too_long" };
  if (linesCount(reply) > 2) return { ok: false, reason: "too_many_lines" };
  if (containsLongDigits(reply)) return { ok: false, reason: "digits" };
  if (containsForbidden(reply)) return { ok: false, reason: "forbidden" };
  if (asksForSensitive(reply)) return { ok: false, reason: "sensitive" };
  if (asksForLinkWithoutContext(reply, ctx.facts, ctx.lastScammerMessage)) {
    return { ok: false, reason: "link_without_context" };
  }
  if (repeatsLast(reply, ctx.lastReplies)) return { ok: false, reason: "repeat" };
  if (hasDelayExcuse(reply)) return { ok: false, reason: "delay_excuse" };

  const turnIndex = ctx.turnIndex ?? 0;
  const maxTurns = ctx.maxTurns ?? 12;
  const allowExit = turnIndex >= Math.max(1, maxTurns - 1);
  if (!allowExit && hasExitPhrase(reply)) return { ok: false, reason: "exit_phrase" };

  return { ok: true };
}

export function fallbackReplyForStage(stage: EngagementStage): string {
  switch (stage) {
    case "SUSPICIOUS":
      return "You already said that. Give ticket number and your designation.";
    case "ASSERTIVE":
      return "Answer clearly: branch/city and official callback number.";
    case "CONFUSED":
    default:
      return "Why am I getting this suddenly? Do you have a reference number?";
  }
}
