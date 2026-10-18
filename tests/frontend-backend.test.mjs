import assert from "node:assert/strict";
import test from "node:test";
import {
  AnnotationBackendError,
  createAnnotationBackend,
} from "../web/backend-client.js";

const CONFIG = { supabaseUrl: "https://example-project.supabase.co", publishableKey: "sb_publishable_synthetic-test-key" };
const OLD_CODE = `SAL-${"A".repeat(64)}`;
const NEW_CODE = `SAL-${"B".repeat(64)}`;

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
    values,
  };
}

function makeServer() {
  const participantsByUid = new Map();
  const participantsById = new Map();
  const recoveryOwners = new Map();
  const stats = { calls: [], signIns: 0, signOuts: 0, nextParticipant: 0, failAction: null, nullAction: null, responseOverride: null };

  function sessionPayload(participant) {
    return {
      authenticated: true,
      enrolled: true,
      mode: "study",
      participant_id: participant.id,
      display_name: participant.name,
      accepted_instructions: false,
      tasks: [
        { id: "practice-old-3", kind: "practice", position: 3, status: "draft", stage: 1 },
        { id: "practice-old-7", kind: "practice", position: 7, status: "draft", stage: 1 },
        ...Array.from({ length: 126 }, (_, index) => ({ id: `study-${index + 1}`, kind: "study", position: index + 1, status: "draft", stage: 1 })),
      ],
      progress: { study_total: 126, study_completed: 0, practice_total: 2, practice_completed: 0, practice_requirement: 2, paused: 0 },
      rubric: { criteria: [], choices: [], shared_instructions: [] },
      guide_md: "Synthetic instructions.",
    };
  }

  function sessionFor(uid) {
    const participant = participantsByUid.get(uid);
    return participant
      ? sessionPayload(participant)
      : { authenticated: true, enrolled: false, needs_enrollment: true, mode: "study", accepted_instructions: false, tasks: [], progress: { study_total: 126, study_completed: 0, practice_total: 2, practice_completed: 0, practice_requirement: 2, paused: 0 }, rubric: { criteria: [], choices: [], shared_instructions: [] }, guide_md: "" };
  }

  function handle({ action, taskId, payload, uid }) {
    if (stats.failAction === action) { stats.failAction = null; return { data: null, error: { code: "PT409", message: "private backend detail must not escape" } }; }
    if (stats.nullAction === action) { stats.nullAction = null; return { data: null, error: null }; }
    if (stats.responseOverride) { const result = stats.responseOverride({ action, taskId, payload, uid }); stats.responseOverride = null; return result; }
    if (action === "session") return { data: sessionFor(uid), error: null };
    if (action === "enroll") {
      const current = participantsByUid.get(uid);
      if (current) {
        if (current.name !== payload.display_name || current.code !== payload.recovery_code) return { data: null, error: { code: "PT409", message: "conflict" } };
        return { data: sessionPayload(current), error: null };
      }
      if (recoveryOwners.has(payload.recovery_code)) return { data: null, error: { code: "PT409", message: "conflict" } };
      const participant = { id: `participant-${++stats.nextParticipant}`, name: payload.display_name, uid, code: payload.recovery_code };
      participantsByUid.set(uid, participant);
      participantsById.set(participant.id, participant);
      recoveryOwners.set(participant.code, participant);
      return { data: sessionPayload(participant), error: null };
    }
    if (action === "recover") {
      const oldOwner = recoveryOwners.get(payload.recovery_code);
      const alreadyRecovered = recoveryOwners.get(payload.new_recovery_code);
      if (alreadyRecovered && alreadyRecovered.uid === uid) return { data: sessionPayload(alreadyRecovered), error: null };
      if (!oldOwner || participantsByUid.has(uid)) return { data: null, error: { code: "PT400", message: "invalid code" } };
      participantsByUid.delete(oldOwner.uid);
      recoveryOwners.delete(oldOwner.code);
      oldOwner.uid = uid;
      oldOwner.code = payload.new_recovery_code;
      participantsByUid.set(uid, oldOwner);
      recoveryOwners.set(oldOwner.code, oldOwner);
      return { data: sessionPayload(oldOwner), error: null };
    }
    if (action === "rotate_recovery") {
      const participant = participantsByUid.get(uid);
      if (!participant) return { data: null, error: { code: "PT403", message: "unmapped" } };
      if (participant.code !== payload.new_recovery_code) recoveryOwners.delete(participant.code);
      participant.code = payload.new_recovery_code;
      recoveryOwners.set(participant.code, participant);
      return { data: { ok: true }, error: null };
    }
    if (action === "export") {
      const participant = participantsByUid.get(uid);
      if (!participant) return { data: null, error: { code: "PT403", message: "unmapped" } };
      return { data: { participant_id: participant.id, display_name: participant.name, study_assignments: [], practice_assignments: [] }, error: null };
    }
    if (!participantsByUid.has(uid)) return { data: null, error: { code: "PT403", message: "unmapped" } };
    if (action === "task") return { data: { id: taskId, stage: 1, status: "draft", answers: {}, source: "Synthetic source only.", summary_a: "A", summary_b: "B" }, error: null };
    if (action === "save") return { data: { revision: 2, answers: payload.answers }, error: null };
    if (action === "lock") return { data: { revision: 2, stage: 2, locked_at: "now" }, error: null };
    if (action === "reference") return { data: { reference: "Synthetic reference.", revision: 3, reference_released_at: "now" }, error: null };
    if (action === "complete") return { data: { revision: 4, status: "complete" }, error: null };
    if (action === "problem" || action === "acknowledge") return { data: { ok: true }, error: null };
    return { data: null, error: { code: "PT400", message: "unsupported" } };
  }

  return { handle, participantsByUid, participantsById, recoveryOwners, stats };
}

