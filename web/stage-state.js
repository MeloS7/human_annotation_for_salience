export const STAGE_ONE_IDS = Object.freeze(["source_coverage", "readability", "faithfulness", "content_focus"]);
export const STAGE_TWO_IDS = Object.freeze(["reference_coverage"]);
export const REQUIRED_STUDY_COUNT = 126;
export const REQUIRED_PRACTICE_COUNT = 2;
export const REQUIRED_QUALIFICATION_COUNT = 10;
export const QUALIFICATION_SCORED_TOTAL = 18;
export const QUALIFICATION_PASS_COUNT = 14;
export const QUALIFICATION_PROTOCOL = "qualification-required-v2";
export const QUALIFICATION_KEY_VERSION = "qualification-pilot-20261020-v1";
export const QUALIFICATION_KEY_STATUS = "human_confirmed_scored";
export const QUALIFICATION_CONFIRMED_SCORED_COUNT = 18;
export const WORKFLOW_VERSION = "qualification-required-20261101-v1";
export const QUALIFICATION_DIMENSION_IDS = Object.freeze([
  "source_coverage", "reference_coverage", "readability", "faithfulness", "content_focus",
]);
const VALID_CHOICES = new Set(["A", "B", "Tie"]);

function validTaskQueue(tasks, kind, expectedCount) {
  const selected = tasks.filter((task) => task?.kind === kind);
  if (selected.length !== expectedCount) return false;
  const positions = new Set();
  const ids = new Set();
  for (const task of selected) {
    if (typeof task.id !== "string" || !task.id || ids.has(task.id)) return false;
    const position = Number(task.position);
    if (!Number.isInteger(position) || position < 1 || position > expectedCount || positions.has(position)) return false;
    if (!["draft", "locked", "complete", "paused"].includes(task.status)) return false;
    positions.add(position);
    ids.add(task.id);
  }
  return positions.size === expectedCount;
}

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

export function qualificationAvailable(session) {
  const available = session?.qualification_available;
  return Boolean(available && typeof available === "object" && !Array.isArray(available) &&
    available.protocol === QUALIFICATION_PROTOCOL && typeof available.version === "string" && available.version.trim() &&
    available.key_status === QUALIFICATION_KEY_STATUS && available.required === REQUIRED_QUALIFICATION_COUNT &&
    available.scored_total === QUALIFICATION_SCORED_TOTAL && available.pass_count === QUALIFICATION_PASS_COUNT);
}

function validCompletedAt(value) {
  return typeof value === "string" && value.length > 0 && Number.isFinite(Date.parse(value));
}

