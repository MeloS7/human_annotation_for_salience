import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  annotationProtocolReady,
  QUALIFICATION_CONFIRMED_SCORED_COUNT,
  QUALIFICATION_KEY_STATUS,
  QUALIFICATION_KEY_VERSION,
  QUALIFICATION_PASS_COUNT,
  QUALIFICATION_PROTOCOL,
  qualificationProtocolReady,
  REQUIRED_QUALIFICATION_COUNT,
  REQUIRED_STUDY_COUNT,
  studyGateOpen,
  WORKFLOW_VERSION,
} from "../web/stage-state.js";

function mandatorySession({ completed = 0, matched = null, state = "in_progress" } = {}) {
  const qualificationTasks = Array.from({ length: REQUIRED_QUALIFICATION_COUNT }, (_, index) => ({
    id: `qualification-${index + 1}`,
    kind: "qualification",
    position: index + 1,
    status: index < completed ? "complete" : "draft",
  }));
  const studyTasks = Array.from({ length: REQUIRED_STUDY_COUNT }, (_, index) => ({
    id: `study-${index + 1}`,
    kind: "study",
    position: index + 1,
    status: "draft",
  }));
  return {
    authenticated: true,
    enrolled: true,
    accepted_instructions: true,
    qualification_required: true,
    workflow_version: WORKFLOW_VERSION,
    workflow_guide_md: "# Updated instructions\n\nComplete qualification before the study.",
    workflow_guide_sha256: "a".repeat(64),
    qualification: {
      protocol: QUALIFICATION_PROTOCOL,
      version: QUALIFICATION_KEY_VERSION,
      policy_version: WORKFLOW_VERSION,
      required_for_study: true,
      key_status: QUALIFICATION_KEY_STATUS,
      confirmed_scored_count: QUALIFICATION_CONFIRMED_SCORED_COUNT,
      required: REQUIRED_QUALIFICATION_COUNT,
      completed,
      state,
      scored_total: QUALIFICATION_CONFIRMED_SCORED_COUNT,
      pass_count: QUALIFICATION_PASS_COUNT,
      score: matched === null ? null : { matched, total: QUALIFICATION_CONFIRMED_SCORED_COUNT },
      completed_at: completed === REQUIRED_QUALIFICATION_COUNT ? "2026-11-01T12:00:00Z" : null,
    },
    tasks: [...qualificationTasks, ...studyTasks],
    progress: {
      study_total: REQUIRED_STUDY_COUNT,
      study_completed: 0,
      qualification_total: REQUIRED_QUALIFICATION_COUNT,
      qualification_completed: completed,
      practice_total: 0,
      practice_completed: 0,
      practice_requirement: 0,
      paused: 0,
    },
  };
}

test("mandatory qualification protocol is required and fails closed on old or incomplete sessions", () => {
  const valid = mandatorySession();
  assert.equal(annotationProtocolReady(valid), true);
  assert.equal(qualificationProtocolReady(valid), true);
  assert.equal(studyGateOpen(valid), false);

  const legacyPractice = {
    tasks: [
      { id: "p1", kind: "practice", position: 1, status: "complete" },
      { id: "p2", kind: "practice", position: 2, status: "complete" },
      ...valid.tasks.filter((task) => task.kind === "study"),
    ],
    progress: { study_total: REQUIRED_STUDY_COUNT, practice_total: 2, practice_completed: 2, practice_requirement: 2 },
  };
  assert.equal(annotationProtocolReady(legacyPractice), false);
  assert.equal(studyGateOpen(legacyPractice), false);

  for (const mutate of [
    (session) => { session.qualification_required = false; },
    (session) => { delete session.workflow_guide_md; },
    (session) => { session.workflow_guide_sha256 = "missing"; },
    (session) => { session.workflow_version = "old"; },
    (session) => { session.qualification.required_for_study = false; },
    (session) => { session.qualification.policy_version = "old"; },
    (session) => { session.qualification.confirmed_scored_count = 17; },
    (session) => { session.tasks.push({ id: "practice-1", kind: "practice", position: 1, status: "draft" }); },
  ]) {
    const invalid = structuredClone(valid);
    mutate(invalid);
    assert.equal(annotationProtocolReady(invalid), false);
    assert.equal(studyGateOpen(invalid), false);
  }
});

test("a completed qualification opens study only at the confirmed 14-of-18 threshold", () => {
  const exactPass = mandatorySession({ completed: 10, matched: 14, state: "passed" });
  assert.equal(qualificationProtocolReady(exactPass), true);
  assert.equal(studyGateOpen(exactPass), true);

  const failed = mandatorySession({ completed: 10, matched: 13, state: "failed" });
  assert.equal(qualificationProtocolReady(failed), true);
  assert.equal(studyGateOpen(failed), false);

  assert.equal(qualificationProtocolReady(mandatorySession({ completed: 9, matched: 14, state: "passed" })), false);
  assert.equal(qualificationProtocolReady(mandatorySession({ completed: 10, matched: 14, state: "failed" })), false);
});

test("the interface starts qualification automatically, hides practice and has no opt-in bypass", async () => {
  const app = await readFile(new URL("../web/app.js", import.meta.url), "utf8");
  const index = await readFile(new URL("../web/index.html", import.meta.url), "utf8");
  const queueStart = app.indexOf("function initialQueueKind()");
  const queueEnd = app.indexOf("function showView", queueStart);
  assert.match(app.slice(queueStart, queueEnd), /return studyReady\(\) \? "study" : "qualification"/);
  assert.doesNotMatch(app, /startQualificationPilot|\/api\/start-qualification|qualification-opt-in|qualification-optin-dialog/);
  assert.doesNotMatch(index, /practice-tab|practice-total|qualification-offer|qualification-optin|Try qualification pilot|Optional pilot/);
  assert.match(index, /id="qualification-tab"/);
  assert.match(index, /id="study-tab"/);
  assert.match(index, /confirmed by a human/);
  assert.match(app, /workflow_guide_md/);
  assert.doesNotMatch(app, /session\.guide_md/);

  const gateStart = app.indexOf('if (kind === "study" && !studyReady())');
  const gateEnd = app.indexOf("async function resumeNext", gateStart);
  assert.ok(gateStart >= 0 && gateEnd > gateStart);
  assert.match(app.slice(gateStart, gateEnd), /activeKind = "qualification"/);
});
