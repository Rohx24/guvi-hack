import { clamp01 } from "../utils/mask";
import { ExtractedIntelligence, normalizeText } from "./extractor";
import type { Context } from "./memory";

export type SessionState = {
  anxiety: number;
  confusion: number;
  overwhelm: number;
  trustAuthority: number;
  compliance: number;
};

export type SessionMode = "SAFE" | "SUSPECT" | "SCAM_CONFIRMED" | "COMPLETE";

export type EngagementStage = "CONFUSED" | "SUSPICIOUS" | "ASSERTIVE";

export type StorySummary = {
  scamType: string;
  scammerClaim: string;
  scammerAsk: string;
};

export type Intent =
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

export type GoalFlags = {
  gotUpiId: boolean;
  gotPaymentLink: boolean;
  gotPhoneOrEmail: boolean;
  gotBankAccountLikeDigits: boolean;
  gotPhishingUrl: boolean;
  gotExplicitOtpAsk: boolean;
};

export type PlannerInput = {
  scamScore: number;
  stressScore: number;
  scamDetected: boolean;
  state: SessionState;
  engagement: { totalMessagesExchanged: number };
  extracted: ExtractedIntelligence;
  askedQuestions: Set<string>;
  lastIntents: Intent[];
  lastScammerMessage: string;
  repeatDemand?: boolean;
  refusedCaseId?: boolean;
};

export type PlannerOutput = {
  nextSlot: Intent;
  mode: SessionMode;
  updatedState: SessionState;
  scamDetected: boolean;
  agentNotes: string;
};

export type EngagementSignals = {
  urgencyRepeat: boolean;
  sameDemandRepeat: boolean;
  pushyRepeat: boolean;
};

type DemandBucket = "otp" | "link" | "account";

function classifyDemand(normalized: string): { urgency: boolean; buckets: Set<DemandBucket> } {
  const urgency = /urgent|immediately|blocked|suspended|verify|now|asap/.test(normalized);
  const buckets = new Set<DemandBucket>();
  if (/(otp|pin|password|cvv)/.test(normalized)) buckets.add("otp");
  if (/(link|click|upi|payment|pay|collect)/.test(normalized)) buckets.add("link");
  if (/(account|card|bank|ifsc|beneficiary|upi id)/.test(normalized)) buckets.add("account");
  return { urgency, buckets };
}

export function detectEngagementSignals(messages: string[]): EngagementSignals {
  const recent = messages.filter(Boolean).slice(-3).map((m) => normalizeText(m));
  let urgencyCount = 0;
  let pushyCount = 0;
  const counts: Record<DemandBucket, number> = { otp: 0, link: 0, account: 0 };

  for (const msg of recent) {
    const { urgency, buckets } = classifyDemand(msg);
    if (urgency) urgencyCount += 1;
    if (buckets.size > 0) pushyCount += 1;
    for (const bucket of buckets) {
      counts[bucket] += 1;
    }
  }

  return {
    urgencyRepeat: urgencyCount >= 2,
    sameDemandRepeat: Object.values(counts).some((count) => count >= 2),
    pushyRepeat: pushyCount >= 2
  };
}

export function advanceEngagementStage(
  current: EngagementStage,
  input: EngagementSignals & { turnCount: number }
): EngagementStage {
  if (current === "ASSERTIVE") return current;
  if (
    current === "CONFUSED" &&
    input.turnCount >= 2 &&
    (input.urgencyRepeat || input.sameDemandRepeat)
  ) {
    return "SUSPICIOUS";
  }
  if (
    current === "SUSPICIOUS" &&
    input.turnCount >= 4 &&
    (input.sameDemandRepeat || input.pushyRepeat)
  ) {
    return "ASSERTIVE";
  }
  return current;
}

function intentRepeated(intent: Intent, lastIntents: Intent[]): boolean {
  const recent = lastIntents.slice(-3);
  return recent.includes(intent);
}

function intentRepeatedCount(intent: Intent, lastIntents: Intent[]): number {
  return lastIntents.filter((i) => i === intent).length;
}

