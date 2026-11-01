import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const MIGRATIONS = await Promise.all([
  '20261018000000_annotation_api.sql',
  '20261018010000_two_practice_tasks.sql',
  '20261020000000_qualification_pilot.sql',
  '20261101000000_mandatory_qualification.sql',
].map((file) => readFile(new URL(`../supabase/migrations/${file}`, import.meta.url), 'utf8')));

const POLICY_VERSION = 'qualification-required-20261101-v1';
const KEY_VERSION = 'qualification-pilot-20261020-v1';
const CRITERIA = [
  'source_coverage', 'readability', 'faithfulness', 'content_focus', 'reference_coverage',
];
const SCORED_MASK = [
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

function uid(n) {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
}

function recoveryCode(n) {
  return `SAL-${n.toString(16).slice(-1).repeat(64)}`;
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function syntheticSuggestions(position, scheme) {
  const scored = new Set(SCORED_MASK[position - 1]);
  const preferred = scheme === 2 || (scheme === 3 && position % 2 === 0) ? 'B' : 'A';
  return Object.fromEntries(CRITERIA.map((id) => [id, {
    label: preferred,
    scored: scored.has(id),
    rationale_zh: `Synthetic rationale for ${id} at ${position}.`,
    confidence: scored.has(id) ? 'high' : 'synthetic',
  }]));
}

async function bootstrap({ existing = false } = {}) {
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
    criteria: CRITERIA.map((id, index) => ({ id, label: id, stage: index === 4 ? 2 : 1, question: `Synthetic ${id}?`, bullets: ['Synthetic fixture.'] })),
    choices: [
      { value: 'A', definition: 'Prefer A.' },
      { value: 'B', definition: 'Prefer B.' },
      { value: 'Tie', definition: 'Tie.' },
    ],
    reference_intro: 'Synthetic reference instruction.',
    shared_instructions: ['Synthetic shared instruction.'],
  };
  await db.query(
    `insert into annotation_private.settings
       (id, study_fingerprint, instruction_fingerprint, rubric_version, rubric, guide_md, enrollment_open)
     values (1, 'synthetic-study', 'synthetic-instructions', 'rubric-v1', $1::jsonb, '# Synthetic guide', true)`,
    [JSON.stringify(rubric)],
  );
  for (let scheme = 1; scheme <= 3; scheme += 1) {
    for (const [kind, count] of [['practice', 8], ['study', 126]]) {
      for (let position = 1; position <= count; position += 1) {
        const id = `legacy-${scheme}-${kind}-${position}`;
        const payload = {
          request: `Request ${id}`,
          source: `Source document for ${id}.`,
          reference: `Reference for ${id}.`,
          summary_a: `Summary A for ${id}.`,
          summary_b: `Summary B for ${id}.`,
        };
        await db.query(
          `insert into annotation_private.templates
             (template_id, scheme, kind, position, payload, hashes, coordinator)
           values ($1, $2, $3, $4, $5::jsonb, $6::jsonb, null)`,
          [id, scheme, kind, position, JSON.stringify(payload), JSON.stringify(Object.fromEntries(
            Object.entries(payload).map(([key, value]) => [`${key}_sha256`, sha256(value)]),
          ))],
        );
      }
    }
  }
  await db.exec(`begin;${MIGRATIONS[2]}commit;`);

  const fingerprint = sha256('mandatory synthetic qualification inventory');
  await db.query(
    `insert into annotation_private.qualification_sets
       (qualification_version, fingerprint, item_count, scored_total, pass_count, key_status)
     values ($1, $2, 10, 18, 15, 'llm_suggested_unvalidated')`,
    [KEY_VERSION, fingerprint],
  );
  for (let scheme = 1; scheme <= 3; scheme += 1) {
    for (let position = 1; position <= 10; position += 1) {
      const templateId = `qualification-${scheme}-${position}`;
      const qualificationId = `Q${String(position).padStart(2, '0')}`;
      const payload = {
        request: `Qualification request ${scheme}-${position}`,
        source: `Qualification source ${scheme}-${position}.`,
        reference: `Qualification reference ${scheme}-${position}.`,
        summary_a: `Qualification summary A ${scheme}-${position}.`,
        summary_b: `Qualification summary B ${scheme}-${position}.`,
      };
      await db.query(
        `insert into annotation_private.templates
           (template_id, scheme, kind, position, payload, hashes, coordinator)
         values ($1, $2, 'qualification', $3, $4::jsonb, $5::jsonb, $6::jsonb)`,
        [templateId, scheme, position, JSON.stringify(payload), JSON.stringify(Object.fromEntries(
          Object.entries(payload).map(([key, value]) => [`${key}_sha256`, sha256(value)]),
        )), JSON.stringify({
          qualification_version: KEY_VERSION,
          qualification_id: qualificationId,
          dataset: position <= 5 ? 'cnndm' : 'gumsum',
          source_id: `SYNTHETIC-${scheme}-${position}`,
        })],
      );
      await db.query(
        `insert into annotation_private.qualification_keys
           (qualification_version, template_id, qualification_id, dataset, title_zh, suggestions)
         values ($1, $2, $3, $4, $5, $6::jsonb)`,
        [KEY_VERSION, templateId, qualificationId, position <= 5 ? 'cnndm' : 'gumsum', `Synthetic item ${position}`, JSON.stringify(syntheticSuggestions(position, scheme))],
      );
    }
  }
  await db.query('update annotation_private.settings set qualification_version = $1 where id = 1', [KEY_VERSION]);

  let old = null;
  if (existing) {
    const userId = uid(1);
    await db.query('insert into auth.users(id, is_anonymous) values ($1, true)', [userId]);
    const enrolled = await api(db, userId, 'enroll', null, {
      display_name: 'Existing participant', recovery_code: recoveryCode(1),
    });
    old = { userId, participantId: enrolled.participant_id };
    await api(db, userId, 'acknowledge', null, { accepted: true });
    await db.query(
      `update annotation_private.assignments
       set status = 'complete', stage = 2, stage1_answers = '{"source_coverage":"A"}'::jsonb,
           stage2_answers = '{"reference_coverage":"A"}'::jsonb, locked_at = now(),
           reference_released_at = now(), completed_at = now()
       where participant_id = $1 and kind = 'practice'`,
      [old.participantId],
    );
    await db.query(
      `update annotation_private.assignments
       set stage1_answers = '{"readability":"B"}'::jsonb, revision = revision + 1
       where participant_id = $1 and kind = 'study' and position = 1`,
      [old.participantId],
    );
  }
  await db.exec(`begin;${MIGRATIONS[3]}commit;`);
  const workflowGuide = `# Before you begin\n\nComplete all ten qualification comparisons before starting the study. Practice items are not used.\n`;
  await db.query(
    `insert into annotation_private.qualification_policies
       (policy_version, qualification_version, fingerprint, pass_count, scored_total,
        key_status, confirmed_scored_count, workflow_guide_md, workflow_guide_sha256)
     values ($1, $2, $3, 14, 18, 'human_confirmed_scored', 18, $4, $5)`,
    [POLICY_VERSION, KEY_VERSION, fingerprint, workflowGuide, sha256(workflowGuide)],
  );
  await db.query(
    'update annotation_private.settings set qualification_policy_version = $1 where id = 1',
    [POLICY_VERSION],
  );
  return { db, old, fingerprint, workflowGuide };
}

async function withRole(db, role, userId, fn) {
  await db.query("select set_config('request.jwt.claim.sub', $1, false)", [userId ?? '']);
  await db.exec(`set role ${role}`);
  try { return await fn(); } finally { await db.exec('reset role'); }
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

async function assertPgCode(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code, error.message);
    return true;
  });
}

