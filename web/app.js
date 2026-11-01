"use strict";

const $ = (id) => document.getElementById(id);
const {
  STAGE_ONE_IDS, QUALIFICATION_DIMENSION_IDS, QUALIFICATION_PASS_COUNT,
  QUALIFICATION_CONFIRMED_SCORED_COUNT,
  allStageChoicesPresent, annotationProtocolReady, criteriaForStage, displayAssignmentNumber,
  mayRequestReference, studyAllocationInfo, studyPackageFull,
  qualificationIsComplete, qualificationResultsReady, stageOf, studyGateOpen,
} = window.HumanPreferenceStageState;
let session = null;
let current = null;
let pendingRecoveryCode = null;
let pendingRecoveryUid = null;
let identityFrozen = false;
let activeKind = "study";
let busyDepth = 0;
let noticeTimer = null;
let searchMatches = [];
let searchPosition = -1;
let searchTruncated = false;
let sourceViewMode = "reading";
let qualificationResults = null;
let qualificationResultsError = null;

class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function api(path, payload, expectedUid = undefined) {
  const backend = window.HumanAnnotationBackend;
  if (!backend) throw new ApiError(503, "The annotation service has not finished loading.");
  const command = backend.mapRequest(path, payload);
  return backend.request(command.action, command.taskId, command.payload, expectedUid === undefined ? undefined : { expectedUid });
}

function taskResult(data) { return data.task || data; }
function showNotice(message, error = false) {
  clearTimeout(noticeTimer);
  $("notice").textContent = message;
  $("notice").classList.toggle("error", error);
  $("notice").hidden = false;
  noticeTimer = setTimeout(() => { $("notice").hidden = true; }, error ? 15000 : 6500);
}
function showError(error) {
  if (error && error.code === "IDENTITY_CHANGED") freezeWorkspace(error.message);
  showNotice(error.message || "Something went wrong. Please try again.", true);
}
function run(callback) { Promise.resolve().then(callback).catch(showError); }
async function busy(callback) {
  busyDepth += 1;
  updateControls();
  try { return await callback(); }
  finally { busyDepth -= 1; updateControls(); }
}
function readOnly(ctx = current) { return !ctx || ctx.task.status === "complete" || ctx.task.status === "paused"; }
function taskPath(id, suffix = "") { return `/api/task/${encodeURIComponent(id)}${suffix}`; }
function preferencesFor(stage) { return criteriaForStage(session?.rubric?.criteria, stage); }
function studyReady() { return studyGateOpen(session); }
function fixedPackageFull() { return studyPackageFull(session); }
function qualificationActive() { return session?.qualification_required === true; }
function protocolReady() { return annotationProtocolReady(session); }
function initialQueueKind() {
  if (fixedPackageFull()) return "study";
  return studyReady() ? "study" : "qualification";
}
function showView(id) {
  for (const view of ["login-view", "recovery-view", "recovery-pending-view", "maintenance-view", "intro-view", "workspace"]) $(view).hidden = view !== id;
}
function clearQualificationResults() {
  qualificationResults = null;
  qualificationResultsError = null;
  const panel = $("qualification-results-panel");
  if (panel) panel.hidden = true;
  const summary = $("qualification-results-summary");
  if (summary) summary.textContent = "";
  const table = $("qualification-results-table");
  if (table) table.replaceChildren();
  const items = $("qualification-items");
  if (items) items.replaceChildren();
  const dialog = $("qualification-result-dialog");
  if (dialog?.open) dialog.close();
}

function showProtocolUpdateRequired() {
  current = null;
  clearComparison();
  $("task-list").replaceChildren();
  $("maintenance-message").textContent = "The server has not confirmed a supported annotation setup for this version. Your saved progress is preserved, but annotation is paused until the coordinator updates the study setup.";
  showView("maintenance-view");
}

function taskDisplayLabel(task) {
  const number = displayAssignmentNumber(task, session?.tasks);
  if (task.kind === "qualification") return number === null ? "Qualification" : `Qualification ${number}`;
  return number === null ? "Comparison" : `Comparison ${String(number).padStart(3, "0")}`;
}

function appendInline(parent, text) {
  const fragments = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  for (const fragment of fragments) {
    if (fragment.startsWith("**") && fragment.endsWith("**")) {
      const strong = document.createElement("strong"); strong.textContent = fragment.slice(2, -2); parent.append(strong);
    } else if (fragment.startsWith("`") && fragment.endsWith("`")) {
      const code = document.createElement("code"); code.textContent = fragment.slice(1, -1); parent.append(code);
    } else parent.append(document.createTextNode(fragment));
  }
}

