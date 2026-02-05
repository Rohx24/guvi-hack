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

  let scamScore = clamp01(
    (signals.urgency + signals.authority + signals.threat + signals.credential + signals.payment) / 5
  );

  const hasOtp = /(otp|pin|password|upi pin)/.test(normalizedText);
  const hasLink = /(http|https|bit\.ly|tinyurl|link)/.test(normalizedText);
  const hasUrgency = /(urgent|immediately|blocked|suspended|asap)/.test(normalizedText);
  const hasAccountAsk = /(account number|bank account|ifsc|card number)/.test(normalizedText);

  if (hasOtp) scamScore = Math.max(scamScore, 0.98);
  if (hasLink && hasUrgency) scamScore = Math.max(scamScore, 0.95);
  if (hasAccountAsk && hasUrgency) scamScore = Math.max(scamScore, 0.9);

  const stressScore = clamp01(
    (signals.urgency + signals.threat + state.anxiety + state.confusion + state.overwhelm) / 5
  );

  return { scamScore, stressScore, signals };
}
