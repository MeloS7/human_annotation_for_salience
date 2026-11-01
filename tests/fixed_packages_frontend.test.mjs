import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import test from "node:test";
import {
  FIXED_PACKAGE_PROTOCOL,
  FIXED_PACKAGE_VERSION,
  FIXED_PACKAGE_STUDY_COUNT,
  QUALIFICATION_KEY_STATUS,
  QUALIFICATION_KEY_VERSION,
  QUALIFICATION_PASS_COUNT,
  QUALIFICATION_PROTOCOL,
  QUALIFICATION_CONFIRMED_SCORED_COUNT,
  qualificationProtocolReady,
  REQUIRED_QUALIFICATION_COUNT,
  REQUIRED_STUDY_COUNT,
  studyAllocationInfo,
  studyGateOpen,
  studyPackageFull,
  WORKFLOW_VERSION,
} from "../web/stage-state.js";

function sessionFor({ mode = "fixed", state = "qualification", packageId = null, matched = null } = {}) {
  const completed = matched === null ? 0 : REQUIRED_QUALIFICATION_COUNT;
  const qualificationState = matched === null ? "in_progress" : matched >= QUALIFICATION_PASS_COUNT ? "passed" : "failed";
  const studyCount = state === "assigned" ? FIXED_PACKAGE_STUDY_COUNT : mode === "legacy" ? REQUIRED_STUDY_COUNT : 0;
  const tasks = [
    ...Array.from({ length: REQUIRED_QUALIFICATION_COUNT }, (_, index) => ({
      id: `qualification-${index + 1}`, kind: "qualification", position: index + 1,
      status: index < completed ? "complete" : "draft",
    })),
    ...Array.from({ length: studyCount }, (_, index) => ({
      id: `study-${index + 1}`, kind: "study", position: index + 1, status: "draft",
    })),
  ];
  const studyTarget = mode === "legacy" ? REQUIRED_STUDY_COUNT : FIXED_PACKAGE_STUDY_COUNT;
  return {
    qualification_required: true,
    workflow_version: WORKFLOW_VERSION,
    workflow_guide_md: "# Instructions\n\nComplete the qualification before the study.",
    workflow_guide_sha256: "a".repeat(64),
    qualification: {
      protocol: QUALIFICATION_PROTOCOL, version: QUALIFICATION_KEY_VERSION,
      policy_version: WORKFLOW_VERSION, required_for_study: true,
      key_status: QUALIFICATION_KEY_STATUS, confirmed_scored_count: QUALIFICATION_CONFIRMED_SCORED_COUNT,
      required: REQUIRED_QUALIFICATION_COUNT, completed, state: qualificationState,
      scored_total: QUALIFICATION_CONFIRMED_SCORED_COUNT, pass_count: QUALIFICATION_PASS_COUNT,
      score: matched === null ? null : { matched, total: QUALIFICATION_CONFIRMED_SCORED_COUNT },
      completed_at: matched === null ? null : "2026-11-01T12:00:00Z",
    },
    allocation: {
      protocol: FIXED_PACKAGE_PROTOCOL, version: FIXED_PACKAGE_VERSION,
      mode, state, package_id: packageId, study_target: studyTarget,
    },
    tasks,
    progress: {
      study_total: studyCount,
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

test("fixed package qualification session safely has no study assignments yet", () => {
  const session = sessionFor();
  assert.equal(qualificationProtocolReady(session), true);
  assert.equal(studyGateOpen(session), false);
  assert.deepEqual(studyAllocationInfo(session), {
    valid: true, mode: "fixed", state: "qualification", packageId: null,
    studyTarget: FIXED_PACKAGE_STUDY_COUNT, queueCount: 0, fixed: true, full: false,
  });
});

test("a passed annotator may open only their assigned 42-item package", () => {
  const session = sessionFor({ state: "assigned", packageId: "package_07", matched: 14 });
  assert.equal(qualificationProtocolReady(session), true);
  assert.equal(studyGateOpen(session), true);
  assert.equal(studyAllocationInfo(session).queueCount, FIXED_PACKAGE_STUDY_COUNT);
  assert.equal(session.tasks.filter((task) => task.kind === "study").length, 42);
});

test("a passed annotator is not shown a false completion when all packages are claimed", () => {
  const session = sessionFor({ state: "full", matched: 18 });
  assert.equal(qualificationProtocolReady(session), true);
  assert.equal(studyGateOpen(session), false);
  assert.equal(studyPackageFull(session), true);
  assert.equal(session.tasks.filter((task) => task.kind === "study").length, 0);
});

test("existing legacy study queue remains intact under an explicit legacy allocation", () => {
  const session = sessionFor({ mode: "legacy", state: "legacy", matched: 14 });
  assert.equal(qualificationProtocolReady(session), true);
  assert.equal(studyGateOpen(session), true);
  assert.equal(studyAllocationInfo(session).queueCount, REQUIRED_STUDY_COUNT);
  assert.equal(session.tasks.filter((task) => task.kind === "study").length, 126);
});

test("fixed allocation rejects malformed states, package IDs and queue lengths", () => {
  const mutations = [
    (s) => { s.allocation.version = "unknown"; },
    (s) => { s.allocation.protocol = "old"; },
    (s) => { s.allocation.study_target = 126; },
    (s) => { s.allocation.state = "assigned"; s.allocation.package_id = "package_10"; },
    (s) => { s.allocation.state = "full"; s.qualification.state = "in_progress"; },
    (s) => { s.allocation.state = "qualification"; s.qualification.completed = 10; s.qualification.state = "passed"; },
    (s) => { s.progress.study_total = 42; },
    (s) => { s.tasks.push({ id: "extra-study", kind: "study", position: 1, status: "draft" }); },
    (s) => { s.tasks.find((task) => task.kind === "qualification").position = 11; },
  ];
  for (const mutate of mutations) {
    const invalid = structuredClone(sessionFor());
    mutate(invalid);
    assert.equal(qualificationProtocolReady(invalid), false);
    assert.equal(studyGateOpen(invalid), false);
  }
});

test("completed fixed-package result offers no continue action when the pool is full", async () => {
  const app = await readFile(new URL("../web/app.js", import.meta.url), "utf8");
  const html = await readFile(new URL("../web/index.html", import.meta.url), "utf8");
  assert.match(app, /all nine study packages have been assigned/i);
  assert.match(app, /qualification-continue-study"\)\.hidden = !passed \|\| packageFull/);
  assert.match(app, /activeKind === "study" && fixedPackageFull\(\)/);
  assert.match(html, /id="study-total">42</);
});

test("queue rendering handles assigned, pre-qualification and full states at runtime", async () => {
  const app = await readFile(new URL("../web/app.js", import.meta.url), "utf8");
  const start = app.indexOf("function queueTasks()");
  const end = app.indexOf("\nfunction clearComparison()", start);
  assert.ok(start >= 0 && end > start, "queue renderer should remain a bounded, testable block");
  const queueCode = app.slice(start, end);
  const ids = ["qualification-tab", "qualification-results-button", "study-tab", "study-total",
    "qualification-total", "progress-label", "progress-percent", "progress-bar", "resume-button",
    "queue-note", "task-list", "unfinished-only"];

  function render(session, activeKind) {
    class Element {
      constructor() {
        this.hidden = false; this.textContent = ""; this.checked = true; this.dataset = {}; this.children = [];
        this.classList = { toggle() {} };
      }
      setAttribute() {}
      replaceChildren(...children) { this.children = children; }
      append(...children) { this.children.push(...children); }
      addEventListener() {}
    }
    const elements = new Map(ids.map((id) => [id, new Element()]));
    const context = {
      session: { ...session, authenticated: true, accepted_instructions: true }, activeKind,
      current: null, busyDepth: 0, identityFrozen: false,
      $: (id) => elements.get(id),
      document: { createElement: () => new Element() },
      qualificationActive: () => session.qualification_required === true,
      protocolReady: () => true,
      qualificationIsComplete: (value) => value.qualification.completed === REQUIRED_QUALIFICATION_COUNT,
      studyReady: () => studyGateOpen(session),
      fixedPackageFull: () => studyPackageFull(session),
      studyAllocationInfo,
      displayAssignmentNumber: (task) => task.position,
      taskDisplayLabel: (task) => `${task.kind} ${task.position}`,
    };
    runInNewContext(`${queueCode}\nrenderQueue();`, context);
    return elements;
  }

  const qualification = render(sessionFor(), "qualification");
  assert.equal(qualification.get("study-total").textContent, 42);
  assert.equal(qualification.get("task-list").children.length, 10);

  const full = render(sessionFor({ state: "full", matched: 18 }), "study");
  assert.equal(full.get("study-total").textContent, 42);
  assert.equal(full.get("progress-label").textContent, "No study package assigned");
  assert.equal(full.get("resume-button").disabled, true);
  assert.equal(full.get("task-list").children.length, 0);
});
