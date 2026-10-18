"use strict";

const $ = (id) => document.getElementById(id);
const { STAGE_ONE_IDS, allStageChoicesPresent, criteriaForStage, mayRequestReference, stageOf } = window.HumanPreferenceStageState;
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
function studyReady() { return session.progress.practice_completed >= session.progress.practice_total; }
function showView(id) {
  for (const view of ["login-view", "recovery-view", "recovery-pending-view", "intro-view", "workspace"]) $(view).hidden = view !== id;
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
  session = await api("/api/session");
  showAccount();
  if (!session.authenticated || !session.enrolled) {
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
  renderGuide($("intro-guide"), session.guide_md || "");
  renderGuide($("dialog-guide"), session.guide_md || "");
  if (!session.accepted_instructions) { showView("intro-view"); return; }
  showView("workspace");
  renderQueue();
}

function queueTasks() { return session.tasks.filter((task) => task.kind === activeKind).sort((a, b) => a.position - b.position); }
function renderQueue() {
  if (!session || !session.authenticated || !session.accepted_instructions) return;
  $("study-tab").classList.toggle("active", activeKind === "study");
  $("practice-tab").classList.toggle("active", activeKind === "practice");
  $("study-tab").setAttribute("aria-pressed", String(activeKind === "study"));
  $("practice-tab").setAttribute("aria-pressed", String(activeKind === "practice"));
  $("study-total").textContent = session.progress.study_total;
  $("practice-total").textContent = session.progress.practice_total;
  const tasks = queueTasks();
  const complete = tasks.filter((task) => task.status === "complete").length;
  $("progress-label").textContent = `${complete} of ${tasks.length} completed`;
  $("progress-percent").textContent = tasks.length ? `${Math.round(100 * complete / tasks.length)}%` : "0%";
  $("progress-bar").max = Math.max(1, tasks.length);
  $("progress-bar").value = complete;
  $("queue-note").textContent = activeKind === "practice"
    ? "Practice answers are not included in the study results."
    : studyReady() ? "Your answers and progress are private to this workspace." : "Complete the practice comparisons before starting the study.";
  $("task-list").replaceChildren();
  for (const task of tasks) {
    if ($("unfinished-only").checked && task.status === "complete" && (!current || current.task.id !== task.id)) continue;
    const button = document.createElement("button");
    button.type = "button";
    button.className = `task-button${current && current.task.id === task.id ? " active" : ""}`;
    button.disabled = busyDepth > 0;
    if (current && current.task.id === task.id) button.setAttribute("aria-current", "true");
    const dot = document.createElement("span"); dot.className = `task-dot ${task.status}`; dot.setAttribute("aria-hidden", "true");
    const label = document.createElement("span"); label.textContent = `${activeKind === "practice" ? "Practice" : "Comparison"} ${String(task.position).padStart(3, "0")}`;
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
  $("empty-state").hidden = false;
  $("empty-heading").textContent = title;
  $("empty-description").textContent = text;
  $("empty-action").hidden = !action;
  $("empty-action").textContent = actionLabel;
  $("empty-action").onclick = action ? () => run(action) : null;
}

async function selectKind(kind) {
  await busy(async () => {
    await flushSave();
    current = null;
    activeKind = kind;
    renderQueue();
    await resumeNext({ skipSave: true });
  });
}

async function resumeNext({ skipSave = false, afterCurrent = false } = {}) {
  if (!skipSave) await flushSave();
  if (activeKind === "study" && !studyReady()) {
    current = null;
    emptyState("Start with practice", "Complete the practice comparisons to become familiar with the two-stage workflow. Practice does not contribute to the study results.", "Go to practice", () => selectKind("practice"));
    return;
  }
  const tasks = queueTasks();
  const available = tasks.filter((task) => task.status !== "complete" && task.status !== "paused");
  const next = (afterCurrent && current ? available.find((task) => task.id !== current.task.id) : available[0]) || available[0];
  if (next) { await loadTask(next.id, { skipSave: true }); return; }
  current = null;
  if (activeKind === "practice" && tasks.length && tasks.every((task) => task.status === "complete")) {
    emptyState("Practice complete", "You have finished the practice comparisons. You can now begin the study comparisons.", "Begin study comparisons", () => selectKind("study"));
  } else if (tasks.some((task) => task.status === "paused")) {
    emptyState("No unpaused comparisons remain", "The remaining comparisons have been reported for review. Your saved work is retained. You can download your responses or contact the study coordinator.");
  } else {
    emptyState("Your comparisons are complete", "Thank you for your careful work. Download your responses and send the file to the study coordinator.", "Download my responses", downloadResponses);
  }
  renderQueue();
}

async function loadTask(id, { skipSave = false } = {}) {
  if (current && current.task.id === id && !skipSave) return;
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
  $("empty-state").hidden = true;
  $("comparison-view").hidden = false;
  $("task-kind").textContent = task.kind === "practice" ? "Practice · not part of study results" : "Your independent assessment";
  $("task-title").textContent = `${task.kind === "practice" ? "Practice" : "Comparison"} ${String(task.position).padStart(3, "0")}`;
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
  for (const id of ["enroll-button", "recover-button", "continue-after-recovery", "retry-recovery-operation", "instructions-button", "export-button", "rotate-recovery-button", "switch-participant-button", "study-tab", "practice-tab", "resume-button", "pause-button", "problem-button", "confirm-lock", "review-back", "problem-submit", "problem-cancel", "pause-download", "pause-resume", "reference-retry", "retry-save", "reload-state", "rotate-confirm", "switch-confirm"]) if ($(id)) $(id).disabled = disabled;
  $("continue-after-recovery").disabled = disabled || !$("recovery-saved-check").checked;
  $("switch-confirm").disabled = disabled || !$("switch-recovery-check").checked;
  $("begin-button").disabled = disabled || !$("guide-ack").checked;
  for (const button of $("task-list").querySelectorAll("button")) button.disabled = disabled;
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
    await flushSave(ctx);
    await api(taskPath(ctx.task.id, "/complete"), { revision: ctx.task.revision, answers: { reference_coverage: ctx.answers.reference_coverage } }, ctx.authUid);
    await refreshSession();
    current = null;
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
    activeKind = studyReady() ? "study" : "practice";
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
  activeKind = studyReady() ? "study" : "practice";
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
$("practice-tab").addEventListener("click", () => run(() => selectKind("practice")));
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
    activeKind = studyReady() ? "study" : "practice";
    await resumeNext({ skipSave: true });
  }
});