async function enroll(db, n) {
  const userId = uid(n);
  await db.query('insert into auth.users(id, is_anonymous) values ($1, true)', [userId]);
  const session = await api(db, userId, 'enroll', null, {
    display_name: `Mandatory ${n}`,
    recovery_code: recoveryCode(n),
  });
  await api(db, userId, 'acknowledge', null, { accepted: true });
  return { userId, participantId: session.participant_id, session };
}

function findTask(session, kind, position = 1) {
  const task = session.tasks.find((item) => item.kind === kind && item.position === position);
  assert.ok(task, `Missing ${kind} task ${position}`);
  return task;
}

async function qualificationAnswerData(db, taskId) {
  const result = await db.query(
    `select k.qualification_id, k.suggestions
     from annotation_private.assignments a
     join annotation_private.qualification_keys k on k.template_id = a.template_id
     where a.task_id = $1`, [taskId],
  );
  assert.equal(result.rows.length, 1);
  return result.rows[0];
}

async function completeQualification(db, userId, task, mismatches) {
  const item = await qualificationAnswerData(db, task.id);
  const selected = {};
  for (const dimension of CRITERIA.slice(0, 4)) {
    const suggested = item.suggestions[dimension].label;
    selected[dimension] = mismatches.has(`${item.qualification_id}:${dimension}`)
      ? (suggested === 'A' ? 'B' : 'A') : suggested;
  }
  const reference = item.suggestions.reference_coverage.label;
  const payload = await api(db, userId, 'task', task.id);
  const locked = await api(db, userId, 'lock', task.id, {
    revision: payload.revision,
    answers: selected,
  });
  const released = await api(db, userId, 'reference', task.id);
  const complete = await api(db, userId, 'complete', task.id, {
    revision: released.revision,
    answers: {
      reference_coverage: mismatches.has(`${item.qualification_id}:reference_coverage`)
        ? (reference === 'A' ? 'B' : 'A') : reference,
    },
  });
  assert.equal(locked.stage, 2);
  assert.equal(complete.status, 'complete');
}

