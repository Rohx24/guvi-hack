import { clamp01 } from "../utils/mask";
import { ExtractedIntelligence } from "./extractor";

export type SessionState = {
  anxiety: number;
  confusion: number;
  overwhelm: number;
  trustAuthority: number;
  compliance: number;
};

export type SessionMode = "SAFE" | "SUSPECT" | "SCAM_CONFIRMED" | "COMPLETE";

export type StorySummary = {
  scamType: string;
  scammerClaim: string;
  scammerAsk: string;
};

export type Intent =
  | "clarify_procedure"
  | "seek_reassurance"
  | "delay_busy"
  | "pretend_technical_issue"
  | "partial_comply_fake_info"
  | "request_link_or_upi"
  | "ask_for_official_id_softly";

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
  linkPressure: boolean;
  engagement: {
    totalMessagesExchanged: number;
  };
  extracted: ExtractedIntelligence;
  story: StorySummary;
  maxTurns: number;
  goalFlags: GoalFlags;
  lastIntents: Intent[];
};

export type PlannerOutput = {
  nextIntent: Intent;
  mode: SessionMode;
  updatedState: SessionState;
  scamDetected: boolean;
  agentNotes: string;
};

function intentRepeated(intent: Intent, lastIntents: Intent[]): boolean {
  const recent = lastIntents.slice(-4);
  const count = recent.filter((item) => item === intent).length;
  return count >= 2;
}

function lastTwoSame(lastIntents: Intent[]): boolean {
  if (lastIntents.length < 2) return false;
  const a = lastIntents[lastIntents.length - 1];
  const b = lastIntents[lastIntents.length - 2];
  return a === b;
}

function pickAlternateIntent(
  preferred: Intent[],
  lastIntents: Intent[],
  disallow: Set<Intent>
): Intent {
  for (const intent of preferred) {
    if (!disallow.has(intent) && !intentRepeated(intent, lastIntents)) {
      return intent;
    }
  }
  for (const intent of preferred) {
    if (!disallow.has(intent)) {
      return intent;
    }
  }
  return "clarify_procedure";
}

export function planNext(input: PlannerInput): PlannerOutput {
  const {
    scamScore,
    stressScore,
    scamDetected,
    state,
    engagement,
    story,
    goalFlags,
    lastIntents,
    extracted,
    linkPressure
  } = input;
  let mode: SessionMode = scamDetected ? "SCAM_CONFIRMED" : "SAFE";
  if (!scamDetected && scamScore >= 0.45) mode = "SUSPECT";

  const updatedState: SessionState = {
    anxiety: clamp01(state.anxiety + (scamScore > 0.6 ? 0.1 : 0.02)),
    confusion: clamp01(state.confusion + (stressScore > 0.5 ? 0.1 : 0.02)),
    overwhelm: clamp01(state.overwhelm + (stressScore > 0.6 ? 0.08 : 0.01)),
    trustAuthority: clamp01(state.trustAuthority + (scamScore < 0.4 ? 0.05 : -0.02)),
    compliance: clamp01(state.compliance + (stressScore > 0.6 ? 0.02 : 0.01))
  };

  let nextIntent: Intent = "clarify_procedure";

  const disallow = new Set<Intent>();

  if (goalFlags.gotUpiId || goalFlags.gotPaymentLink || goalFlags.gotBankAccountLikeDigits) {
    disallow.add("request_link_or_upi");
  }

  const earlyTurns = engagement.totalMessagesExchanged <= 2;

  if (earlyTurns) {
    nextIntent = stressScore > 0.6 ? "seek_reassurance" : "clarify_procedure";
  }

  if (goalFlags.gotUpiId || goalFlags.gotPaymentLink || goalFlags.gotBankAccountLikeDigits) {
    if (stressScore > 0.7) {
      nextIntent = "seek_reassurance";
    } else if (updatedState.confusion > 0.6) {
      nextIntent = "clarify_procedure";
    } else {
      nextIntent = "pretend_technical_issue";
    }
  }

  if (scamDetected && updatedState.compliance > 0.55 && goalFlags.gotExplicitOtpAsk) {
    nextIntent = "partial_comply_fake_info";
  }

  if (scamDetected && story.scammerClaim.length < 5) {
    nextIntent = "clarify_procedure";
  }

  if (scamDetected && story.scammerClaim.length > 5 && story.scammerAsk.length < 5) {
    nextIntent = "ask_for_official_id_softly";
  }

  if (scamDetected && linkPressure) {
    nextIntent = "ask_for_official_id_softly";
  }

  if (lastTwoSame(lastIntents) || intentRepeated(nextIntent, lastIntents)) {
    const preferredFallbacks: Intent[] = [
      "pretend_technical_issue",
      "seek_reassurance",
      "delay_busy",
      "clarify_procedure",
      "ask_for_official_id_softly",
      "partial_comply_fake_info"
    ];
    nextIntent = pickAlternateIntent(preferredFallbacks, lastIntents, disallow);
  }

  if (disallow.has(nextIntent)) {
    const preferredFallbacks: Intent[] = [
      "pretend_technical_issue",
      "seek_reassurance",
      "delay_busy",
      "clarify_procedure",
      "ask_for_official_id_softly",
      "partial_comply_fake_info"
    ];
    nextIntent = pickAlternateIntent(preferredFallbacks, lastIntents, disallow);
  }

  const agentNotes = `mode=${mode}, scamScore=${scamScore.toFixed(2)}, stressScore=${stressScore.toFixed(2)}, intent=${nextIntent}`;

  return { nextIntent, mode, updatedState, scamDetected, agentNotes };
}