function createAuthBus() {
  return { clients: new Set() };
}

function mockSupabaseFactory({ localStorage, server = makeServer(), authBus = createAuthBus() }) {
  const { clients } = authBus;
  const stats = { clients: [], calls: server.stats.calls, signIns: () => server.stats.signIns, signOuts: () => server.stats.signOuts };
  function readSession(storageKey) {
    const raw = localStorage.getItem(storageKey);
    return raw ? JSON.parse(raw) : null;
  }
  function broadcast(event, session, except = null) {
    for (const peer of clients) {
      if (peer !== except) for (const callback of peer.listeners) callback(event, session);
    }
  }
  function setSession(session, source = null) {
    if (session) localStorage.setItem("human-annotation-open-v1", JSON.stringify(session));
    else localStorage.removeItem("human-annotation-open-v1");
    broadcast(session ? "SIGNED_IN" : "SIGNED_OUT", session, source);
  }
  function createClient(url, key, options) {
    const record = { url, key, options, listeners: new Set(), storageKey: options.auth.storageKey, nextHeader: null, setSession };
    stats.clients.push(record);
    clients.add(record);
    const auth = {
      async getSession() { return { data: { session: readSession(record.storageKey) }, error: null }; },
      onAuthStateChange(callback) { record.listeners.add(callback); return { data: { subscription: { unsubscribe: () => record.listeners.delete(callback) } } }; },
      async signInAnonymously(credentials) {
        if (credentials?.options?.captchaToken) record.captchaToken = credentials.options.captchaToken;
        server.stats.signIns += 1;
        const uid = `auth-uid-${server.stats.signIns}`;
        const session = {
          access_token: `synthetic-access-${uid}`,
          refresh_token: `synthetic-refresh-${uid}`,
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          user: { id: uid, is_anonymous: true, user_metadata: { display_name: "untrusted", participant_id: "spoofed" } },
        };
        setSession(session, record);
        for (const callback of record.listeners) callback("SIGNED_IN", session);
        return { data: { user: session.user, session }, error: null };
      },
      async signOut({ scope } = {}) {
        record.signOutScope = scope;
        server.stats.signOuts += 1;
        setSession(null, record);
        for (const callback of record.listeners) callback("SIGNED_OUT", null);
        return { error: null };
      },
    };
    const client = {
      auth,
      rpc(name, args) {
        const builder = {
          setHeader(header, value) { record.nextHeader = [header, value]; return builder; },
          then(resolve, reject) {
            const session = readSession(record.storageKey);
            const [headerName, headerValue] = record.nextHeader || [];
            record.nextHeader = null;
            const call = { name, args, headerName, headerValue, uid: session?.user?.id || null };
            server.stats.calls.push(call);
            if (name !== "annotation_api" || headerName !== "Authorization" || headerValue !== `Bearer ${session?.access_token}`) {
              return Promise.resolve({ data: null, error: { code: "PT401", message: "invalid auth header" } }).then(resolve, reject);
            }
            return Promise.resolve(server.handle({ action: args.p_action, taskId: args.p_task_id, payload: args.p_payload, uid: session.user.id })).then(resolve, reject);
          },
        };
        return builder;
      },
    };
    record.client = client;
    return client;
  }
  return { createClient, stats, server };
}