async function scoreParticipant(db, userId, mismatchedCount) {
  let session = await api(db, userId, 'session');
  assert.equal(session.qualification_required, true);
  const scoredCells = await db.query(
    `select k.qualification_id, dimension.key as criterion
     from annotation_private.qualification_keys k
     join annotation_private.templates t on t.template_id = k.template_id
     cross join lateral jsonb_each(k.suggestions) dimension(key, value)
     where k.qualification_version = $1 and t.scheme = (
       select scheme from annotation_private.participants where auth_user_id = $2
     ) and dimension.value -> 'scored' = 'true'::jsonb
     order by k.qualification_id, dimension.key limit $3`,
    [KEY_VERSION, userId, mismatchedCount],
  );
  const mismatches = new Set(scoredCells.rows.map((row) => `${row.qualification_id}:${row.criterion}`));
  for (const task of session.tasks.filter((item) => item.kind === 'qualification')) {
    await completeQualification(db, userId, task, mismatches);
  }
  return api(db, userId, 'qualification_results');
}

test('mandatory enrollment auto-queues qualification, hides archived practice, and preserves existing rows', async () => {
  const { db, old } = await bootstrap({ existing: true });
  try {
    const before = await db.query(
      `select jsonb_agg(to_jsonb(a) order by a.kind, a.position) rows
       from annotation_private.assignments a where participant_id = $1`, [old.participantId],
    );
    const session = await api(db, old.userId, 'session');
    assert.equal(session.qualification_required, true);
    assert.equal(session.workflow_version, POLICY_VERSION);
    assert.equal(session.workflow_guide_sha256, sha256(session.workflow_guide_md));
    assert.equal(session.qualification.confirmed_scored_count, 18);
    assert.equal(session.qualification.pass_count, 14);
    assert.equal(session.qualification.state, 'in_progress');
    assert.equal(session.tasks.length, 136);
    assert.equal(session.tasks.filter((task) => task.kind === 'study').length, 126);
    assert.equal(session.tasks.filter((task) => task.kind === 'qualification').length, 10);
    assert.equal(session.tasks.some((task) => task.kind === 'practice'), false);
    assert.equal(session.progress.practice_total, 0);
    const participant = await db.query(
      'select qualification_version from annotation_private.participants where participant_id = $1',
      [old.participantId],
    );
    assert.equal(participant.rows[0].qualification_version, KEY_VERSION);
    const after = await db.query(
      `select jsonb_agg(to_jsonb(a) order by a.kind, a.position) rows
       from annotation_private.assignments a where participant_id = $1`, [old.participantId],
    );
    assert.deepEqual(after.rows[0].rows, before.rows[0].rows);

    const newParticipant = await enroll(db, 20);
    assert.equal(newParticipant.session.tasks.length, 136);
    const newCounts = await db.query(
      `select kind, count(*)::integer count from annotation_private.assignments
       where participant_id = $1 group by kind order by kind`, [newParticipant.participantId],
    );
    assert.deepEqual(newCounts.rows, [
      { kind: 'practice', count: 8 },
      { kind: 'qualification', count: 10 },
      { kind: 'study', count: 126 },
    ]);
  } finally {
    await db.close();
  }
});