export function qualificationProtocolReady(session) {
  const qualification = session?.qualification;
  const progress = session?.progress;
  const tasks = session?.tasks;
  if (session?.qualification_required !== true || session?.workflow_version !== WORKFLOW_VERSION ||
      typeof session?.workflow_guide_md !== "string" || !session.workflow_guide_md.trim() ||
      typeof session?.workflow_guide_sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(session.workflow_guide_sha256) ||
      !qualification || typeof qualification !== "object" || Array.isArray(qualification) ||
      qualification.protocol !== QUALIFICATION_PROTOCOL || typeof qualification.version !== "string" || !qualification.version.trim() ||
      qualification.version !== QUALIFICATION_KEY_VERSION || qualification.policy_version !== WORKFLOW_VERSION ||
      qualification.required_for_study !== true ||
      qualification.key_status !== QUALIFICATION_KEY_STATUS || qualification.required !== REQUIRED_QUALIFICATION_COUNT ||
      qualification.confirmed_scored_count !== QUALIFICATION_CONFIRMED_SCORED_COUNT ||
      qualification.scored_total !== QUALIFICATION_SCORED_TOTAL || qualification.pass_count !== QUALIFICATION_PASS_COUNT ||
      !Number.isInteger(qualification.completed) || qualification.completed < 0 || qualification.completed > REQUIRED_QUALIFICATION_COUNT ||
      !["in_progress", "passed", "failed"].includes(qualification.state) ||
      !progress || progress.study_total !== REQUIRED_STUDY_COUNT || progress.qualification_total !== REQUIRED_QUALIFICATION_COUNT ||
      progress.qualification_completed !== qualification.completed || progress.practice_total !== 0 ||
      progress.practice_completed !== 0 || progress.practice_requirement !== 0 ||
      !Number.isInteger(progress.study_completed) || progress.study_completed < 0 || progress.study_completed > REQUIRED_STUDY_COUNT ||
      !Number.isInteger(progress.paused) || progress.paused < 0 || progress.paused > REQUIRED_STUDY_COUNT + REQUIRED_QUALIFICATION_COUNT ||
      !Array.isArray(tasks) || tasks.length !== REQUIRED_STUDY_COUNT + REQUIRED_QUALIFICATION_COUNT) return false;

  if (!validTaskQueue(tasks, "study", REQUIRED_STUDY_COUNT) ||
      !validTaskQueue(tasks, "qualification", REQUIRED_QUALIFICATION_COUNT)) return false;
  if (tasks.some((task) => task.kind !== "study" && task.kind !== "qualification") ||
      new Set(tasks.map((task) => task.id)).size !== tasks.length ||
      tasks.filter((task) => task.status === "paused").length !== progress.paused) return false;
  if (tasks.filter((task) => task.kind === "study" && task.status === "complete").length !== progress.study_completed) return false;

  const qualificationTasks = tasks.filter((task) => task.kind === "qualification");
  const completedCount = qualificationTasks.filter((task) => task.status === "complete").length;
  if (completedCount !== qualification.completed) return false;

  if (qualification.completed < REQUIRED_QUALIFICATION_COUNT) {
    return qualification.state === "in_progress" && qualification.score === null && qualification.completed_at === null;
  }

  const score = qualification.score;
  if (!qualificationTasks.every((task) => task.status === "complete") ||
      !score || typeof score !== "object" || Array.isArray(score) ||
      !Number.isInteger(score.matched) || score.matched < 0 || score.matched > QUALIFICATION_SCORED_TOTAL ||
      score.total !== QUALIFICATION_SCORED_TOTAL || !validCompletedAt(qualification.completed_at)) return false;
  return qualification.state === (score.matched >= QUALIFICATION_PASS_COUNT ? "passed" : "failed");
}

export function hasQualificationProtocol(session) {
  return Boolean(session && Object.prototype.hasOwnProperty.call(session, "qualification"));
}

export function annotationProtocolReady(session) {
  return qualificationProtocolReady(session);
}

export function qualificationIsComplete(session) {
  return qualificationProtocolReady(session) && session.qualification.completed === REQUIRED_QUALIFICATION_COUNT;
}

export function studyGateOpen(session) {
  return qualificationProtocolReady(session) && session.qualification.state === "passed";
}

function percentageMatches(value, matched, total) {
  if (total === 0) return matched === 0 && value === null;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100 &&
    Math.abs(value - (total ? (100 * matched) / total : 0)) < 0.051;
}

