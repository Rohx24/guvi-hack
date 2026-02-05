import type { PersonaStage } from "./planner";
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

export type ValidationContext = {
  lastReplies: string[];
  personaStage: PersonaStage;
  facts?: SessionFacts;
  lastScammerMessage?: string;
  turnIndex?: number;
};

export type ValidationResult = { ok: boolean; reason?: string };

export function validateReply(reply: string, ctx: ValidationContext): ValidationResult {
  if (!reply || reply.trim().length === 0) return { ok: false, reason: "empty" };
  if (reply.length > 140) return { ok: false, reason: "too_long" };
  if (linesCount(reply) > 2) return { ok: false, reason: "too_many_lines" };
  if (containsLongDigits(reply)) return { ok: false, reason: "digits" };
  if (containsForbidden(reply)) return { ok: false, reason: "forbidden" };
  if (asksForSensitive(reply)) return { ok: false, reason: "sensitive" };
  if (asksForLinkWithoutContext(reply, ctx.facts, ctx.lastScammerMessage)) {
    return { ok: false, reason: "link_without_context" };
  }
  if (repeatsLast(reply, ctx.lastReplies)) return { ok: false, reason: "repeat" };
  if ((ctx.personaStage === "DEFENSIVE" || ctx.personaStage === "DONE") && reply.includes("?")) {
    return { ok: false, reason: "question_in_late_stage" };
  }
  const lower = reply.toLowerCase();
  const turnIndex = ctx.turnIndex ?? 0;
  if (
    (ctx.personaStage === "CONFUSED" || ctx.personaStage === "SUSPICIOUS" || ctx.personaStage === "ANNOYED") &&
    (lower.includes("calling") || lower.includes("call the bank") || lower.includes("stop messaging") || lower.includes("i'm done"))
  ) {
    return { ok: false, reason: "too_defensive" };
  }
  if ((ctx.personaStage === "DEFENSIVE" || ctx.personaStage === "DONE") && turnIndex < 6) {
    return { ok: false, reason: "too_early_defensive" };
  }
  if (ctx.personaStage === "ANNOYED" && (lower.includes("confused") || lower.includes("not sure"))) {
    return { ok: false, reason: "too_soft" };
  }
  return { ok: true };
}

export function fallbackReplyForStage(stage: PersonaStage): string {
  switch (stage) {
    case "SUSPICIOUS":
      return "You already said this... why OTP on chat? Give a ticket number.";
    case "ANNOYED":
      return "You keep repeating same thing. This doesn't look right.";
    case "DEFENSIVE":
      return "Stop this. I'm calling SBI directly now.";
    case "DONE":
      return "I'm done. Don't contact me again.";
    case "CONFUSED":
    default:
      return "Why am I getting this suddenly? Do you have any reference number?";
  }
}
