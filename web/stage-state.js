export const STAGE_ONE_IDS = Object.freeze(["source_coverage", "readability", "faithfulness", "content_focus"]);
export const STAGE_TWO_IDS = Object.freeze(["reference_coverage"]);
export const REQUIRED_STUDY_COUNT = 126;
export const REQUIRED_PRACTICE_COUNT = 2;
const VALID_CHOICES = new Set(["A", "B", "Tie"]);

export function practiceProtocolReady(session) {
  const progress = session?.progress;
  if (progress?.practice_requirement !== REQUIRED_PRACTICE_COUNT ||
      progress?.practice_total !== REQUIRED_PRACTICE_COUNT ||
      progress?.study_total !== REQUIRED_STUDY_COUNT ||
      !Array.isArray(session?.tasks) ||
      session.tasks.length !== REQUIRED_STUDY_COUNT + REQUIRED_PRACTICE_COUNT) return false;
  return session.tasks.filter((task) => task?.kind === "practice").length === REQUIRED_PRACTICE_COUNT &&
    session.tasks.filter((task) => task?.kind === "study").length === REQUIRED_STUDY_COUNT;
}

export function studyGateOpen(session) {
  if (!practiceProtocolReady(session) || session.progress.practice_completed !== REQUIRED_PRACTICE_COUNT) return false;
  return session.tasks.filter((task) => task?.kind === "practice").every((task) => task.status === "complete");
}

export function displayAssignmentNumber(task, allTasks) {
  const position = Number(task?.position);
  if (!Number.isInteger(position) || position < 1) return null;
  if (task.kind !== "practice") return position;

  const orderedPractice = (Array.isArray(allTasks) ? allTasks : [])
    .filter((candidate) => candidate?.kind === "practice" && typeof candidate.id === "string" && Number.isInteger(Number(candidate.position)) && Number(candidate.position) > 0)
    .slice()
    .sort((left, right) => Number(left.position) - Number(right.position) || left.id.localeCompare(right.id));
  const index = orderedPractice.findIndex((candidate) => candidate.id === task.id);
  return index === -1 ? null : index + 1;
}

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
