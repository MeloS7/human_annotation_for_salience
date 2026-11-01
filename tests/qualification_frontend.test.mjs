import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { AnnotationBackendError, mapAppRequest } from "../web/backend-client.js";
import {
  annotationProtocolReady,
  displayAssignmentNumber,
  practiceProtocolReady,
  qualificationProtocolReady,
  qualificationResultsReady,
  REQUIRED_QUALIFICATION_COUNT,
  REQUIRED_STUDY_COUNT,
  studyGateOpen,
  QUALIFICATION_DIMENSION_IDS,
  QUALIFICATION_KEY_STATUS,
  QUALIFICATION_PASS_COUNT,
  QUALIFICATION_PROTOCOL,
  QUALIFICATION_SCORED_TOTAL,
  QUALIFICATION_KEY_VERSION,
  WORKFLOW_VERSION,
} from "../web/stage-state.js";

function qualificationSession({ completed = 0, matched = null, state = "in_progress" } = {}) {
  const qTasks = Array.from({ length: REQUIRED_QUALIFICATION_COUNT }, (_, index) => ({
    id: `q-${index + 1}`,
    kind: "qualification",
    position: index + 1,
    status: index < completed ? "complete" : "draft",
    stage: 1,
  }));
  const studyTasks = Array.from({ length: REQUIRED_STUDY_COUNT }, (_, index) => ({
    id: `study-${index + 1}`,
    kind: "study",
    position: index + 1,
    status: index < 3 ? "complete" : "draft",
    stage: 1,
  }));
  return {
    authenticated: true,
    enrolled: true,
    accepted_instructions: true,
    qualification_required: true,
    workflow_version: WORKFLOW_VERSION,
    workflow_guide_md: "# Annotation instructions\n\nMandatory qualification comes first.",
    workflow_guide_sha256: "a".repeat(64),
    qualification: {
      protocol: QUALIFICATION_PROTOCOL,
      version: QUALIFICATION_KEY_VERSION,
      policy_version: WORKFLOW_VERSION,
      required_for_study: true,
      key_status: QUALIFICATION_KEY_STATUS,
      confirmed_scored_count: 18,
      required: REQUIRED_QUALIFICATION_COUNT,
      completed,
      state,
      scored_total: QUALIFICATION_SCORED_TOTAL,
      pass_count: QUALIFICATION_PASS_COUNT,
      score: matched === null ? null : { matched, total: QUALIFICATION_SCORED_TOTAL },
      completed_at: completed === REQUIRED_QUALIFICATION_COUNT ? "2026-10-20T12:00:00Z" : null,
    },
    tasks: [...qTasks, ...studyTasks],
    progress: {
      study_total: REQUIRED_STUDY_COUNT,
      study_completed: 3,
      practice_total: 0,
      practice_completed: 0,
      practice_requirement: 0,
      qualification_total: REQUIRED_QUALIFICATION_COUNT,
      qualification_completed: completed,
      paused: 0,
    },
  };
}

function makeResults({ matched = 15, state = "passed" } = {}) {
  const dimensionCounts = new Map(QUALIFICATION_DIMENSION_IDS.map((id) => [id, {
    scored_matched: 0, scored_total: 0, all_matched: 0, all_total: REQUIRED_QUALIFICATION_COUNT,
  }]));
  let allMatched = 0;
  const items = Array.from({ length: REQUIRED_QUALIFICATION_COUNT }, (_, itemIndex) => {
    const dimensions = QUALIFICATION_DIMENSION_IDS.map((id, dimensionIndex) => {
      // The first 18 cells (10 source-coverage + 8 reference-coverage) are
      // scored; the other 32 remain exploratory. This also exercises a valid
      // zero-count dimension, whose scored percentage is null.
      const scored = dimensionIndex === 0 || (dimensionIndex === 1 && itemIndex < 8);
      const scoredIndex = dimensionIndex === 0 ? itemIndex : 10 + itemIndex;
      const isMatch = scored ? scoredIndex < matched : (itemIndex + dimensionIndex) % 2 === 0;
      const suggested = itemIndex % 3 === 0 ? "Tie" : itemIndex % 2 === 0 ? "A" : "B";
      const answer = isMatch ? suggested : suggested === "A" ? "B" : "A";
      const counts = dimensionCounts.get(id);
      if (scored) {
        counts.scored_total += 1;
        if (isMatch) counts.scored_matched += 1;
      }
      if (isMatch) {
        counts.all_matched += 1;
        allMatched += 1;
      }
      return { id, answer, suggested, matches: isMatch, scored, rationale_zh: "简短依据" };
    });
    return {
      id: `task-${itemIndex + 1}`,
      number: itemIndex + 1,
      qualification_id: `Q${String(itemIndex + 1).padStart(2, "0")}`,
      dataset: itemIndex < 5 ? "cnndm" : "gumsum",
      title_zh: `Article ${itemIndex + 1}`,
      dimensions,
    };
  });
  const dimensions = QUALIFICATION_DIMENSION_IDS.map((id) => {
    const counts = dimensionCounts.get(id);
    return {
      id,
      ...counts,
      scored_percent: counts.scored_total ? Number((100 * counts.scored_matched / counts.scored_total).toFixed(2)) : null,
      all_percent: Number((100 * counts.all_matched / counts.all_total).toFixed(2)),
    };
  });
  return {
    version: QUALIFICATION_KEY_VERSION,
    policy_version: WORKFLOW_VERSION,
    confirmed_scored_count: 18,
    key_status: QUALIFICATION_KEY_STATUS,
    state,
    matched,
    total: QUALIFICATION_SCORED_TOTAL,
    pass_count: QUALIFICATION_PASS_COUNT,
    percent: Number((100 * matched / QUALIFICATION_SCORED_TOTAL).toFixed(2)),
    overall: { matched: allMatched, total: 50, percent: Number((100 * allMatched / 50).toFixed(2)) },
    dimensions,
    items,
    evaluated_at: "2026-10-20T12:00:00Z",
  };
}

