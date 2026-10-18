(function exposeSourceDisplay(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.HumanPreferenceSourceDisplay = api;
}(typeof globalThis === "undefined" ? this : globalThis, function createSourceDisplay() {
  "use strict";

  const CONTEXT_TOKEN = /<\/?context\b[^>]*>|<\/?context\b/gi;
  const OPEN_CONTEXT = "<context>";
  const CLOSE_CONTEXT = "</context>";

  function parseContextSegments(source) {
    if (typeof source !== "string") throw new TypeError("Source text must be a string.");

    const tokens = [];
    let token;
    CONTEXT_TOKEN.lastIndex = 0;
    while ((token = CONTEXT_TOKEN.exec(source)) !== null) {
      tokens.push({ value: token[0], index: token.index, end: CONTEXT_TOKEN.lastIndex });
    }

    if (tokens.length === 0) {
      return { valid: true, hasContext: false, segments: [{ kind: "text", text: source }] };
    }

    const segments = [];
    let cursor = 0;
    let contextStart = null;
    let valid = true;
    for (const item of tokens) {
      // The canonical delimiters are exact, lowercase tags. Treat malformed,
      // nested, or doubled tag-like sequences as literal source instead.
      if ((item.value !== OPEN_CONTEXT && item.value !== CLOSE_CONTEXT) ||
          (item.index > 0 && source[item.index - 1] === "<")) {
        valid = false;
        break;
      }
      if (item.value === OPEN_CONTEXT) {
        if (contextStart !== null) { valid = false; break; }
        if (item.index > cursor) segments.push({ kind: "text", text: source.slice(cursor, item.index) });
        contextStart = item.end;
      } else {
        if (contextStart === null) { valid = false; break; }
        segments.push({ kind: "context", text: source.slice(contextStart, item.index) });
        cursor = item.end;
        contextStart = null;
      }
    }

    if (contextStart !== null) valid = false;
    if (!valid) {
      return { valid: false, hasContext: false, segments: [{ kind: "text", text: source }] };
    }
    if (cursor < source.length) segments.push({ kind: "text", text: source.slice(cursor) });
    return { valid: true, hasContext: true, segments };
  }

  function escapeRegExpLiteral(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function splitStructureSegments(segments, offsetsUtf16) {
    if (!Array.isArray(segments)) throw new TypeError("Segments must be an array.");
    const unchanged = () => ({ valid: false, hasStructure: false, segments });
    if (!Array.isArray(offsetsUtf16)) return unchanged();
    if (offsetsUtf16.length === 0) {
      return { valid: true, hasStructure: false, segments };
    }

    let source = "";
    for (const segment of segments) {
      if (!segment || typeof segment.text !== "string") {
        throw new TypeError("Every segment must contain string text.");
      }
      source += segment.text;
    }

    let previous = 0;
    for (const offset of offsetsUtf16) {
      if (!Number.isInteger(offset) || offset <= previous || offset >= source.length) return unchanged();
      const before = source.charCodeAt(offset - 1);
      const after = source.charCodeAt(offset);
      if (before >= 0xD800 && before <= 0xDBFF && after >= 0xDC00 && after <= 0xDFFF) {
        return unchanged();
      }
      previous = offset;
    }

    const output = [];
    let sourceOffset = 0;
    let offsetIndex = 0;
    let structureGroup = 0;
    for (const segment of segments) {
      const text = segment.text;
      if (text.length === 0) {
        while (offsetIndex < offsetsUtf16.length && offsetsUtf16[offsetIndex] <= sourceOffset) {
          structureGroup += 1;
          offsetIndex += 1;
        }
        output.push({ ...segment, structureGroup });
        continue;
      }

      let localOffset = 0;
      while (localOffset < text.length) {
        const absoluteOffset = sourceOffset + localOffset;
        while (offsetIndex < offsetsUtf16.length && offsetsUtf16[offsetIndex] <= absoluteOffset) {
          structureGroup += 1;
          offsetIndex += 1;
        }
        const nextBoundary = offsetIndex < offsetsUtf16.length
          ? offsetsUtf16[offsetIndex]
          : source.length;
        const chunkEnd = Math.min(text.length, localOffset + nextBoundary - absoluteOffset);
        if (chunkEnd <= localOffset) return unchanged();
        output.push({
          ...segment,
          text: text.slice(localOffset, chunkEnd),
          structureGroup,
        });
        localOffset = chunkEnd;
      }
      sourceOffset += text.length;
    }
    return { valid: true, hasStructure: offsetsUtf16.length > 0, segments: output };
  }

  function isCollapsibleContextSeparator(segments, index, hasStructureLayout = false) {
    if (!Array.isArray(segments) || !Number.isInteger(index) || index < 0 || index >= segments.length) {
      return false;
    }
    const segment = segments[index];
    if (!segment || segment.kind !== "text" || typeof segment.text !== "string" || !/^[ \t]+$/.test(segment.text)) {
      return false;
    }

    const previous = segments[index - 1];
    const next = segments[index + 1];
    const isContext = (candidate) => candidate && candidate.kind === "context" &&
      typeof candidate.text === "string" && candidate.text.length > 0;
    if (isContext(previous) && isContext(next)) return true;
    if (!hasStructureLayout) return false;

    // A separator may sit immediately before/after an original structure
    // boundary, with a plain-text segment rather than a context segment on
    // the far side. Collapse only when that exact edge is adjacent to context.
    const atStructureEdge = (previous && previous.structureGroup !== undefined &&
        previous.structureGroup !== segment.structureGroup) ||
      (next && next.structureGroup !== undefined && next.structureGroup !== segment.structureGroup);
    return Boolean(atStructureEdge && (isContext(previous) || isContext(next)));
  }

  function findLiteralMatches(segments, query, limit = 1000) {
    if (!Array.isArray(segments)) throw new TypeError("Segments must be an array.");
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError("Match limit must be a positive integer.");
    if (typeof query !== "string" || query.length === 0) return { matches: [], truncated: false };

    const offsets = [];
    let renderedText = "";
    for (const segment of segments) {
      if (!segment || typeof segment.text !== "string") throw new TypeError("Every segment must contain string text.");
      offsets.push({ start: renderedText.length, end: renderedText.length + segment.text.length });
      renderedText += segment.text;
    }

    const pattern = new RegExp(escapeRegExpLiteral(query), "giu");
    const matches = [];
    let match;
    let truncated = false;
    while ((match = pattern.exec(renderedText)) !== null) {
      if (matches.length === limit) { truncated = true; break; }
      const start = match.index;
      const end = start + match[0].length;
      const parts = [];
      for (let index = 0; index < offsets.length; index += 1) {
        const segmentStart = offsets[index].start;
        const segmentEnd = offsets[index].end;
        const partStart = Math.max(start, segmentStart);
        const partEnd = Math.min(end, segmentEnd);
        if (partStart < partEnd) {
          parts.push({
            segmentIndex: index,
            start: partStart - segmentStart,
            end: partEnd - segmentStart,
          });
        }
      }
      matches.push({ start, end, text: match[0], parts });
    }
    return { matches, truncated };
  }

  return {
    parseContextSegments,
    splitStructureSegments,
    isCollapsibleContextSeparator,
    findLiteralMatches,
  };
}));
