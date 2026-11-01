import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import {
  DIMENSIONS, FEEDBACK_VERSION, KEY_VERSION, POLICY_VERSION, SCORED_MASK,
  makeCanonicalFeedback, makeQualificationFixture,
} from './english_feedback_fixture.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const BUILDER = path.join(ROOT, 'scripts/build-english-feedback-setup.py');
const MIGRATIONS = await Promise.all([
  '20261018000000_annotation_api.sql',
  '20261018010000_two_practice_tasks.sql',
  '20261020000000_qualification_pilot.sql',
  '20261101000000_mandatory_qualification.sql',
  '20261101010000_fixed_packages.sql',
].map((file) => readFile(new URL(`../supabase/migrations/${file}`, import.meta.url), 'utf8')));
const ENGLISH_MIGRATION = await readFile(
  new URL('../supabase/migrations/20261101020000_english_feedback.sql', import.meta.url), 'utf8',
);

const uid = (n) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const sha = (value) => createHash('sha256').update(value, 'utf8').digest('hex');
const cjk = /[\u3400-\u9fff]/u;

function labelFor(position, dimension, scheme = 1) {
  const index = DIMENSIONS.indexOf(dimension);
  const scored = SCORED_MASK[position - 1].includes(dimension);
  if (!scored) return 'Tie';
  const canonical = (position + index) % 2 ? 'A' : 'B';
  return scheme === 2 ? (canonical === 'A' ? 'B' : 'A') : canonical;
}