test("legacy practice helpers remain available but never open the active study gate", () => {
  const legacy = {
    tasks: [
      { id: "p1", kind: "practice", position: 1, status: "complete" },
      { id: "p2", kind: "practice", position: 2, status: "complete" },
      ...Array.from({ length: REQUIRED_STUDY_COUNT }, (_, index) => ({ id: `s${index + 1}`, kind: "study", position: index + 1, status: "draft" })),
    ],
    progress: { study_total: REQUIRED_STUDY_COUNT, practice_total: 2, practice_completed: 2, practice_requirement: 2 },
  };
  assert.equal(practiceProtocolReady(legacy), true);
  assert.equal(annotationProtocolReady(legacy), false);
  assert.equal(qualificationProtocolReady(legacy), false);
  assert.equal(studyGateOpen(legacy), false);
});

test("qualification gate requires ten completed items and at least 14 of 18 confirmed judgments", () => {
  const inProgress = qualificationSession({ completed: 9 });
  assert.equal(qualificationProtocolReady(inProgress), true);
  assert.equal(studyGateOpen(inProgress), false);

  const passed = qualificationSession({ completed: 10, matched: 14, state: "passed" });
  assert.equal(qualificationProtocolReady(passed), true);
  assert.equal(studyGateOpen(passed), true);

  const failed = qualificationSession({ completed: 10, matched: 13, state: "failed" });
  assert.equal(qualificationProtocolReady(failed), true);
  assert.equal(studyGateOpen(failed), false);

  assert.equal(qualificationProtocolReady(qualificationSession({ completed: 10, matched: 13, state: "passed" })), false);
  assert.equal(qualificationProtocolReady(qualificationSession({ completed: 9, matched: 14, state: "passed" })), false);
});

test("active qualification sessions fail closed on malformed counts, identities, and protocol versions", () => {
  const valid = qualificationSession({ completed: 2 });
  const badDuplicateId = structuredClone(valid);
  badDuplicateId.tasks.at(-1).id = badDuplicateId.tasks[0].id;
  const badQCount = structuredClone(valid);
  badQCount.progress.qualification_completed = 1;
  const badStudyCount = structuredClone(valid);
  badStudyCount.progress.study_completed = 2;
  const badPausedCount = structuredClone(valid);
  badPausedCount.tasks[0].status = "paused";
  const badProtocol = structuredClone(valid);
  badProtocol.qualification.protocol = "qualification-pilot-v2";
  const missingGate = structuredClone(valid);
  delete missingGate.qualification_required;
  const badGuide = structuredClone(valid);
  badGuide.workflow_guide_sha256 = "bad-hash";
  const wrongPolicy = structuredClone(valid);
  wrongPolicy.qualification.policy_version = "old-policy";
  for (const invalid of [badDuplicateId, badQCount, badStudyCount, badPausedCount, badProtocol, missingGate, badGuide, wrongPolicy]) {
    assert.equal(annotationProtocolReady(invalid), false);
    assert.equal(qualificationProtocolReady(invalid), false);
    assert.equal(studyGateOpen(invalid), false);
  }
});

test("qualification numbering remains the assigned 1–10 position even when task order differs", () => {
  const shuffled = [
    { id: "q-8", kind: "qualification", position: 8 },
    { id: "q-1", kind: "qualification", position: 1 },
  ];
  assert.equal(displayAssignmentNumber(shuffled[0], shuffled), 8);
  assert.equal(displayAssignmentNumber(shuffled[1], shuffled), 1);
});

