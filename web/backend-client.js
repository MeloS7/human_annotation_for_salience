const RPC_ACTIONS = new Set([
  "session", "acknowledge", "task", "save", "lock", "reference", "complete", "problem", "export", "qualification_results", "start_qualification",
  "enroll", "recover", "rotate_recovery",
]);
const TASK_ACTIONS = new Set(["task", "save", "lock", "reference", "complete", "problem"]);
const SQLSTATE_STATUS = Object.freeze({ PT400: 400, PT401: 401, PT403: 403, PT404: 404, PT409: 409, PT503: 503 });
const PIN_KEY = "human-annotation-active-auth-uid-v1";
const PENDING_PREFIX = "human-annotation-recovery-pending-v1:";
const RECOVERY_PURPOSES = new Set(["enroll", "recover", "rotate_recovery"]);
const RECOVERY_PHASES = new Set(["requesting", "confirmation"]);
const TURNSTILE_SCRIPT = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

export class AnnotationBackendError extends Error {
  constructor(status, message, code = "") {
    super(message);
    this.name = "AnnotationBackendError";
    this.status = status;
    this.code = code;
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validRecoveryCode(value) {
  return typeof value === "string" && /^SAL-[A-F0-9]{64}$/.test(value);
}

export function normalizeRecoveryCode(value) {
  const normalized = typeof value === "string" ? value.trim().toUpperCase() : "";
  if (!validRecoveryCode(normalized)) {
    throw new AnnotationBackendError(400, "Enter the complete private recovery code in the format SAL- followed by 64 letters or numbers.");
  }
  return normalized;
}

export function generateRecoveryCode(cryptoSource = globalThis.crypto) {
  if (!cryptoSource || typeof cryptoSource.getRandomValues !== "function") {
    throw new AnnotationBackendError(503, "This browser cannot securely create a recovery code. Use an up-to-date browser and try again.");
  }
  const bytes = new Uint8Array(32);
  cryptoSource.getRandomValues(bytes);
  return `SAL-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("").toUpperCase()}`;
}

export function normalizeDisplayName(value) {
  if (typeof value !== "string") throw new AnnotationBackendError(400, "Enter a display nickname.");
  const name = value.trim();
  const characters = Array.from(name);
  if (!characters.length || characters.length > 40 || /[\p{Cc}\p{Cf}]/u.test(name)) {
    throw new AnnotationBackendError(400, "Use a nickname of 1–40 characters without control characters.");
  }
  return name;
}

export function validatePublicConfig(config) {
  if (!isRecord(config)) throw new Error("Public Supabase configuration is missing.");
  const supabaseUrl = typeof config.supabaseUrl === "string" ? config.supabaseUrl.trim() : "";
  const publishableKey = typeof config.publishableKey === "string" ? config.publishableKey.trim() : "";
  if (!supabaseUrl || !publishableKey) throw new Error("Public Supabase configuration is incomplete.");

  let parsedUrl;
  try { parsedUrl = new URL(supabaseUrl); }
  catch (_) { throw new Error("Public Supabase URL is invalid."); }
  const localHttp = parsedUrl.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(parsedUrl.hostname);
  if (parsedUrl.protocol !== "https:" && !localHttp) throw new Error("Public Supabase URL must use HTTPS.");
  if (parsedUrl.pathname !== "/" || parsedUrl.username || parsedUrl.password || parsedUrl.search || parsedUrl.hash) {
    throw new Error("Public Supabase URL must be a project origin without credentials or URL parameters.");
  }
  if (/^(sb_secret_|eyj)/i.test(publishableKey) || /service_role/i.test(publishableKey)) {
    throw new Error("A public publishable key is required; secret keys are not accepted.");
  }
  if (!publishableKey.startsWith("sb_publishable_")) throw new Error("Supabase configuration must use a publishable key.");

  const turnstileSiteKey = config.turnstileSiteKey === undefined || config.turnstileSiteKey === null
    ? ""
    : String(config.turnstileSiteKey).trim();
  if (turnstileSiteKey && !/^[A-Za-z0-9_-]{20,}$/.test(turnstileSiteKey)) {
    throw new Error("The optional Turnstile site key is invalid.");
  }
  return Object.freeze({ supabaseUrl: parsedUrl.origin, publishableKey, turnstileSiteKey });
}

export function mapAppRequest(path, payload) {
  if (typeof path !== "string") throw new AnnotationBackendError(400, "Unsupported application request.");
  const body = payload === undefined ? {} : payload;
  if (!isRecord(body)) throw new AnnotationBackendError(400, "Request data must be an object.");

  if (["/api/session", "/api/export", "/api/qualification-results"].includes(path) && payload === undefined) {
    const action = path === "/api/qualification-results" ? "qualification_results" : path.slice("/api/".length);
    return { type: "rpc", action, taskId: null, payload: {} };
  }
  const noTaskActions = new Map([
    ["/api/acknowledge", "acknowledge"], ["/api/enroll", "enroll"],
    ["/api/recover", "recover"], ["/api/rotate-recovery", "rotate_recovery"],
    ["/api/start-qualification", "start_qualification"],
  ]);
  if (noTaskActions.has(path) && payload !== undefined) {
    return { type: "rpc", action: noTaskActions.get(path), taskId: null, payload: body };
  }

  const match = /^\/api\/task\/([^/]+)(?:\/(reference|save|lock|complete|problem))?$/.exec(path);
  if (!match) throw new AnnotationBackendError(400, "Unsupported application request.");
  let taskId;
  try { taskId = decodeURIComponent(match[1]); }
  catch (_) { throw new AnnotationBackendError(400, "The comparison identifier is invalid."); }
  if (!taskId) throw new AnnotationBackendError(400, "The comparison identifier is invalid.");
  const action = match[2] || "task";
  if (action === "task" || action === "reference") {
    if (payload !== undefined) throw new AnnotationBackendError(400, "This request does not accept changes.");
    return { type: "rpc", action, taskId, payload: {} };
  }
  if (payload === undefined) throw new AnnotationBackendError(400, "Request data is required.");
  return { type: "rpc", action, taskId, payload: body };
}

function safeAuthError(error, fallback = "The sign-in service could not be reached. Please retry.") {
  const status = Number.isInteger(error && error.status) ? error.status : 0;
  if (status === 429) return new AnnotationBackendError(429, "Too many sign-in attempts. Please wait a moment before trying again.");
  if (status === 400 || status === 401) return new AnnotationBackendError(401, "The sign-in could not be completed. Check the recovery code if you were recovering progress.");
  return new AnnotationBackendError(status || 0, fallback);
}

function safeRpcError(error) {
  const code = error && typeof error.code === "string" ? error.code : "";
  const status = SQLSTATE_STATUS[code] || (Number.isInteger(error && error.status) ? error.status : 0);
  const messages = {
    400: "The request was not accepted. Check the information and try again.",
    401: "Your sign-in could not be verified. Your unsaved choices remain in this tab; do not start a new identity before saving or recovering.",
    403: "This action is not available for the current account.",
    404: "This comparison is no longer available.",
    409: "This comparison changed elsewhere. Reload its saved state before continuing.",
    503: "Enrollment or storage is temporarily unavailable. Please try again later.",
  };
  if (status === 0) return new AnnotationBackendError(0, "The annotation service could not be reached. Your changes have not been confirmed as saved.", code);
  return new AnnotationBackendError(status || 500, messages[status] || "The request could not be completed.", code);
}

function containsCredentialField(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (["recoverycode", "recoveryhash", "authuserid", "authuid", "accesstoken", "refreshtoken", "authorization", "jwt", "servicerole"].includes(normalized)) return true;
    if (containsCredentialField(child, seen)) return true;
  }
  return false;
}

function safeRpcResult(data) {
  if (!isRecord(data) || containsCredentialField(data)) {
    throw new AnnotationBackendError(502, "The annotation service returned an unexpected response. No recovery credential was accepted from the server.");
  }
  return data;
}

function sessionUid(session) {
  return session && session.user && typeof session.user.id === "string" ? session.user.id : null;
}

function storageGet(storage, key, message) {
  try { return storage ? storage.getItem(key) : null; }
  catch (_) { throw new AnnotationBackendError(503, message); }
}
function storageSet(storage, key, value, message) {
  try { if (!storage) throw new Error("storage unavailable"); storage.setItem(key, value); }
  catch (_) { throw new AnnotationBackendError(503, message); }
}
function storageRemove(storage, key, message) {
  try { if (storage) storage.removeItem(key); }
  catch (_) { throw new AnnotationBackendError(503, message); }
}

export function createAnnotationBackend(config, {
  createClient,
  localStorage = globalThis.localStorage,
  sessionStorage = globalThis.sessionStorage,
  cryptoSource = globalThis.crypto,
  documentObject = globalThis.document,
  windowObject = globalThis.window,
} = {}) {
  if (typeof createClient !== "function") throw new TypeError("A Supabase client factory is required.");
  let checkedConfig;
  let client;
  let configurationError = null;
  let frozen = false;
  let frozenReason = "";
  let explicitRecoveryTransition = false;
  let recoveryTransitionUid = null;
  let knownParticipantUid = null;
  const listeners = new Set();
  let captchaScriptPromise = null;
  let captchaWidgetId = null;
  let captchaElement = null;
  let captchaResolve = null;
  let captchaReject = null;

  try {
    checkedConfig = validatePublicConfig(config);
    if (!localStorage || !sessionStorage) throw new Error("This browser must allow local and session storage for private progress.");
    client = createClient(checkedConfig.supabaseUrl, checkedConfig.publishableKey, {
      auth: {
        autoRefreshToken: true,
        detectSessionInUrl: false,
        persistSession: true,
        storage: localStorage,
        storageKey: "human-annotation-open-v1",
      },
    });
  } catch (error) {
    configurationError = error instanceof Error ? error : new Error("Public Supabase configuration is invalid.");
  }

  function pinnedUid() {
    return storageGet(sessionStorage, PIN_KEY, "This tab cannot securely track its sign-in. Enable session storage and reload.");
  }

  function freeze(reason = "A different participant was opened in another tab.") {
    if (frozen) return;
    frozen = true;
    frozenReason = reason;
    for (const listener of listeners) {
      try { listener({ reason: frozenReason }); } catch (_) { /* UI listener errors must not affect Auth */ }
    }
  }

  function assertPinned(uid) {
    if (frozen) throw new AnnotationBackendError(409, "This tab is frozen because its sign-in changed. Reload and explicitly continue with the current participant.", "IDENTITY_CHANGED");
    const pin = pinnedUid();
    if (!pin) {
      if (!uid) return;
      storageSet(sessionStorage, PIN_KEY, uid, "This tab could not pin its sign-in. Enable session storage and reload.");
      return;
    }
    if (!uid) return;
    if (uid !== pin) {
      if (explicitRecoveryTransition && recoveryTransitionUid === uid) {
        storageSet(sessionStorage, PIN_KEY, uid, "This tab could not pin the recovered sign-in. Enable session storage and reload.");
        explicitRecoveryTransition = false;
        recoveryTransitionUid = null;
        return;
      }
      freeze();
      throw new AnnotationBackendError(409, "A different participant was opened in another tab. This tab is frozen to protect unsaved work.", "IDENTITY_CHANGED");
    }
  }

  async function requireClient() {
    if (configurationError || !client) throw new AnnotationBackendError(503, configurationError ? configurationError.message : "Annotation service is not configured.");
    return client;
  }

  async function authSession() {
    const supabase = await requireClient();
    let result;
    try { result = await supabase.auth.getSession(); }
    catch (_) { throw new AnnotationBackendError(0, "The sign-in service could not be reached. Your current work has not been discarded."); }
    if (result && result.error) throw safeAuthError(result.error, "Your sign-in could not be checked. Your current work has not been discarded.");
    const session = result && result.data ? result.data.session || null : null;
    assertPinned(sessionUid(session));
    return session;
  }

  function pendingKey(uid) { return `${PENDING_PREFIX}${uid}`; }
  function readPending(uid) {
    if (typeof uid !== "string" || !uid) return null;
    const raw = storageGet(localStorage, pendingKey(uid), "The private recovery-code backup could not be read.");
    if (!raw) return null;
    let data;
    try { data = JSON.parse(raw); } catch (_) { throw new AnnotationBackendError(409, "A recovery-code backup is damaged. Keep this browser open and contact the coordinator before switching participants."); }
    if (!isRecord(data) || data.version !== 1 || data.uid !== uid || !validRecoveryCode(data.code) || !RECOVERY_PURPOSES.has(data.purpose) || !RECOVERY_PHASES.has(data.phase)) {
      throw new AnnotationBackendError(409, "A recovery-code backup is not in a usable state. Keep this browser open and contact the coordinator before switching participants.");
    }
    const allowed = ["version", "uid", "code", "purpose", "phase"];
    if (Object.keys(data).some((key) => !allowed.includes(key))) throw new AnnotationBackendError(409, "The local recovery backup contains unexpected information and cannot be used safely.");
    return Object.freeze(data);
  }

  function storePendingRecovery(uid, code, purpose, phase = "requesting") {
    if (typeof uid !== "string" || !uid || !validRecoveryCode(code) || !RECOVERY_PURPOSES.has(purpose) || !RECOVERY_PHASES.has(phase)) {
      throw new AnnotationBackendError(400, "The private recovery information is invalid.");
    }
    const existing = readPending(uid);
    if (existing) {
      if (existing.code === code && existing.purpose === purpose) return existing;
      throw new AnnotationBackendError(409, "A different recovery code is awaiting confirmation. Save or resolve it before starting another action.");
    }
    const record = { version: 1, uid, code, purpose, phase };
    storageSet(localStorage, pendingKey(uid), JSON.stringify(record), "Your recovery code could not be stored safely in this browser. Nothing has been submitted; check browser storage and retry.");
    return Object.freeze(record);
  }

  function setPendingPhase(uid, code, phase) {
    const existing = readPending(uid);
    if (!existing || existing.code !== code || !RECOVERY_PHASES.has(phase)) throw new AnnotationBackendError(409, "The pending recovery code changed. Keep this page open and retry.");
    const updated = { ...existing, phase };
    storageSet(localStorage, pendingKey(uid), JSON.stringify(updated), "Your recovery confirmation could not be saved in this browser.");
    return Object.freeze(updated);
  }

  function confirmPendingRecovery(uid, code) {
    const existing = readPending(uid);
    if (!existing || existing.code !== code || existing.phase !== "confirmation") throw new AnnotationBackendError(409, "The recovery code has not yet been confirmed by the service.");
    storageRemove(localStorage, pendingKey(uid), "The recovery code could not be cleared after confirmation.");
    return true;
  }

  async function invokeRpc(action, taskId, payload, session) {
    const supabase = await requireClient();
    let result;
    try {
      let query = supabase.rpc("annotation_api", { p_action: action, p_task_id: taskId, p_payload: payload });
      if (!query || typeof query.setHeader !== "function") throw new Error("Supabase RPC builder unavailable");
      query = query.setHeader("Authorization", `Bearer ${session.access_token}`);
      result = await query;
    } catch (error) {
      if (error instanceof AnnotationBackendError) throw error;
      throw new AnnotationBackendError(0, "The annotation service could not be reached. Your changes have not been confirmed as saved.");
    }
    const { data, error } = result || {};
    if (error) throw safeRpcError(error);
    return safeRpcResult(data);
  }

  async function request(action, taskId = null, payload = {}, { expectedUid } = {}) {
    if (!RPC_ACTIONS.has(action)) throw new AnnotationBackendError(400, "Unsupported application action.");
    if (!isRecord(payload)) throw new AnnotationBackendError(400, "Request data must be an object.");
    if (TASK_ACTIONS.has(action) && (typeof taskId !== "string" || taskId.length === 0)) throw new AnnotationBackendError(400, "A comparison identifier is required.");
    if (!TASK_ACTIONS.has(action) && taskId !== null) throw new AnnotationBackendError(400, "This action does not accept a comparison identifier.");
    if (action === "enroll") {
      normalizeDisplayName(payload.display_name);
      if (!validRecoveryCode(payload.recovery_code)) throw new AnnotationBackendError(400, "The private recovery code is invalid.");
    }
    if (action === "recover") {
      if (!validRecoveryCode(payload.recovery_code) || !validRecoveryCode(payload.new_recovery_code)) throw new AnnotationBackendError(400, "The private recovery code is invalid.");
    }
    if (action === "rotate_recovery" && !validRecoveryCode(payload.new_recovery_code)) throw new AnnotationBackendError(400, "The new private recovery code is invalid.");

    const auth = await authSession();
    const uid = sessionUid(auth);
    if (!auth || !uid) {
      if (action === "session") {
        return {
          authenticated: false, enrolled: false, needs_enrollment: true, mode: "study", participant_id: null,
          display_name: null, accepted_instructions: false, tasks: [],
          progress: { study_total: 126, study_completed: 0, practice_total: 2, practice_completed: 0, practice_requirement: 2, paused: 0 },
          rubric: { criteria: [], choices: [], shared_instructions: [] }, guide_md: "",
        };
      }
      throw new AnnotationBackendError(401, "Start or recover a participant session before continuing.");
    }
    if (expectedUid && uid !== expectedUid) {
      freeze();
      throw new AnnotationBackendError(409, "This saved action belongs to the previous participant. The tab is frozen to protect their work.", "IDENTITY_CHANGED");
    }
    const result = await invokeRpc(action, taskId, payload, auth);
    const after = await authSession();
    if (sessionUid(after) !== uid) {
      freeze();
      throw new AnnotationBackendError(409, "The participant changed while this request was in progress. Reload to see the saved server state.", "IDENTITY_CHANGED");
    }
    if (action === "session" && (result.authenticated !== true || typeof result.enrolled !== "boolean")) {
      throw new AnnotationBackendError(502, "The annotation service could not confirm this participant session.");
    }
    if (action === "session" && result.enrolled === true) knownParticipantUid = uid;
    if (action === "session" && result.enrolled === false && knownParticipantUid === uid) {
      freeze("This workspace was recovered elsewhere, so this sign-in no longer has access.");
      throw new AnnotationBackendError(409, "This workspace was recovered elsewhere. This tab is frozen and cannot save changes under the old sign-in.", "IDENTITY_CHANGED");
    }
    if (result.enrolled === true && action === "session" && (typeof result.participant_id !== "string" || typeof result.display_name !== "string")) {
      throw new AnnotationBackendError(502, "The annotation service returned an incomplete participant session.");
    }
    return result;
  }

  async function ensureAnonymousIdentity({ captchaToken = null, purpose = "enroll" } = {}) {
    const supabase = await requireClient();
    if (frozen) throw new AnnotationBackendError(409, "This tab is frozen. Reload before opening another participant.", "IDENTITY_CHANGED");
    const existing = await authSession();
    if (existing && sessionUid(existing)) return sessionUid(existing);
    const priorPin = pinnedUid();
    if (priorPin && purpose !== "recover") {
      throw new AnnotationBackendError(409, "This browser has a previous participant sign-in. Recover that workspace with its private code or explicitly switch participants before starting another.");
    }
    if (captchaToken && !checkedConfig.turnstileSiteKey) throw new AnnotationBackendError(400, "CAPTCHA is not configured for this study.");
    let result;
    explicitRecoveryTransition = Boolean(priorPin && purpose === "recover");
    recoveryTransitionUid = null;
    try {
      result = await supabase.auth.signInAnonymously(captchaToken
        ? { options: { captchaToken } }
        : undefined);
    } catch (_) {
      explicitRecoveryTransition = false;
      recoveryTransitionUid = null;
      throw new AnnotationBackendError(0, "A private participant session could not be started. Your current browser data has not been cleared.");
    }
    const { data, error } = result || {};
    if (error) {
      explicitRecoveryTransition = false;
      recoveryTransitionUid = null;
      throw safeAuthError(error, "A private participant session could not be started. Please retry.");
    }
    const resultUid = data && data.user && typeof data.user.id === "string" ? data.user.id : null;
    if (!resultUid) {
      explicitRecoveryTransition = false;
      recoveryTransitionUid = null;
      throw new AnnotationBackendError(502, "Supabase did not return a participant session.");
    }
    if (explicitRecoveryTransition) recoveryTransitionUid = resultUid;
    const current = await authSession();
    if (sessionUid(current) !== resultUid) {
      explicitRecoveryTransition = false;
      recoveryTransitionUid = null;
      freeze();
      throw new AnnotationBackendError(409, "Another tab changed the sign-in while a new participant session was starting. This tab is frozen.", "IDENTITY_CHANGED");
    }
    if (explicitRecoveryTransition) {
      // A recovery is an explicit user action. Pin the new anonymous UID only
      // after Supabase confirms that the requested sign-in is the active one.
      storageSet(sessionStorage, PIN_KEY, resultUid, "This tab could not pin the recovered sign-in. Enable session storage and reload.");
      explicitRecoveryTransition = false;
      recoveryTransitionUid = null;
    }
    return resultUid;
  }

  async function switchParticipant() {
    const supabase = await requireClient();
    if (frozen) throw new AnnotationBackendError(409, "This tab is frozen. Reload before switching participants.", "IDENTITY_CHANGED");
    const current = await authSession();
    const uid = sessionUid(current);
    if (uid && readPending(uid)) throw new AnnotationBackendError(409, "Save and confirm the pending recovery code before switching participants.");
    try {
      const result = await supabase.auth.signOut({ scope: "local" });
      if (result && result.error) throw result.error;
    } catch (_) {
      throw new AnnotationBackendError(0, "The current participant could not be safely switched. This account remains active.");
    }
    storageRemove(sessionStorage, PIN_KEY, "The participant switch could not be completed safely.");
    knownParticipantUid = null;
  }

  async function currentUid() {
    const auth = await authSession();
    return sessionUid(auth);
  }

  async function adoptCurrentIdentityAfterReload() {
    if (!frozen) return;
    storageRemove(sessionStorage, PIN_KEY, "This tab could not reset its sign-in pin. Reload the page again.");
    frozen = false;
    frozenReason = "";
    knownParticipantUid = null;
  }

  function pendingRecovery(uid) { return readPending(uid); }

  async function ensureTurnstileScript() {
    if (!checkedConfig.turnstileSiteKey) return null;
    if (!documentObject || !windowObject) throw new AnnotationBackendError(503, "CAPTCHA cannot be displayed in this browser.");
    if (windowObject.turnstile && typeof windowObject.turnstile.render === "function") return windowObject.turnstile;
    if (!captchaScriptPromise) {
      captchaScriptPromise = new Promise((resolve, reject) => {
        const script = documentObject.createElement("script");
        script.src = TURNSTILE_SCRIPT;
        script.async = true;
        script.defer = true;
        script.onload = () => {
          if (windowObject.turnstile && typeof windowObject.turnstile.render === "function") resolve(windowObject.turnstile);
          else reject(new AnnotationBackendError(503, "The CAPTCHA service did not load correctly."));
        };
        script.onerror = () => reject(new AnnotationBackendError(503, "The CAPTCHA service could not be reached."));
        documentObject.head.append(script);
      }).catch((error) => { captchaScriptPromise = null; throw error; });
    }
    return captchaScriptPromise;
  }

  async function getCaptchaToken(container) {
    if (!checkedConfig.turnstileSiteKey) return null;
    if (!container) throw new AnnotationBackendError(503, "CAPTCHA could not be displayed. Reload and try again.");
    const turnstile = await ensureTurnstileScript();
    if (captchaElement && captchaWidgetId !== null && captchaElement !== container) {
      try { turnstile.remove(captchaWidgetId); } catch (_) { /* reset below */ }
      captchaWidgetId = null;
    }
    captchaElement = container;
    container.hidden = false;
    if (captchaWidgetId !== null) {
      try { turnstile.reset(captchaWidgetId); } catch (_) { captchaWidgetId = null; }
    }
    return new Promise((resolve, reject) => {
      captchaResolve = resolve;
      captchaReject = reject;
      const callbacks = {
        sitekey: checkedConfig.turnstileSiteKey,
        callback: (token) => { captchaResolve?.(String(token)); captchaResolve = null; captchaReject = null; },
        "error-callback": () => { captchaReject?.(new AnnotationBackendError(503, "CAPTCHA verification failed. Please retry.")); captchaResolve = null; captchaReject = null; },
        "expired-callback": () => { captchaReject?.(new AnnotationBackendError(503, "CAPTCHA expired. Please complete it again.")); captchaResolve = null; captchaReject = null; },
      };
      if (captchaWidgetId === null) captchaWidgetId = turnstile.render(container, callbacks);
    });
  }

  function resetCaptcha() {
    captchaResolve = null;
    captchaReject = null;
    if (!checkedConfig || !checkedConfig.turnstileSiteKey || captchaWidgetId === null || !windowObject?.turnstile) return;
    try { windowObject.turnstile.reset(captchaWidgetId); } catch (_) { /* next request rerenders if needed */ }
  }

  if (client && client.auth && typeof client.auth.onAuthStateChange === "function") {
    client.auth.onAuthStateChange((_event, nextSession) => {
      const uid = sessionUid(nextSession);
      const pin = (() => { try { return sessionStorage.getItem(PIN_KEY); } catch (_) { return null; } })();
      // A null session can be a transient refresh/sign-out; never adopt or
      // replace the pin automatically. Freeze only on a different live UID.
      if (uid && pin && uid !== pin && !explicitRecoveryTransition) freeze();
    });
  }

  return Object.freeze({
    configurationError,
    confirmPendingRecovery,
    ensureAnonymousIdentity,
    generateRecoveryCode: () => generateRecoveryCode(cryptoSource),
    getCaptchaToken,
    identityUid: currentUid,
    isFrozen: () => frozen,
    mapRequest: mapAppRequest,
    normalizeDisplayName,
    normalizeRecoveryCode,
    onIdentityChange(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    pendingRecovery,
    request,
    resetCaptcha,
    setPendingRecoveryPhase: setPendingPhase,
    storePendingRecovery,
    switchParticipant,
    adoptCurrentIdentityAfterReload,
  });
}