async function buildPrivateSetup(scratch) {
  const fixturePath = path.join(scratch, 'qualification-fixture.private.json');
  const feedbackPath = path.join(scratch, 'english-catalog.private.json');
  const sqlPath = path.join(scratch, 'activation.private.sql');
  const expandedPath = path.join(scratch, 'expanded.private.json');
  await writeFile(fixturePath, JSON.stringify(makeQualificationFixture()), { mode: 0o600 });
  await writeFile(feedbackPath, JSON.stringify(makeCanonicalFeedback()), { mode: 0o600 });
  const result = spawnSync('python3', ['-B', BUILDER,
    '--qualification-fixture', fixturePath,
    '--feedback', feedbackPath,
    '--output-sql', sqlPath,
    '--expanded-output', expandedPath,
  ], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return { sql: await readFile(sqlPath, 'utf8'), expanded: JSON.parse(await readFile(expandedPath, 'utf8')) };
}

async function bootstrap() {
  const db = new PGlite();
  await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create schema auth;
    create table auth.users (id uuid primary key, is_anonymous boolean not null default true);
    create function auth.uid() returns uuid language sql stable
      as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth to anon, authenticated;
    grant execute on function auth.uid() to anon, authenticated;
  `);
  await db.exec(MIGRATIONS[0]);
  await db.exec(`begin;${MIGRATIONS[1]}commit;`);
  const rubric = {
    criteria: DIMENSIONS.map((id, index) => ({ id, label: id, stage: index === 1 ? 2 : 1, question: id, bullets: ['Synthetic criterion.'] })),
    choices: [{ value: 'A', definition: 'Summary A' }, { value: 'B', definition: 'Summary B' }, { value: 'Tie', definition: 'Neither summary is preferred' }],
    reference_intro: 'Review the reference.',
    shared_instructions: ['Synthetic instructions.'],
  };
  await db.query(
    `insert into annotation_private.settings
       (id, study_fingerprint, instruction_fingerprint, rubric_version, rubric, guide_md, enrollment_open)
     values (1, 'synthetic-study', 'synthetic-instructions', 'rubric-v1', $1::jsonb, '# Synthetic guide', true)`,
    [JSON.stringify(rubric)],
  );

  for (let scheme = 1; scheme <= 3; scheme += 1) {
    for (let position = 1; position <= 126; position += 1) {
      await insertTemplate(db, {
        templateId: `study-${scheme}-${position}`,
        scheme,
        kind: 'study',
        position,
        coordinator: { pair_id: `study-pair-${position}` },
      });
    }
    for (let position = 1; position <= 8; position += 1) {
      await insertTemplate(db, {
        templateId: `practice-${scheme}-${position}`,
        scheme,
        kind: 'practice',
        position,
        coordinator: null,
      });
    }
  }

  await db.exec(`begin;${MIGRATIONS[2]}commit;`);
  const fixture = makeQualificationFixture();
  const fingerprint = fixture.config.fingerprint;
  await db.query(
    `insert into annotation_private.qualification_sets
       (qualification_version, fingerprint, item_count, scored_total, pass_count, key_status)
     values ($1, $2, 10, 18, 15, 'llm_suggested_unvalidated')`,
    [KEY_VERSION, fingerprint],
  );
  for (const template of fixture.templates) {
    const key = fixture.keys.find((row) => row.template_id === template.template_id);
    const payload = {
      request: `Qualification request ${template.coordinator.qualification_id}`,
      source: `Qualification source ${template.coordinator.qualification_id}`,
      reference: `Qualification reference ${template.coordinator.qualification_id}`,
      summary_a: `Summary A ${template.coordinator.qualification_id}`,
      summary_b: `Summary B ${template.coordinator.qualification_id}`,
    };
    const hashes = Object.fromEntries(Object.entries(payload).map(([name, value]) => [`${name}_sha256`, sha(value)]));
    await db.query(
      `insert into annotation_private.templates
         (template_id, scheme, kind, position, payload, hashes, coordinator)
       values ($1, $2, 'qualification', $3, $4::jsonb, $5::jsonb, $6::jsonb)`,
      [template.template_id, template.scheme, template.position, JSON.stringify(payload), JSON.stringify(hashes), JSON.stringify(template.coordinator)],
    );
    await db.query(
      `insert into annotation_private.qualification_keys
         (qualification_version, template_id, qualification_id, dataset, title_zh, suggestions)
       values ($1, $2, $3, $4, $5, $6::jsonb)`,
      [KEY_VERSION, template.template_id, key.qualification_id, key.dataset, key.title_zh, JSON.stringify(key.suggestions)],
    );
  }
  await db.query('update annotation_private.settings set qualification_version = $1 where id = 1', [KEY_VERSION]);
  await db.exec(`begin;${MIGRATIONS[3]}commit;`);
  const guide = '# Before you begin\n\nComplete all 10 qualification comparisons before starting the study.\n';
  await db.query(
    `insert into annotation_private.qualification_policies
       (policy_version, qualification_version, fingerprint, pass_count, scored_total,
        key_status, confirmed_scored_count, workflow_guide_md, workflow_guide_sha256)
     values ($1, $2, $3, 14, 18, 'human_confirmed_scored', 18, $4, $5)`,
    [POLICY_VERSION, KEY_VERSION, fingerprint, guide, sha(guide)],
  );
  await db.query('update annotation_private.settings set qualification_policy_version = $1 where id = 1', [POLICY_VERSION]);
  await db.exec(`begin;${MIGRATIONS[4]}commit;`);
  return { db, fingerprint };
}

async function insertTemplate(db, { templateId, scheme, kind, position, coordinator }) {
  const payload = {
    request: `Request ${templateId}`,
    source: `Source document ${templateId}`,
    summary_a: `Summary A ${templateId}`,
    summary_b: `Summary B ${templateId}`,
    reference: `Reference ${templateId}`,
  };
  const hashes = Object.fromEntries(Object.entries(payload).map(([name, value]) => [`${name}_sha256`, sha(value)]));
  await db.query(
    `insert into annotation_private.templates
       (template_id, scheme, kind, position, payload, hashes, coordinator)
     values ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb)`,
    [templateId, scheme, kind, position, JSON.stringify(payload), JSON.stringify(hashes), coordinator === null ? null : JSON.stringify(coordinator)],
  );
}

async function addParticipant(db, n, scheme, { completed = 10, mismatches = 0 } = {}) {
  const userId = uid(n);
  const participantId = `participant-${n}`;
  const recoveryHash = sha(`recovery-${n}`);
  await db.query('insert into auth.users (id, is_anonymous) values ($1, true)', [userId]);
  await db.query(
    `insert into annotation_private.participants
       (participant_id, auth_user_id, display_name, recovery_hash, scheme, guide_ack_at, qualification_version)
     values ($1, $2, $3, decode($4, 'hex'), $5, now(), $6)`,
    [participantId, userId, `Synthetic ${n}`, recoveryHash, scheme, KEY_VERSION],
  );
  const mismatchCells = new Set();
  for (let position = 1; position <= 10 && mismatchCells.size < mismatches; position += 1) {
    for (const dimension of SCORED_MASK[position - 1]) {
      if (mismatchCells.size < mismatches) mismatchCells.add(`${position}:${dimension}`);
    }
  }
  for (let position = 1; position <= completed; position += 1) {
    const templateId = `qualification-${scheme}-${position}`;
    const answers = Object.fromEntries(DIMENSIONS.map((dimension) => {
      const suggestion = labelFor(position, dimension, scheme);
      const label = mismatchCells.has(`${position}:${dimension}`)
        ? (suggestion === 'A' ? 'B' : suggestion === 'B' ? 'A' : 'Tie')
        : suggestion;
      return [dimension, label];
    }));
    await db.query(
      `insert into annotation_private.assignments
         (task_id, participant_id, template_id, kind, position, stage, status, revision,
          stage1_answers, stage2_answers, locked_at, reference_released_at, completed_at)
       values ($1, $2, $3, 'qualification', $4, 2, 'complete', 3, $5::jsonb, $6::jsonb, now(), now(), now())`,
      [
        `task-${participantId}-${position}`, participantId, templateId, position,
        JSON.stringify(Object.fromEntries(Object.entries(answers).filter(([dimension]) => dimension !== 'reference_coverage'))),
        JSON.stringify({ reference_coverage: answers.reference_coverage }),
      ],
    );
  }
  if (completed > 0) {
    await db.query(
      `insert into annotation_private.events (participant_id, task_id, event_type, revision, payload)
       values ($1, $2, 'synthetic_saved', 3, '{"saved":true}'::jsonb)`,
      [participantId, `task-${participantId}-1`],
    );
  }
  if (completed === 10) await db.query('select annotation_private._evaluate_qualification($1)', [participantId]);
  return { userId, participantId };
}

async function asRole(db, role, userId, fn) {
  await db.query("select set_config('request.jwt.claim.sub', $1, false)", [userId ?? '']);
  await db.exec(`set role ${role}`);
  try { return await fn(); } finally { await db.exec('reset role'); }
}

async function api(db, userId, action) {
  return asRole(db, 'authenticated', userId, async () => {
    const result = await db.query(
      'select public.annotation_api($1, null, \'{}\'::jsonb) as response', [action],
    );
    return result.rows[0].response;
  });
}

async function currentResult(db, participantId) {
  return (await db.query('select annotation_private._current_qualification_result($1) as result', [participantId])).rows[0].result;
}

async function snapshotCore(db) {
  const tables = [
    ['settings', 'id', "to_jsonb(x) - 'qualification_feedback_version'"],
    ['participants', 'participant_id', 'to_jsonb(x)'],
    ['templates', 'template_id', 'to_jsonb(x)'],
    ['qualification_sets', 'qualification_version', 'to_jsonb(x)'],
    ['qualification_keys', 'template_id', 'to_jsonb(x)'],
    ['qualification_policies', 'policy_version', 'to_jsonb(x)'],
    ['qualification_results', 'participant_id', 'to_jsonb(x)'],
    ['assignments', 'task_id', 'to_jsonb(x)'],
    ['events', 'event_id', 'to_jsonb(x)'],
    ['fixed_package_sets', 'assignment_version', 'to_jsonb(x)'],
    ['fixed_package_slots', 'assignment_version, package_id', 'to_jsonb(x)'],
    ['fixed_package_items', 'assignment_version, package_id, position', 'to_jsonb(x)'],
    ['fixed_package_participants', 'participant_id', 'to_jsonb(x)'],
    ['fixed_package_task_assignments', 'assignment_version, participant_id, item_position', 'to_jsonb(x)'],
  ];
  const result = {};
  for (const [table, order, projection] of tables) {
    const sort = order.split(',').map((column) => `x.${column.trim()}`).join(',');
    result[table] = (await db.query(`select ${projection} as row from annotation_private.${table} x order by ${sort}`)).rows;
  }
  return result;
}

function publicProjection(result) {
  return {
    matched: result.matched,
    total: result.total,
    pass_count: result.pass_count,
    state: result.state,
    overall: result.overall,
    dimensions: result.dimensions,
    items: result.items.map((item) => ({
      id: item.id,
      number: item.number,
      qualification_id: item.qualification_id,
      dataset: item.dataset,
      dimensions: item.dimensions.map((dimension) => ({
        id: dimension.id,
        answer: dimension.answer,
        suggested: dimension.suggested,
        matches: dimension.matches,
        scored: dimension.scored,
      })),
    })),
  };
}

function assertEnglishResult(result, scheme) {
  assert.equal(result.feedback_language, 'en');
  assert.equal(result.feedback_version, FEEDBACK_VERSION);
  assert.equal(result.items.length, 10);
  for (const item of result.items) {
    assert.equal(typeof item.title_en, 'string');
    assert.equal('title_zh' in item, false);
    assert.equal(item.dimensions.length, 5);
    for (const dimension of item.dimensions) {
      assert.equal(typeof dimension.rationale_en, 'string');
      assert.equal('rationale_zh' in dimension, false);
      assert.doesNotMatch(dimension.rationale_en, cjk);
    }
    assert.doesNotMatch(item.title_en, cjk);
    const expected = scheme === 2
      ? 'B includes more of the source information than A.'
      : 'A includes more of the source information than B.';
    assert.equal(item.dimensions.find((dimension) => dimension.id === 'source_coverage').rationale_en, expected);
  }
}

test('English feedback overlays only completed presentation and preserves active scores and saved data', async () => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'english-feedback-backend-'));
  const { db, fingerprint } = await bootstrap();
  try {
    const passed = await addParticipant(db, 1, 1, { mismatches: 4 });
    const failed = await addParticipant(db, 2, 2, { mismatches: 5 });
    const thirdScheme = await addParticipant(db, 3, 3, { mismatches: 0 });
    const inProgress = await addParticipant(db, 4, 1, { completed: 0, mismatches: 0 });
    const oldResults = new Map();
    const rawResults = new Map();
    for (const participant of [passed, failed, thirdScheme]) {
      const result = await currentResult(db, participant.participantId);
      oldResults.set(participant.participantId, result);
      rawResults.set(participant.participantId, (await db.query(
        'select result from annotation_private.qualification_results where participant_id = $1',
        [participant.participantId],
      )).rows[0].result);
      assert.ok(result.items[0].title_zh);
      assert.ok(result.items[0].dimensions[0].rationale_zh);
    }
    assert.equal((await currentResult(db, inProgress.participantId)), null);
    const before = await snapshotCore(db);
    await db.exec(`begin;${ENGLISH_MIGRATION}commit;`);
    for (const participant of [passed, failed, thirdScheme]) {
      assert.deepEqual(await currentResult(db, participant.participantId), oldResults.get(participant.participantId));
    }
    const dormantExport = await api(db, passed.userId, 'export');
    assert.deepEqual(dormantExport.qualification_result, oldResults.get(passed.participantId));
    assert.deepEqual(dormantExport.qualification_original_result, rawResults.get(passed.participantId));
    assert.deepEqual(await snapshotCore(db), before);

    const setup = await buildPrivateSetup(scratch);
    assert.equal(setup.expanded.qualification_fingerprint, fingerprint);
    await db.exec(setup.sql);
    assert.deepEqual(await snapshotCore(db), before);

    const counts = await db.query(`
      select feedback.language, count(item.template_id)::integer as template_count,
             count(item.title_en)::integer as title_count,
             sum((select count(*) from jsonb_object_keys(item.rationales_en)))::integer as rationale_count,
             policy.pass_count, policy.scored_total
      from annotation_private.settings settings
      join annotation_private.qualification_feedback_sets feedback
        on feedback.feedback_version = settings.qualification_feedback_version
      join annotation_private.qualification_feedback_items item using (feedback_version)
      join annotation_private.qualification_policies policy
        on policy.policy_version = settings.qualification_policy_version
      group by feedback.language, policy.pass_count, policy.scored_total`);
    assert.deepEqual(counts.rows[0], {
      language: 'en', template_count: 30, title_count: 30, rationale_count: 150,
      pass_count: 14, scored_total: 18,
    });

    for (const [participant, score, state] of [
      [passed, 14, 'passed'], [failed, 13, 'failed'], [thirdScheme, 18, 'passed'],
    ]) {
      const actual = await currentResult(db, participant.participantId);
      assert.equal(actual.matched, score, JSON.stringify(actual));
      assert.equal(actual.total, 18);
      assert.equal(actual.pass_count, 14);
      assert.equal(actual.state, state);
      assert.deepEqual(publicProjection(actual), publicProjection(oldResults.get(participant.participantId)));
      assertEnglishResult(actual, participant === failed ? 2 : participant === thirdScheme ? 3 : 1);
    }
    assert.equal(await currentResult(db, inProgress.participantId), null);
    await assert.rejects(api(db, inProgress.userId, 'qualification_results'), (error) => error.code === 'PT403');
    const partialExport = await api(db, inProgress.userId, 'export');
    assert.equal(partialExport.qualification_result, null);
    assert.equal(partialExport.qualification_original_result, null);

    const exported = await api(db, passed.userId, 'export');
    assertEnglishResult(exported.qualification_result, 1);
    assertEnglishResult(exported.qualification_original_result, 1);
    assert.equal(exported.qualification_result.matched, 14);
    assert.equal(exported.qualification_original_result.matched, 14);
    const stored = (await db.query(
      'select result from annotation_private.qualification_results where participant_id = $1',
      [passed.participantId],
    )).rows[0].result;
    assert.deepEqual(stored, rawResults.get(passed.participantId));
    assert.ok(stored.items[0].title_zh);
    assert.doesNotMatch(JSON.stringify(exported.qualification_original_result), cjk);

    const privileges = await db.query(`
      select has_table_privilege('authenticated', 'annotation_private.qualification_feedback_items', 'select') as table_read,
             has_function_privilege('authenticated', 'annotation_private._present_qualification_result_english(text,jsonb)', 'execute') as helper_execute`);
    assert.deepEqual(privileges.rows[0], { table_read: false, helper_execute: false });
    await assert.rejects(
      db.query("update annotation_private.qualification_feedback_items set title_en = 'Changed' where feedback_version = $1 and template_id = 'qualification-1-1'", [FEEDBACK_VERSION]),
    );
    await assert.rejects(db.query("update annotation_private.settings set qualification_feedback_version = null where id = 1"));

    const beforeRerun = await snapshotCore(db);
    await db.exec(setup.sql);
    assert.deepEqual(await snapshotCore(db), beforeRerun);
    assertEnglishResult(await currentResult(db, passed.participantId), 1);
  } finally {
    await db.close();
    await rm(scratch, { recursive: true, force: true });
  }
});
