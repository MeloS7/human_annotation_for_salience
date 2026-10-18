import { createClient } from "@supabase/supabase-js";
import "./source-display.js";
import "./source-layouts.js";
import * as stageState from "./stage-state.js";
import { createAnnotationBackend } from "./backend-client.js";

const backend = createAnnotationBackend(window.HUMAN_ANNOTATION_CONFIG, {
  createClient,
  localStorage: window.localStorage,
  sessionStorage: window.sessionStorage,
  documentObject: document,
  windowObject: window,
});

window.HumanAnnotationBackend = backend;
window.HumanPreferenceStageState = stageState;

// The app reads the backend from the global above and keeps the existing
// DOM-based reading and annotation interface. Loading it only after the
// Supabase client is ready avoids any unauthenticated startup RPC.
await import("./app.js");