// Render only the small, safe Markdown subset used by the local guide.
// Raw HTML and links in source material are never interpreted as markup.
function renderGuide(target, text) {
  target.replaceChildren();
  const blocks = text.replace(/\r\n/g, "\n").split(/\n\s*\n/);
  for (const block of blocks) {
    if (!block.trim()) continue;
    const heading = /^(#{1,3}) (.+)$/.exec(block.trim());
    if (heading) {
      const node = document.createElement(`h${heading[1].length}`); appendInline(node, heading[2]); target.append(node);
    } else if (block.split("\n").every((line) => /^- /.test(line))) {
      const list = document.createElement("ul");
      for (const line of block.split("\n")) { const item = document.createElement("li"); appendInline(item, line.slice(2)); list.append(item); }
      target.append(list);
    } else {
      const paragraph = document.createElement("p"); appendInline(paragraph, block.replace(/\n/g, " ")); target.append(paragraph);
    }
  }
}

function showAccount() {
  const enrolled = Boolean(session && session.authenticated && session.enrolled);
  $("account-actions").hidden = !enrolled || identityFrozen;
  $("mode-badge").hidden = !enrolled || identityFrozen;
  $("mode-badge").textContent = "Private workspace";
  $("mode-badge").className = "badge";
  $("participant-label").textContent = enrolled ? String(session.display_name) : "";
}

function renderQualificationNotices() {
  const active = qualificationActive();
  const allocation = studyAllocationInfo(session);
  const studyTarget = allocation.studyTarget;
  const introNote = $("qualification-intro-note");
  if (introNote) {
    introNote.hidden = !active;
    introNote.textContent = !active ? "" : allocation.full
      ? `You passed the qualification, but all nine study packages have already been assigned. Please contact the study coordinator.`
      : allocation.mode === "legacy"
        ? `Complete 10 qualification comparisons first. Study comparisons unlock after at least ${QUALIFICATION_PASS_COUNT} of 18 human-confirmed judgments match. Your existing queue of ${studyTarget} study comparisons is preserved. The same five criteria and two-stage reference process apply.`
        : `Complete 10 qualification comparisons first. Study comparisons unlock after at least ${QUALIFICATION_PASS_COUNT} of 18 human-confirmed judgments match. You will then receive ${studyTarget} assigned study comparisons. The same five criteria and two-stage reference process apply.`;
  }
  const workspaceNote = $("qualification-workspace-note");
  if (workspaceNote) {
    workspaceNote.hidden = !active || qualificationIsComplete(session);
    workspaceNote.textContent = active && !qualificationIsComplete(session)
      ? "Complete all 10 qualification comparisons. Your score and suggested labels stay hidden until then."
      : "";
  }
}

function freezeWorkspace(reason) {
  if (identityFrozen) return;
  identityFrozen = true;
  if (current) clearTimeout(current.timer);
  showAccount();
  document.body.classList.add("identity-frozen");
  $("identity-changed-dialog").showModal();
  $("identity-reload").setAttribute("aria-label", reason || "Reload with the participant currently active in this browser");
  updateControls();
}

function showRecoveryConfirmation(uid, code) {
  pendingRecoveryUid = uid;
  pendingRecoveryCode = code;
  $("account-actions").hidden = true;
  $("mode-badge").hidden = true;
  $("recovery-code-display").textContent = code;
  $("recovery-saved-check").checked = false;
  $("continue-after-recovery").disabled = true;
  showView("recovery-view");
}

function downloadRecoveryCode() {
  if (!pendingRecoveryCode) throw new ApiError(409, "No confirmed recovery code is available to download.");
  const contents = `Private annotation recovery code\n\n${pendingRecoveryCode}\n\nKeep this code private. Anyone with it can recover this annotation workspace.\n`;
  const blob = new Blob([contents], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "private-annotation-recovery-code.txt";
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function refreshSession() {
  const nextSession = await api("/api/session");
  if (session?.participant_id && session.participant_id !== nextSession?.participant_id) {
    clearQualificationResults();
  }
  session = nextSession;
  showAccount();
  if (!session.authenticated || !session.enrolled) {
    clearQualificationResults();
    current = null;
    clearComparison();
    $("entry-status").textContent = session.authenticated
      ? "This browser has a private anonymous session but no annotation workspace yet. Start a new workspace or recover existing progress."
      : "Start a workspace with a nickname, or recover existing progress with your private recovery code.";
    showView("login-view");
    return;
  }
  const backend = window.HumanAnnotationBackend;
  const uid = await backend.identityUid();
  const pending = backend.pendingRecovery(uid);
  if (pending) {
    pendingRecoveryUid = uid;
    pendingRecoveryCode = pending.code;
    if (pending.phase === "requesting" && pending.purpose === "rotate_recovery") {
      try {
        await api("/api/rotate-recovery", { new_recovery_code: pending.code }, uid);
        backend.setPendingRecoveryPhase(uid, pending.code, "confirmation");
      } catch (error) {
        if (error && error.code === "IDENTITY_CHANGED") throw error;
        $("recovery-pending-message").textContent = "The replacement code has not yet been confirmed by the service. Keep this browser open and retry; your previous recovery code may already have been replaced.";
        showView("recovery-pending-view");
        return;
      }
    } else if (pending.phase === "requesting") {
      // The server session proves that an enrollment/recovery committed even
      // if the browser lost the original response.
      backend.setPendingRecoveryPhase(uid, pending.code, "confirmation");
    }
    showRecoveryConfirmation(uid, pending.code);
    return;
  }
  if (!protocolReady()) {
    showProtocolUpdateRequired();
    return;
  }
  renderGuide($("intro-guide"), session.workflow_guide_md || "");
  renderGuide($("dialog-guide"), session.workflow_guide_md || "");
  renderQualificationNotices();
  if (!session.accepted_instructions) { showView("intro-view"); return; }
  showView("workspace");
  renderQueue();
}

const QUALIFICATION_LABELS = Object.freeze({
  source_coverage: "Source coverage",
  reference_coverage: "Reference coverage",
  readability: "Readability",
  faithfulness: "Faithfulness",
  content_focus: "Content focus",
});

function showQualificationOutcome(state, matched, total) {
  const passed = state === "passed";
  const packageFull = passed && fixedPackageFull();
  $("qualification-result-heading").textContent = passed ? "Qualification passed" : "Qualification not passed";
  $("qualification-result-summary").textContent = passed
    ? packageFull
      ? `You matched ${matched} of ${total} human-confirmed judgments and passed. All nine study packages have already been assigned. Please contact the study coordinator; no additional tasks have been opened.`
      : `You matched ${matched} of ${total} human-confirmed judgments. At least ${QUALIFICATION_PASS_COUNT} matches are required to continue to the study.`
    : `You matched ${matched} of ${total} human-confirmed judgments. At least ${QUALIFICATION_PASS_COUNT} matches are required to continue, so study comparisons remain locked.`;
  $("qualification-continue-study").hidden = !passed || packageFull;
  if (!$("qualification-result-dialog").open) $("qualification-result-dialog").showModal();
}

function appendResultCell(row, text, tag = "td") {
  const cell = document.createElement(tag);
  cell.textContent = String(text);
  row.append(cell);
  return cell;
}

function scrollQualificationResultsHeadingIntoView() {
  const panel = $("qualification-results-panel");
  const heading = $("qualification-results-heading");
  if (!panel?.hidden && heading) heading.scrollIntoView({ block: "start", behavior: "instant" });
}

function renderQualificationResultsPanel(results = null, error = null) {
  const panel = $("qualification-results-panel");
  panel.hidden = false;
  $("qualification-results-table").replaceChildren();
  $("qualification-items").replaceChildren();
  $("qualification-results-retry").hidden = !error;
  $("qualification-results-download").hidden = !results;
  $("qualification-continue-study-panel").hidden = !(results?.state === "passed") || fixedPackageFull();

  if (!results) {
    $("qualification-results-summary").textContent = error
      ? "All 10 qualification comparisons are saved, but the result breakdown could not be loaded. Retry to retrieve the comparison; do not repeat completed tasks."
      : "Loading your qualification comparison…";
    scrollQualificationResultsHeadingIntoView();
    return;
  }

  const passed = results.state === "passed";
  const packageFull = passed && fixedPackageFull();
  $("qualification-results-summary").textContent = `${passed ? "Passed" : "Not passed"}: ${results.matched} of ${results.total} human-confirmed judgments matched. ${packageFull ? "All nine study packages have already been assigned; please contact the study coordinator." : `At least ${results.pass_count} are required to continue to the study.`} The other 32 AI suggestions are shown for exploration and do not affect the qualification result.`;
  const table = $("qualification-results-table");
  const header = document.createElement("tr");
  for (const label of ["Dimension", "Confirmed labels (counted)", "All judgments (incl. 32 exploratory)"]) appendResultCell(header, label, "th");
  table.append(header);
  for (const id of QUALIFICATION_DIMENSION_IDS) {
    const dimension = results.dimensions.find((entry) => entry.id === id);
    const row = document.createElement("tr");
    appendResultCell(row, QUALIFICATION_LABELS[id]);
    const scoredPercent = dimension.scored_percent === null ? "n/a" : `${dimension.scored_percent.toFixed(1)}%`;
    appendResultCell(row, `${dimension.scored_matched}/${dimension.scored_total} (${scoredPercent})`);
    appendResultCell(row, `${dimension.all_matched}/${dimension.all_total} (${dimension.all_percent.toFixed(1)}%)`);
    table.append(row);
  }
  const overallRow = document.createElement("tr");
  appendResultCell(overallRow, "All five dimensions");
  appendResultCell(overallRow, `${results.matched}/${results.total} (${results.percent.toFixed(1)}%)`);
  appendResultCell(overallRow, `${results.overall.matched}/${results.overall.total} (${results.overall.percent.toFixed(1)}%)`);
  table.append(overallRow);

  const items = $("qualification-items");
  for (const item of [...results.items].sort((left, right) => left.number - right.number)) {
    const details = document.createElement("details");
    details.className = "qualification-item-result";
    const summary = document.createElement("summary");
    summary.textContent = `Q${String(item.number).padStart(2, "0")} · ${item.dataset === "cnndm" ? "CNN/DM" : "GUMSum"} · ${item.title_zh}`;
    details.append(summary);
    const list = document.createElement("ul");
    for (const dimension of [...item.dimensions].sort((left, right) => QUALIFICATION_DIMENSION_IDS.indexOf(left.id) - QUALIFICATION_DIMENSION_IDS.indexOf(right.id))) {
      const line = document.createElement("li");
      const status = dimension.scored ? (dimension.matches ? "Counted · matched" : "Counted · did not match") : (dimension.matches ? "Exploratory · matched" : "Exploratory · did not match");
      const labelType = dimension.scored ? "human-confirmed label" : "exploratory AI suggestion";
      const prefix = `${QUALIFICATION_LABELS[dimension.id]} — your choice: ${dimension.answer}; ${labelType}: ${dimension.suggested}; ${status}.`;
      line.append(document.createTextNode(prefix));
      if (typeof dimension.rationale_zh === "string" && dimension.rationale_zh.trim()) {
        const rationale = document.createElement("span");
        rationale.className = "qualification-rationale";
        rationale.textContent = ` AI-suggested rationale: ${dimension.rationale_zh}`;
        line.append(rationale);
      }
      list.append(line);
    }
    details.append(list);
    items.append(details);
  }
  scrollQualificationResultsHeadingIntoView();
}

async function loadQualificationResults({ notify = false } = {}) {
  if (!qualificationIsComplete(session)) throw new ApiError(409, "Finish all 10 qualification comparisons before viewing the result.");
  const expectedUid = await window.HumanAnnotationBackend.identityUid();
  if (!expectedUid) throw new ApiError(401, "Your private sign-in is unavailable. Keep this page open and retry.");
  try {
    const results = await api("/api/qualification-results", undefined, expectedUid);
    if (!qualificationResultsReady(results) || results.version !== session.qualification.version ||
        results.policy_version !== session.workflow_version ||
        results.confirmed_scored_count !== QUALIFICATION_CONFIRMED_SCORED_COUNT ||
        results.state !== session.qualification.state || results.matched !== session.qualification.score?.matched) {
      throw new ApiError(502, "The qualification service returned an incomplete or inconsistent result. Your saved answers are unchanged; contact the coordinator before continuing.");
    }
    qualificationResults = results;
    qualificationResultsError = null;
    renderQualificationResultsPanel(results);
    if (notify) showQualificationOutcome(results.state, results.matched, results.total);
    return results;
  } catch (error) {
    qualificationResultsError = error;
    renderQualificationResultsPanel(null, error);
    if (notify && Number.isInteger(session.qualification.score?.matched)) {
      showQualificationOutcome(session.qualification.state, session.qualification.score.matched, session.qualification.score.total);
    }
    throw error;
  }
}

async function showQualificationResults({ notify = false } = {}) {
  // Results can be opened from the workspace while a study comparison is
  // active. Finish its debounced save before replacing that view.
  await flushSave();
  current = null;
  clearComparison();
  $("empty-state").hidden = true;
  $("qualification-results-panel").hidden = false;
  if (qualificationResults) {
    renderQualificationResultsPanel(qualificationResults);
    if (notify) showQualificationOutcome(qualificationResults.state, qualificationResults.matched, qualificationResults.total);
    return qualificationResults;
  }
  renderQualificationResultsPanel(null, qualificationResultsError);
  return loadQualificationResults({ notify });
}

async function downloadQualificationResults() {
  if (!qualificationResults || !qualificationIsComplete(session)) {
    await loadQualificationResults();
  }
  if (!qualificationResults) return;
  const blob = new Blob([JSON.stringify(qualificationResults, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `qualification-${session.participant_id}.json`;
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function queueTasks() { return session.tasks.filter((task) => task.kind === activeKind).sort((a, b) => a.position - b.position); }
function renderQueue() {
  if (!session || !session.authenticated || !session.accepted_instructions || !protocolReady()) return;
  const qualification = qualificationActive();
  $("qualification-tab").hidden = false;
  $("qualification-results-button").hidden = !qualificationIsComplete(session) || activeKind === "qualification";
  $("study-tab").classList.toggle("active", activeKind === "study");
  $("qualification-tab").classList.toggle("active", activeKind === "qualification");
  $("study-tab").setAttribute("aria-pressed", String(activeKind === "study"));
  $("qualification-tab").setAttribute("aria-pressed", String(activeKind === "qualification"));
  $("study-total").textContent = studyAllocationInfo(session).studyTarget;
  $("qualification-total").textContent = session.qualification.required;
  const tasks = queueTasks();
  const complete = tasks.filter((task) => task.status === "complete").length;
  const noStudyPackage = activeKind === "study" && fixedPackageFull();
  $("progress-label").textContent = noStudyPackage ? "No study package assigned" : `${complete} of ${tasks.length} completed`;
  $("progress-percent").textContent = noStudyPackage ? "—" : tasks.length ? `${Math.round(100 * complete / tasks.length)}%` : "0%";
  $("progress-bar").max = Math.max(1, tasks.length);
  $("progress-bar").value = complete;
  const qualificationComplete = qualification && qualificationIsComplete(session);
  $("resume-button").textContent = activeKind === "qualification"
    ? qualificationComplete ? "Review qualification result" : "Resume next qualification comparison"
    : "Resume next comparison";
  let queueNote;
  if (activeKind === "qualification") {
    queueNote = qualificationComplete
      ? "All 10 qualification comparisons are complete. Review your result."
      : "Your score and suggested labels remain hidden until all 10 comparisons are complete.";
  } else if (studyReady()) {
    queueNote = studyAllocationInfo(session).mode === "legacy"
      ? "Your existing 126-comparison queue is preserved so earlier answers and locked choices remain unchanged. You can resume your saved work."
      : qualificationComplete
      ? "Your qualification is passed. Study comparisons are ready to continue."
      : "Your answers and progress are private to this workspace.";
  } else if (fixedPackageFull()) {
    queueNote = "You passed qualification, but all nine study packages have been assigned. Contact the study coordinator.";
  } else {
    queueNote = "Pass the qualification before opening study comparisons.";
  }
  $("queue-note").textContent = queueNote;
  $("resume-button").disabled = busyDepth > 0 || identityFrozen || noStudyPackage;
  $("task-list").replaceChildren();
  for (const task of tasks) {
    if ($("unfinished-only").checked && task.status === "complete" && (!current || current.task.id !== task.id)) continue;
    const button = document.createElement("button");
    button.type = "button";
    button.className = `task-button${current && current.task.id === task.id ? " active" : ""}`;
    button.disabled = busyDepth > 0 || (activeKind === "study" && !studyReady());
    button.dataset.kind = activeKind;
    if (current && current.task.id === task.id) button.setAttribute("aria-current", "true");
    const dot = document.createElement("span"); dot.className = `task-dot ${task.status}`; dot.setAttribute("aria-hidden", "true");
    const label = document.createElement("span"); label.textContent = taskDisplayLabel(task);
    const status = document.createElement("span"); status.className = "task-small-status";
    status.textContent = task.status === "complete" ? "Done" : task.status === "paused" ? "Paused" : Number(task.stage) === 2 || task.status === "locked" ? "Stage 2" : "";
    button.append(dot, label, status);
    button.addEventListener("click", () => run(() => loadTask(task.id)));
    const row = document.createElement("div"); row.setAttribute("role", "listitem"); row.append(button);
    $("task-list").append(row);
  }
}

function clearComparison() {
  for (const id of ["source-text", "summary-a", "summary-b", "reference-text", "request-text", "criteria-form", "reference-guidance"]) $(id).replaceChildren();
  $("comparison-view").hidden = true;
  searchMatches = []; searchPosition = -1;
}
function emptyState(title, text, actionLabel = "", action = null) {
  clearComparison();
  $("qualification-results-panel").hidden = true;
  $("empty-state").hidden = false;
  $("empty-heading").textContent = title;
  $("empty-description").textContent = text;
  $("empty-action").hidden = !action;
  $("empty-action").textContent = actionLabel;
  $("empty-action").onclick = action ? () => run(action) : null;
}

async function selectKind(kind) {
  await busy(async () => {
    if (kind === "study" && !studyReady()) {
      if (fixedPackageFull()) {
        current = null;
        activeKind = "study";
        renderQueue();
        emptyState("No study package available", "You passed the qualification, but all nine study packages have been assigned. Your result and progress are preserved. Please contact the study coordinator.");
        return;
      }
      await flushSave();
      activeKind = "qualification";
      renderQueue();
      await resumeNext({ skipSave: true });
      return;
    }
    if (kind === "qualification" && qualificationIsComplete(session)) {
      if (qualificationActive()) {
        activeKind = "qualification";
        renderQueue();
        await showQualificationResults();
      }
      return;
    }
    if (kind !== "study" && kind !== "qualification") return;
    await flushSave();
    current = null;
    activeKind = kind;
    renderQueue();
    await resumeNext({ skipSave: true });
  });
}

async function resumeNext({ skipSave = false, afterCurrent = false } = {}) {
  if (!skipSave) await flushSave();
  if (!protocolReady()) { showProtocolUpdateRequired(); return; }
  if (activeKind === "study" && fixedPackageFull()) {
    current = null;
    emptyState("No study package available", "You passed the qualification, but all nine study packages have been assigned. Your result and progress are preserved. Please contact the study coordinator.");
    renderQueue();
    return;
  }
  if (activeKind === "study" && !studyReady()) {
    activeKind = "qualification";
    renderQueue();
    if (qualificationIsComplete(session)) return showQualificationResults();
    return resumeNext({ skipSave: true, afterCurrent });
  }
  if (activeKind === "qualification" && qualificationIsComplete(session)) {
    current = null;
    await showQualificationResults();
    renderQueue();
    return;
  }
  const tasks = queueTasks();
  const available = tasks.filter((task) => task.status !== "complete" && task.status !== "paused");
  const next = (afterCurrent && current ? available.find((task) => task.id !== current.task.id) : available[0]) || available[0];
  if (next) { await loadTask(next.id, { skipSave: true }); return; }
  current = null;
  if (activeKind === "qualification" && tasks.length && tasks.every((task) => task.status === "complete")) {
    await showQualificationResults();
  } else if (tasks.some((task) => task.status === "paused")) {
    emptyState("No unpaused comparisons remain", "The remaining comparisons have been reported for review. Your saved work is retained. You can download your responses or contact the study coordinator.");
  } else {
    emptyState("Your comparisons are complete", "Thank you for your careful work. Download your responses and send the file to the study coordinator.", "Download my responses", downloadResponses);
  }
  renderQueue();
}

async function loadTask(id, { skipSave = false } = {}) {
  if (current && current.task.id === id && !skipSave) return;
  const requestedTask = session?.tasks?.find((task) => task.id === id);
  if (!protocolReady()) { showProtocolUpdateRequired(); return; }
  if (requestedTask?.kind === "study" && !studyReady()) {
    activeKind = "qualification";
    if (qualificationIsComplete(session)) await showQualificationResults();
    else {
      renderQueue();
      await resumeNext();
    }
    return;
  }
  if (requestedTask?.kind === "qualification" && qualificationIsComplete(session)) {
    activeKind = "qualification";
    await showQualificationResults();
    return;
  }
  await busy(async () => {
    if (!skipSave) await flushSave();
    const authUid = await window.HumanAnnotationBackend.identityUid();
    if (!authUid) throw new ApiError(401, "Your private sign-in is unavailable. Keep this tab open and retry rather than starting a new workspace.");
    const task = taskResult(await api(taskPath(id), undefined, authUid));
    current = { task, authUid, answers: { ...(task.answers || {}) }, version: 0, savedVersion: 0, chain: Promise.resolve(), timer: null, error: null, conflict: false, reference: null, referenceLoaded: false };
    activeKind = task.kind;
    renderTask();
    renderQueue();
    if (stageOf(task) === 2) await loadReference(current);
    $("task-title").scrollIntoView({ block: "start", behavior: "instant" });
  });
}

async function loadReference(ctx) {
  if (!ctx || !mayRequestReference(ctx.task) || current !== ctx) return;
  $("reference-retry").hidden = true;
  $("reference-text").textContent = "Loading reference...";
  try {
    const data = await api(taskPath(ctx.task.id, "/reference"), undefined, ctx.authUid);
    if (current !== ctx) return;
    ctx.reference = data.reference;
    ctx.referenceLoaded = true;
    if (Number.isInteger(data.revision)) ctx.task.revision = data.revision;
    ctx.task.reference_released_at = data.reference_released_at;
    $("reference-text").textContent = ctx.reference;
  } catch (error) {
    if (current !== ctx) return;
    $("reference-text").textContent = "The reference has not loaded. Your first four answers remain locked. Please retry when the server is available.";
    $("reference-retry").hidden = false;
    showError(error);
  }
  updateControls();
}

function renderTask() {
  if (!current) return;
  const { task } = current;
  const stage = stageOf(task);
  $("qualification-results-panel").hidden = true;
  $("empty-state").hidden = true;
  $("comparison-view").hidden = false;
  $("task-kind").textContent = task.kind === "qualification" ? "Required qualification"
      : "Your independent assessment";
  $("task-title").textContent = taskDisplayLabel(task);
  $("task-state").textContent = task.status === "complete" ? "Completed · read only" : task.status === "paused" ? "Paused for review" : stage === 2 ? "First four answers locked" : "Reference not shown";
  $("task-state").className = `badge ${task.status === "complete" ? "complete" : task.status === "paused" ? "paused" : stage === 2 ? "locked" : ""}`;
  $("stage-one-step").classList.toggle("active", stage === 1);
  $("stage-one-step").classList.toggle("done", stage === 2);
  $("stage-two-step").classList.toggle("active", stage === 2);
  $("stage-message").textContent = stage === 1
    ? "Read the source and both summaries. Select one preference for each of the four criteria."
    : "Your first four answers have been saved and locked. Read the reference summary below and answer the reference-coverage question only. This answer may differ from your source-coverage answer.";
  $("request-text").textContent = task.request;
  $("source-search").value = "";
  renderSource();
  $("summary-a").textContent = task.summary_a;
  $("summary-b").textContent = task.summary_b;
  $("reference-panel").hidden = stage !== 2;
  $("reference-text").textContent = "";
  $("reference-guidance").hidden = stage !== 2;
  $("reference-guidance").textContent = stage === 2 ? session.rubric.reference_intro : "";
  $("paused-message").hidden = task.status !== "paused";
  renderSharedGuidance();
  renderCriteria();
  updateSaveState();
  updateControls();
}

function renderSharedGuidance() {
  const container = $("shared-guidance-copy");
  container.replaceChildren();
  for (const instruction of session.rubric.shared_instructions || []) {
    if (instruction.startsWith("You will read a source document")) continue;
    if (stageOf(current.task) === 2 && instruction.startsWith("Read the source document and the request")) continue;
    const paragraph = document.createElement("p"); paragraph.textContent = instruction; container.append(paragraph);
  }
  for (const choice of session.rubric.choices) {
    const paragraph = document.createElement("p");
    paragraph.textContent = `${choice.value}: ${choice.definition}`;
    container.append(paragraph);
  }
}

function renderCriteria() {
  const form = $("criteria-form");
  form.replaceChildren();
  for (const criterion of preferencesFor(stageOf(current.task))) {
    const fieldset = document.createElement("fieldset"); fieldset.className = "criterion";
    const legend = document.createElement("legend");
    const label = document.createElement("span"); label.className = "criterion-heading"; label.textContent = criterion.label;
    const question = document.createElement("span"); question.className = "criterion-question"; question.textContent = criterion.question;
    legend.append(label, question); fieldset.append(legend);
    const list = document.createElement("ul");
    for (const instruction of criterion.bullets) { const li = document.createElement("li"); li.textContent = instruction; list.append(li); }
    fieldset.append(list);
    const options = document.createElement("div"); options.className = "preference-options";
    for (const choice of session.rubric.choices) {
      const option = document.createElement("label"); option.className = "preference-choice";
      const input = document.createElement("input");
      input.type = "radio"; input.name = criterion.id; input.value = choice.value;
      input.checked = current.answers[criterion.id] === choice.value;
      input.setAttribute("aria-label", `${choice.value}: ${choice.definition}`);
      const text = document.createElement("span"); text.textContent = choice.value;
      option.title = choice.definition;
      input.addEventListener("change", () => onPreference(criterion.id, choice.value));
      option.append(input, text); options.append(option);
    }
    fieldset.append(options); form.append(fieldset);
  }
}

function onPreference(id, value) {
  if (!current || readOnly() || busyDepth > 0 || current.conflict) return;
  current.answers[id] = value;
  current.version += 1;
  current.error = null;
  updateSaveState();
  updateControls();
  const ctx = current;
  clearTimeout(ctx.timer);
  ctx.timer = setTimeout(() => { flushSave(ctx).catch(() => {}); }, 250);
}

async function flushSave(ctx = current) {
  if (!ctx || readOnly(ctx)) return;
  clearTimeout(ctx.timer);
  ctx.chain = ctx.chain.catch(() => {}).then(async () => {
    if (ctx.conflict) throw new ApiError(409, "This comparison was updated elsewhere. Reload its saved state before continuing.");
    while (ctx.savedVersion < ctx.version) {
      const version = ctx.version;
      const answers = { ...ctx.answers };
      ctx.error = null;
      if (current === ctx) updateSaveState(true);
      try {
        const data = taskResult(await api(taskPath(ctx.task.id, "/save"), { stage: stageOf(ctx.task), revision: ctx.task.revision, answers }, ctx.authUid));
        ctx.task = { ...ctx.task, ...data };
        ctx.savedVersion = version;
        ctx.error = null;
      } catch (error) {
        ctx.error = error;
        if (error.status === 409) ctx.conflict = true;
        if (current === ctx) { updateSaveState(); updateControls(); }
        throw error;
      }
    }
    if (current === ctx) { updateSaveState(); updateControls(); }
  });
  return ctx.chain;
}

function updateSaveState(inFlight = false) {
  if (!current) return;
  const dirty = current.savedVersion < current.version;
  $("save-dot").className = `save-dot${current.error ? " failed" : dirty || inFlight ? " pending" : ""}`;
  $("save-label").textContent = current.conflict ? "Updated elsewhere. Reload the saved state."
    : current.error ? "Not saved · keep this page open"
      : dirty || inFlight ? "Saving your preferences..."
        : current.task.status === "complete" ? "Submitted and saved to your private workspace" : "Saved to your private workspace";
  $("retry-save").hidden = !current.error || current.conflict;
  $("reload-state").hidden = !current.conflict;
}

function allAnswered() {
  return current && allStageChoicesPresent(current.task, current.answers);
}
function updateControls() {
  const disabled = busyDepth > 0 || identityFrozen;
  for (const id of ["enroll-button", "recover-button", "continue-after-recovery", "retry-recovery-operation", "instructions-button", "export-button", "rotate-recovery-button", "switch-participant-button", "qualification-results-button", "qualification-results-retry", "qualification-results-download", "qualification-continue-study-panel", "qualification-tab", "study-tab", "resume-button", "pause-button", "problem-button", "confirm-lock", "review-back", "problem-submit", "problem-cancel", "pause-download", "pause-resume", "reference-retry", "retry-save", "reload-state", "rotate-confirm", "switch-confirm", "qualification-result-close", "qualification-continue-study"]) if ($(id)) $(id).disabled = disabled;
  $("continue-after-recovery").disabled = disabled || !$("recovery-saved-check").checked;
  $("switch-confirm").disabled = disabled || !$("switch-recovery-check").checked;
  $("begin-button").disabled = disabled || !$("guide-ack").checked;
  $("resume-button").disabled = disabled || (activeKind === "study" && fixedPackageFull());
  for (const button of $("task-list").querySelectorAll("button")) {
    button.disabled = disabled || (button.dataset.kind === "study" && !studyReady());
  }
  if (identityFrozen) {
    for (const control of document.querySelectorAll("button, input, select, textarea")) {
      if (control.id !== "identity-reload") control.disabled = true;
    }
  }
  if (!current) return;
  const locked = disabled || readOnly() || current.conflict || (stageOf(current.task) === 2 && !current.referenceLoaded);
  for (const input of $("criteria-form").querySelectorAll("input")) input.disabled = locked;
  $("primary-action").textContent = readOnly() ? "Next comparison" : stageOf(current.task) === 1 ? "Review Stage 1" : "Submit comparison";
  $("primary-action").disabled = disabled || (!readOnly() && (!allAnswered() || current.conflict || (stageOf(current.task) === 2 && !current.referenceLoaded)));
}

async function reviewStageOne() {
  await busy(async () => {
    await flushSave();
    if (!allAnswered() || stageOf(current.task) !== 1) return;
    $("review-answers").replaceChildren();
    for (const criterion of preferencesFor(1)) {
      const row = document.createElement("div");
      const term = document.createElement("dt"); term.textContent = criterion.label;
      const value = document.createElement("dd"); value.textContent = current.answers[criterion.id];
      row.append(term, value); $("review-answers").append(row);
    }
    $("review-dialog").showModal();
  });
}

async function lockStageOne() {
  await busy(async () => {
    const ctx = current;
    await flushSave(ctx);
    const answers = Object.fromEntries(STAGE_ONE_IDS.map((id) => [id, ctx.answers[id]]));
    await api(taskPath(ctx.task.id, "/lock"), { revision: ctx.task.revision, answers }, ctx.authUid);
    $("review-dialog").close();
    await refreshSession();
    await loadTask(ctx.task.id, { skipSave: true });
  });
}

async function completeComparison() {
  await busy(async () => {
    const ctx = current;
    const completedKind = ctx.task.kind;
    await flushSave(ctx);
    await api(taskPath(ctx.task.id, "/complete"), { revision: ctx.task.revision, answers: { reference_coverage: ctx.answers.reference_coverage } }, ctx.authUid);
    await refreshSession();
    current = null;
    if (completedKind === "qualification" && qualificationIsComplete(session)) {
      activeKind = "qualification";
      renderQueue();
      await showQualificationResults({ notify: true });
      return;
    }
    await resumeNext({ skipSave: true });
    showNotice("Comparison submitted. Your progress has been saved.");
  });
}

async function reportProblem() {
  if (!current) return;
  $("problem-category").value = "";
  const fieldset = $("problem-criteria");
  fieldset.replaceChildren();
  const legend = document.createElement("legend"); legend.textContent = "Affected criteria"; fieldset.append(legend);
  for (const criterion of session.rubric.criteria) {
    if (stageOf(current.task) === 1 && Number(criterion.stage) === 2) continue;
    const label = document.createElement("label");
    const input = document.createElement("input"); input.type = "checkbox"; input.value = criterion.id;
    label.append(input, document.createTextNode(` ${criterion.label}`)); fieldset.append(label);
  }
  $("problem-dialog").showModal();
}

async function submitProblem() {
  const category = $("problem-category").value;
  const criteria = Array.from($("problem-criteria").querySelectorAll("input:checked"), (input) => input.value);
  if (!category || criteria.length === 0) { showNotice("Select a problem category and at least one affected criterion.", true); return; }
  await busy(async () => {
    const ctx = current;
    await flushSave(ctx);
    await api(taskPath(ctx.task.id, "/problem"), { revision: ctx.task.revision, category, criteria }, ctx.authUid);
    $("problem-dialog").close();
    await refreshSession();
    current = null;
    await resumeNext({ skipSave: true });
    showNotice("Problem reported separately. Your existing saved answers have been retained.");
  });
}

async function saveAndPause() {
  await busy(async () => { await flushSave(); $("pause-dialog").showModal(); });
}

async function downloadResponses() {
  await busy(async () => {
    await flushSave();
    const authUid = await window.HumanAnnotationBackend.identityUid();
    if (!authUid) throw new ApiError(401, "Your private sign-in is unavailable. The responses were not downloaded.");
    const data = await api("/api/export", undefined, authUid);
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `summary-comparison-${session.mode}-${session.participant_id}.json`;
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
}

function updateSourceViewControls() {
  const reading = sourceViewMode === "reading";
  const originalSource = current && current.task.kind === "study"
    ? "the exact source text provided to the LLM judges"
    : "the unchanged stored source";
  $("source-reading-view").setAttribute("aria-pressed", String(reading));
  $("source-original-view").setAttribute("aria-pressed", String(!reading));
  $("source-view-description").textContent = reading
    ? `Grey blocks and spacing help you follow the document structure and make reading easier, without changing its content. Select Original text to see ${originalSource}.`
    : `This view shows ${originalSource}, including any <context>...</context> tags. Switch to Reading view for easier reading.`;
}

function renderSource() {
  const container = $("source-text");
  container.replaceChildren();
  searchMatches = [];
  searchPosition = -1;
  searchTruncated = false;
  updateSourceViewControls();
  if (!current) { $("search-count").textContent = ""; return; }

  const source = current.task.source;
  const parsed = HumanPreferenceSourceDisplay.parseContextSegments(source);
  const reading = sourceViewMode === "reading";
  let segments = reading ? parsed.segments : [{ kind: "text", text: source }];
  let hasStructureLayout = false;
  const sourceHash = current.task.source_sha256;
  const sourceLayouts = window.HumanPreferenceSourceLayouts;
  if (reading && parsed.valid && sourceHash && sourceLayouts && sourceLayouts.layouts) {
    const layout = sourceLayouts.layouts[sourceHash];
    if (layout && Array.isArray(layout.offsets_utf16) && layout.offsets_utf16.length > 0) {
      const structured = HumanPreferenceSourceDisplay.splitStructureSegments(
        parsed.segments,
        layout.offsets_utf16,
      );
      if (structured.valid && structured.hasStructure) {
        segments = structured.segments;
        hasStructureLayout = true;
      }
    }
  }
  const query = $("source-search").value.slice(0, 256);
  const result = HumanPreferenceSourceDisplay.findLiteralMatches(segments, query, 1000);
  searchTruncated = result.truncated;
  searchMatches = result.matches.map(() => ({ nodes: [] }));
  const matchesBySegment = segments.map(() => []);
  result.matches.forEach((match, matchIndex) => {
    for (const part of match.parts) matchesBySegment[part.segmentIndex].push({ ...part, matchIndex });
  });

  const content = document.createElement("div");
  content.id = "source-content";
  content.className = hasStructureLayout ? "source-content has-structure-layout" : "source-content";
  let currentStructureGroup = null;
  let groupContainer = content;
  segments.forEach((segment, segmentIndex) => {
    if (hasStructureLayout && segment.structureGroup !== currentStructureGroup) {
      currentStructureGroup = segment.structureGroup;
      groupContainer = document.createElement("div");
      groupContainer.className = "source-structure-group";
      content.append(groupContainer);
    }
    const styledContext = reading && parsed.valid && parsed.hasContext && segment.kind === "context" && segment.text.length > 0;
    const collapsibleContextSeparator = reading && parsed.valid && parsed.hasContext &&
      HumanPreferenceSourceDisplay.isCollapsibleContextSeparator(segments, segmentIndex, hasStructureLayout);
    const target = styledContext ? document.createElement("div")
      : collapsibleContextSeparator ? document.createElement("span") : groupContainer;
    if (styledContext) target.className = "context-block";
    else if (collapsibleContextSeparator) target.className = "context-separator";
    const parts = matchesBySegment[segmentIndex];
    let offset = 0;
    for (const part of parts) {
      target.append(document.createTextNode(segment.text.slice(offset, part.start)));
      const mark = document.createElement("mark");
      mark.textContent = segment.text.slice(part.start, part.end);
      target.append(mark);
      searchMatches[part.matchIndex].nodes.push(mark);
      offset = part.end;
    }
    target.append(document.createTextNode(segment.text.slice(offset)));
    if (target !== groupContainer) groupContainer.append(target);
  });
  container.append(content);
  if (!query) $("search-count").textContent = "";
  else if (searchMatches.length) moveSearch(1);
  else $("search-count").textContent = "0";
}

function findInSource() { renderSource(); }

function setSourceView(mode) {
  if (mode !== "reading" && mode !== "original") return;
  if (sourceViewMode === mode) return;
  sourceViewMode = mode;
  renderSource();
}

function moveSearch(direction) {
  if (!searchMatches.length) { $("search-count").textContent = $("source-search").value ? "0" : ""; return; }
  for (const match of searchMatches) for (const node of match.nodes) node.classList.remove("current-match");
  searchPosition = (searchPosition + direction + searchMatches.length) % searchMatches.length;
  const currentMatch = searchMatches[searchPosition];
  for (const node of currentMatch.nodes) node.classList.add("current-match");
  if (currentMatch.nodes.length) currentMatch.nodes[0].scrollIntoView({ block: "nearest", inline: "nearest" });
  $("search-count").textContent = `${searchPosition + 1}/${searchMatches.length}${searchTruncated ? "+" : ""}`;
}

$("enroll-form").addEventListener("submit", (event) => {
  event.preventDefault();
  run(() => busy(async () => {
    const backend = window.HumanAnnotationBackend;
    const displayName = backend.normalizeDisplayName($("participant-name").value);
    let uid = await backend.identityUid();
    if (!uid) {
      let captchaToken = null;
      try {
        captchaToken = await backend.getCaptchaToken($("captcha-widget"));
        uid = await backend.ensureAnonymousIdentity({ captchaToken, purpose: "enroll" });
      } finally { backend.resetCaptcha(); }
    }
    const previous = backend.pendingRecovery(uid);
    if (previous && previous.purpose !== "enroll") throw new ApiError(409, "Resolve the pending recovery operation before starting a new workspace.");
    const code = previous ? previous.code : backend.generateRecoveryCode();
    backend.storePendingRecovery(uid, code, "enroll", "requesting");
    await api("/api/enroll", { display_name: displayName, recovery_code: code }, uid);
    backend.setPendingRecoveryPhase(uid, code, "confirmation");
    $("participant-name").value = "";
    await refreshSession();
  }));
});
$("recover-form").addEventListener("submit", (event) => {
  event.preventDefault();
  run(() => busy(async () => {
    const backend = window.HumanAnnotationBackend;
    const oldCode = backend.normalizeRecoveryCode($("recovery-input").value);
    let uid = await backend.identityUid();
    if (!uid) {
      let captchaToken = null;
      try {
        captchaToken = await backend.getCaptchaToken($("captcha-widget"));
        uid = await backend.ensureAnonymousIdentity({ captchaToken, purpose: "recover" });
      } finally { backend.resetCaptcha(); }
    }
    const previous = backend.pendingRecovery(uid);
    if (previous && previous.purpose !== "recover") throw new ApiError(409, "Resolve the pending recovery operation before recovering a different workspace.");
    const newCode = previous ? previous.code : backend.generateRecoveryCode();
    backend.storePendingRecovery(uid, newCode, "recover", "requesting");
    await api("/api/recover", { recovery_code: oldCode, new_recovery_code: newCode }, uid);
    backend.setPendingRecoveryPhase(uid, newCode, "confirmation");
    $("recovery-input").value = "";
    await refreshSession();
  }));
});
$("continue-after-recovery").addEventListener("click", () => run(() => busy(async () => {
  if (!$("recovery-saved-check").checked || !pendingRecoveryUid || !pendingRecoveryCode) return;
  window.HumanAnnotationBackend.confirmPendingRecovery(pendingRecoveryUid, pendingRecoveryCode);
  pendingRecoveryUid = null;
  pendingRecoveryCode = null;
  await refreshSession();
  if (session.authenticated && session.enrolled && session.accepted_instructions) {
    activeKind = initialQueueKind();
    await resumeNext({ skipSave: true });
  }
})));
$("download-recovery-code").addEventListener("click", () => run(downloadRecoveryCode));
$("recovery-saved-check").addEventListener("change", updateControls);
$("retry-recovery-operation").addEventListener("click", () => run(() => busy(async () => {
  const backend = window.HumanAnnotationBackend;
  const uid = await backend.identityUid();
  const pending = backend.pendingRecovery(uid);
  if (!uid || !pending || pending.purpose !== "rotate_recovery") throw new ApiError(409, "There is no pending replacement code to retry.");
  await api("/api/rotate-recovery", { new_recovery_code: pending.code }, uid);
  backend.setPendingRecoveryPhase(uid, pending.code, "confirmation");
  showRecoveryConfirmation(uid, pending.code);
})));
$("guide-ack").addEventListener("change", updateControls);
$("begin-button").addEventListener("click", () => run(() => busy(async () => {
  const authUid = await window.HumanAnnotationBackend.identityUid();
  if (!authUid) throw new ApiError(401, "Your private sign-in is unavailable. Please retry without switching participants.");
  await api("/api/acknowledge", { accepted: true }, authUid);
  await refreshSession();
  activeKind = initialQueueKind();
  await resumeNext({ skipSave: true });
})));
$("instructions-button").addEventListener("click", () => $("guide-dialog").showModal());
$("close-guide").addEventListener("click", () => $("guide-dialog").close());
$("export-button").addEventListener("click", () => run(downloadResponses));
$("switch-participant-button").addEventListener("click", () => run(() => busy(async () => {
  await flushSave();
  const uid = await window.HumanAnnotationBackend.identityUid();
  if (uid && window.HumanAnnotationBackend.pendingRecovery(uid)) throw new ApiError(409, "Save and confirm the recovery code before switching participants.");
  $("switch-recovery-check").checked = false;
  updateControls();
  $("switch-dialog").showModal();
})));
$("switch-recovery-check").addEventListener("change", updateControls);
$("switch-cancel").addEventListener("click", () => $("switch-dialog").close());
$("switch-confirm").addEventListener("click", () => run(() => busy(async () => {
  if (!$("switch-recovery-check").checked) return;
  await flushSave();
  clearTimeout(current?.timer);
  current = null;
  await window.HumanAnnotationBackend.switchParticipant();
  $("switch-dialog").close();
  session = null;
  clearQualificationResults();
  showAccount();
  await refreshSession();
})));
$("rotate-recovery-button").addEventListener("click", () => $("rotate-dialog").showModal());
$("rotate-cancel").addEventListener("click", () => $("rotate-dialog").close());
$("rotate-confirm").addEventListener("click", () => run(() => busy(async () => {
  const backend = window.HumanAnnotationBackend;
  await flushSave();
  const uid = await backend.identityUid();
  if (!uid) throw new ApiError(401, "Your private sign-in is unavailable. Keep this tab open and retry later.");
  const previous = backend.pendingRecovery(uid);
  if (previous && previous.purpose !== "rotate_recovery") throw new ApiError(409, "Resolve the pending recovery operation first.");
  const code = previous ? previous.code : backend.generateRecoveryCode();
  backend.storePendingRecovery(uid, code, "rotate_recovery", "requesting");
  $("rotate-dialog").close();
  try {
    await api("/api/rotate-recovery", { new_recovery_code: code }, uid);
    backend.setPendingRecoveryPhase(uid, code, "confirmation");
    showRecoveryConfirmation(uid, code);
  } catch (error) {
    if (error && error.code === "IDENTITY_CHANGED") throw error;
    pendingRecoveryUid = uid;
    pendingRecoveryCode = code;
    $("recovery-pending-message").textContent = "The replacement code has not yet been confirmed by the service. Keep this browser open and retry; your previous recovery code may already have been replaced.";
    showView("recovery-pending-view");
    throw error;
  }
})));
$("study-tab").addEventListener("click", () => run(() => selectKind("study")));
$("qualification-tab").addEventListener("click", () => run(() => selectKind("qualification")));
$("qualification-results-button").addEventListener("click", () => run(() => busy(async () => {
  activeKind = "qualification";
  renderQueue();
  await showQualificationResults();
})));
$("qualification-results-retry").addEventListener("click", () => run(() => busy(async () => {
  await loadQualificationResults();
  renderQueue();
})));
$("qualification-results-download").addEventListener("click", () => run(downloadQualificationResults));
$("qualification-continue-study-panel").addEventListener("click", () => run(() => selectKind("study")));
$("qualification-result-close").addEventListener("click", () => $("qualification-result-dialog").close());
$("qualification-continue-study").addEventListener("click", () => run(async () => {
  $("qualification-result-dialog").close();
  await selectKind("study");
}));
$("unfinished-only").addEventListener("change", renderQueue);
$("resume-button").addEventListener("click", () => run(() => busy(() => resumeNext())));
$("criteria-form").addEventListener("submit", (event) => event.preventDefault());
$("primary-action").addEventListener("click", () => run(async () => {
  if (readOnly()) await busy(() => resumeNext({ afterCurrent: true }));
  else if (stageOf(current.task) === 1) await reviewStageOne();
  else await completeComparison();
}));
$("review-back").addEventListener("click", () => $("review-dialog").close());
$("confirm-lock").addEventListener("click", () => run(lockStageOne));
$("reference-retry").addEventListener("click", () => run(() => busy(() => loadReference(current))));
$("pause-button").addEventListener("click", () => run(saveAndPause));
$("pause-resume").addEventListener("click", () => $("pause-dialog").close());
$("pause-download").addEventListener("click", () => run(downloadResponses));
$("problem-button").addEventListener("click", () => run(reportProblem));
$("problem-cancel").addEventListener("click", () => $("problem-dialog").close());
$("problem-submit").addEventListener("click", () => run(submitProblem));
$("retry-save").addEventListener("click", () => run(() => busy(() => flushSave())));
$("reload-state").addEventListener("click", () => run(async () => {
  if (!current) return;
  if (window.confirm("Reload the saved state? Unsaved choices in this tab will be discarded. Locked answers cannot be changed.")) {
    const id = current.task.id;
    clearTimeout(current.timer);
    await refreshSession();
    await loadTask(id, { skipSave: true });
  }
}));
$("source-search").addEventListener("input", findInSource);
$("source-search").addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); moveSearch(event.shiftKey ? -1 : 1); } });
$("search-next").addEventListener("click", () => moveSearch(1));
$("search-previous").addEventListener("click", () => moveSearch(-1));
$("source-reading-view").addEventListener("click", () => setSourceView("reading"));
$("source-original-view").addEventListener("click", () => setSourceView("original"));
window.HumanAnnotationBackend.onIdentityChange(({ reason }) => freezeWorkspace(reason));
$("identity-reload").addEventListener("click", () => run(async () => {
  await window.HumanAnnotationBackend.adoptCurrentIdentityAfterReload();
  window.location.reload();
}));
for (const dialog of document.querySelectorAll("dialog")) dialog.addEventListener("cancel", (event) => { if (busyDepth > 0) event.preventDefault(); });
window.addEventListener("beforeunload", (event) => {
  if (current && current.savedVersion < current.version) { event.preventDefault(); event.returnValue = ""; }
});
document.addEventListener("visibilitychange", () => { if (document.hidden && current) flushSave().catch(() => {}); });

run(async () => {
  showView("login-view");
  await refreshSession();
  if (session.authenticated && session.accepted_instructions) {
    activeKind = initialQueueKind();
    await resumeNext({ skipSave: true });
  }
});
