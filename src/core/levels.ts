import type { EngagementSignals } from "./planner";

export type LevelInput = {
  currentLevel: number;
  scamScore: number;
  signals: EngagementSignals;
  newIntel: boolean;
  missingSlots: number;
};

export function computeNextLevel(input: LevelInput): number {
  let level = Math.max(0, Math.min(10, input.currentLevel));
  if (level === 0 && input.scamScore >= 0.45) level = 1;

  if (input.signals.sameDemandRepeat || input.signals.pushyRepeat) level += 1;
  if (input.signals.urgencyRepeat) level += 1;
  if (input.newIntel) level += 1;
  if (input.scamScore >= 0.75) level += 2;
  if (input.missingSlots >= 6) level += 1;

  if (level > 10) level = 10;
  return level;
}