function makeBackend({ localStorage = memoryStorage(), sessionStorage = memoryStorage(), server = makeServer(), authBus, config = CONFIG, cryptoSource = { getRandomValues(bytes) { bytes.fill(0x2a); return bytes; } }, documentObject, windowObject } = {}) {
  const mock = mockSupabaseFactory({ localStorage, server, authBus });
  const backend = createAnnotationBackend(config, { createClient: mock.createClient, localStorage, sessionStorage, cryptoSource, documentObject, windowObject });
  return { backend, localStorage, sessionStorage, mock, server };
}

async function startParticipant(backend, name, recoveryCode) {
  const uid = await backend.ensureAnonymousIdentity({ purpose: "enroll" });
  backend.storePendingRecovery(uid, recoveryCode, "enroll");
  await backend.request("enroll", null, { display_name: name, recovery_code: recoveryCode }, { expectedUid: uid });
  backend.setPendingRecoveryPhase(uid, recoveryCode, "confirmation");
  backend.confirmPendingRecovery(uid, recoveryCode);
  return uid;
}

test("Anonymous Auth persists via shared localStorage and returns server-bound participant identity", async () => {
  const localStorage = memoryStorage();
  const sessionStorage = memoryStorage();
  const { backend, mock } = makeBackend({ localStorage, sessionStorage });
  assert.deepEqual(mock.stats.clients[0].options.auth, {
    autoRefreshToken: true,
    detectSessionInUrl: false,
    persistSession: true,
    storage: localStorage,
    storageKey: "human-annotation-open-v1",
  });
  const uid = await backend.ensureAnonymousIdentity({ purpose: "enroll" });
  await backend.request("enroll", null, { display_name: "Researcher", recovery_code: OLD_CODE }, { expectedUid: uid });
  const session = await backend.request("session");
  assert.equal(session.authenticated, true);
  assert.equal(session.enrolled, true);
  assert.equal(session.display_name, "Researcher");
  assert.match(session.participant_id, /^participant-/);
  assert.notEqual(session.participant_id, "spoofed");
  assert.equal(mock.stats.calls.at(-1).uid, uid);
  assert.equal(mock.stats.calls.at(-1).headerValue, `Bearer synthetic-access-${uid}`);
});

test("same-browser reload reuses local Auth and resumes the same private participant", async () => {
  const localStorage = memoryStorage();
  const server = makeServer();
  const first = makeBackend({ localStorage, sessionStorage: memoryStorage(), server });
  const uid = await startParticipant(first.backend, "Ada", OLD_CODE);
  const beforeSignIns = first.server.stats.signIns;
  const reloaded = makeBackend({ localStorage, sessionStorage: memoryStorage(), server });
  assert.equal(await reloaded.backend.identityUid(), uid);
  const session = await reloaded.backend.request("session");
  assert.equal(session.participant_id, "participant-1");
  assert.equal(session.display_name, "Ada");
  assert.equal(reloaded.server.stats.signIns, beforeSignIns);
});

test("display nicknames are not identity: duplicate names enroll as independent server IDs", async () => {
  const server = makeServer();
  const first = makeBackend({ server });
  const second = makeBackend({ server });
  const uidOne = await startParticipant(first.backend, "Same nickname", OLD_CODE);
  const uidTwo = await startParticipant(second.backend, "Same nickname", NEW_CODE);
  const firstSession = await first.backend.request("session");
  const secondSession = await second.backend.request("session");
  assert.notEqual(uidOne, uidTwo);
  assert.equal(firstSession.display_name, secondSession.display_name);
  assert.notEqual(firstSession.participant_id, secondSession.participant_id);
  assert.equal(server.participantsByUid.get(uidOne).name, "Same nickname");
  assert.equal(server.participantsByUid.get(uidTwo).name, "Same nickname");
});