test('13 scored matches fails, while 14 and 15 pass without changing immutable original snapshots', async () => {
  const { db } = await bootstrap();
  try {
    for (const [n, mismatches, expectedState] of [[21, 5, 'failed'], [22, 4, 'passed'], [23, 3, 'passed']]) {
      const participant = await enroll(db, n);
      const result = await scoreParticipant(db, participant.userId, mismatches);
      assert.equal(result.matched, 18 - mismatches);
      assert.equal(result.total, 18);
      assert.equal(result.state, expectedState);
      assert.equal(result.pass_count, 14);
      assert.equal(result.policy_version, POLICY_VERSION);
      assert.equal(result.key_status, 'human_confirmed_scored');
      assert.equal(result.confirmed_scored_count, 18);
      const persisted = await db.query(
        `select result from annotation_private.qualification_results where participant_id = $1`,
        [participant.participantId],
      );
      assert.equal(persisted.rows[0].result.state, mismatches <= 3 ? 'passed' : 'failed');
      assert.equal(persisted.rows[0].result.pass_count, 15);
      assert.equal(persisted.rows[0].result.key_status, 'llm_suggested_unvalidated');
      assert.equal(persisted.rows[0].result.version, KEY_VERSION);
      const session = await api(db, participant.userId, 'session');
      assert.equal(session.qualification.state, expectedState);
      assert.equal(session.qualification.score.matched, 18 - mismatches);
      assert.equal(session.tasks.length, 136);
      const study = findTask(session, 'study');
      if (expectedState === 'passed') {
        assert.equal((await api(db, participant.userId, 'task', study.id)).kind, 'study');
      } else {
        for (const [action, payload] of [
          ['task', {}], ['save', { stage: 1, revision: 0, answers: { readability: 'A' } }],
          ['lock', { revision: 0, answers: { source_coverage: 'A' } }],
          ['reference', {}], ['complete', { revision: 0, answers: { reference_coverage: 'A' } }],
          ['problem', { category: 'other', note: 'synthetic test' }],
        ]) {
          await assertPgCode(api(db, participant.userId, action, study.id, payload), 'PT403');
        }
      }
      const exported = await api(db, participant.userId, 'export');
      assert.equal(exported.qualification_result.pass_count, 14);
      assert.equal(exported.qualification_original_result.pass_count, 15);
      assert.equal(exported.qualification_policy.confirmed_scored_count, 18);
      assert.match(exported.qualification_policy.workflow_guide_sha256, /^[a-f0-9]{64}$/);
    }
  } finally {
    await db.close();
  }
});

