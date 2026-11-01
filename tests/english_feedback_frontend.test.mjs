import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import {
  QUALIFICATION_DIMENSION_IDS,
  QUALIFICATION_FEEDBACK_LANGUAGE,
  QUALIFICATION_FEEDBACK_VERSION,
  QUALIFICATION_KEY_STATUS,
  QUALIFICATION_KEY_VERSION,
  QUALIFICATION_PASS_COUNT,
  QUALIFICATION_SCORED_TOTAL,
  WORKFLOW_VERSION,
  qualificationResultsReady,
} from "../web/stage-state.js";

function englishResults() {
  const items = Array.from({ length: 10 }, (_, index) => ({
    id: `qualification-task-${index + 1}`,
    number: index + 1,
    qualification_id: `Q${String(index + 1).padStart(2, "0")}`,
    dataset: index < 5 ? "cnndm" : "gumsum",
    title_en: `Translated qualification item ${index + 1}`,
    dimensions: QUALIFICATION_DIMENSION_IDS.map((id, dimensionIndex) => ({
      id,
      answer: "A",
      suggested: "A",
      matches: true,
      scored: dimensionIndex === 0 || (dimensionIndex === 1 && index < 8),
      rationale_en: `Summary A better preserves the ${id.replaceAll("_", " ")} criterion.`,
    })),
  }));
  const dimensions = QUALIFICATION_DIMENSION_IDS.map((id, dimensionIndex) => {
    const scoredTotal = dimensionIndex === 0 ? 10 : dimensionIndex === 1 ? 8 : 0;
    return {
      id,
      scored_matched: scoredTotal,
      scored_total: scoredTotal,
      scored_percent: scoredTotal ? 100 : null,
      all_matched: 10,
      all_total: 10,
      all_percent: 100,
    };
  });
  return {
    version: QUALIFICATION_KEY_VERSION,
    policy_version: WORKFLOW_VERSION,
    feedback_language: QUALIFICATION_FEEDBACK_LANGUAGE,
    feedback_version: QUALIFICATION_FEEDBACK_VERSION,
    confirmed_scored_count: QUALIFICATION_SCORED_TOTAL,
    key_status: QUALIFICATION_KEY_STATUS,
    state: "passed",
    matched: QUALIFICATION_SCORED_TOTAL,
    total: QUALIFICATION_SCORED_TOTAL,
    pass_count: QUALIFICATION_PASS_COUNT,
    percent: 100,
    overall: { matched: 50, total: 50, percent: 100 },
    dimensions,
    items,
    evaluated_at: "2026-10-20T12:00:00Z",
  };
}

class FakeElement {
  constructor(tag = "div") {
    this.tag = tag;
    this.textContent = "";
    this.children = [];
    this.hidden = false;
    this.className = "";
  }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = [...children]; }
  scrollIntoView() {}
}

function visibleText(element) {
  return [element.textContent, ...element.children.map((child) => visibleText(child))].join("");
}

async function renderResults(results) {
  const app = await readFile(new URL("../web/app.js", import.meta.url), "utf8");
  const start = app.indexOf("function appendResultCell");
  const end = app.indexOf("async function loadQualificationResults", start);
  assert.ok(start >= 0 && end > start, "result renderer should remain available");
  const nodes = new Map([
    "qualification-results-panel", "qualification-results-table", "qualification-items",
    "qualification-results-retry", "qualification-results-download", "qualification-continue-study-panel",
    "qualification-results-summary", "qualification-results-heading",
  ].map((id) => [id, new FakeElement(id)]));
  const context = {
    $: (id) => nodes.get(id),
    QUALIFICATION_DIMENSION_IDS,
    QUALIFICATION_LABELS: {
      source_coverage: "Source coverage",
      reference_coverage: "Reference coverage",
      readability: "Readability",
      faithfulness: "Faithfulness",
      content_focus: "Content focus",
    },
    QUALIFICATION_FEEDBACK_LANGUAGE,
    QUALIFICATION_FEEDBACK_VERSION,
    fixedPackageFull: () => false,
    document: {
      createElement: (tag) => new FakeElement(tag),
      createTextNode: (text) => Object.assign(new FakeElement("text"), { textContent: String(text) }),
    },
  };
  const renderer = app.slice(start, end);
  vm.runInNewContext(`${renderer}\nrenderQualificationResultsPanel(results);`, { ...context, results });
  return [...nodes.values()].map(visibleText).join("\n");
}