test("qualification results validate the hidden-until-complete 18-cell score and all-50 breakdown", () => {
  const results = makeResults();
  assert.equal(qualificationResultsReady(results), true);
  assert.equal(results.dimensions.find((dimension) => dimension.id === "content_focus").scored_percent, null);
  assert.equal(qualificationResultsReady({ ...results, matched: 14 }), false);
  assert.equal(qualificationResultsReady({ ...results, items: results.items.slice(0, 9) }), false);
  assert.equal(qualificationResultsReady({ ...results, confirmed_scored_count: 17 }), false);
  assert.equal(qualificationResultsReady({ ...results, policy_version: "old-policy" }), false);

  const duplicateNumber = structuredClone(results);
  duplicateNumber.items[1].number = duplicateNumber.items[0].number;
  assert.equal(qualificationResultsReady(duplicateNumber), false);

  const mismatchedCell = structuredClone(results);
  mismatchedCell.items[0].dimensions[0].matches = false;
  assert.equal(qualificationResultsReady(mismatchedCell), false);

  const noOptionalRationale = structuredClone(results);
  delete noOptionalRationale.items[0].dimensions[0].rationale_zh;
  assert.equal(qualificationResultsReady(noOptionalRationale), true);
});

test("qualification routes retain the private result action and no pre-completion client result path", async () => {
  assert.deepEqual(mapAppRequest("/api/start-qualification", {}), {
    type: "rpc", action: "start_qualification", taskId: null, payload: {},
  });
  assert.deepEqual(mapAppRequest("/api/qualification-results"), {
    type: "rpc", action: "qualification_results", taskId: null, payload: {},
  });
  assert.throws(() => mapAppRequest("/api/qualification-results", {}), AnnotationBackendError);
  assert.throws(() => mapAppRequest("/api/start-qualification"), AnnotationBackendError);

  const app = await readFile(new URL("../web/app.js", import.meta.url), "utf8");
  const loaderStart = app.indexOf("async function loadQualificationResults");
  const loaderEnd = app.indexOf("function showQualificationResults", loaderStart);
  const loader = app.slice(loaderStart, loaderEnd);
  assert.ok(loader.indexOf("qualificationIsComplete(session)") < loader.indexOf('api("/api/qualification-results"'));
  const resultRenderer = app.slice(app.indexOf("function renderQualificationResultsPanel"), loaderStart);
  assert.match(resultRenderer, /\.textContent/);
  assert.doesNotMatch(resultRenderer, /innerHTML/);
  assert.doesNotMatch(app, /startQualificationPilot|\/api\/start-qualification/);
  const showResults = app.slice(app.indexOf("async function showQualificationResults"), app.indexOf("async function downloadQualificationResults"));
  assert.ok(showResults.indexOf("await flushSave()") < showResults.indexOf("current = null"));
  const selectQueue = app.slice(app.indexOf("async function selectKind"), app.indexOf("async function resumeNext"));
  assert.ok(selectQueue.indexOf('kind === "study" && !studyReady()') < selectQueue.indexOf("await flushSave()"));
  assert.ok(selectQueue.indexOf("await flushSave()") < selectQueue.indexOf('activeKind = "qualification"'));

  const html = await readFile(new URL("../web/index.html", import.meta.url), "utf8");
  assert.match(html, /id="qualification-results-panel"[^>]*hidden/);
  assert.match(html, /<tbody id="qualification-results-table"><\/tbody>/);
  assert.match(html, /id="qualification-items"[^>]*><\/div>/);
  assert.doesNotMatch(html, /practice-tab|practice-total|qualification-optin|Optional pilot|Try qualification pilot/);
  assert.match(html, /confirmed by a human/);
  assert.match(app, /session\.workflow_guide_md/);
  assert.doesNotMatch(app, /session\.guide_md/);
});

test("qualification results scroll clear of the sticky header and remain readable in a short sidebar", async () => {
  const app = await readFile(new URL("../web/app.js", import.meta.url), "utf8");
  const renderer = app.slice(app.indexOf("function scrollQualificationResultsHeadingIntoView"), app.indexOf("async function loadQualificationResults"));
  assert.match(renderer, /scrollIntoView\(\{ block: "start", behavior: "instant" \}\)/);
  assert.match(renderer, /scrollQualificationResultsHeadingIntoView\(\)/);

  const queue = app.slice(app.indexOf("function renderQueue()"), app.indexOf("function clearComparison()"));
  assert.match(queue, /qualificationComplete\s*\?\s*"Review qualification result"/);
  assert.match(queue, /All 10 qualification comparisons are complete\. Review your result\./);
  assert.match(queue, /Your qualification is passed\. Study comparisons are ready to continue\./);

  const css = await readFile(new URL("../web/app.css", import.meta.url), "utf8");
  assert.match(css, /#qualification-results-heading\s*\{\s*scroll-margin-top:\s*102px;/);
  assert.match(css, /\.sidebar\s*\{[^}]*overflow-y:\s*auto;/s);
  assert.match(css, /\.sidebar\s*>\s*:not\(\.task-list\)\s*\{\s*flex:\s*0 0 auto;/);
});
