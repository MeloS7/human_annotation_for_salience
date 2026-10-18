export const STAGE_ONE_IDS = Object.freeze(["source_coverage", "readability", "faithfulness", "content_focus"]);
export const STAGE_TWO_IDS = Object.freeze(["reference_coverage"]);
const VALID_CHOICES = new Set(["A", "B", "Tie"]);

export function stageOf(task) {
  return Number(task?.stage) === 2 || Boolean(task?.locked_at) ? 2 : 1;
}

export function criteriaForStage(criteria, stage) {
  const allowed = new Set(stage === 1 ? STAGE_ONE_IDS : stage === 2 ? STAGE_TWO_IDS : []);
  return (Array.isArray(criteria) ? criteria : []).filter((criterion) =>
    Number(criterion.stage) === stage && allowed.has(criterion.id));
}

export function allStageChoicesPresent(task, answers) {
  const required = stageOf(task) === 1 ? STAGE_ONE_IDS : STAGE_TWO_IDS;
  return required.every((id) => VALID_CHOICES.has(answers?.[id]));
}

export function mayRequestReference(task) {
  return stageOf(task) === 2 && Boolean(task?.locked_at);
}