async function makeDownloadPayload(results) {
  const app = await readFile(new URL("../web/app.js", import.meta.url), "utf8");
  const start = app.indexOf("function qualificationResultsDownloadPayload");
  const end = app.indexOf("async function downloadQualificationResults", start);
  assert.ok(start >= 0 && end > start, "qualification download projection should remain available");
  return vm.runInNewContext(
    `${app.slice(start, end)}\nqualificationResultsDownloadPayload(results);`,
    { results, QUALIFICATION_FEEDBACK_LANGUAGE, QUALIFICATION_FEEDBACK_VERSION },
  );
}

test("English feedback projection is strictly validated and rendered without legacy fields", async () => {
  const results = englishResults();
  assert.equal(qualificationResultsReady(results), true);
  const rendered = await renderResults(results);
  assert.match(rendered, /Translated qualification item 1/);
  assert.match(rendered, /AI-suggested rationale: Summary A better preserves the source coverage criterion\./);
  assert.doesNotMatch(rendered, /title_zh|rationale_zh/);

  const missingTitle = structuredClone(results);
  delete missingTitle.items[0].title_en;
  assert.equal(qualificationResultsReady(missingTitle), false);
  const missingRationale = structuredClone(results);
  delete missingRationale.items[0].dimensions[0].rationale_en;
  assert.equal(qualificationResultsReady(missingRationale), false);
  const partialMetadata = structuredClone(results);
  delete partialMetadata.feedback_version;
  assert.equal(qualificationResultsReady(partialMetadata), false);
  const wrongVersion = structuredClone(results);
  wrongVersion.feedback_version = "unknown-feedback-version";
  assert.equal(qualificationResultsReady(wrongVersion), false);
  const nonAsciiCopy = structuredClone(results);
  nonAsciiCopy.items[0].title_en = "Ελληνικό title";
  assert.equal(qualificationResultsReady(nonAsciiCopy), false);
});

test("legacy result snapshots remain valid but render only neutral qualification IDs", async () => {
  const legacy = englishResults();
  delete legacy.feedback_language;
  delete legacy.feedback_version;
  for (const item of legacy.items) {
    item.title_zh = "LEGACY_TITLE_FIELD_MUST_NOT_RENDER";
    delete item.title_en;
    for (const dimension of item.dimensions) {
      dimension.rationale_zh = "LEGACY_RATIONALE_FIELD_MUST_NOT_RENDER";
      delete dimension.rationale_en;
    }
  }

  assert.equal(qualificationResultsReady(legacy), true);
  const rendered = await renderResults(legacy);
  assert.match(rendered, /Q01 · CNN\/DM/);
  assert.match(rendered, /Item titles and AI-suggested rationales are unavailable for this earlier result\./);
  assert.doesNotMatch(rendered, /LEGACY_TITLE_FIELD_MUST_NOT_RENDER|LEGACY_RATIONALE_FIELD_MUST_NOT_RENDER/);

  const download = await makeDownloadPayload(legacy);
  const serialized = JSON.stringify(download);
  assert.match(serialized, /Qualification item Q01/);
  assert.doesNotMatch(serialized, /LEGACY_TITLE_FIELD_MUST_NOT_RENDER|LEGACY_RATIONALE_FIELD_MUST_NOT_RENDER|title_zh|rationale_zh/);
  assert.equal("rationale_en" in download.items[0].dimensions[0], false);
});
