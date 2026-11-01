import { createHash } from 'node:crypto';

export const KEY_VERSION = 'qualification-pilot-20261020-v1';
export const POLICY_VERSION = 'qualification-required-20261101-v1';
export const FEEDBACK_VERSION = 'qualification-feedback-en-20261101-v1';
export const DIMENSIONS = [
  'source_coverage', 'reference_coverage', 'readability', 'faithfulness', 'content_focus',
];
export const SCORED_MASK = [
  ['source_coverage', 'readability'],
  ['source_coverage', 'faithfulness'],
  ['source_coverage', 'content_focus'],
  ['readability', 'faithfulness'],
  ['readability', 'reference_coverage'],
  ['readability', 'content_focus'],
  ['faithfulness', 'content_focus'],
  ['faithfulness', 'reference_coverage'],
  ['content_focus', 'reference_coverage'],
  [],
];

export function canonical(value) {
  return JSON.stringify(value, (_, nested) => nested && typeof nested === 'object' && !Array.isArray(nested)
    ? Object.fromEntries(Object.entries(nested).sort(([left], [right]) => left.localeCompare(right)))
    : nested);
}

export function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function makeQualificationFixture() {
  const templates = [];
  const keys = [];
  for (let scheme = 1; scheme <= 3; scheme += 1) {
    for (let position = 1; position <= 10; position += 1) {
      const qualificationId = `Q${String(position).padStart(2, '0')}`;
      const dataset = position <= 5 ? 'cnndm' : 'gumsum';
      const templateId = `qualification-${scheme}-${position}`;
      const coordinator = {
        qualification_version: KEY_VERSION,
        qualification_id: qualificationId,
        dataset,
        source_id: `SYNTHETIC-${scheme}-${position}`,
        review_orientation_swapped: scheme === 2,
      };
      const payload = {
        request: `Qualification request ${scheme}-${position}`,
        source: `Qualification source ${scheme}-${position}`,
        reference: `Qualification reference ${scheme}-${position}`,
        summary_a: `Summary A ${scheme}-${position}`,
        summary_b: `Summary B ${scheme}-${position}`,
      };
      const hashes = Object.fromEntries(Object.entries(payload).map(([name, value]) => [`${name}_sha256`, sha256(value)]));
      templates.push({
        template_id: templateId,
        scheme,
        kind: 'qualification',
        position,
        payload,
        hashes,
        coordinator,
      });
      const scored = new Set(SCORED_MASK[position - 1]);
      const suggestions = Object.fromEntries(DIMENSIONS.map((dimension, index) => {
        const canonicalLabel = (position + index) % 2 ? 'A' : 'B';
        const label = !scored.has(dimension) ? 'Tie'
          : scheme === 2 ? (canonicalLabel === 'A' ? 'B' : 'A') : canonicalLabel;
        return [dimension, {
          label,
          scored: scored.has(dimension),
          rationale_zh: `${String.fromCodePoint(0x5408, 0x6210)} ${qualificationId} ${dimension}`,
          confidence: scored.has(dimension) ? 'high' : 'synthetic',
        }];
      }));
      keys.push({
        template_id: templateId,
        qualification_version: KEY_VERSION,
        qualification_id: qualificationId,
        dataset,
        title_zh: `${String.fromCodePoint(0x5408, 0x6210)} ${qualificationId}`,
        suggestions,
      });
    }
  }
  const fingerprint = sha256(canonical({ templates, keys }));
  return {
    config: {
      qualification_version: KEY_VERSION,
      item_count: 10,
      scored_total: 18,
      fingerprint,
    },
    templates,
    keys,
  };
}

export function makeCanonicalFeedback() {
  const items = Array.from({ length: 10 }, (_, index) => {
    const qualificationId = `Q${String(index + 1).padStart(2, '0')}`;
    return {
      qualification_id: qualificationId,
      title_en: `Question ${qualificationId}: A title that remains unchanged`,
      rationales_en: {
        source_coverage: 'A includes more of the source information than B.',
        reference_coverage: 'A better covers the reference content than B.',
        readability: 'A is clearer and easier to read than B.',
        faithfulness: 'A is more faithful to the source than B.',
        content_focus: 'A stays more focused on the main content than B.',
      },
    };
  });
  return {
    feedback_version: FEEDBACK_VERSION,
    qualification_version: KEY_VERSION,
    language: 'en',
    canonical_scheme: 1,
    items,
  };
}
