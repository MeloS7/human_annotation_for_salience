"use strict";

const assert = require("node:assert/strict");
const { before, test } = require("node:test");

let findLiteralMatches;
let isCollapsibleContextSeparator;
let parseContextSegments;
let splitStructureSegments;

before(async () => {
  // The browser build imports this classic-script helper as an ES module so it
  // can attach its API to globalThis. Load it the same way in this package,
  // whose "type: module" setting makes require() return no UMD exports.
  await import("../web/source-display.js");
  ({
    findLiteralMatches,
    isCollapsibleContextSeparator,
    parseContextSegments,
    splitStructureSegments,
  } = globalThis.HumanPreferenceSourceDisplay);
});

function textOf(parsed) {
  return parsed.segments.map((segment) => segment.text).join("");
}

test("unmarked source is returned without changing any text", () => {
  const source = "  First line\n<img src=x onerror=alert(1)>\nLast line  ";
  const parsed = parseContextSegments(source);
  assert.equal(parsed.valid, true);
  assert.equal(parsed.hasContext, false);
  assert.equal(textOf(parsed), source);
  assert.deepEqual(parsed.segments, [{ kind: "text", text: source }]);
});

test("empty source and empty context content are handled without inventing text", () => {
  const empty = parseContextSegments("");
  assert.equal(empty.valid, true);
  assert.equal(empty.hasContext, false);
  assert.equal(textOf(empty), "");
  assert.deepEqual(empty.segments, [{ kind: "text", text: "" }]);

  const emptyContext = parseContextSegments("<context></context>");
  assert.equal(emptyContext.valid, true);
  assert.equal(emptyContext.hasContext, true);
  assert.equal(textOf(emptyContext), "");
  assert.deepEqual(emptyContext.segments, [{ kind: "context", text: "" }]);
  assert.deepEqual(findLiteralMatches(emptyContext.segments, "context").matches, []);
});

test("only balanced canonical context delimiters are removed from reading text", () => {
  const source = "Lead\n<context>Byline — Zoë\n</context> Body text.\n<context>Caption</context>End";
  const parsed = parseContextSegments(source);
  assert.equal(parsed.valid, true);
  assert.equal(parsed.hasContext, true);
  assert.equal(textOf(parsed), "Lead\nByline — Zoë\n Body text.\nCaptionEnd");
  assert.deepEqual(parsed.segments.map((segment) => segment.kind), ["text", "context", "text", "context", "text"]);
});

test("consecutive context blocks retain a single-space separator segment", () => {
  const source = "<context>Heading</context> <context>Byline</context>";
  const parsed = parseContextSegments(source);
  assert.equal(parsed.valid, true);
  assert.deepEqual(parsed.segments, [
    { kind: "context", text: "Heading" },
    { kind: "text", text: " " },
    { kind: "context", text: "Byline" },
  ]);
  assert.equal(textOf(parsed), "Heading Byline");
});

test("structure boundaries split text exactly and preserve original group order", () => {
  const segments = [
    { kind: "text", text: "intro " },
    { kind: "context", text: "Heading block" },
    { kind: "text", text: " rest" },
  ];
  const split = splitStructureSegments(segments, [6, 20]);
  assert.equal(split.valid, true);
  assert.equal(split.hasStructure, true);
  assert.equal(textOf(split), textOf({ segments }));
  assert.deepEqual(split.segments.map(({ kind, text, structureGroup }) => ({ kind, text, structureGroup })), [
    { kind: "text", text: "intro ", structureGroup: 0 },
    { kind: "context", text: "Heading block", structureGroup: 1 },
    { kind: "text", text: " ", structureGroup: 1 },
    { kind: "text", text: "rest", structureGroup: 2 },
  ]);
});

test("a single-space separator between consecutive contexts remains exact with layout", () => {
  const parsed = parseContextSegments("<context>Heading</context> <context>Byline</context>");
  const split = splitStructureSegments(parsed.segments, [8]);
  assert.equal(split.valid, true);
  assert.equal(textOf(split), "Heading Byline");
  assert.ok(split.segments.some((segment) => segment.text === " "));
});

test("horizontal whitespace beside context collapses only at a structure-group edge", () => {
  const source = "<context>Learning Objectives</context> Next section";
  const parsed = parseContextSegments(source);
  const clean = textOf(parsed);
  const boundary = clean.indexOf("Next");
  const split = splitStructureSegments(parsed.segments, [boundary]);
  assert.equal(split.valid, true);
  assert.equal(textOf(split), clean);
  assert.deepEqual(split.segments.map(({ kind, text, structureGroup }) => [kind, text, structureGroup]), [
    ["context", "Learning Objectives", 0],
    ["text", " ", 0],
    ["text", "Next section", 1],
  ]);
  assert.equal(isCollapsibleContextSeparator(split.segments, 1, true), true);
  assert.equal(isCollapsibleContextSeparator(parsed.segments, 1, false), false);

  const newlineSource = "<context>Learning Objectives</context>\nNext section";
  const newlineParsed = parseContextSegments(newlineSource);
  const newlineBoundary = textOf(newlineParsed).indexOf("Next");
  const newlineSplit = splitStructureSegments(newlineParsed.segments, [newlineBoundary]);
  assert.equal(isCollapsibleContextSeparator(newlineSplit.segments, 1, true), false);
  assert.equal(textOf(newlineSplit), "Learning Objectives\nNext section");

  const horizontalAndNewline = [{ kind: "text", text: " \n" }];
  assert.equal(isCollapsibleContextSeparator(horizontalAndNewline, 0, true), false);
});