export function qualificationResultsReady(results) {
  if (!results || typeof results !== "object" || Array.isArray(results) ||
      typeof results.version !== "string" || !results.version.trim() ||
      results.version !== QUALIFICATION_KEY_VERSION || results.policy_version !== WORKFLOW_VERSION ||
      results.confirmed_scored_count !== QUALIFICATION_CONFIRMED_SCORED_COUNT ||
      results.key_status !== QUALIFICATION_KEY_STATUS || !["passed", "failed"].includes(results.state) ||
      !Number.isInteger(results.matched) || results.matched < 0 || results.matched > QUALIFICATION_SCORED_TOTAL ||
      results.total !== QUALIFICATION_SCORED_TOTAL || results.pass_count !== QUALIFICATION_PASS_COUNT ||
      !percentageMatches(results.percent, results.matched, results.total) ||
      !validCompletedAt(results.evaluated_at)) return false;

  const overall = results.overall;
  if (!overall || typeof overall !== "object" || Array.isArray(overall) ||
      !Number.isInteger(overall.matched) || overall.matched < 0 || overall.matched > 50 || overall.total !== 50 ||
      !percentageMatches(overall.percent, overall.matched, overall.total)) return false;

  if (results.state !== (results.matched >= QUALIFICATION_PASS_COUNT ? "passed" : "failed") ||
      !Array.isArray(results.dimensions) || results.dimensions.length !== QUALIFICATION_DIMENSION_IDS.length ||
      !Array.isArray(results.items) || results.items.length !== REQUIRED_QUALIFICATION_COUNT) return false;

  const dimensions = new Map();
  for (const dimension of results.dimensions) {
    if (!dimension || typeof dimension !== "object" || Array.isArray(dimension) ||
        !QUALIFICATION_DIMENSION_IDS.includes(dimension.id) || dimensions.has(dimension.id) ||
        !Number.isInteger(dimension.scored_matched) || !Number.isInteger(dimension.scored_total) ||
        dimension.scored_matched < 0 || dimension.scored_total < dimension.scored_matched ||
        dimension.scored_total > REQUIRED_QUALIFICATION_COUNT ||
        !Number.isInteger(dimension.all_matched) || dimension.all_matched < 0 ||
        dimension.all_matched > REQUIRED_QUALIFICATION_COUNT || dimension.all_total !== REQUIRED_QUALIFICATION_COUNT ||
        !percentageMatches(dimension.scored_percent, dimension.scored_matched, dimension.scored_total) ||
        !percentageMatches(dimension.all_percent, dimension.all_matched, dimension.all_total)) return false;
    dimensions.set(dimension.id, dimension);
  }
  if (QUALIFICATION_DIMENSION_IDS.some((id) => !dimensions.has(id)) ||
      Array.from(dimensions.values()).reduce((sum, dimension) => sum + dimension.scored_total, 0) !== QUALIFICATION_SCORED_TOTAL ||
      Array.from(dimensions.values()).reduce((sum, dimension) => sum + dimension.scored_matched, 0) !== results.matched ||
      Array.from(dimensions.values()).reduce((sum, dimension) => sum + dimension.all_matched, 0) !== overall.matched) return false;

  const numbers = new Set();
  const taskIds = new Set();
  const allMatches = new Map(QUALIFICATION_DIMENSION_IDS.map((id) => [id, 0]));
  const scoredTotals = new Map(QUALIFICATION_DIMENSION_IDS.map((id) => [id, 0]));
  const scoredMatches = new Map(QUALIFICATION_DIMENSION_IDS.map((id) => [id, 0]));
  for (const item of results.items) {
    if (!item || typeof item !== "object" || Array.isArray(item) || typeof item.id !== "string" || !item.id ||
        taskIds.has(item.id) || !Number.isInteger(item.number) || item.number < 1 || item.number > REQUIRED_QUALIFICATION_COUNT ||
        numbers.has(item.number) || !["cnndm", "gumsum"].includes(item.dataset) ||
        typeof item.qualification_id !== "string" || !item.qualification_id.trim() ||
        typeof item.title_zh !== "string" || !item.title_zh.trim() ||
        !Array.isArray(item.dimensions) || item.dimensions.length !== QUALIFICATION_DIMENSION_IDS.length) return false;
    taskIds.add(item.id);
    numbers.add(item.number);
    const itemDimensions = new Set();
    for (const answer of item.dimensions) {
      if (!answer || typeof answer !== "object" || Array.isArray(answer) ||
          !QUALIFICATION_DIMENSION_IDS.includes(answer.id) || itemDimensions.has(answer.id) ||
          !VALID_CHOICES.has(answer.answer) || !VALID_CHOICES.has(answer.suggested) ||
          typeof answer.matches !== "boolean" || answer.matches !== (answer.answer === answer.suggested) ||
          typeof answer.scored !== "boolean" ||
          !(answer.rationale_zh === undefined || answer.rationale_zh === null || typeof answer.rationale_zh === "string")) return false;
      itemDimensions.add(answer.id);
      if (answer.matches) allMatches.set(answer.id, allMatches.get(answer.id) + 1);
      if (answer.scored) {
        scoredTotals.set(answer.id, scoredTotals.get(answer.id) + 1);
        if (answer.matches) scoredMatches.set(answer.id, scoredMatches.get(answer.id) + 1);
      }
    }
    if (QUALIFICATION_DIMENSION_IDS.some((id) => !itemDimensions.has(id))) return false;
  }
  if (numbers.size !== REQUIRED_QUALIFICATION_COUNT ||
      QUALIFICATION_DIMENSION_IDS.some((id) => allMatches.get(id) !== dimensions.get(id).all_matched ||
        scoredTotals.get(id) !== dimensions.get(id).scored_total || scoredMatches.get(id) !== dimensions.get(id).scored_matched)) return false;
  return true;
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