test("recovery rebinds stable participant ID, rotates code and leaves the old UID unmapped", async () => {
  const server = makeServer();
  const original = makeBackend({ server });
  const oldUid = await startParticipant(original.backend, "Morgan", OLD_CODE);
  const newBrowser = makeBackend({ server });
  const newUid = await newBrowser.backend.ensureAnonymousIdentity({ purpose: "recover" });
  newBrowser.backend.storePendingRecovery(newUid, NEW_CODE, "recover");
  const recovered = await newBrowser.backend.request("recover", null, { recovery_code: OLD_CODE, new_recovery_code: NEW_CODE }, { expectedUid: newUid });
  assert.equal(recovered.participant_id, "participant-1");
  assert.equal((await newBrowser.backend.request("session")).display_name, "Morgan");
  assert.equal(server.participantsByUid.has(oldUid), false);
  assert.equal(server.recoveryOwners.has(OLD_CODE), false);
  assert.equal(server.recoveryOwners.get(NEW_CODE).id, "participant-1");
  newBrowser.backend.setPendingRecoveryPhase(newUid, NEW_CODE, "confirmation");
  assert.equal(newBrowser.backend.pendingRecovery(newUid).phase, "confirmation");
  assert.equal(newBrowser.backend.confirmPendingRecovery(newUid, NEW_CODE), true);
});

test("rotate and export never return or export a recovery code; response credential fields fail closed", async () => {
  const { backend, server } = makeBackend();
  const uid = await startParticipant(backend, "Morgan", OLD_CODE);
  backend.storePendingRecovery(uid, NEW_CODE, "rotate_recovery");
  const rotated = await backend.request("rotate_recovery", null, { new_recovery_code: NEW_CODE }, { expectedUid: uid });
  assert.equal(rotated.ok, true);
  const exported = await backend.request("export", null, {}, { expectedUid: uid });
  assert.equal(JSON.stringify(exported).includes(OLD_CODE), false);
  assert.equal(JSON.stringify(exported).includes(NEW_CODE), false);
  assert.equal(JSON.stringify(backend.pendingRecovery(uid)).includes("source"), false);
  assert.deepEqual(Object.keys(backend.pendingRecovery(uid)).sort(), ["code", "phase", "purpose", "uid", "version"]);
  server.stats.responseOverride = () => ({ data: { recovery_code: OLD_CODE }, error: null });
  await assert.rejects(backend.request("export", null, {}, { expectedUid: uid }), (error) => error.status === 502);
});

test("no authenticated session never reaches RPC and a null server response is never a successful save", async () => {
  const { backend, mock } = makeBackend();
  const state = await backend.request("session");
  assert.equal(state.authenticated, false);
  assert.equal(state.enrolled, false);
  assert.equal(state.progress.practice_total, 2);
  assert.equal(state.progress.practice_requirement, 2);
  await assert.rejects(backend.request("save", "task-1", { stage: 1, revision: 0, answers: { readability: "A" } }), (error) => error.status === 401);
  assert.equal(mock.stats.calls.length, 0);
  const uid = await backend.ensureAnonymousIdentity({ purpose: "enroll" });
  await backend.request("enroll", null, { display_name: "A", recovery_code: OLD_CODE }, { expectedUid: uid });
  mock.server.stats.nullAction = "save";
  await assert.rejects(backend.request("save", "task-1", { stage: 1, revision: 0, answers: { readability: "A" } }, { expectedUid: uid }), (error) => error.status === 502);
});

test("two tabs never send an old task write under a different active Auth UID", async () => {
  const localStorage = memoryStorage();
  const server = makeServer();
  const authBus = createAuthBus();
  const tabOne = makeBackend({ localStorage, sessionStorage: memoryStorage(), server, authBus });
  const tabTwo = makeBackend({ localStorage, sessionStorage: memoryStorage(), server, authBus });
  const uidOne = await startParticipant(tabOne.backend, "First", OLD_CODE);
  const secondTabSession = await tabTwo.backend.request("session");
  assert.equal(secondTabSession.participant_id, "participant-1");
  // The second tab explicitly leaves the first participant, then creates a
  // distinct workspace. Supabase Auth storage is shared by the two tabs.
  const secondTabUid = await tabTwo.backend.identityUid();
  tabTwo.backend.storePendingRecovery(secondTabUid, OLD_CODE, "enroll", "confirmation");
  tabTwo.backend.confirmPendingRecovery(secondTabUid, OLD_CODE);
  await tabTwo.backend.switchParticipant();
  const uidTwo = await tabTwo.backend.ensureAnonymousIdentity({ purpose: "enroll" });
  await tabTwo.backend.request("enroll", null, { display_name: "Second", recovery_code: NEW_CODE }, { expectedUid: uidTwo });
  assert.notEqual(uidOne, uidTwo);
  assert.equal(tabOne.backend.isFrozen(), true);
  const callsBefore = server.stats.calls.length;
  await assert.rejects(tabOne.backend.request("save", "task-old", { stage: 1, revision: 0, answers: { readability: "A" } }, { expectedUid: uidOne }), (error) => error.code === "IDENTITY_CHANGED");
  assert.equal(server.stats.calls.length, callsBefore);
  assert.equal((await tabTwo.backend.request("session")).display_name, "Second");
  await tabOne.backend.adoptCurrentIdentityAfterReload();
  assert.equal((await tabOne.backend.request("session")).display_name, "Second");
});