test("structure offsets use JavaScript UTF-16 indexes and reject surrogate splits", () => {
  const source = "α😺 beta";
  const parsed = [{ kind: "text", text: source }];
  const betaOffset = source.indexOf("beta");
  assert.equal(betaOffset, 4);
  const split = splitStructureSegments(parsed, [betaOffset]);
  assert.equal(split.valid, true);
  assert.deepEqual(split.segments.map((segment) => [segment.text, segment.structureGroup]), [
    ["α😺 ", 0],
    ["beta", 1],
  ]);
  assert.equal(textOf(split), source);
  const splitSurrogate = splitStructureSegments(parsed, [2]);
  assert.equal(splitSurrogate.valid, false);
  assert.equal(textOf(splitSurrogate), source);
});

test("missing, empty, duplicate, unordered, noninteger, and out-of-range layouts fail closed", () => {
  const segments = [{ kind: "text", text: "abcdef" }];
  const missing = splitStructureSegments(segments);
  assert.equal(missing.valid, false);
  assert.equal(missing.hasStructure, false);
  assert.equal(missing.segments, segments);

  const empty = splitStructureSegments(segments, []);
  assert.equal(empty.valid, true);
  assert.equal(empty.hasStructure, false);
  assert.equal(empty.segments, segments);

  for (const offsets of [[0], [6], [2, 2], [4, 3], [1.5], ["2"], null]) {
    const result = splitStructureSegments(segments, offsets);
    assert.equal(result.valid, false, JSON.stringify(offsets));
    assert.equal(result.segments, segments, JSON.stringify(offsets));
  }
});

test("leading and trailing whitespace, newlines, and Unicode remain exact", () => {
  const source = " \n<context>  Καλημέρα, naïve café 😺\n  </context>\n end  \n";
  const parsed = parseContextSegments(source);
  assert.equal(parsed.valid, true);
  assert.equal(textOf(parsed), " \n  Καλημέρα, naïve café 😺\n  \n end  \n");
  assert.equal(parsed.segments[1].text, "  Καλημέρα, naïve café 😺\n  ");
});

test("malformed, unmatched, nested, or noncanonical marker sequences fall back literally", () => {
  const cases = [
    "<context>unclosed",
    "orphan</context>",
    "<context>a<context>b</context></context>",
    "<Context>case changed</Context>",
    "<context class=\"raw\">not canonical</context>",
    "<<context>extra opener</context>",
    "<context>incomplete close</context",
  ];
  for (const source of cases) {
    const parsed = parseContextSegments(source);
    assert.equal(parsed.valid, false, source);
    assert.equal(parsed.hasContext, false, source);
    assert.equal(textOf(parsed), source, source);
    assert.deepEqual(parsed.segments, [{ kind: "text", text: source }], source);
  }
});

test("literal search escapes regular-expression metacharacters and is case-insensitive", () => {
  const segments = [{ kind: "text", text: "Needles: A+B (x)? [end] and a+b (X)? [END]." }];
  for (const query of ["+", "(x)?", "[end]"]) {
    const { matches, truncated } = findLiteralMatches(segments, query);
    assert.equal(truncated, false);
    assert.equal(matches.length, 2, query);
    assert.ok(matches.every((match) => match.text.toLowerCase() === query.toLowerCase()));
  }
});

test("a match crossing a context boundary is one logical match with multiple render parts", () => {
  const segments = [
    { kind: "text", text: "before AL" },
    { kind: "context", text: "pha" },
    { kind: "text", text: "Beta after" },
  ];
  const { matches, truncated } = findLiteralMatches(segments, "alpha");
  assert.equal(truncated, false);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].text, "ALpha");
  assert.deepEqual(matches[0].parts, [
    { segmentIndex: 0, start: 7, end: 9 },
    { segmentIndex: 1, start: 0, end: 3 },
  ]);
});

test("search keeps a single logical match across original structure groups", () => {
  const split = splitStructureSegments(
    [{ kind: "text", text: "A key point remains." }],
    [7],
  );
  const { matches } = findLiteralMatches(split.segments, "point");
  assert.equal(matches.length, 1);
  assert.equal(matches[0].text, "point");
  assert.deepEqual(matches[0].parts, [
    { segmentIndex: 0, start: 6, end: 7 },
    { segmentIndex: 1, start: 0, end: 4 },
  ]);

  const crossBoundary = splitStructureSegments(
    [{ kind: "text", text: "The phrase crosses." }],
    [7],
  );
  const crossing = findLiteralMatches(crossBoundary.segments, "phrase");
  assert.equal(crossing.matches.length, 1);
  assert.equal(crossing.matches[0].text, "phrase");
  assert.equal(crossing.matches[0].parts.length, 2);
});

test("search match cap counts logical matches and signals truncation only when needed", () => {
  const exactlyLimit = [{ kind: "text", text: "x ".repeat(1000) }];
  const overLimit = [{ kind: "text", text: "x ".repeat(1001) }];
  const exact = findLiteralMatches(exactlyLimit, "x", 1000);
  const capped = findLiteralMatches(overLimit, "x", 1000);
  assert.equal(exact.matches.length, 1000);
  assert.equal(exact.truncated, false);
  assert.equal(capped.matches.length, 1000);
  assert.equal(capped.truncated, true);
});
