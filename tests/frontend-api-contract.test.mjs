import assert from "node:assert/strict";
import test from "node:test";
import {
  AnnotationBackendError,
  generateRecoveryCode,
  mapAppRequest,
  normalizeDisplayName,
  normalizeRecoveryCode,
  validatePublicConfig,
} from "../web/backend-client.js";
import {
  STAGE_ONE_IDS,
  STAGE_TWO_IDS,
  allStageChoicesPresent,
  criteriaForStage,
  mayRequestReference,
  stageOf,
} from "../web/stage-state.js";

const CONFIG = { supabaseUrl: "https://project-ref.supabase.co", publishableKey: "sb_publishable_test-key" };

test("public configuration accepts HTTPS Supabase origins and publishable keys only", () => {
  assert.deepEqual(validatePublicConfig(CONFIG), { ...CONFIG, turnstileSiteKey: "" });
  assert.equal(validatePublicConfig({ ...CONFIG, turnstileSiteKey: "01234567890123456789012345678901" }).turnstileSiteKey, "01234567890123456789012345678901");
  for (const config of [
    null,
    {},
    { ...CONFIG, publishableKey: "sb_secret_test-key" },
    { ...CONFIG, publishableKey: "eyJhbGciOiJIUzI1NiJ9.secret" },
    { ...CONFIG, publishableKey: "service_role" },
    { ...CONFIG, supabaseUrl: "http://project-ref.supabase.co" },
    { ...CONFIG, supabaseUrl: "https://user:pass@project-ref.supabase.co" },
    { ...CONFIG, supabaseUrl: "https://project-ref.supabase.co/?key=x" },
    { ...CONFIG, turnstileSiteKey: "not a valid site key" },
  ]) assert.throws(() => validatePublicConfig(config));
});

test("application routes map only to documented RPC actions", () => {
  const expected = (action, taskId = null, payload = {}) => ({ type: "rpc", action, taskId, payload });
  assert.deepEqual(mapAppRequest("/api/session"), expected("session"));
  assert.deepEqual(mapAppRequest("/api/export"), expected("export"));
  assert.deepEqual(mapAppRequest("/api/task/task%2F17"), expected("task", "task/17"));
  assert.deepEqual(mapAppRequest("/api/task/task-17/reference"), expected("reference", "task-17"));
  assert.deepEqual(mapAppRequest("/api/acknowledge", { accepted: true }), expected("acknowledge", null, { accepted: true }));
  assert.deepEqual(mapAppRequest("/api/enroll", { display_name: "Ada", recovery_code: "not inspected by mapper" }), expected("enroll", null, { display_name: "Ada", recovery_code: "not inspected by mapper" }));
  assert.deepEqual(mapAppRequest("/api/recover", { recovery_code: "old", new_recovery_code: "new" }), expected("recover", null, { recovery_code: "old", new_recovery_code: "new" }));
  assert.deepEqual(mapAppRequest("/api/rotate-recovery", { new_recovery_code: "new" }), expected("rotate_recovery", null, { new_recovery_code: "new" }));
  for (const action of ["save", "lock", "complete", "problem"]) {
    const payload = { revision: 4, answers: { readability: "A" } };
    assert.deepEqual(mapAppRequest(`/api/task/task-17/${action}`, payload), expected(action, "task-17", payload));
  }
});

test("route mapper rejects legacy password endpoints and malformed routes", () => {
  for (const [path, payload] of [
    ["/api/login", { participant_id: "annotator_1", password: "x" }],
    ["/api/logout", {}],
    ["/api/task/", undefined],
    ["/api/task/%E0%A4%A", undefined],
    ["/api/task/task-17/save", undefined],
    ["/api/task/task-17/reference", {}],
    ["/api/task/task-17", {}],
    ["/api/session", {}],
    ["/api/export", {}],
    ["/api/enroll", undefined],
    ["/api/unknown", undefined],
  ]) assert.throws(() => mapAppRequest(path, payload), AnnotationBackendError, path);
  assert.throws(() => mapAppRequest("/api/task/task-17/save", []), /object/);
});

test("nickname validation counts Unicode characters and rejects controls", () => {
  assert.equal(normalizeDisplayName("  Zoë 👋  "), "Zoë 👋");
  assert.throws(() => normalizeDisplayName("\n"), /nickname/);
  assert.throws(() => normalizeDisplayName("x".repeat(41)), /1–40/);
  assert.throws(() => normalizeDisplayName("hello\u0000world"), /control/);
});

test("recovery codes are normalized and generated from 256 CSPRNG bits", () => {
  const code = `SAL-${"a".repeat(64)}`;
  assert.equal(normalizeRecoveryCode(` ${code} `), `SAL-${"A".repeat(64)}`);
  assert.throws(() => normalizeRecoveryCode("SAL-short"), /complete private recovery code/);
  let capturedLength = 0;
  const generated = generateRecoveryCode({ getRandomValues(bytes) { capturedLength = bytes.length; bytes.fill(0xab); return bytes; } });
  assert.equal(capturedLength, 32);
  assert.equal(generated, `SAL-${"AB".repeat(32)}`);
  assert.throws(() => generateRecoveryCode({}), /securely create/);
});

test("stage helpers expose exactly four Stage 1 choices and one reference-only Stage 2 choice", () => {
  const criteria = [
    ...STAGE_ONE_IDS.map((id) => ({ id, stage: 1 })),
    ...STAGE_TWO_IDS.map((id) => ({ id, stage: 2 })),
    { id: "unexpected", stage: 1 },
  ];
  assert.deepEqual(criteriaForStage(criteria, 1).map((criterion) => criterion.id), [...STAGE_ONE_IDS]);
  assert.deepEqual(criteriaForStage(criteria, 2).map((criterion) => criterion.id), [...STAGE_TWO_IDS]);
  assert.equal(stageOf({ stage: 1 }), 1);
  assert.equal(stageOf({ stage: 2, locked_at: "now" }), 2);
  assert.equal(mayRequestReference({ stage: 1 }), false);
  assert.equal(mayRequestReference({ stage: 2 }), false);
  assert.equal(mayRequestReference({ stage: 2, locked_at: "now" }), true);
  assert.equal(allStageChoicesPresent({ stage: 1 }, Object.fromEntries(STAGE_ONE_IDS.map((id) => [id, "Tie"]))), true);
  assert.equal(allStageChoicesPresent({ stage: 1 }, { source_coverage: "A", readability: "B" }), false);
  assert.equal(allStageChoicesPresent({ stage: 2, locked_at: "now" }, { reference_coverage: "Tie" }), true);
  assert.equal(allStageChoicesPresent({ stage: 2, locked_at: "now" }, { reference_coverage: "C" }), false);
});
