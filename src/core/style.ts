import type { ValidationContext } from "./validator";
import { validateReply } from "./validator";

const FORMAL_WORDS = [
  /\bkindly\b/gi,
  /\bprovide\b/gi,
  /\bverifiable\b/gi,
  /\binvestigation\b/gi,
  /\bguidelines?\b/gi,
  /\bprotocols?\b/gi,
  /\bnon[-\s]?compliance\b/gi,
  /\brequest denied\b/gi,
  /\bverification\b/gi,
  /\bvalidation\b/gi,
  /\bauthenticity\b/gi,
  /\bsuspicious\b/gi
];

const DEAD_ENDS = [
  /\bdriving\b/gi,
  /\bmeeting\b/gi,
  /\bbusy\b/gi,
  /\bcall later\b/gi,
  /\bnetwork is slow\b/gi,
  /\bbattery\b/gi,
  /\beating\b/gi,
  /\bsleeping\b/gi
];

const FALLBACKS = [
  "I'm outside rn. Not sharing OTP on chat. What's the reference or case ID?",
  "OTP hasn't come yet. Which official number can I call back?",
  "I can't open links now. Which branch and your employee code?",
  "If it's real, send the official email or ticket ID. I'll check."
];

function stripFormalWords(text: string): string {
  let out = text;
  for (const re of FORMAL_WORDS) out = out.replace(re, "");
  return out;
}

function stripDeadEnds(text: string): string {
  let out = text;
  for (const re of DEAD_ENDS) out = out.replace(re, "");
  return out;
}

function scrubSensitive(text: string): string {
  let out = text;
  out = out.replace(/\b(otp|pin|cvv|password)\s*[:\-]?\s*\d{4,8}\b/gi, "$1 [hidden]");
  out = out.replace(/\bmy\s+(otp|pin|cvv|password)\s+is\s+\d{4,8}\b/gi, "my $1 is [hidden]");
  out = out.replace(/\b(account number|acc no)\s*[:\-]?\s*\d{6,18}\b/gi, "$1 [hidden]");
  out = out.replace(/\b\d{4,}\b/g, "[redacted]");
  return out;
}

function normalizeSpacing(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function ensureSingleQuestion(text: string, fallbackQuestion: string): string {
  const match = text.match(/\?/g) || [];
  if (match.length === 0) return `${text} ${fallbackQuestion}`.trim();
  if (match.length === 1) return text;
  const idx = text.indexOf("?");
  return text.slice(0, idx + 1);
}

function pickFallback(): string {
  const idx = Math.floor(Math.random() * FALLBACKS.length);
  return FALLBACKS[idx] || FALLBACKS[0];
}

function fallbackQuestion(ctx: ValidationContext): string {
  const last = (ctx.lastScammerMessage || "").toLowerCase();
  if (/link|http/.test(last)) return "What link should I open?";
  if (/otp|pin/.test(last)) return "What's the case or reference ID?";
  if (/branch|city/.test(last)) return "Which branch is this from?";
  if (/employee|officer|id/.test(last)) return "What's your employee code?";
  return "What's the reference or case ID?";
}

export function safeFallbackReply(ctx: ValidationContext): string {
  const base = pickFallback();
  return normalizeReplyStyle(base, ctx, true);
}

export function normalizeReplyStyle(
  reply: string,
  ctx: ValidationContext,
  skipValidation = false
): string {
  let text = String(reply || "").trim();
  if (!text) {
    return pickFallback();
  }

  text = text.replace(/\r?\n/g, " ");
  text = stripFormalWords(text);
  text = stripDeadEnds(text);
  text = scrubSensitive(text);
  text = normalizeSpacing(text);

  const question = fallbackQuestion(ctx);
  text = ensureSingleQuestion(text, question);

  if (text.length > 160) {
    text = `${text.slice(0, 157).trim()}...`;
  }

  if (!skipValidation) {
    const validation = validateReply(text, ctx);
    if (!validation.ok) {
      return pickFallback();
    }
  }

  return text;
}
