import { clamp01 } from "../utils/mask";
import { tacticSignals } from "./extractor";

export type Scores = {
  scamScore: number;
  stressScore: number;
  signals: ReturnType<typeof tacticSignals>;
};

export function computeScores(
  normalizedText: string,
  state: {
    anxiety: number;
    confusion: number;
    overwhelm: number;
    trustAuthority: number;
    compliance: number;
  }
): Scores {
  const signals = tacticSignals(normalizedText);

  const scamScore = clamp01(
    (signals.urgency + signals.authority + signals.threat + signals.credential + signals.payment) / 5
  );

  const stressScore = clamp01(
    (signals.urgency + signals.threat + state.anxiety + state.confusion + state.overwhelm) / 5
  );

  return { scamScore, stressScore, signals };
}
