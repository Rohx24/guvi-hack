import { clamp01 } from "../utils/mask";

export type ExtractedIntelligence = {
  bankAccounts: string[];
  upiIds: string[];
  phishingLinks: string[];
  phoneNumbers: string[];
  emails: string[];
  suspiciousKeywords: string[];
};

const suspiciousKeywordList = [
  "urgent",
  "immediately",
  "verify",
  "verification",
  "otp",
  "blocked",
  "suspended",
  "account",
  "kyc",
  "penalty",
  "legal",
  "complaint",
  "refund",
  "reward",
  "prize",
  "lottery",
  "bank",
  "upi",
  "transfer",
  "payment",
  "police",
  "rbi",
  "customs",
  "parcel",
  "courier",
  "delivery",
  "tax",
  "fine",
  "link",
  "click",
  "password",
  "pin"
];

const phoneRegex = /(?:\+91[\s-]?)?(?:0)?[6-9]\d{9}/g;
const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[A-Za-z]{2,}/g;
const urlRegex = /https?:\/\/[^\s/$.?#].[^\s]*/gi;
const upiRegex = /[a-zA-Z0-9._-]{2,}@(upi|ybl|okhdfcbank|oksbi|okicici|okaxis|okpaytm|paytm|ibl|axl|sbi|hdfcbank|icici|kotak|baroda|upiicici)/gi;
const longDigitRegex = /\b\d{10,}\b/g;

export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^a-z0-9@._+\-:/ ]/g, " ")
    .trim();
}

function uniqueMerge(base: string[], next: string[]): string[] {
  const set = new Set(base.map((v) => v.trim()).filter(Boolean));
  for (const item of next) {
    const value = item.trim();
    if (value) set.add(value);
  }
  return Array.from(set);
}

export function extractIntelligence(texts: string[]): ExtractedIntelligence {
  const combined = texts.join(" \n ");
  const normalized = normalizeText(combined);

  const phones = normalized.match(phoneRegex) || [];
  const emails = normalized.match(emailRegex) || [];
  const urls = combined.match(urlRegex) || [];
  const upiIds = normalized.match(upiRegex) || [];
  const longDigits = normalized.match(longDigitRegex) || [];

  const suspicious = suspiciousKeywordList.filter((kw) => normalized.includes(kw));

  return {
    bankAccounts: uniqueMerge([], longDigits),
    upiIds: uniqueMerge([], upiIds),
    phishingLinks: uniqueMerge([], urls),
    phoneNumbers: uniqueMerge([], phones),
    emails: uniqueMerge([], emails),
    suspiciousKeywords: uniqueMerge([], suspicious)
  };
}

export function mergeIntelligence(
  existing: ExtractedIntelligence,
  incoming: ExtractedIntelligence
): ExtractedIntelligence {
  return {
    bankAccounts: uniqueMerge(existing.bankAccounts, incoming.bankAccounts),
    upiIds: uniqueMerge(existing.upiIds, incoming.upiIds),
    phishingLinks: uniqueMerge(existing.phishingLinks, incoming.phishingLinks),
    phoneNumbers: uniqueMerge(existing.phoneNumbers, incoming.phoneNumbers),
    emails: uniqueMerge(existing.emails, incoming.emails),
    suspiciousKeywords: uniqueMerge(existing.suspiciousKeywords, incoming.suspiciousKeywords)
  };
}

export function tacticSignals(normalized: string): {
  urgency: number;
  authority: number;
  threat: number;
  credential: number;
  payment: number;
} {
  const urgencyTerms = ["urgent", "immediately", "within", "today", "now", "asap"];
  const authorityTerms = ["bank", "rbi", "police", "customs", "gov", "official", "kyc"];
  const threatTerms = ["blocked", "suspended", "penalty", "legal", "complaint", "fine", "arrest"];
  const credentialTerms = ["otp", "password", "pin", "cvv", "verification"];
  const paymentTerms = ["transfer", "upi", "payment", "refund", "reward", "prize", "lottery", "link"];

  const urgency = urgencyTerms.some((t) => normalized.includes(t)) ? 1 : 0;
  const authority = authorityTerms.some((t) => normalized.includes(t)) ? 1 : 0;
  const threat = threatTerms.some((t) => normalized.includes(t)) ? 1 : 0;
  const credential = credentialTerms.some((t) => normalized.includes(t)) ? 1 : 0;
  const payment = paymentTerms.some((t) => normalized.includes(t)) ? 1 : 0;

  return {
    urgency: clamp01(urgency),
    authority: clamp01(authority),
    threat: clamp01(threat),
    credential: clamp01(credential),
    payment: clamp01(payment)
  };
}
