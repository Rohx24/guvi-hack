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

export type PlannerInput = {
  scamScore: number;
  stressScore: number;
  state: SessionState;
  engagement: {
    totalMessagesExchanged: number;
  };
  extracted: ExtractedIntelligence;
  story: StorySummary;
  maxTurns: number;
};

export type PlannerOutput = {
  nextIntent:
    | "clarify_procedure"
    | "seek_reassurance"
    | "delay_busy"
    | "pretend_technical_issue"
    | "partial_comply_fake_info"
    | "request_link_or_upi"
    | "ask_for_official_id_softly";
  mode: SessionMode;
  updatedState: SessionState;
  scamDetected: boolean;
  agentNotes: string;
};

export function planNext(input: PlannerInput): PlannerOutput {
  const { scamScore, stressScore, state, engagement, extracted, story, maxTurns } = input;
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

  let nextIntent: PlannerOutput["nextIntent"] = "clarify_procedure";

  const needsUPI = extracted.upiIds.length === 0;
  const needsLink = extracted.phishingLinks.length === 0;
  const needsPhone = extracted.phoneNumbers.length === 0;

  if (needsUPI || needsLink || needsPhone) {
    nextIntent = "request_link_or_upi";
  }

  if (stressScore > 0.7) {
    nextIntent = "seek_reassurance";
  } else if (updatedState.anxiety > 0.7 && updatedState.confusion > 0.6) {
    nextIntent = "delay_busy";
  }

  if (scamDetected && updatedState.compliance > 0.55) {
    nextIntent = "partial_comply_fake_info";
  }

  if (scamDetected && story.scammerClaim.length < 5) {
    nextIntent = "clarify_procedure";
  }

  if (scamDetected && story.scammerClaim.length > 5 && story.scammerAsk.length < 5) {
    nextIntent = "ask_for_official_id_softly";
  }

  if (engagement.totalMessagesExchanged >= maxTurns) {
    mode = "COMPLETE";
  }

  const agentNotes = `mode=${mode}, scamScore=${scamScore.toFixed(2)}, stressScore=${stressScore.toFixed(2)}`;

  return { nextIntent, mode, updatedState, scamDetected, agentNotes };
}
