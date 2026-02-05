import { clamp01 } from "../utils/mask";
import { ExtractedIntelligence, normalizeText } from "./extractor";

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
  | "ask_designation_and_branch"
  | "ask_official_callback_tollfree"
  | "ask_transaction_details"
  | "ask_device_location_details"
  | "ask_sender_id_or_email"
  | "ask_link_or_upi"
  | "ask_secure_process";

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
};

export type PlannerOutput = {
  nextIntent: Intent;
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
  const count = recent.filter((item) => item === intent).length;
  return count >= 1;
}

function pickNextIntent(input: PlannerInput): Intent {
  const asked = input.askedQuestions;
  const extracted = input.extracted;
  const ladder: Intent[] = [
    "ask_ticket_or_case_id",
    "ask_designation_and_branch",
    "ask_official_callback_tollfree",
    "ask_transaction_details",
    "ask_device_location_details",
    "ask_sender_id_or_email",
    "ask_link_or_upi",
    "ask_secure_process"
  ];

  const alreadyHasLinkOrUpi = extracted.phishingLinks.length > 0 || extracted.upiIds.length > 0;

  for (const intent of ladder) {
    if (intent === "ask_link_or_upi" && alreadyHasLinkOrUpi) continue;
    if (asked.has(intent)) continue;
    if (intentRepeated(intent, input.lastIntents)) continue;
    return intent;
  }

  return "ask_secure_process";
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

  const nextIntent = pickNextIntent(input);

  const agentNotes = `mode=${mode}, scamScore=${scamScore.toFixed(
    2
  )}, stressScore=${stressScore.toFixed(2)}, intent=${nextIntent}, turns=${
    engagement.totalMessagesExchanged
  }`;

  return { nextIntent, mode, updatedState, scamDetected, agentNotes };
}