function pickNextIntent(input: PlannerInput): Intent {
  const asked = input.askedQuestions;
  const extracted = input.extracted;
  const normalized = normalizeText(input.lastScammerMessage);

  const burned = new Set<Intent>(asked as unknown as Set<Intent>);
  const allIntents: Intent[] = [
    "ask_ticket_or_case_id",
    "ask_branch_city",
    "ask_department_name",
    "ask_employee_id",
    "ask_designation",
    "ask_callback_number",
    "ask_escalation_authority",
    "ask_transaction_amount_time",
    "ask_transaction_mode",
    "ask_merchant_receiver",
    "ask_device_type",
    "ask_login_location",
    "ask_ip_or_reason",
    "ask_otp_reason",
    "ask_no_notification_reason",
    "ask_internal_system",
    "ask_phone_numbers",
    "ask_sender_id_or_email",
    "ask_links",
    "ask_upi_or_beneficiary",
    "ask_names_used",
    "ask_keywords_used"
  ];

  for (const intent of allIntents) {
    if (intentRepeatedCount(intent, input.lastIntents) >= 1) burned.add(intent);
  }

  if (extracted.caseIds.length > 0) burned.add("ask_ticket_or_case_id");
  if (input.refusedCaseId) burned.add("ask_ticket_or_case_id");
  if (extracted.employeeIds.length > 0) burned.add("ask_employee_id");
  if (extracted.upiIds.length > 0) burned.add("ask_upi_or_beneficiary");

  const forceUpi = /(pay|transfer|send money|send cash|payment)/.test(normalized);
  const forceEmployee = /(verification|kyc)/.test(normalized);

  if (forceUpi && !burned.has("ask_upi_or_beneficiary")) return "ask_upi_or_beneficiary";
  if (forceEmployee && !burned.has("ask_employee_id")) return "ask_employee_id";

  if (input.repeatDemand) {
    const priority: Intent[] = [
      "ask_links",
      "ask_callback_number",
      "ask_sender_id_or_email",
      "ask_upi_or_beneficiary",
      "ask_merchant_receiver",
      "ask_employee_id",
      "ask_department_name",
      "ask_branch_city",
      "ask_ticket_or_case_id"
    ];
    for (const intent of priority) {
      if (burned.has(intent)) continue;
      if (intent === "ask_links" && extracted.phishingLinks.length > 0) continue;
      if (intent === "ask_upi_or_beneficiary" && extracted.upiIds.length > 0) continue;
      if (intent === "ask_callback_number" && extracted.phoneNumbers.length > 0) continue;
      return intent;
    }
  }

  const ladder: Intent[] = [
    "ask_ticket_or_case_id",
    "ask_branch_city",
    "ask_department_name",
    "ask_employee_id",
    "ask_designation",
    "ask_callback_number",
    "ask_escalation_authority",
    "ask_transaction_amount_time",
    "ask_transaction_mode",
    "ask_merchant_receiver",
    "ask_device_type",
    "ask_login_location",
    "ask_ip_or_reason",
    "ask_otp_reason",
    "ask_no_notification_reason",
    "ask_internal_system",
    "ask_phone_numbers",
    "ask_sender_id_or_email",
    "ask_links",
    "ask_upi_or_beneficiary",
    "ask_names_used",
    "ask_keywords_used"
  ];

  for (const intent of ladder) {
    if (burned.has(intent)) continue;
    if (intent === "ask_ticket_or_case_id" && extracted.caseIds.length > 0) continue;
    if (intent === "ask_links" && extracted.phishingLinks.length > 0) continue;
    if (intent === "ask_upi_or_beneficiary" && extracted.upiIds.length > 0) continue;
    if (intent === "ask_phone_numbers" && (extracted.phoneNumbers.length > 0 || extracted.tollFreeNumbers.length > 0)) continue;
    if (intent === "ask_callback_number" && (extracted.phoneNumbers.length > 0 || extracted.tollFreeNumbers.length > 0)) continue;
    if (intent === "ask_employee_id" && extracted.employeeIds.length > 0) continue;
    if (intent === "ask_sender_id_or_email" && extracted.senderIds.length > 0) continue;
    if (asked.has(intent)) continue;
    if (intentRepeated(intent, input.lastIntents)) continue;
    return intent;
  }

  return "ask_keywords_used";
}

export function planNext(input: PlannerInput): PlannerOutput {
  const { scamScore, stressScore, scamDetected, state, engagement } = input;
  let mode: SessionMode = scamDetected ? "SCAM_CONFIRMED" : "SAFE";
  if (!scamDetected && scamScore >= 0.45) mode = "SUSPECT";

  const updatedState: SessionState = {
    anxiety: clamp01(state.anxiety + (scamScore > 0.6 ? 0.1 : 0.02)),
    confusion: clamp01(state.confusion + (stressScore > 0.5 ? 0.08 : 0.02)),
    overwhelm: clamp01(state.overwhelm + (stressScore > 0.6 ? 0.06 : 0.01)),
    trustAuthority: clamp01(state.trustAuthority + (scamScore < 0.4 ? 0.03 : -0.01)),
    compliance: clamp01(state.compliance + (stressScore > 0.6 ? 0.01 : 0.005))
  };

  const nextSlot = pickNextIntent(input);

  const agentNotes = `mode=${mode}, scamScore=${scamScore.toFixed(2)}, stressScore=${stressScore.toFixed(
    2
  )}, slot=${nextSlot}, turns=${engagement.totalMessagesExchanged}`;

  return { nextSlot, mode, updatedState, scamDetected, agentNotes };
}

// Conversational Memory Planner (new)
export type NextIntent =
  | "ask_callback_number"
  | "ask_employee_id"
  | "ask_case_id"
  | "ask_upi"
  | "ask_branch"
  | "ask_department"
  | "ask_official_email";

export type PlannerResult = {
  intent: NextIntent;
  tone: "WARY" | "NEUTRAL";
  reason: string;
};

function mentionsUrgency(text: string): boolean {
  const t = text.toLowerCase();
  return /(urgent|immediately|blocked|suspended|asap)/.test(t);
}

export function planNextMemory(context: Context, lastMessage: string): PlannerResult {
  const forbidden = new Set<NextIntent>();

  if (context.extracted.phone) forbidden.add("ask_callback_number");
  if (context.extracted.id) forbidden.add("ask_employee_id");

  const tone: "WARY" | "NEUTRAL" = mentionsUrgency(lastMessage) ? "WARY" : "NEUTRAL";

  const candidates: Array<{ intent: NextIntent; reason: string }> = [
    { intent: "ask_employee_id", reason: "need_employee_id" },
    { intent: "ask_case_id", reason: "need_case_id" },
    { intent: "ask_upi", reason: "need_upi" },
    { intent: "ask_callback_number", reason: "need_callback" },
    { intent: "ask_official_email", reason: "need_official_email" },
    { intent: "ask_branch", reason: "need_branch" },
    { intent: "ask_department", reason: "need_department" }
  ];

  for (const c of candidates) {
    if (!forbidden.has(c.intent)) {
      return { intent: c.intent, tone, reason: c.reason };
    }
  }

  return { intent: "ask_case_id", tone, reason: "fallback" };
}