test('old practice completion and partial study answers cannot bypass qualification and resume intact after a pass', async () => {
  const { db, old } = await bootstrap({ existing: true });
  try {
    const partialBefore = await db.query(
      `select task_id, stage1_answers, revision, status from annotation_private.assignments
       where participant_id = $1 and kind = 'study' and position = 1`, [old.participantId],
    );
    assert.equal(partialBefore.rows[0].stage1_answers.readability, 'B');
    const practice = await db.query(
      "select task_id from annotation_private.assignments where participant_id = $1 and kind = 'practice' limit 1",
      [old.participantId],
    );
    await assertPgCode(api(db, old.userId, 'task', practice.rows[0].task_id), 'PT403');
    const session = await api(db, old.userId, 'session');
    const study = findTask(session, 'study');
    await assertPgCode(api(db, old.userId, 'task', study.id), 'PT403');
    const afterBlocked = await db.query(
      `select task_id, stage1_answers, revision, status from annotation_private.assignments
       where participant_id = $1 and kind = 'study' and position = 1`, [old.participantId],
    );
    assert.deepEqual(afterBlocked.rows[0], partialBefore.rows[0]);

    const result = await scoreParticipant(db, old.userId, 4);
    assert.equal(result.state, 'passed');
    const task = await api(db, old.userId, 'task', study.id);
    assert.equal(task.id, study.id);
    assert.equal(task.answers.readability, 'B');
    assert.equal(task.revision, partialBefore.rows[0].revision);
  } finally {
    await db.close();
  }
});

test('recovery auto-adopts the active policy and preserves qualification task IDs and saved answers', async () => {
  const { db } = await bootstrap();
  try {
    const participant = await enroll(db, 41);
    const first = findTask(participant.session, 'qualification');
    const payload = await api(db, participant.userId, 'task', first.id);
    const saved = await api(db, participant.userId, 'save', first.id, {
      stage: 1,
      revision: payload.revision,
      answers: { source_coverage: 'A', readability: 'B', faithfulness: 'Tie', content_focus: 'A' },
    });
    const recoveryUser = uid(42);
    await db.query('insert into auth.users(id, is_anonymous) values ($1, true)', [recoveryUser]);
    const recovered = await api(db, recoveryUser, 'recover', null, {
      recovery_code: recoveryCode(41),
      new_recovery_code: recoveryCode(42),
    });
    assert.equal(recovered.qualification_required, true);
    assert.equal(recovered.qualification.policy_version, POLICY_VERSION);
    const recoveredTask = findTask(recovered, 'qualification', first.position);
    assert.equal(recoveredTask.id, first.id);
    assert.equal(recoveredTask.status, 'draft');
    const restored = await api(db, recoveryUser, 'task', first.id);
    assert.deepEqual(restored.answers, saved.answers);
    assert.equal(restored.revision, saved.revision);
  } finally {
    await db.close();
  }
});

