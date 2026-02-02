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
  | "ask_for_official_id_softly"
  | "confused_resistance";

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
  signals: {
    urgency: number;
    authority: number;
    threat: number;
    credential: number;
    payment: number;
  };
  state: SessionState;
  engagement: {
    totalMessagesExchanged: number;
  };
  extracted: ExtractedIntelligence;
  story: StorySummary;
  maxTurns: number;
  goalFlags: GoalFlags;
  lastIntents: Intent[];
  phase: "SHOCK" | "PUSHBACK" | "OVERWHELM" | "NEAR_COMPLY" | "EXIT";
  convictionToComply: number;
  askedVerification: boolean;
  lastFriction: string;
  normalizedText: string;
};

export type PlannerOutput = {
  nextIntent: Intent;
  mode: SessionMode;
  updatedState: SessionState;
  scamDetected: boolean;
  agentNotes: string;
  nextPhase: "SHOCK" | "PUSHBACK" | "OVERWHELM" | "NEAR_COMPLY" | "EXIT";
  nextConvictionToComply: number;
  nextAskedVerification: boolean;
  nextFriction: string;
};

function intentRepeated(intent: Intent, lastIntents: Intent[]): boolean {
  const recent = lastIntents.slice(-4);
  const count = recent.filter((item) => item === intent).length;
  return count >= 2;
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
    signals,
    state,
    engagement,
    extracted,
    story,
    maxTurns,
    goalFlags,
    lastIntents,
    phase,
    convictionToComply,
    askedVerification,
    lastFriction,
    normalizedText
  } = input;
  let mode: SessionMode = "SAFE";
  if (scamScore >= 0.75) mode = "SCAM_CONFIRMED";
  else if (scamScore >= 0.45) mode = "SUSPECT";

  const scamDetected = mode === "SCAM_CONFIRMED" || scamScore >= 0.7;

  const updatedState: SessionState = {
    anxiety: clamp01(state.anxiety + (scamScore > 0.6 ? 0.1 : 0.02)),
    confusion: clamp01(state.confusion + (stressScore > 0.5 ? 0.1 : 0.02)),
    overwhelm: clamp01(state.overwhelm + (stressScore > 0.6 ? 0.08 : 0.01)),
    trustAuthority: clamp01(state.trustAuthority + (scamScore < 0.4 ? 0.05 : -0.02)),
    compliance: clamp01(state.compliance + (stressScore > 0.6 ? 0.02 : 0.01))
  };

  let nextIntent: Intent = "clarify_procedure";
  let nextPhase = phase;
  let nextConviction = convictionToComply;
  let nextAskedVerification = askedVerification;
  let nextFriction = lastFriction || "otp_not_received";

  const needsUPI = !goalFlags.gotUpiId;
  const needsLink = !goalFlags.gotPaymentLink;
  const needsPhoneOrEmail = !goalFlags.gotPhoneOrEmail;
  const disallow = new Set<Intent>();

  if (goalFlags.gotUpiId || goalFlags.gotPaymentLink || goalFlags.gotBankAccountLikeDigits || goalFlags.gotPhoneOrEmail) {
    disallow.add("request_link_or_upi");
  }

  const earlyTurns = engagement.totalMessagesExchanged <= 2;
  const scammerAlreadySharedLinkOrUpi = goalFlags.gotUpiId || goalFlags.gotPaymentLink;

  const otpOrPinAsk = /otp|pin|password|cvv|account/i.test(normalizedText);
  const urgencyHit = signals.urgency + signals.threat > 0 ? 0.08 : 0;
  const authorityHit = signals.authority > 0 ? 0.05 : 0;
  const repeatedPressure = signals.credential > 0 ? 0.06 : 0;
  const inconsistencyHit = /otp.*pin|pin.*otp/i.test(normalizedText) ? 0.08 : 0;
  const directAccountAsk = /account number|bank account|card number/i.test(normalizedText) ? 0.08 : 0;
  const refusesCall = /no call|don't call|dont call|only chat|no call back/i.test(normalizedText) ? 0.06 : 0;
  const decreases = (otpOrPinAsk ? 0.08 : 0) + inconsistencyHit + directAccountAsk + refusesCall;

  nextConviction = clamp01(nextConviction + urgencyHit + authorityHit + repeatedPressure - decreases);

  if (earlyTurns) {
    if (!askedVerification) {
      nextIntent = "confused_resistance";
    } else {
      nextIntent = stressScore > 0.6 ? "seek_reassurance" : "clarify_procedure";
    }
  } else if (
    (needsUPI || needsLink || needsPhoneOrEmail) &&
    !disallow.has("request_link_or_upi") &&
    scammerAlreadySharedLinkOrUpi
  ) {
    nextIntent = "request_link_or_upi";
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

  if (!askedVerification && engagement.totalMessagesExchanged <= 4) {
    nextIntent = "confused_resistance";
  }

  const nearComplyAllowed =
    engagement.totalMessagesExchanged >= 4 &&
    stressScore > 0.6 &&
    nextConviction > 0.55 &&
    nextAskedVerification;

  if (nearComplyAllowed) {
    nextIntent = "partial_comply_fake_info";
  }

  if (phase === "PUSHBACK" && !nearComplyAllowed && !earlyTurns) {
    nextIntent = "confused_resistance";
  }

  if (phase === "OVERWHELM" && !nearComplyAllowed) {
    nextIntent = stressScore > 0.7 ? "seek_reassurance" : "pretend_technical_issue";
  }

  if (
    engagement.totalMessagesExchanged >= maxTurns ||
    ((goalFlags.gotUpiId ||
      goalFlags.gotPaymentLink ||
      goalFlags.gotBankAccountLikeDigits ||
      goalFlags.gotPhoneOrEmail) &&
      engagement.totalMessagesExchanged >= 8)
  ) {
    mode = "COMPLETE";
    nextPhase = "EXIT";
  }

  if (earlyTurns && (nextIntent === "request_link_or_upi" || nextIntent === "partial_comply_fake_info")) {
    nextIntent = "clarify_procedure";
  }

  if (intentRepeated(nextIntent, lastIntents)) {
    const preferredFallbacks: Intent[] = [
      "confused_resistance",
      "pretend_technical_issue",
      "seek_reassurance",
      "delay_busy",
      "clarify_procedure",
      "ask_for_official_id_softly",
      "partial_comply_fake_info",
      "request_link_or_upi"
    ];
    nextIntent = pickAlternateIntent(preferredFallbacks, lastIntents, disallow);
  }

  if (disallow.has(nextIntent)) {
    const preferredFallbacks: Intent[] = [
      "confused_resistance",
      "pretend_technical_issue",
      "seek_reassurance",
      "delay_busy",
      "clarify_procedure",
      "ask_for_official_id_softly",
      "partial_comply_fake_info"
    ];
    nextIntent = pickAlternateIntent(preferredFallbacks, lastIntents, disallow);
  }

  if (nextIntent === "confused_resistance" || nextIntent === "ask_for_official_id_softly") {
    nextAskedVerification = true;
  }

  if (nextPhase === "EXIT") {
    nextIntent = "delay_busy";
  } else if (engagement.totalMessagesExchanged <= 1) {
    nextPhase = "SHOCK";
  } else if (nearComplyAllowed) {
    nextPhase = "NEAR_COMPLY";
  } else if (stressScore > 0.7 || updatedState.overwhelm > 0.6) {
    nextPhase = "OVERWHELM";
  } else if (!nextAskedVerification) {
    nextPhase = "PUSHBACK";
  } else {
    nextPhase = "OVERWHELM";
  }

  if (nextPhase === "OVERWHELM") {
    const frictionOrder = ["otp_not_received", "name_mismatch", "pin_forgot", "app_crash", "server_down"];
    const idx = Math.max(0, frictionOrder.indexOf(nextFriction));
    nextFriction = frictionOrder[(idx + 1) % frictionOrder.length];
  }

  const agentNotes = `mode=${mode}, phase=${nextPhase}, conviction=${nextConviction.toFixed(
    2
  )}, scamScore=${scamScore.toFixed(2)}, stressScore=${stressScore.toFixed(2)}, intent=${nextIntent}`;

  return {
    nextIntent,
    mode,
    updatedState,
    scamDetected,
    agentNotes,
    nextPhase,
    nextConvictionToComply: nextConviction,
    nextAskedVerification,
    nextFriction
  };
}
