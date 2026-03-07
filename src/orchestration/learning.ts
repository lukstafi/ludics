import type { OrchestrationState } from "./state.ts";
import { nowEpoch } from "./util.ts";

export function shouldRunUpdateDocs(state: OrchestrationState): boolean {
  const lastAt = state.lastLearningAt ?? 0;
  const lastRound = state.lastLearningRound ?? 0;
  const enoughTime = nowEpoch() - lastAt >= state.config.learningInterval;
  const enoughRounds = state.round - lastRound >= state.config.learningProductiveRoundsGap;
  return lastAt === 0 || enoughTime || enoughRounds;
}
