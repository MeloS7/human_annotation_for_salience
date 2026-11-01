import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { makeCanonicalFeedback, makeQualificationFixture } from './english_feedback_fixture.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const BUILDER = path.join(ROOT, 'scripts/build-english-feedback-setup.py');
const MIGRATION = path.join(ROOT, 'supabase/migrations/20261101020000_english_feedback.sql');
const DIMENSIONS = [
  'source_coverage', 'reference_coverage', 'readability', 'faithfulness', 'content_focus',
];

async function makePrivateInputs(directory, feedback = makeCanonicalFeedback()) {
  const fixturePath = path.join(directory, 'qualification-pilot-expected-private.json');
  const feedbackPath = path.join(directory, 'qualification_feedback_en.canonical.private.json');
  await writeFile(fixturePath, JSON.stringify(makeQualificationFixture()), { mode: 0o600 });
  await writeFile(feedbackPath, JSON.stringify(feedback), { mode: 0o600 });
  return { fixturePath, feedbackPath };
}

function runBuilder({ fixturePath, feedbackPath, sqlPath, expandedPath }) {
  return spawnSync('python3', ['-B', BUILDER,
    '--qualification-fixture', fixturePath,
    '--feedback', feedbackPath,
    '--output-sql', sqlPath,
    '--expanded-output', expandedPath,
  ], { encoding: 'utf8' });
}

test('private feedback builder expands only English presentation for all 30 orientations', async () => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'english-feedback-setup-'));
  try {
    const { fixturePath, feedbackPath } = await makePrivateInputs(scratch);
    const sqlPath = path.join(scratch, '06_qualification_feedback_en.private.sql');
    const expandedPath = path.join(scratch, 'qualification_feedback_en.private.json');
    const result = runBuilder({ fixturePath, feedbackPath, sqlPath, expandedPath });
    assert.equal(result.status, 0, result.stderr);
    const migration = await readFile(MIGRATION, 'utf8');
    const sql = await readFile(sqlPath, 'utf8');
    const expanded = JSON.parse(await readFile(expandedPath, 'utf8'));
    assert.equal((await stat(sqlPath)).mode & 0o777, 0o600);
    assert.equal((await stat(expandedPath)).mode & 0o777, 0o600);
    assert.ok(Buffer.byteLength(sql, 'utf8') <= 900_000);
    assert.doesNotMatch(migration, /[\u3400-\u9fff]/u);
    assert.doesNotMatch(sql, /[\u3400-\u9fff]/u);
    assert.doesNotMatch(await readFile(expandedPath, 'utf8'), /[\u3400-\u9fff]/u);
    assert.match(migration, /qualification_feedback_version/);
    assert.equal(expanded.feedback_version, 'qualification-feedback-en-20261101-v1');
    assert.equal(expanded.qualification_version, 'qualification-pilot-20261020-v1');
    assert.equal(expanded.language, 'en');
    assert.equal(expanded.items.length, 30);
    assert.equal(new Set(expanded.items.map((item) => item.template_id)).size, 30);
    assert.equal(sql.includes('qualification_keys'), true);
    assert.equal(sql.includes('title_zh text'), false);
    for (let scheme = 1; scheme <= 3; scheme += 1) {
      for (let position = 1; position <= 10; position += 1) {
        const item = expanded.items.find((candidate) => candidate.template_id === `qualification-${scheme}-${position}`);
        assert.ok(item);
        assert.equal(item.qualification_id, `Q${String(position).padStart(2, '0')}`);
        assert.deepEqual(Object.keys(item.rationales_en).sort(), [...DIMENSIONS].sort());
        const expected = scheme === 2
          ? 'B includes more of the source information than A.'
          : 'A includes more of the source information than B.';
        assert.equal(item.rationales_en.source_coverage, expected);
        assert.equal(item.title_en, `Question Q${String(position).padStart(2, '0')}: A title that remains unchanged`);
      }
    }
    assert.match(sql, /v_before/);
    assert.match(sql, /v_after/);
    assert.match(sql, /qualification_feedback_version/);
    assert.match(sql, /rationale_count/);
    assert.match(sql, /qualification_original_result/);

    const rerun = runBuilder({ fixturePath, feedbackPath, sqlPath, expandedPath });
    assert.notEqual(rerun.status, 0);
    assert.match(rerun.stderr, /Refusing to overwrite/);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('private feedback builder rejects non-ASCII rationale text', async () => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'english-feedback-invalid-'));
  try {
    const feedback = makeCanonicalFeedback();
    feedback.items[0].rationales_en.readability = `A is clearer: caf${String.fromCodePoint(0xe9)}.`;
    const { fixturePath, feedbackPath } = await makePrivateInputs(scratch, feedback);
    const result = runBuilder({
      fixturePath,
      feedbackPath,
      sqlPath: path.join(scratch, 'activation.private.sql'),
      expandedPath: path.join(scratch, 'expanded.private.json'),
    });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /printable ASCII/);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