test("explicit recovery can replace a stale tab pin only after the requested anonymous UID succeeds", async () => {
  const localStorage = memoryStorage();
  const sessionStorage = memoryStorage();
  const first = makeBackend({ localStorage, sessionStorage });
  const oldUid = await startParticipant(first.backend, "Recovery", OLD_CODE);
  // Simulate the old Auth session having disappeared while the per-tab pin
  // remains. Enrollment must not silently create a replacement identity.
  localStorage.removeItem("human-annotation-open-v1");
  await assert.rejects(first.backend.ensureAnonymousIdentity({ purpose: "enroll" }), (error) => error.status === 409);
  // A user-entered recovery operation is the one explicit path allowed to
  // establish a fresh anonymous UID and rebind this participant.
  const newUid = await first.backend.ensureAnonymousIdentity({ purpose: "recover" });
  assert.notEqual(newUid, oldUid);
  assert.equal(await first.backend.identityUid(), newUid);
});

test("RPC errors are sanitized and Auth secrets never reach browser logging", async () => {
  const { backend, server } = makeBackend();
  const uid = await startParticipant(backend, "Safe", OLD_CODE);
  const originalLog = console.log;
  const logs = [];
  console.log = (...args) => logs.push(args.join(" "));
  try {
    server.stats.failAction = "save";
    await assert.rejects(backend.request("save", "task-1", { stage: 1, revision: 0, answers: { readability: "A" } }, { expectedUid: uid }), (error) => {
      assert.equal(error.status, 409);
      assert.equal(error.message.includes("private backend detail"), false);
      return true;
    });
  } finally { console.log = originalLog; }
  assert.deepEqual(logs, []);
  const calls = server.stats.calls;
  assert.equal(JSON.stringify(calls).includes(OLD_CODE), true); // It exists only in the request payload in this synthetic harness.
  assert.equal(JSON.stringify(backend.pendingRecovery(uid)).includes(OLD_CODE), false);
});

test("optional CAPTCHA has no third-party request when unconfigured and uses explicit widget only when configured", async () => {
  const scripts = [];
  const noCaptcha = makeBackend({
    documentObject: { createElement() { scripts.push("created"); return {}; }, head: { append() { scripts.push("appended"); } } },
    windowObject: {},
  });
  assert.equal(await noCaptcha.backend.getCaptchaToken({}), null);
  noCaptcha.backend.resetCaptcha();
  assert.deepEqual(scripts, []);

  let widgetOptions;
  let resets = 0;
  const configured = makeBackend({
    config: { ...CONFIG, turnstileSiteKey: "synthetic-turnstile-site-key-0123456789" },
    documentObject: { createElement() { return {}; }, head: { append(script) { script.onload(); } } },
    windowObject: { turnstile: {
      render(_element, options) { widgetOptions = options; options.callback("synthetic-captcha-token"); return 7; },
      reset() { resets += 1; },
    } },
  });
  assert.equal(await configured.backend.getCaptchaToken({ hidden: true }), "synthetic-captcha-token");
  assert.equal(widgetOptions.sitekey, "synthetic-turnstile-site-key-0123456789");
  configured.backend.resetCaptcha();
  assert.equal(resets, 1);
});

test("malformed recovery credentials are rejected before any RPC", async () => {
  const { backend, mock } = makeBackend();
  const uid = await backend.ensureAnonymousIdentity({ purpose: "enroll" });
  await assert.rejects(backend.request("enroll", null, { display_name: "Name", recovery_code: "short" }, { expectedUid: uid }), (error) => error.status === 400);
  await assert.rejects(backend.request("recover", null, { recovery_code: OLD_CODE, new_recovery_code: "short" }, { expectedUid: uid }), AnnotationBackendError);
  assert.equal(mock.stats.calls.length, 0);
});
