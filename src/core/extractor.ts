import { clamp01 } from "../utils/mask";

export type ExtractedIntelligence = {
  bankAccounts: string[];
  upiIds: string[];
  phishingLinks: string[];
  phoneNumbers: string[];
  emails: string[];
  suspiciousKeywords: string[];
  employeeIds: string[];
  caseIds: string[];
  tollFreeNumbers: string[];
  senderIds: string[];
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
  "pin",
  "ticket",
  "case",
  "reference"
];

const phoneRegex = /(?:\+91[\s-]?)?(?:0)?[6-9]\d{9}/g;
const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[A-Za-z]{2,}/g;
const urlRegex = /https?:\/\/[^\s/$.?#].[^\s]*/gi;
const paymentLinkRegex = /(?:upi:\/\/pay|payto:)[^\s]+/gi;
const upiRegex = /[a-zA-Z0-9._-]{2,}@(upi|ybl|okhdfcbank|oksbi|okicici|okaxis|okpaytm|paytm|ibl|axl|sbi|hdfcbank|icici|kotak|baroda|upiicici)/gi;
const bankAccountRegex = /\b\d{11,18}\b/g;
const employeeIdRegex = /\b(?:employee|emp|staff|officer)\s*(?:id|code|no|number)?\s*[:#-]?\s*([a-z0-9-]{3,12})\b/gi;
const employeeIdShortRegex = /\bemp\d{3,}\b/gi;
const caseIdRegex = /\b(?:case|ticket|ref|reference)[- ]?[a-z0-9]{3,}\b/gi;
const caseIdDigitsRegex = /\b(?:case id|ticket id|reference id)[:\\s-]*([0-9]{3,})\b/gi;
const employeeCodeDigitsRegex = /\b(?:employee code|officer code)[:\\s-]*([0-9]{3,})\b/gi;
const tollFreeRegex = /\b(1800|1860|1861|1850)[- ]?\d{3,8}\b/g;
const senderIdRegex = /\b(?:sender id|sms id|from)[:\\s]*([A-Z0-9-]{4,10})\b/g;
const senderIdBareRegex = /\b[A-Z]{2}[A-Z0-9]{4,6}\b/g;

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

function normalizeUrl(url: string): string {
  return url.replace(/[),\].}]+$/g, "").trim();
}

function uniqueNormalizedUrls(items: string[]): string[] {
  const set = new Set<string>();
  for (const raw of items) {
    const normalized = normalizeUrl(raw);
    if (normalized) set.add(normalized);
  }
  return Array.from(set);
}

export function extractIntelligence(texts: string[]): ExtractedIntelligence {
  const combined = texts.join(" \n ");
  const normalized = normalizeText(combined);

  const phones: string[] = normalized.match(phoneRegex) || [];
  const emails: string[] = normalized.match(emailRegex) || [];
  const urls: string[] = combined.match(urlRegex) || [];
  const payLinks: string[] = combined.match(paymentLinkRegex) || [];
  const upiIds: string[] = normalized.match(upiRegex) || [];
  const bankDigits: string[] = normalized.match(bankAccountRegex) || [];
  const employeeIds = Array.from(normalized.matchAll(employeeIdRegex)).map((m) => m[1]);
  const employeeIdsShort = normalized.match(employeeIdShortRegex) || [];
  const caseIds = normalized.match(caseIdRegex) || [];
  const caseIdsDigits = Array.from(normalized.matchAll(caseIdDigitsRegex)).map((m) => m[1]);
  const employeeCodesDigits = Array.from(normalized.matchAll(employeeCodeDigitsRegex)).map((m) => m[1]);
  const tollFreeNumbers = (combined.match(tollFreeRegex) || []).map((v) =>
    v.replace(/\s|-/g, "")
  );
  const senderIds = Array.from(combined.matchAll(senderIdRegex)).map((m) => m[1]);
  const senderIdsBare = combined.match(senderIdBareRegex) || [];

  const suspicious = suspiciousKeywordList.filter((kw) => normalized.includes(kw));

  return {
    bankAccounts: uniqueMerge([], bankDigits.filter((d) => !phones.includes(d))),
    upiIds: uniqueMerge([], upiIds),
    phishingLinks: uniqueMerge([], uniqueNormalizedUrls([...urls, ...payLinks])),
    phoneNumbers: uniqueMerge([], phones),
    emails: uniqueMerge([], emails),
    suspiciousKeywords: uniqueMerge([], suspicious),
    employeeIds: uniqueMerge([], [...employeeIds, ...employeeIdsShort, ...employeeCodesDigits]),
    caseIds: uniqueMerge([], [...caseIds, ...caseIdsDigits]),
    tollFreeNumbers: uniqueMerge([], tollFreeNumbers),
    senderIds: uniqueMerge([], [...senderIds, ...senderIdsBare])
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
    suspiciousKeywords: uniqueMerge(existing.suspiciousKeywords, incoming.suspiciousKeywords),
    employeeIds: uniqueMerge(existing.employeeIds, incoming.employeeIds),
    caseIds: uniqueMerge(existing.caseIds || [], incoming.caseIds || []),
    tollFreeNumbers: uniqueMerge(existing.tollFreeNumbers || [], incoming.tollFreeNumbers || []),
    senderIds: uniqueMerge(existing.senderIds || [], incoming.senderIds || [])
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
