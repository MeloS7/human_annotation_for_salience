import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const MIGRATION_PATH = new URL('../supabase/migrations/20261018000000_annotation_api.sql', import.meta.url);
const MIGRATION = await readFile(MIGRATION_PATH, 'utf8');
const RUBRIC_VERSION = 'v2-two-stage-selection-only-v1';
const STAGE1 = {
  source_coverage: 'A',
  readability: 'Tie',
  faithfulness: 'B',
  content_focus: 'Tie',
};

function uid(number) {
  return `00000000-0000-4000-8000-${number.toString(16).padStart(12, '0')}`;
}

function recoveryCode(number) {
  return `SAL-${number.toString(16).padStart(2, '0').repeat(32)}`;
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function rubric() {
  return {
    criteria: [
      { id: 'source_coverage', label: 'Source coverage', stage: 1, question: 'Which summary covers the source?', bullets: ['Synthetic rubric text.'] },
      { id: 'readability', label: 'Readability', stage: 1, question: 'Which is clearer?', bullets: ['Synthetic rubric text.'] },
      { id: 'faithfulness', label: 'Faithfulness', stage: 1, question: 'Which is more faithful?', bullets: ['Synthetic rubric text.'] },
      { id: 'content_focus', label: 'Content focus', stage: 1, question: 'Which is more focused?', bullets: ['Synthetic rubric text.'] },
      { id: 'reference_coverage', label: 'Reference coverage', stage: 2, question: 'Which covers the reference?', bullets: ['Synthetic rubric text.'] },
    ],
    choices: [
      { value: 'A', definition: 'Summary A is better.' },
      { value: 'B', definition: 'Summary B is better.' },
      { value: 'Tie', definition: 'Neither is clearly better.' },
    ],
    reference_intro: 'Synthetic reference-stage instruction.',
    shared_instructions: ['Synthetic shared instruction.'],
  };
}

function templateMaterial(scheme, kind, position) {
  const id = `scheme-${scheme}-${kind}-${position}`;
  const request = `Synthetic request for ${id}`;
  const source = `Synthetic source text for ${kind} item ${position}, scheme ${scheme}.`;
  const reference = `PRIVATE_REFERENCE_SECRET_${id}`;
  let summaryA;
  let summaryB;
  let coordinator = null;
  if (kind === 'study') {
    const oursSide = scheme === 2 ? (position <= 63 ? 'B' : 'A')
      : scheme === 3 ? (position % 2 === 0 ? 'B' : 'A')
        : position <= 63 ? 'A' : 'B';
    const ours = `OURS_SUMMARY_${position}`;
    const standard = `STANDARD_SUMMARY_${position}`;
    summaryA = oursSide === 'A' ? ours : standard;
    summaryB = oursSide === 'B' ? ours : standard;
    coordinator = {
      pair_id: `PRIVATE_PAIR_${position}`,
      example_id: `PRIVATE_EXAMPLE_${position}`,
      dataset: position % 2 ? 'MACSum' : 'GUMSum',
      genre: `genre_${position % 11}`,
      macsum_length: position % 3 ? 'normal' : 'short',
      stratum: position % 3 ? 'improvement' : 'decline',
      ours_side: oursSide,
      summary_a_id: oursSide === 'A' ? `ours-${position}` : `standard-${position}`,
      summary_b_id: oursSide === 'B' ? `ours-${position}` : `standard-${position}`,
      summary_a_method: oursSide === 'A' ? 'PRIVATE_OURS_METHOD' : 'PRIVATE_STANDARD_METHOD',
      summary_b_method: oursSide === 'B' ? 'PRIVATE_OURS_METHOD' : 'PRIVATE_STANDARD_METHOD',
    };
  } else {
    summaryA = `Synthetic practice summary A for ${position}.`;
    summaryB = `Synthetic practice summary B for ${position}.`;
  }
  const payload = { request, source, summary_a: summaryA, summary_b: summaryB, reference };
  const hashes = {
    request_sha256: sha256(request),
    source_sha256: sha256(source),
    summary_a_sha256: sha256(summaryA),
    summary_b_sha256: sha256(summaryB),
    reference_sha256: sha256(reference),
  };
  return { templateId: id, payload, hashes, coordinator };
}

async function createAuthBase(db) {
  await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create schema auth;
    create table auth.users (id uuid primary key, is_anonymous boolean not null default true);
    create function auth.uid() returns uuid
      language sql stable
      as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth to anon, authenticated;
    grant execute on function auth.uid() to anon, authenticated;
  `);
}

async function insertAuthUser(db, userId) {
  await db.query('insert into auth.users(id, is_anonymous) values ($1, true) on conflict (id) do nothing', [userId]);
}

async function seedStudy(db, { enrollmentOpen = true, includeTemplates = true } = {}) {
  const settingsRubric = rubric();
  await db.query(
    `insert into annotation_private.settings
       (id, study_fingerprint, instruction_fingerprint, rubric_version, rubric, guide_md, enrollment_open)
     values (1, $1, $2, $3, $4::jsonb, $5, $6)`,
    [
      'synthetic-study-fingerprint', 'synthetic-instruction-fingerprint', RUBRIC_VERSION,
      JSON.stringify(settingsRubric), '# Synthetic guide\n', enrollmentOpen,
    ],
  );
  if (!includeTemplates) return;
  for (let scheme = 1; scheme <= 3; scheme += 1) {
    for (const kind of ['practice', 'study']) {
      const total = kind === 'practice' ? 8 : 126;
      for (let position = 1; position <= total; position += 1) {
        const material = templateMaterial(scheme, kind, position);
        await db.query(
          `insert into annotation_private.templates
             (template_id, scheme, kind, position, payload, hashes, coordinator)
           values ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb)`,
          [
            material.templateId, scheme, kind, position,
            JSON.stringify(material.payload), JSON.stringify(material.hashes),
            material.coordinator === null ? null : JSON.stringify(material.coordinator),
          ],
        );
      }
    }
  }
}

async function openDatabase(dataDir = undefined, options = {}) {
  const db = new PGlite(dataDir);
  await createAuthBase(db);
  await db.exec(MIGRATION);
  await seedStudy(db, options);
  return db;
}

async function withRole(db, role, userId, callback) {
  await db.query("select set_config('request.jwt.claim.sub', $1, false)", [userId ?? '']);
  await db.exec(`set role ${role}`);
  try {
    return await callback();
  } finally {
    await db.exec('reset role');
  }
}

async function api(db, userId, action, taskId = null, payload = {}) {
  return withRole(db, 'authenticated', userId, async () => {
    const result = await db.query(
      'select public.annotation_api($1, $2, $3::jsonb) as response',
      [action, taskId, payload === null ? null : JSON.stringify(payload)],
    );
    return result.rows[0].response;
  });
}

async function assertPgCode(promise, expectedCode) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, expectedCode, error.message);
    return true;
  });
}

async function enroll(db, userId, name, code) {
  await insertAuthUser(db, userId);
  return api(db, userId, 'enroll', null, { display_name: name, recovery_code: code });
}

function assignedTask(session, kind, position = 1) {
  const task = session.tasks.find((item) => item.kind === kind && item.position === position);
  assert.ok(task, `Missing ${kind} task ${position}`);
  return task;
}

async function completePractice(db, userId, taskId) {
  const task = await api(db, userId, 'task', taskId);
  const locked = await api(db, userId, 'lock', taskId, { revision: task.revision, answers: STAGE1 });
  const exposed = await api(db, userId, 'reference', taskId);
  return api(db, userId, 'complete', taskId, {
    revision: exposed.revision,
    answers: { reference_coverage: 'Tie' },
  }).then((completed) => ({ locked, exposed, completed }));
}

async function completeAllPractice(db, userId, session) {
  for (const task of session.tasks.filter((item) => item.kind === 'practice')) {
    await completePractice(db, userId, task.id);
  }
}

test('open enrollment assigns balanced schemes, independent names, and opaque state-only queues', async () => {
  const db = await openDatabase();
  try {
    const userIds = [1, 2, 3, 4].map(uid);
    for (const userId of userIds) await insertAuthUser(db, userId);

    const unregistered = await api(db, userIds[0], 'session');
    assert.deepEqual(unregistered, { authenticated: true, enrolled: false, needs_enrollment: true });
    assert.equal(JSON.stringify(unregistered).includes('Synthetic source'), false);
    assert.equal(JSON.stringify(unregistered).includes('PRIVATE_REFERENCE_SECRET'), false);

    const codes = [1, 2, 3, 4].map(recoveryCode);
    const sessions = [];
    for (let index = 0; index < userIds.length; index += 1) {
      sessions.push(await api(db, userIds[index], 'enroll', null, {
        display_name: 'Same nickname', recovery_code: codes[index],
      }));
    }
    assert.deepEqual(sessions.map((session) => session.enrolled), [true, true, true, true]);
    assert.deepEqual(sessions.map((session) => session.display_name), ['Same nickname', 'Same nickname', 'Same nickname', 'Same nickname']);
    assert.equal(new Set(sessions.map((session) => session.participant_id)).size, 4);
    assert.deepEqual(sessions.map((session) => session.tasks.length), [134, 134, 134, 134]);
    assert.deepEqual(sessions.map((session) => session.progress), userIds.map(() => ({
      study_total: 126, study_completed: 0, practice_total: 8, practice_completed: 0, paused: 0,
    })));
    for (const userId of userIds) {
      await api(db, userId, 'acknowledge', null, { accepted: true });
    }

    const participantRows = await db.query(
      'select participant_id, auth_user_id::text as auth_user_id, display_name, scheme, pg_catalog.octet_length(recovery_hash) as hash_bytes from annotation_private.participants order by auth_user_id',
    );
    assert.deepEqual(participantRows.rows.map((row) => Number(row.scheme)), [1, 2, 3, 1]);
    assert.deepEqual(participantRows.rows.map((row) => Number(row.hash_bytes)), [32, 32, 32, 32]);
    assert.deepEqual(participantRows.rows.map((row) => row.auth_user_id), userIds);

    const assignmentInventory = await db.query(
      `select participant_id, kind, count(*) as n, count(distinct task_id) as ids,
              count(distinct position) as positions
       from annotation_private.assignments group by participant_id, kind order by participant_id, kind`,
    );
    assert.equal(assignmentInventory.rows.length, 8);
    for (const row of assignmentInventory.rows) {
      const expected = row.kind === 'practice' ? 8 : 126;
      assert.equal(Number(row.n), expected);
      assert.equal(Number(row.ids), expected);
      assert.equal(Number(row.positions), expected);
    }

    const repeated = await api(db, userIds[0], 'enroll', null, {
      display_name: '  Same nickname  ', recovery_code: `  ${codes[0].toLowerCase()}\n`,
    });
    assert.equal(repeated.participant_id, sessions[0].participant_id);
    assert.deepEqual(repeated.tasks.map((task) => task.id), sessions[0].tasks.map((task) => task.id));
    await assertPgCode(api(db, userIds[0], 'enroll', null, {
      display_name: 'Changed name', recovery_code: recoveryCode(99),
    }), 'PT409');
    const afterRetry = await db.query('select count(*) as n from annotation_private.participants');
    assert.equal(Number(afterRetry.rows[0].n), 4);

    for (const session of sessions) {
      for (const [kind, count] of [['practice', 8], ['study', 126]]) {
        assert.deepEqual(
          session.tasks.filter((task) => task.kind === kind).map((task) => task.position),
          [...Array(count)].map((_, index) => index + 1),
        );
      }
      assert.equal(new Set(session.tasks.map((task) => task.id)).size, 134);
      assert.equal(session.tasks.some((task) => task.id.includes('scheme-')), false);
      assert.equal(JSON.stringify(session).includes('PRIVATE_PAIR_'), false);
      assert.equal(JSON.stringify(session).includes('PRIVATE_OURS_METHOD'), false);
      assert.equal(JSON.stringify(session).includes(codes[0]), false);
      assert.equal(JSON.stringify(session).includes('recovery_hash'), false);
      assert.equal(JSON.stringify(session).includes('Synthetic source text'), false);
    }

    const schemes = participantRows.rows;
    for (const scheme of [1, 2, 3]) {
      const participantRow = schemes.find((row) => Number(row.scheme) === scheme);
      const templateId = `scheme-${scheme}-study-1`;
      const mapping = await db.query(
        `select a.task_id, t.coordinator
         from annotation_private.assignments a join annotation_private.templates t using (template_id)
         where a.participant_id = $1 and a.template_id = $2`,
        [participantRow.participant_id, templateId],
      );
      assert.equal(mapping.rows.length, 1);
      const schemeSession = sessions.find((session) => session.participant_id === participantRow.participant_id);
      await completeAllPractice(db, participantRow.auth_user_id, schemeSession);
      const task = await api(db, participantRow.auth_user_id, 'task', mapping.rows[0].task_id);
      assert.equal(task.id.includes(templateId), false);
      assert.equal(task.summary_a, mapping.rows[0].coordinator.ours_side === 'A' ? 'OURS_SUMMARY_1' : 'STANDARD_SUMMARY_1');
      assert.equal(task.summary_b, mapping.rows[0].coordinator.ours_side === 'B' ? 'OURS_SUMMARY_1' : 'STANDARD_SUMMARY_1');
      assert.equal(Object.hasOwn(task, 'coordinator'), false);
      assert.equal(Object.hasOwn(task, 'template_id'), false);
      assert.equal(JSON.stringify(task).includes('PRIVATE_OURS_METHOD'), false);
    }
    const scheme1 = await db.query(
      `select t.coordinator->>'ours_side' as ours_side from annotation_private.templates t where template_id='scheme-1-study-1'`,
    );
    const scheme2 = await db.query(
      `select t.coordinator->>'ours_side' as ours_side from annotation_private.templates t where template_id='scheme-2-study-1'`,
    );
    assert.notEqual(scheme1.rows[0].ours_side, scheme2.rows[0].ours_side);
  } finally {
    await db.close();
  }
});

test('anonymous identities are isolated and the two-stage lifecycle, gates, exports, and admin actions stay private', async () => {
  const db = await openDatabase();
  try {
    const one = uid(10);
    const two = uid(11);
    const oneSession = await enroll(db, one, 'Volunteer One', recoveryCode(10));
    const twoSession = await enroll(db, two, 'Volunteer Two', recoveryCode(11));
    assert.notEqual(oneSession.participant_id, twoSession.participant_id);
    await assertPgCode(api(db, one, 'session', 'unexpected'), 'PT400');
    await assertPgCode(api(db, one, 'session', null, { extra: true }), 'PT400');
    await assertPgCode(api(db, one, 'acknowledge', null, { accepted: true, extra: true }), 'PT400');
    await assertPgCode(api(db, one, 'acknowledge', null, { accepted: false }), 'PT400');

    await assertPgCode(api(db, null, 'session'), 'PT401');
    await assertPgCode(api(db, uid(999), 'task', oneSession.tasks[0].id), 'PT401');
    await withRole(db, 'anon', null, async () => {
      await assertPgCode(db.query("select public.annotation_api('session', null, '{}'::jsonb)"), '42501');
      for (const table of ['settings', 'templates', 'participants', 'assignments', 'events']) {
        await assertPgCode(db.query(`select * from annotation_private.${table}`), '42501');
      }
      await assertPgCode(db.query("select annotation_private.export_all()"), '42501');
    });
    const protectedStatements = [
      'select * from annotation_private.settings',
      'select * from annotation_private.templates',
      'select * from annotation_private.participants',
      'select * from annotation_private.assignments',
      'select * from annotation_private.events',
      "select annotation_private._normalize_recovery_code('null'::jsonb)",
      "select annotation_private._normalize_display_name('null'::jsonb)",
      "select annotation_private._session_payload('participant_none')",
      'select annotation_private.export_all()',
      "select annotation_private.resolve_problem('participant_none', 'task_none')",
    ];
    await withRole(db, 'authenticated', one, async () => {
      for (const statement of protectedStatements) await assertPgCode(db.query(statement), '42501');
    });
    const rls = await db.query(`
      select count(*) as enabled
      from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'annotation_private'
        and c.relkind = 'r'
        and c.relrowsecurity
    `);
    assert.equal(Number(rls.rows[0].enabled), 5);
    const policyCount = await db.query("select count(*) as n from pg_catalog.pg_policies where schemaname='annotation_private'");
    assert.equal(Number(policyCount.rows[0].n), 0);

    const task1 = assignedTask(oneSession, 'practice').id;
    const study1 = assignedTask(oneSession, 'study').id;
    await assertPgCode(api(db, one, 'task', task1), 'PT403');
    const beforeAck = [
      ['save', { stage: 1, revision: 0, answers: { source_coverage: 'A' } }],
      ['lock', { revision: 0, answers: STAGE1 }],
      ['reference', {}],
      ['complete', { revision: 0, answers: { reference_coverage: 'A' } }],
      ['problem', { revision: 0, category: 'other_interface_problem', criteria: ['source_coverage'] }],
    ];
    for (const [action, payload] of beforeAck) await assertPgCode(api(db, one, action, task1, payload), 'PT403');
    assert.deepEqual(await api(db, one, 'acknowledge', null, { accepted: true }), { ok: true });
    assert.deepEqual(await api(db, one, 'acknowledge', null, { accepted: true }), { ok: true });
    await assertPgCode(api(db, one, 'task', study1), 'PT403');

    const draft = await api(db, one, 'task', task1);
    const taskMaterial = await db.query(
      `select t.payload from annotation_private.assignments a
       join annotation_private.templates t using (template_id)
       where a.task_id = $1 and a.participant_id = $2`,
      [task1, oneSession.participant_id],
    );
    assert.equal(taskMaterial.rows.length, 1);
    assert.deepEqual(Object.keys(draft).sort(), [
      'id', 'kind', 'position', 'total', 'stage', 'status', 'revision', 'request', 'source', 'source_sha256',
      'summary_a', 'summary_b', 'answers', 'locked_at', 'completed_at', 'reference_released_at',
    ].sort());
    assert.equal(draft.total, 8);
    assert.equal(Object.hasOwn(draft, 'reference'), false);
    assert.deepEqual(draft.answers, {});
    assert.equal(draft.source, taskMaterial.rows[0].payload.source);
    assert.equal(draft.source_sha256, sha256(draft.source));
    await assertPgCode(api(db, two, 'task', task1), 'PT404');
    await assertPgCode(api(db, one, 'reference', task1), 'PT403');
    await assertPgCode(api(db, one, 'task', task1, { hidden: true }), 'PT400');
    await assertPgCode(api(db, one, 'reference', task1, { hidden: true }), 'PT400');
    await assertPgCode(api(db, one, 'export', null, { hidden: true }), 'PT400');
    await assertPgCode(api(db, one, 'unknown_action'), 'PT400');
    await assertPgCode(api(db, one, 'task', ''), 'PT400');

    await assertPgCode(api(db, one, 'save', task1, { stage: true, revision: 0, answers: { source_coverage: 'A' } }), 'PT400');
    await assertPgCode(api(db, one, 'save', task1, { stage: 1, revision: true, answers: { source_coverage: 'A' } }), 'PT400');
    await assertPgCode(api(db, one, 'save', task1, { stage: 1, revision: 0, answers: { source_coverage: ['A'] } }), 'PT400');
    await assertPgCode(api(db, one, 'save', task1, { stage: 1, revision: 0, answers: { source_coverage: 'A', unknown: 'B' } }), 'PT400');
    const saved1 = await api(db, one, 'save', task1, { stage: 1, revision: 0, answers: { source_coverage: 'A' } });
    assert.equal(saved1.revision, 1);
    assert.deepEqual(saved1.answers, { source_coverage: 'A' });
    await assertPgCode(api(db, one, 'save', task1, { stage: 1, revision: 0, answers: { readability: 'B' } }), 'PT409');
    const saved2 = await api(db, one, 'save', task1, { stage: 1, revision: 1, answers: { readability: 'Tie' } });
    assert.equal(saved2.revision, 2);
    assert.deepEqual(saved2.answers, { source_coverage: 'A', readability: 'Tie' });
    await assertPgCode(api(db, one, 'lock', task1, { revision: 2, answers: { ...STAGE1, unknown: 'A' } }), 'PT400');
    await assertPgCode(api(db, one, 'lock', task1, { revision: 2, answers: { ...STAGE1, faithfulness: ['B'] } }), 'PT400');
    const locked = await api(db, one, 'lock', task1, { revision: 2, answers: STAGE1 });
    assert.equal(locked.status, 'locked');
    assert.equal(locked.stage, 2);
    assert.deepEqual(locked.answers, {});
    assert.equal(JSON.stringify(locked).includes('source_coverage'), false);
    assert.equal(Object.hasOwn(locked, 'reference'), false);
    const lockRetry = await api(db, one, 'lock', task1, { revision: 0, answers: STAGE1 });
    assert.equal(lockRetry.revision, locked.revision);
    for (const invalidRevision of [null, true, '0']) {
      await assertPgCode(api(db, one, 'lock', task1, { revision: invalidRevision, answers: STAGE1 }), 'PT400');
    }
    await assertPgCode(api(db, one, 'lock', task1, { revision: 0, answers: { ...STAGE1, source_coverage: 'B' } }), 'PT409');
    await assertPgCode(api(db, one, 'save', task1, { stage: 1, revision: 3, answers: { readability: 'A' } }), 'PT409');
    await assertPgCode(api(db, one, 'save', task1, { stage: 2, revision: 3, answers: { reference_coverage: 'A' } }), 'PT403');
    await assertPgCode(api(db, one, 'complete', task1, { revision: 2, answers: { reference_coverage: 'A' } }), 'PT403');

    const reference = await api(db, one, 'reference', task1);
    assert.deepEqual(Object.keys(reference).sort(), ['reference', 'revision', 'reference_released_at'].sort());
    assert.equal(reference.reference, taskMaterial.rows[0].payload.reference);
    assert.equal(reference.revision, locked.revision + 1);
    const referenceAgain = await api(db, one, 'reference', task1);
    assert.equal(referenceAgain.revision, reference.revision);
    assert.equal(referenceAgain.reference_released_at, reference.reference_released_at);
    const postReleaseTask = await api(db, one, 'task', task1);
    assert.equal(Object.hasOwn(postReleaseTask, 'reference'), false);
    assert.deepEqual(postReleaseTask.answers, {});
    await assertPgCode(api(db, one, 'save', task1, { stage: 2, revision: reference.revision - 1, answers: { reference_coverage: 'B' } }), 'PT409');
    const savedStage2 = await api(db, one, 'save', task1, { stage: 2, revision: reference.revision, answers: { reference_coverage: 'B' } });
    const completed = await api(db, one, 'complete', task1, { revision: savedStage2.revision, answers: { reference_coverage: 'B' } });
    assert.equal(completed.status, 'complete');
    assert.deepEqual(completed.answers, { reference_coverage: 'B' });
    assert.deepEqual((await api(db, one, 'complete', task1, { revision: 0, answers: { reference_coverage: 'B' } })).answers, { reference_coverage: 'B' });
    for (const invalidRevision of [null, true, '0']) {
      await assertPgCode(api(db, one, 'complete', task1, {
        revision: invalidRevision, answers: { reference_coverage: 'B' },
      }), 'PT400');
    }
    await assertPgCode(api(db, one, 'complete', task1, { revision: 0, answers: { reference_coverage: 'A' } }), 'PT409');
    await assertPgCode(api(db, one, 'save', task1, { stage: 2, revision: completed.revision, answers: { reference_coverage: 'A' } }), 'PT409');

    const exportBeforePractice = await api(db, one, 'export');
    assert.deepEqual(Object.keys(exportBeforePractice).sort(), [
      'schema_version', 'rubric_version', 'study_fingerprint', 'instruction_fingerprint', 'mode',
      'participant_id', 'display_name', 'instructions_acknowledged_at', 'exported_at', 'events',
      'study_assignments', 'practice_assignments',
    ].sort());
    assert.equal(exportBeforePractice.study_assignments.length, 126);
    assert.equal(exportBeforePractice.practice_assignments.length, 8);
    assert.equal(exportBeforePractice.participant_id, oneSession.participant_id);
    assert.equal(exportBeforePractice.display_name, 'Volunteer One');
    const exportText = JSON.stringify(exportBeforePractice);
    assert.equal(exportText.includes('PRIVATE_REFERENCE_SECRET'), false);
    assert.equal(exportText.includes('PRIVATE_PAIR'), false);
    assert.equal(exportText.includes('PRIVATE_OURS_METHOD'), false);
    assert.equal(exportText.includes('Synthetic source text'), false);
    assert.equal(exportText.includes('recovery_hash'), false);
    assert.equal(exportText.includes(recoveryCode(10)), false);
    assert.equal(exportText.includes(one), false);
    assert.equal(exportText.includes(twoSession.participant_id), false);
    for (const task of [...exportBeforePractice.study_assignments, ...exportBeforePractice.practice_assignments]) {
      assert.equal(Object.hasOwn(task, 'coordinator'), false);
      assert.equal(task.hashes.source_sha256.length, 64);
    }

    for (const task of oneSession.tasks.filter((item) => item.kind === 'practice' && item.id !== task1)) {
      await completePractice(db, one, task.id);
    }
    assert.equal((await api(db, one, 'task', study1)).kind, 'study');
    const studyDraft = await api(db, one, 'task', study1);
    await assertPgCode(api(db, one, 'problem', study1, {
      revision: studyDraft.revision, category: ['other_interface_problem'], criteria: ['source_coverage'],
    }), 'PT400');
    await assertPgCode(api(db, one, 'problem', study1, {
      revision: studyDraft.revision, category: 'other_interface_problem', criteria: ['source_coverage', 'source_coverage'],
    }), 'PT400');
    await assertPgCode(api(db, one, 'problem', study1, {
      revision: studyDraft.revision, category: 'other_interface_problem', criteria: ['reference_coverage'],
    }), 'PT400');
    const paused = await api(db, one, 'problem', study1, {
      revision: studyDraft.revision, category: 'text_missing_or_unreadable', criteria: ['source_coverage'],
    });
    assert.equal(paused.status, 'paused');
    await assertPgCode(api(db, one, 'save', study1, { stage: 1, revision: paused.revision, answers: { source_coverage: 'A' } }), 'PT403');
    await withRole(db, 'authenticated', one, async () => {
      await assertPgCode(db.query('select annotation_private.resolve_problem($1, $2)', [oneSession.participant_id, study1]), '42501');
    });
    const resolved = await db.query('select annotation_private.resolve_problem($1, $2) as response', [oneSession.participant_id, study1]);
    assert.deepEqual(resolved.rows[0].response, { ok: true, id: study1, status: 'draft', revision: paused.revision + 1 });
    const resumed = await api(db, one, 'task', study1);
    assert.equal(resumed.status, 'draft');
    assert.deepEqual(resumed.answers, {});

    const afterResolution = await api(db, one, 'export');
    const practice1Export = afterResolution.practice_assignments.find((item) => item.id === task1);
    assert.ok(practice1Export.events.some((event) => event.event === 'reference_released'));
    assert.ok(practice1Export.events.some((event) => event.event === 'comparison_completed'));
    assert.equal(practice1Export.problem_reports.length, 0);
    const studyExport = afterResolution.study_assignments.find((item) => item.id === study1);
    assert.equal(studyExport.status, 'draft');
    assert.ok(studyExport.problem_reports.some((event) => event.data.category === 'text_missing_or_unreadable'));
    assert.ok(studyExport.events.some((event) => event.event === 'problem_resolved'));

    const coordinator = await db.query('select annotation_private.export_all() as response');
    const coordinatorExport = coordinator.rows[0].response;
    assert.deepEqual(Object.keys(coordinatorExport.participants).sort(), [oneSession.participant_id, twoSession.participant_id].sort());
    const privateStudyExport = coordinatorExport.participants[oneSession.participant_id].study_assignments.find((item) => item.id === study1);
    assert.equal(privateStudyExport.coordinator.pair_id.startsWith('PRIVATE_PAIR_'), true);
    assert.equal(privateStudyExport.coordinator.template_id.startsWith('scheme-'), true);
    assert.equal(JSON.stringify(coordinatorExport).includes('PRIVATE_REFERENCE_SECRET'), false);
    assert.equal(JSON.stringify(coordinatorExport).includes(recoveryCode(10)), false);
    assert.equal(JSON.stringify(coordinatorExport).includes(one), false);
  } finally {
    await db.close();
  }
});

test('only current anonymous Auth users may access or enroll in the annotation API', async () => {
  const db = await openDatabase();
  try {
    const participantUid = uid(12);
    const permanentUid = uid(13);
    const recoveryTargetCode = recoveryCode(12);
    const participant = await enroll(db, participantUid, 'Anonymous volunteer', recoveryTargetCode);
    await insertAuthUser(db, permanentUid);
    await db.query('update auth.users set is_anonymous=false where id=$1', [permanentUid]);

    await assertPgCode(api(db, permanentUid, 'session'), 'PT401');
    await assertPgCode(api(db, permanentUid, 'enroll', null, {
      display_name: 'Permanent user', recovery_code: recoveryCode(13), is_anonymous: true,
    }), 'PT401');
    await assertPgCode(api(db, permanentUid, 'recover', null, {
      recovery_code: recoveryTargetCode, new_recovery_code: recoveryCode(14),
    }), 'PT401');
    const participantsBefore = await db.query('select count(*) as n from annotation_private.participants');
    assert.equal(Number(participantsBefore.rows[0].n), 1);
    await insertAuthUser(db, uid(14));
    const recoveryStillUsable = await api(db, uid(14), 'recover', null, {
      recovery_code: recoveryTargetCode, new_recovery_code: recoveryCode(15),
    });
    assert.equal(recoveryStillUsable.participant_id, participant.participant_id);

    await insertAuthUser(db, uid(16));
    await assertPgCode(api(db, uid(16), 'enroll', null, {
      display_name: 'Forged claim', recovery_code: recoveryCode(16), is_anonymous: true,
    }), 'PT400');

    await db.query('update auth.users set is_anonymous=false where id=$1', [participantUid]);
    await assertPgCode(api(db, participantUid, 'session'), 'PT401');
    await assertPgCode(api(db, participantUid, 'task', assignedTask(participant, 'practice').id), 'PT401');
  } finally {
    await db.close();
  }
});

test('recovery rebinds identity atomically, preserves drafts and locked work, and rotates only the private code hash', async () => {
  const db = await openDatabase();
  try {
    const oldA = uid(20);
    const oldB = uid(21);
    const newA = uid(120);
    const newB = uid(121);
    const replayFresh = uid(122);
    const aCode = recoveryCode(20);
    const bCode = recoveryCode(21);
    const aNewCode = recoveryCode(120);
    const bNewCode = recoveryCode(121);
    const bRotatedCode = recoveryCode(221);
    const aSession = await enroll(db, oldA, 'Draft annotator', aCode);
    const bSession = await enroll(db, oldB, 'Locked annotator', bCode);
    await api(db, oldA, 'acknowledge', null, { accepted: true });
    await api(db, oldB, 'acknowledge', null, { accepted: true });

    const draftId = assignedTask(aSession, 'practice').id;
    const draft = await api(db, oldA, 'task', draftId);
    const savedDraft = await api(db, oldA, 'save', draftId, {
      stage: 1, revision: draft.revision, answers: { source_coverage: 'B', faithfulness: 'Tie' },
    });
    const oldASession = await api(db, oldA, 'session');
    await insertAuthUser(db, newA);
    const recoveredA = await api(db, newA, 'recover', null, { recovery_code: aCode, new_recovery_code: aNewCode });
    assert.equal(recoveredA.participant_id, aSession.participant_id);
    assert.equal(recoveredA.display_name, 'Draft annotator');
    assert.deepEqual(recoveredA.tasks, oldASession.tasks);
    const recoveredDraft = await api(db, newA, 'task', draftId);
    assert.equal(recoveredDraft.status, 'draft');
    assert.equal(recoveredDraft.revision, savedDraft.revision);
    assert.deepEqual(recoveredDraft.answers, { source_coverage: 'B', faithfulness: 'Tie' });
    assert.equal(recoveredA.accepted_instructions, true);
    assert.deepEqual(await api(db, oldA, 'session'), { authenticated: true, enrolled: false, needs_enrollment: true });
    await assertPgCode(api(db, oldA, 'task', draftId), 'PT401');

    const lockedId = assignedTask(bSession, 'practice').id;
    const lockedTask = await api(db, oldB, 'task', lockedId);
    const locked = await api(db, oldB, 'lock', lockedId, { revision: lockedTask.revision, answers: STAGE1 });
    const exposed = await api(db, oldB, 'reference', lockedId);
    const stage2 = await api(db, oldB, 'save', lockedId, {
      stage: 2, revision: exposed.revision, answers: { reference_coverage: 'B' },
    });
    await insertAuthUser(db, newB);
    const recoveredB = await api(db, newB, 'recover', null, { recovery_code: bCode, new_recovery_code: bNewCode });
    assert.equal(recoveredB.participant_id, bSession.participant_id);
    assert.equal(recoveredB.accepted_instructions, true);
    const recoveredLocked = await api(db, newB, 'task', lockedId);
    assert.equal(recoveredLocked.status, 'locked');
    assert.equal(recoveredLocked.stage, 2);
    assert.equal(recoveredLocked.revision, stage2.revision);
    assert.equal(recoveredLocked.locked_at, locked.locked_at);
    assert.equal(recoveredLocked.reference_released_at, exposed.reference_released_at);
    assert.deepEqual(recoveredLocked.answers, { reference_coverage: 'B' });
    assert.equal(JSON.stringify(recoveredLocked).includes('source_coverage'), false);
    assert.deepEqual((await api(db, newB, 'reference', lockedId)).reference, exposed.reference);

    const eventCountBeforeReplay = await db.query(
      "select count(*) as n from annotation_private.events where participant_id=$1 and event_type='identity_recovered'",
      [bSession.participant_id],
    );
    const replay = await api(db, newB, 'recover', null, { recovery_code: bCode, new_recovery_code: bNewCode });
    assert.equal(replay.participant_id, bSession.participant_id);
    const eventCountAfterReplay = await db.query(
      "select count(*) as n from annotation_private.events where participant_id=$1 and event_type='identity_recovered'",
      [bSession.participant_id],
    );
    assert.equal(Number(eventCountAfterReplay.rows[0].n), Number(eventCountBeforeReplay.rows[0].n));
    await assertPgCode(api(db, oldB, 'task', lockedId), 'PT401');

    await insertAuthUser(db, replayFresh);
    const wrongCode = await api(db, replayFresh, 'recover', null, {
      recovery_code: bCode, new_recovery_code: recoveryCode(123),
    }).catch((error) => error);
    assert.equal(wrongCode.code, 'PT400');
    assert.equal(wrongCode.message, 'The recovery code is invalid or unavailable.');
    assert.equal(wrongCode.message.includes('Locked annotator'), false);
    assert.equal(wrongCode.message.includes(bSession.participant_id), false);

    const beforeRotate = await api(db, newB, 'export');
    const rotated = await api(db, newB, 'rotate_recovery', null, { new_recovery_code: bRotatedCode });
    assert.equal(rotated.participant_id, bSession.participant_id);
    assert.equal(rotated.tasks.find((task) => task.id === lockedId).status, 'locked');
    const rotateRetry = await api(db, newB, 'rotate_recovery', null, { new_recovery_code: bRotatedCode });
    assert.equal(rotateRetry.participant_id, bSession.participant_id);
    const afterRotate = await api(db, newB, 'export');
    assert.deepEqual(afterRotate.study_assignments, beforeRotate.study_assignments);
    assert.deepEqual(afterRotate.practice_assignments, beforeRotate.practice_assignments);
    assert.equal(JSON.stringify(afterRotate).includes(bRotatedCode), false);
    assert.equal(JSON.stringify(afterRotate).includes(bNewCode), false);

    await insertAuthUser(db, replayFresh);
    await assertPgCode(api(db, replayFresh, 'recover', null, {
      recovery_code: bNewCode, new_recovery_code: recoveryCode(222),
    }), 'PT400');
    const finalCode = recoveryCode(223);
    const reboundAgain = await api(db, replayFresh, 'recover', null, {
      recovery_code: bRotatedCode, new_recovery_code: finalCode,
    });
    assert.equal(reboundAgain.participant_id, bSession.participant_id);
    await assertPgCode(api(db, newB, 'task', lockedId), 'PT401');

    const participantRows = await db.query(
      'select participant_id, auth_user_id::text as auth_user_id, display_name, recovery_hash from annotation_private.participants order by participant_id',
    );
    const bRow = participantRows.rows.find((row) => row.participant_id === bSession.participant_id);
    assert.equal(bRow.auth_user_id, replayFresh);
    assert.equal(bRow.display_name, 'Locked annotator');
    assert.equal(Buffer.from(bRow.recovery_hash).toString('hex'), sha256(finalCode.toUpperCase()));
    assert.equal(JSON.stringify(participantRows.rows).includes(bCode), false);
    const events = await db.query('select event_type, payload from annotation_private.events order by event_id');
    const eventText = JSON.stringify(events.rows);
    for (const secret of [aCode, aNewCode, bCode, bNewCode, bRotatedCode, finalCode, sha256(finalCode)]) {
      assert.equal(eventText.includes(secret), false);
    }
    assert.equal(events.rows.filter((event) => event.event_type === 'identity_recovered').length, 3);
    assert.equal(events.rows.filter((event) => event.event_type === 'recovery_code_rotated').length, 1);
    const allExport = await db.query('select annotation_private.export_all() as response');
    const allExportText = JSON.stringify(allExport.rows[0].response);
    for (const secret of [aCode, aNewCode, bCode, bNewCode, bRotatedCode, finalCode, sha256(finalCode)]) {
      assert.equal(allExportText.includes(secret), false);
    }
    assert.equal(allExportText.includes(oldA), false);
    assert.equal(allExportText.includes(newA), false);
    assert.equal(allExportText.includes(oldB), false);
    assert.equal(allExportText.includes(newB), false);
  } finally {
    await db.close();
  }
});

test('enrollment fails closed for malformed names/codes, closed signup, and incomplete private templates', async () => {
  const db = await openDatabase();
  try {
    const first = uid(30);
    await insertAuthUser(db, first);
    await assertPgCode(api(db, first, 'enroll', null, { display_name: 'A\nB', recovery_code: recoveryCode(30) }), 'PT400');
    await assertPgCode(api(db, first, 'enroll', null, { display_name: 'A'.repeat(41), recovery_code: recoveryCode(30) }), 'PT400');
    await assertPgCode(api(db, first, 'enroll', null, { display_name: 'Valid', recovery_code: 'short-code' }), 'PT400');
    await assertPgCode(api(db, first, 'enroll', null, { display_name: ['Valid'], recovery_code: recoveryCode(30) }), 'PT400');
    await assertPgCode(api(db, first, 'enroll', null, { display_name: 'Valid', recovery_code: recoveryCode(30), participant_id: 'attacker' }), 'PT400');

    const unicodeName = '😀'.repeat(40);
    const validSession = await api(db, first, 'enroll', null, { display_name: ` ${unicodeName} `, recovery_code: `\t${recoveryCode(30).toLowerCase()}\n` });
    assert.equal(validSession.display_name, unicodeName);
    assert.equal(validSession.tasks.length, 134);
    await insertAuthUser(db, uid(31));
    const duplicateCodeError = await api(db, uid(31), 'enroll', null, {
      display_name: 'Another volunteer', recovery_code: recoveryCode(30),
    }).catch((error) => error);
    assert.equal(duplicateCodeError.code, 'PT409');
    assert.equal(duplicateCodeError.message.includes(unicodeName), false);
  } finally {
    await db.close();
  }

  const closed = await openDatabase(undefined, { enrollmentOpen: false });
  try {
    const user = uid(32);
    await insertAuthUser(closed, user);
    await assertPgCode(api(closed, user, 'enroll', null, { display_name: 'Closed', recovery_code: recoveryCode(32) }), 'PT503');
    const participants = await closed.query('select count(*) as n from annotation_private.participants');
    assert.equal(Number(participants.rows[0].n), 0);
    const settings = await closed.query('select next_scheme from annotation_private.settings where id=1');
    assert.equal(Number(settings.rows[0].next_scheme), 0);
  } finally {
    await closed.close();
  }

  const incomplete = await openDatabase(undefined, { includeTemplates: false });
  try {
    const user = uid(33);
    await insertAuthUser(incomplete, user);
    await assertPgCode(api(incomplete, user, 'enroll', null, { display_name: 'Missing templates', recovery_code: recoveryCode(33) }), 'PT503');
  } finally {
    await incomplete.close();
  }

  const missingOne = await openDatabase();
  try {
    await missingOne.query("delete from annotation_private.templates where template_id='scheme-2-study-126'");
    const user = uid(34);
    await insertAuthUser(missingOne, user);
    await assertPgCode(api(missingOne, user, 'enroll', null, { display_name: 'Incomplete', recovery_code: recoveryCode(34) }), 'PT503');
    const participants = await missingOne.query('select count(*) as n from annotation_private.participants');
    const settings = await missingOne.query('select next_scheme from annotation_private.settings where id=1');
    assert.equal(Number(participants.rows[0].n), 0);
    assert.equal(Number(settings.rows[0].next_scheme), 0);
  } finally {
    await missingOne.close();
  }
});

test('migration is additive and idempotent; enrollment, responses, and recovery survive restart', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'human-annotation-pglite-'));
  let db;
  try {
    db = await openDatabase(dataDir);
    const user = uid(40);
    const code = recoveryCode(40);
    const next = recoveryCode(41);
    const session = await enroll(db, user, 'Persistent volunteer', code);
    await api(db, user, 'acknowledge', null, { accepted: true });
    const taskId = assignedTask(session, 'practice').id;
    const draft = await api(db, user, 'task', taskId);
    const saved = await api(db, user, 'save', taskId, {
      stage: 1, revision: draft.revision, answers: { readability: 'B' },
    });
    await db.exec(MIGRATION);
    const countsBeforeClose = await db.query(`
      select (select count(*) from annotation_private.participants) as participants,
             (select count(*) from annotation_private.assignments) as assignments,
             (select next_scheme from annotation_private.settings where id=1) as next_scheme
    `);
    assert.equal(Number(countsBeforeClose.rows[0].participants), 1);
    assert.equal(Number(countsBeforeClose.rows[0].assignments), 134);
    assert.equal(Number(countsBeforeClose.rows[0].next_scheme), 1);
    await db.close();
    db = new PGlite(dataDir);
    const afterRestart = await api(db, user, 'task', taskId);
    assert.equal(afterRestart.revision, saved.revision);
    assert.deepEqual(afterRestart.answers, { readability: 'B' });
    assert.equal((await api(db, user, 'session')).accepted_instructions, true);

    await insertAuthUser(db, uid(140));
    const recovered = await api(db, uid(140), 'recover', null, { recovery_code: code, new_recovery_code: next });
    assert.equal(recovered.participant_id, session.participant_id);
    const recoveredTask = await api(db, uid(140), 'task', taskId);
    assert.deepEqual(recoveredTask.answers, { readability: 'B' });
  } finally {
    if (db) await db.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('migration refuses an incompatible unpublished fixed-account prototype without dropping its data', async () => {
  const db = new PGlite();
  try {
    await createAuthBase(db);
    await db.exec(`
      create schema annotation_private;
      create table annotation_private.settings (
        id integer primary key, study_fingerprint text not null, instruction_fingerprint text not null,
        rubric_version text not null, rubric jsonb not null, guide_md text not null
      );
      insert into annotation_private.settings values (1, 'old-study', 'old-instructions', 'old-rubric', '{}'::jsonb, 'old guide');
    `);
    await assert.rejects(db.exec(MIGRATION), (error) => {
      assert.match(error.message, /Incompatible annotation_private\.settings prototype/);
      return true;
    });
    const preserved = await db.query('select study_fingerprint, guide_md from annotation_private.settings where id=1');
    assert.deepEqual(preserved.rows[0], { study_fingerprint: 'old-study', guide_md: 'old guide' });
    const tables = await db.query(`
      select count(*) as n from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid=c.relnamespace
      where n.nspname='annotation_private' and c.relkind='r'
    `);
    assert.equal(Number(tables.rows[0].n), 1);
  } finally {
    await db.close();
  }
});