test('policy, key, staged qualification answers, and workflow gate remain protected and repeatable', async () => {
  const { db, fingerprint } = await bootstrap();
  try {
    const participant = await enroll(db, 31);
    const session = await api(db, participant.userId, 'session');
    const task = findTask(session, 'qualification');
    const payload = await api(db, participant.userId, 'task', task.id);
    assert.equal(JSON.stringify(payload).includes('suggested'), false);
    assert.equal(JSON.stringify(payload).includes('rationale_zh'), false);
    const locked = await api(db, participant.userId, 'lock', task.id, {
      revision: payload.revision,
      answers: { source_coverage: 'A', readability: 'A', faithfulness: 'A', content_focus: 'A' },
    });
    assert.equal(locked.stage, 2);
    await assertPgCode(api(db, participant.userId, 'lock', task.id, {
      revision: payload.revision,
      answers: { source_coverage: 'B', readability: 'B', faithfulness: 'B', content_focus: 'B' },
    }), 'PT409');
    await assertPgCode(api(db, participant.userId, 'save', task.id, {
      stage: 2, revision: locked.revision, answers: { reference_coverage: 'A' },
    }), 'PT403');
    const reference = await api(db, participant.userId, 'reference', task.id);
    assert.match(reference.reference, /^Qualification reference/);
    const afterReference = await db.query(
      `select stage1_answers, locked_at, reference_released_at, revision
       from annotation_private.assignments where task_id = $1`, [task.id],
    );
    const exported = await api(db, participant.userId, 'export');
    assert.equal(exported.qualification_result, null);
    assert.equal(exported.qualification_original_result, null);
    await db.query(
      `insert into annotation_private.qualification_results
         (participant_id, qualification_version, result)
       values ($1, $2, '{"version":"qualification-pilot-20261020-v1","key_status":"llm_suggested_unvalidated","state":"failed","matched":14,"total":18,"pass_count":15}'::jsonb)`,
      [participant.participantId, KEY_VERSION],
    );
    await assertPgCode(
      db.query("update annotation_private.qualification_policies set pass_count = 15 where policy_version = $1", [POLICY_VERSION]),
      'PT409',
    );
    await assertPgCode(
      db.query("delete from annotation_private.qualification_policies where policy_version = $1", [POLICY_VERSION]),
      'PT409',
    );
    await assertPgCode(
      db.query("update annotation_private.settings set qualification_policy_version = null where id = 1"),
      'PT409',
    );
    await assertPgCode(
      db.query("update annotation_private.settings set qualification_version = 'another-version' where id = 1"),
      'PT409',
    );
    await assertPgCode(
      db.query("update annotation_private.qualification_results set result = '{}'::jsonb where participant_id = $1", [participant.participantId]),
      'PT409',
    );
    await assertPgCode(
      db.query("update annotation_private.qualification_keys set suggestions = suggestions where template_id = 'qualification-1-1'"),
      'PT409',
    );
    const grants = await db.query(`
      select
        has_table_privilege('authenticated', 'annotation_private.qualification_policies', 'SELECT') as can_read_policy,
        has_function_privilege('authenticated', 'annotation_private._current_qualification_result(text)', 'EXECUTE') as can_read_result,
        has_function_privilege('authenticated', 'annotation_private._adopt_mandatory_qualification(text)', 'EXECUTE') as can_adopt,
        has_function_privilege('authenticated', 'annotation_private._annotation_api_pre_mandatory(text,text,jsonb)', 'EXECUTE') as can_call_old_api
    `);
    assert.deepEqual(grants.rows[0], {
      can_read_policy: false, can_read_result: false, can_adopt: false, can_call_old_api: false,
    });
    await withRole(db, 'authenticated', participant.userId, async () => {
      await assert.rejects(db.query('select * from annotation_private.qualification_policies'), (error) => error.code === '42501');
    });

    await db.exec(`begin;${MIGRATIONS[3]}commit;`);
    const current = await db.query(
      `select p.fingerprint, p.pass_count, p.confirmed_scored_count, s.qualification_policy_version
       from annotation_private.qualification_policies p
       join annotation_private.settings s on s.id = 1 where p.policy_version = $1`,
      [POLICY_VERSION],
    );
    assert.deepEqual(current.rows[0], {
      fingerprint, pass_count: 14, confirmed_scored_count: 18,
      qualification_policy_version: POLICY_VERSION,
    });
    const afterRepeat = await db.query(
      `select stage1_answers, locked_at, reference_released_at, revision
       from annotation_private.assignments where task_id = $1`, [task.id],
    );
    assert.deepEqual(afterRepeat.rows[0], afterReference.rows[0]);
    await assertPgCode(api(db, uid(99), 'qualification_results'), 'PT401');
    await assertPgCode(api(db, participant.userId, 'start_qualification', 'bad-task', {}), 'PT400');
    await assertPgCode(api(db, participant.userId, 'qualification_results', null, { unexpected: true }), 'PT400');
    await assertPgCode(api(db, participant.userId, null, null, null), 'PT400');
  } finally {
    await db.close();
  }
});
