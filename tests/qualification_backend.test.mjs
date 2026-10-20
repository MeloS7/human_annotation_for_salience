import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const BASE_MIGRATION = await readFile(
  new URL('../supabase/migrations/20261018000000_annotation_api.sql', import.meta.url), 'utf8',
);
const PRACTICE_MIGRATION = await readFile(
  new URL('../supabase/migrations/20261018010000_two_practice_tasks.sql', import.meta.url), 'utf8',
);
const QUALIFICATION_MIGRATION = await readFile(
  new URL('../supabase/migrations/20261020000000_qualification_pilot.sql', import.meta.url), 'utf8',
);
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

function uid(number) {
  return `00000000-0000-4000-8000-${number.toString(16).padStart(12, '0')}`;
}

function recoveryCode(number) {
  return `SAL-${number.toString(16).padStart(2, '0').repeat(32)}`;
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function stage1Answers(overrides = {}) {
  return {
    source_coverage: 'A',
    readability: 'A',
    faithfulness: 'A',
    content_focus: 'A',
    ...overrides,
  };
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
  await db.query(
    'insert into auth.users(id, is_anonymous) values ($1, true) on conflict (id) do nothing',
    [userId],
  );
}

function makePayload(templateId, kind, position, scheme) {
  const request = `Synthetic ${kind} request ${scheme}-${position}`;
  const source = `Synthetic source for ${kind} item ${scheme}-${position}.`;
  const reference = `Synthetic reference ${kind} ${scheme}-${position}.`;
  const summaryA = `Synthetic summary A for ${kind} item ${scheme}-${position}.`;
  const summaryB = `Synthetic summary B for ${kind} item ${scheme}-${position}.`;
  return {
    payload: { request, source, reference, summary_a: summaryA, summary_b: summaryB },
    hashes: {
      request_sha256: sha256(request),
      source_sha256: sha256(source),
      reference_sha256: sha256(reference),
      summary_a_sha256: sha256(summaryA),
      summary_b_sha256: sha256(summaryB),
    },
    coordinator: kind === 'study' ? { pair_id: `SYNTHETIC_PAIR_${position}` } : null,
  };
}

function syntheticSuggestions(position, scheme) {
  const scoredCriteria = new Set(SCORED_MASK[position - 1]);
  const swapped = scheme === 2 || (scheme === 3 && position % 2 === 0);
  return Object.fromEntries(CRITERIA.map((id) => [id, {
    label: swapped ? 'B' : 'A',
    scored: scoredCriteria.has(id),
    rationale_zh: `Synthetic fixture rationale for ${id}, item ${position}.`,
    confidence: scoredCriteria.has(id) ? 'high' : 'synthetic',
  }]));
}

async function seedLegacyMaterials(db, { settingVersion = null } = {}) {
  const rubric = {
    criteria: CRITERIA.map((id, index) => ({ id, label: id, stage: index === 4 ? 2 : 1, question: `Synthetic ${id}?`, bullets: ['Synthetic test only.'] })),
    choices: [
      { value: 'A', definition: 'Summary A is preferred.' },
      { value: 'B', definition: 'Summary B is preferred.' },
      { value: 'Tie', definition: 'Neither is preferred.' },
    ],
    reference_intro: 'Synthetic reference instruction.',
    shared_instructions: ['Synthetic shared instruction.'],
  };
  await db.query(
    `insert into annotation_private.settings
       (id, study_fingerprint, instruction_fingerprint, rubric_version, rubric, guide_md, enrollment_open)
     values (1, $1, $2, $3, $4::jsonb, $5, true)`,
    ['synthetic-fingerprint', 'synthetic-instructions', 'synthetic-rubric-v1', JSON.stringify(rubric), '# Synthetic guide'],
  );
  for (let scheme = 1; scheme <= 3; scheme += 1) {
    for (const kind of ['practice', 'study']) {
      const total = kind === 'practice' ? 8 : 126;
      for (let position = 1; position <= total; position += 1) {
        const templateId = `legacy-${scheme}-${kind}-${position}`;
        const material = makePayload(templateId, kind, position, scheme);
        await db.query(
          `insert into annotation_private.templates
             (template_id, scheme, kind, position, payload, hashes, coordinator)
           values ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb)`,
          [templateId, scheme, kind, position, JSON.stringify(material.payload), JSON.stringify(material.hashes), JSON.stringify(material.coordinator)],
        );
      }
    }
  }
  if (settingVersion !== null) {
    await db.query('update annotation_private.settings set qualification_version = $1 where id = 1', [settingVersion]);
  }
}

async function seedQualificationMaterials(db, version = 'pilot-synthetic-v1') {
  await db.query(
    `insert into annotation_private.qualification_sets
       (qualification_version, fingerprint, item_count, scored_total, pass_count, key_status)
     values ($1, $2, 10, 18, 15, 'llm_suggested_unvalidated')`,
    [version, sha256(`fixture:${version}`)],
  );
  for (let scheme = 1; scheme <= 3; scheme += 1) {
    for (let position = 1; position <= 10; position += 1) {
      const templateId = `qualification-${scheme}-${position}`;
      const material = makePayload(templateId, 'qualification', position, scheme);
      const qualificationId = `Q${String(position).padStart(2, '0')}`;
      const dataset = position <= 5 ? 'cnndm' : 'gumsum';
      await db.query(
        `insert into annotation_private.templates
           (template_id, scheme, kind, position, payload, hashes, coordinator)
         values ($1, $2, 'qualification', $3, $4::jsonb, $5::jsonb, null)`,
        [templateId, scheme, position, JSON.stringify(material.payload), JSON.stringify(material.hashes)],
      );
      await db.query(
        `update annotation_private.templates set coordinator = $2::jsonb where template_id = $1`,
        [templateId, JSON.stringify({ qualification_version: version, qualification_id: qualificationId, dataset, source_id: `SYNTHETIC_SOURCE_${scheme}_${position}` })],
      );
      await db.query(
        `insert into annotation_private.qualification_keys
           (qualification_version, template_id, qualification_id, dataset, title_zh, suggestions)
         values ($1, $2, $3, $4, $5, $6::jsonb)`,
        [
          version,
          templateId,
          qualificationId,
          dataset,
          `Synthetic qualification item ${position}`,
          JSON.stringify(syntheticSuggestions(position, scheme)),
        ],
      );
    }
  }
  await db.query('update annotation_private.settings set qualification_version = $1 where id = 1', [version]);
  await db.query('select annotation_private._assert_qualification_inventory()');
}

async function applyQualificationMigration(db) {
  await db.exec(`begin;\n${QUALIFICATION_MIGRATION}\ncommit;`);
}

async function openDatabase({ existingParticipant = false, settingVersion = null } = {}) {
  const db = new PGlite();
  await createAuthBase(db);
  await db.exec(BASE_MIGRATION);
  await db.exec(`begin;\n${PRACTICE_MIGRATION}\ncommit;`);
  await seedLegacyMaterials(db);
  let existing = null;
  if (existingParticipant) {
    existing = { userId: uid(1), recovery: recoveryCode(1) };
    await insertAuthUser(db, existing.userId);
    existing.session = await api(db, existing.userId, 'enroll', null, {
      display_name: 'Legacy Pilot', recovery_code: existing.recovery,
    });
    await api(db, existing.userId, 'acknowledge', null, { accepted: true });
  }
  await applyQualificationMigration(db);
  if (settingVersion !== null) await seedQualificationMaterials(db, settingVersion);
  return { db, existing };
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

async function enroll(db, userId, code = recoveryCode(Number(userId.slice(-2), 16) || 2)) {
  await insertAuthUser(db, userId);
  return api(db, userId, 'enroll', null, { display_name: `Tester ${userId.slice(-2)}`, recovery_code: code });
}

async function acknowledge(db, userId) {
  await api(db, userId, 'acknowledge', null, { accepted: true });
}

function findTask(session, kind, position = 1) {
  const task = session.tasks.find((entry) => entry.kind === kind && entry.position === position);
  assert.ok(task, `Missing ${kind} task at position ${position}`);
  return task;
}

async function qualificationCells(db, taskId, version = 'pilot-synthetic-v1') {
  const row = await db.query(
    `select k.qualification_id, k.suggestions, t.template_id
     from annotation_private.assignments a
     join annotation_private.templates t on t.template_id = a.template_id
     join annotation_private.qualification_keys k on k.template_id = t.template_id and k.qualification_version = $2
     where a.task_id = $1`,
    [taskId, version],
  );
  assert.equal(row.rows.length, 1);
  return row.rows[0];
}

async function answerSetForTask(db, taskId, mismatchCellSet, version = 'pilot-synthetic-v1') {
  const item = await qualificationCells(db, taskId, version);
  const stage1 = {};
  for (const criterion of CRITERIA.slice(0, 4)) {
    const suggestion = item.suggestions[criterion].label;
    stage1[criterion] = mismatchCellSet.has(`${item.qualification_id}:${criterion}`)
      ? (suggestion === 'A' ? 'B' : 'A')
      : suggestion;
  }
  const referenceSuggestion = item.suggestions.reference_coverage.label;
  const reference = mismatchCellSet.has(`${item.qualification_id}:reference_coverage`)
    ? (referenceSuggestion === 'A' ? 'B' : 'A')
    : referenceSuggestion;
  return { stage1, reference };
}

async function completeQualificationTask(db, userId, task, mismatchCellSet = new Set()) {
  const payload = await api(db, userId, 'task', task.id);
  const answers = await answerSetForTask(db, task.id, mismatchCellSet);
  const locked = await api(db, userId, 'lock', task.id, {
    revision: payload.revision,
    answers: answers.stage1,
  });
  const opened = await api(db, userId, 'reference', task.id);
  const completed = await api(db, userId, 'complete', task.id, {
    revision: opened.revision,
    answers: { reference_coverage: answers.reference },
  });
  return { locked, opened, completed };
}

async function firstScoredCells(db, version = 'pilot-synthetic-v1', count) {
  const rows = await db.query(
    `select k.qualification_id, dimension.key as criterion
     from annotation_private.qualification_keys k
     join annotation_private.templates t on t.template_id = k.template_id
     cross join lateral jsonb_each(k.suggestions) as dimension(key, value)
     where k.qualification_version = $1
       and t.scheme = 1
       and dimension.value -> 'scored' = 'true'::jsonb
     order by k.qualification_id, dimension.key
     limit $2`,
    [version, count],
  );
  return new Set(rows.rows.map((row) => `${row.qualification_id}:${row.criterion}`));
}

async function startQualification(db, userId) {
  return api(db, userId, 'start_qualification', null, {});
}

async function completeSome(db, userId, session, count, mismatchCellSet = new Set()) {
  const tasks = session.tasks.filter((task) => task.kind === 'qualification');
  for (const task of tasks.slice(0, count)) {
    await completeQualificationTask(db, userId, task, mismatchCellSet);
  }
}

test('migration is additive and opt-in: legacy participants retain practice flow and old task state', async () => {
  const { db, existing } = await openDatabase({ existingParticipant: true });
  try {
    const before = await db.query(
      `select jsonb_agg(to_jsonb(a) order by a.kind, a.position) as rows
       from annotation_private.assignments a where participant_id = $1`,
      [existing.session.participant_id],
    );
    const session = await api(db, existing.userId, 'session');
    assert.equal(session.tasks.length, 128);
    assert.equal(session.qualification_available, undefined);
    assert.equal(session.progress.practice_requirement, 2);
    const after = await db.query(
      `select jsonb_agg(to_jsonb(a) order by a.kind, a.position) as rows
       from annotation_private.assignments a where participant_id = $1`,
      [existing.session.participant_id],
    );
    assert.deepEqual(after.rows[0].rows, before.rows[0].rows);
  } finally {
    await db.close();
  }
});

test('available qualification stays optional; explicit start reuses hidden assignments and changes only the gate', async () => {
  const { db, existing } = await openDatabase({ existingParticipant: true, settingVersion: 'pilot-synthetic-v1' });
  try {
    const participantId = existing.session.participant_id;
    const oldRows = await db.query(
      `select jsonb_agg(to_jsonb(a) order by a.kind, a.position) as rows
       from annotation_private.assignments a
       where participant_id = $1 and kind in ('practice', 'study')`,
      [participantId],
    );
    const available = await api(db, existing.userId, 'session');
    assert.equal(available.tasks.length, 128);
    assert.equal(available.qualification_available.version, 'pilot-synthetic-v1');
    assert.equal(available.progress.practice_requirement, 2);
    assert.equal(available.tasks.some((task) => task.kind === 'qualification'), false);
    await assertPgCode(api(db, existing.userId, 'qualification_results'), 'PT403');

    const started = await startQualification(db, existing.userId);
    assert.equal(started.qualification.state, 'in_progress');
    assert.equal(started.qualification.completed, 0);
    assert.equal(started.qualification.score, null);
    assert.equal(started.tasks.length, 136);
    assert.equal(started.tasks.filter((task) => task.kind === 'qualification').length, 10);
    assert.equal(started.tasks.some((task) => task.kind === 'practice'), false);
    assert.equal(started.progress.practice_requirement, 0);
    const oldRowsAfterStart = await db.query(
      `select jsonb_agg(to_jsonb(a) order by a.kind, a.position) as rows
       from annotation_private.assignments a
       where participant_id = $1 and kind in ('practice', 'study')`,
      [participantId],
    );
    assert.deepEqual(oldRowsAfterStart.rows[0].rows, oldRows.rows[0].rows);

    const repeated = await startQualification(db, existing.userId);
    assert.deepEqual(
      repeated.tasks.filter((task) => task.kind === 'qualification').map((task) => task.id),
      started.tasks.filter((task) => task.kind === 'qualification').map((task) => task.id),
    );
    assert.equal(await api(db, existing.userId, 'session').then((value) => value.progress.qualification_total), 10);

    const hiddenPracticeId = (await db.query(
      "select task_id from annotation_private.assignments where participant_id = $1 and kind = 'practice' limit 1",
      [participantId],
    )).rows[0].task_id;
    await assertPgCode(api(db, existing.userId, 'task', hiddenPracticeId), 'PT403');
    const studyId = started.tasks.find((task) => task.kind === 'study').id;
    await assertPgCode(api(db, existing.userId, 'task', studyId), 'PT403');
  } finally {
    await db.close();
  }
});

test('two-stage qualification remains blind until all ten complete, then reports cell and dimension comparisons', async () => {
  const { db } = await openDatabase({ settingVersion: 'pilot-synthetic-v1' });
  const userId = uid(21);
  try {
    const initial = await enroll(db, userId, recoveryCode(21));
    await acknowledge(db, userId);
    const available = await api(db, userId, 'session');
    assert.equal(available.tasks.length, 128);
    const started = await startQualification(db, userId);
    const task = started.tasks.find((entry) => entry.kind === 'qualification');
    const payload = await api(db, userId, 'task', task.id);
    assert.equal(JSON.stringify(payload).includes('rationale_zh'), false);
    assert.equal(JSON.stringify(payload).includes('suggested'), false);

    await assertPgCode(api(db, userId, 'reference', task.id), 'PT403');
    const answers = await answerSetForTask(db, task.id, new Set());
    const locked = await api(db, userId, 'lock', task.id, {
      revision: payload.revision,
      answers: answers.stage1,
    });
    assert.equal(locked.status, 'locked');
    assert.equal(locked.stage, 2);
    await assertPgCode(api(db, userId, 'save', task.id, {
      stage: 2, revision: locked.revision, answers: { reference_coverage: 'A' },
    }), 'PT403');
    const opened = await api(db, userId, 'reference', task.id);
    assert.match(opened.reference, /^Synthetic reference qualification 1-\d+\.$/);
    await api(db, userId, 'complete', task.id, {
      revision: opened.revision,
      answers: { reference_coverage: answers.reference },
    });
    await completeSome(db, userId, { ...started, tasks: started.tasks.filter((entry) => entry.id !== task.id) }, 8);
    await assertPgCode(api(db, userId, 'qualification_results'), 'PT403');
    const partial = await api(db, userId, 'session');
    assert.equal(partial.qualification.completed, 9);
    assert.equal(partial.qualification.state, 'in_progress');
    assert.equal(partial.qualification.score, null);

    const lastTask = started.tasks.filter((entry) => entry.kind === 'qualification')[9];
    await completeQualificationTask(db, userId, lastTask);
    const result = await api(db, userId, 'qualification_results');
    assert.equal(result.state, 'passed');
    assert.equal(result.matched, 18);
    assert.equal(result.total, 18);
    assert.equal(result.overall.matched, 50);
    assert.equal(result.overall.total, 50);
    assert.deepEqual(result.dimensions.map((dimension) => dimension.id), CRITERIA);
    assert.deepEqual(result.dimensions.map((dimension) => dimension.scored_total), [3, 4, 4, 4, 3]);
    assert.ok(result.items.every((item) => item.dimensions.length === 5));
    assert.ok(result.items.every((item) => item.dimensions.every((cell) => cell.matches)));
    assert.equal(result.items.filter((item) => item.dataset === 'cnndm').length, 5);
    assert.equal(result.items.filter((item) => item.dataset === 'gumsum').length, 5);
    assert.equal(JSON.stringify(result).includes('Synthetic source'), false);
    assert.equal(JSON.stringify(result).includes('Synthetic reference'), false);

    const passedSession = await api(db, userId, 'session');
    assert.equal(passedSession.qualification.state, 'passed');
    assert.equal(passedSession.qualification.score.matched, 18);
    const studyId = passedSession.tasks.find((entry) => entry.kind === 'study').id;
    assert.equal((await api(db, userId, 'task', studyId)).kind, 'study');
    assert.equal(initial.enrolled, true);
  } finally {
    await db.close();
  }
});

test('each assigned scheme uses its own remapped qualification key', async () => {
  const { db } = await openDatabase({ settingVersion: 'pilot-synthetic-v1' });
  try {
    for (const scheme of [1, 2, 3]) {
      const userId = uid(70 + scheme);
      await enroll(db, userId, recoveryCode(70 + scheme));
      await acknowledge(db, userId);
      const assignedScheme = await db.query(
        'select scheme from annotation_private.participants where auth_user_id = $1', [userId],
      );
      assert.equal(assignedScheme.rows[0].scheme, scheme);
      const started = await startQualification(db, userId);
      await completeSome(db, userId, started, 10);
      const result = await api(db, userId, 'qualification_results');
      assert.equal(result.state, 'passed');
      assert.equal(result.matched, 18);
      assert.equal(result.items.length, 10);
    }
  } finally {
    await db.close();
  }
});

test('15 of 18 scored cells passes and 14 fails; threshold uses only pre-scored cells', async () => {
  const { db } = await openDatabase({ settingVersion: 'pilot-synthetic-v1' });
  try {
    const passingUser = uid(31);
    await enroll(db, passingUser, recoveryCode(31));
    await acknowledge(db, passingUser);
    const passingSession = await startQualification(db, passingUser);
    const threeMismatches = await firstScoredCells(db, 'pilot-synthetic-v1', 3);
    await completeSome(db, passingUser, passingSession, 10, threeMismatches);
    const passingResult = await api(db, passingUser, 'qualification_results');
    assert.equal(passingResult.matched, 15);
    assert.equal(passingResult.state, 'passed');
    assert.equal(passingResult.overall.matched, 47);
    const passingStudyTask = (await api(db, passingUser, 'session')).tasks.find((entry) => entry.kind === 'study');
    assert.equal((await api(db, passingUser, 'task', passingStudyTask.id)).kind, 'study');

    const failingUser = uid(32);
    await enroll(db, failingUser, recoveryCode(32));
    await acknowledge(db, failingUser);
    const failingSession = await startQualification(db, failingUser);
    const fourMismatches = await firstScoredCells(db, 'pilot-synthetic-v1', 4);
    await completeSome(db, failingUser, failingSession, 10, fourMismatches);
    const failingResult = await api(db, failingUser, 'qualification_results');
    assert.equal(failingResult.matched, 14);
    assert.equal(failingResult.state, 'failed');
    const failingStudyTask = (await api(db, failingUser, 'session')).tasks.find((entry) => entry.kind === 'study');
    await assertPgCode(api(db, failingUser, 'task', failingStudyTask.id), 'PT403');

    const persisted = await db.query(
      `select result ->> 'state' as state, result ->> 'matched' as matched
       from annotation_private.qualification_results order by participant_id`,
    );
    assert.deepEqual(
      persisted.rows.map((row) => [row.state, Number(row.matched)]).sort((left, right) => left[0].localeCompare(right[0])),
      [['failed', 14], ['passed', 15]],
    );
  } finally {
    await db.close();
  }
});

test('new enrollments hide preassigned qualification tasks until opt-in and direct task IDs cannot bypass it', async () => {
  const { db } = await openDatabase({ settingVersion: 'pilot-synthetic-v1' });
  const userId = uid(41);
  try {
    await enroll(db, userId, recoveryCode(41));
    await acknowledge(db, userId);
    const internal = await db.query(
      "select task_id from annotation_private.assignments where participant_id = (select participant_id from annotation_private.participants where auth_user_id = $1) and kind = 'qualification' limit 1",
      [userId],
    );
    assert.equal(internal.rows.length, 1);
    const session = await api(db, userId, 'session');
    assert.equal(session.tasks.some((task) => task.kind === 'qualification'), false);
    assert.equal(session.qualification_available.version, 'pilot-synthetic-v1');
    await assertPgCode(api(db, userId, 'task', internal.rows[0].task_id), 'PT403');
    const before = await api(db, userId, 'export');
    assert.equal(before.qualification_result, null);
    assert.equal(before.qualification_assignments.length, 10);
    const started = await startQualification(db, userId);
    assert.equal(started.tasks.filter((task) => task.kind === 'qualification').length, 10);
  } finally {
    await db.close();
  }
});

test('qualification opt-in rejects pre-existing assignments from another presentation scheme', async () => {
  const { db } = await openDatabase({ settingVersion: 'pilot-synthetic-v1' });
  const userId = uid(64);
  const participantId = 'participant_synthetic_wrong_scheme';
  try {
    await insertAuthUser(db, userId);
    await db.query(
      `insert into annotation_private.participants
         (participant_id, auth_user_id, display_name, recovery_hash, scheme, guide_ack_at)
       values ($1, $2, 'Synthetic participant', $3, 1, now())`,
      [participantId, userId, Buffer.from(sha256('synthetic recovery hash'), 'hex')],
    );
    for (let position = 1; position <= 10; position += 1) {
      await db.query(
        `insert into annotation_private.assignments
           (task_id, participant_id, template_id, kind, position)
         values ($1, $2, $3, 'qualification', $4)`,
        [`synthetic-wrong-scheme-${position}`, participantId, `qualification-2-${position}`, position],
      );
    }

    await assertPgCode(api(db, userId, 'start_qualification'), 'PT503');
    const state = await db.query(
      `select p.qualification_version, count(a.task_id)::integer as task_count
       from annotation_private.participants p
       left join annotation_private.assignments a
         on a.participant_id = p.participant_id and a.kind = 'qualification'
       where p.participant_id = $1
       group by p.participant_id`,
      [participantId],
    );
    assert.deepEqual(state.rows[0], { qualification_version: null, task_count: 10 });
  } finally {
    await db.close();
  }
});

test('recovery preserves qualification answers; completed results and answers cannot be reset or replaced', async () => {
  const { db } = await openDatabase({ settingVersion: 'pilot-synthetic-v1' });
  const firstUser = uid(51);
  const recovery = recoveryCode(51);
  try {
    await enroll(db, firstUser, recovery);
    await acknowledge(db, firstUser);
    const started = await startQualification(db, firstUser);
    await completeSome(db, firstUser, started, 3);
    const before = await api(db, firstUser, 'session');

    const recoveryUser = uid(52);
    await insertAuthUser(db, recoveryUser);
    const recovered = await api(db, recoveryUser, 'recover', null, {
      recovery_code: recovery,
      new_recovery_code: recoveryCode(52),
    });
    assert.equal(recovered.progress.qualification_completed, 3);
    assert.deepEqual(
      recovered.tasks.filter((task) => task.kind === 'qualification').map((task) => [task.id, task.status]),
      before.tasks.filter((task) => task.kind === 'qualification').map((task) => [task.id, task.status]),
    );

    const finished = await api(db, recoveryUser, 'start_qualification');
    await completeSome(db, recoveryUser, finished, 10);
    const result = await api(db, recoveryUser, 'qualification_results');
    assert.equal(result.state, 'passed');
    const completedTask = finished.tasks.filter((task) => task.kind === 'qualification')[0];
    const completedPayload = await api(db, recoveryUser, 'task', completedTask.id);
    await assertPgCode(api(db, recoveryUser, 'lock', completedTask.id, {
      revision: completedPayload.revision,
      answers: stage1Answers({ source_coverage: 'B' }),
    }), 'PT409');
    await assert.rejects(
      db.query("delete from annotation_private.assignments where task_id = $1", [completedTask.id]),
      (error) => error.code === 'PT409',
    );
    await assert.rejects(
      db.query("update annotation_private.qualification_results set result = '{}'::jsonb where participant_id = (select participant_id from annotation_private.participants where auth_user_id = $1)", [recoveryUser]),
      (error) => error.code === 'PT409',
    );
  } finally {
    await db.close();
  }
});

test('qualification actions validate identity and payload, and private keys/helpers are not client-executable', async () => {
  const { db } = await openDatabase({ settingVersion: 'pilot-synthetic-v1' });
  const userId = uid(61);
  try {
    await enroll(db, userId, recoveryCode(61));
    await acknowledge(db, userId);
    await assertPgCode(api(db, userId, 'start_qualification', 'unexpected-task', {}), 'PT400');
    await assertPgCode(api(db, userId, 'start_qualification', null, { unexpected: true }), 'PT400');
    await assertPgCode(api(db, userId, 'qualification_results', null, { unexpected: true }), 'PT400');
    await assertPgCode(api(db, userId, null), 'PT400');
    await assertPgCode(api(db, uid(62), 'start_qualification'), 'PT401');

    const grants = await db.query(`
      select
        has_function_privilege('authenticated', 'annotation_private._evaluate_qualification(text)', 'EXECUTE') as can_evaluate,
        has_function_privilege('authenticated', 'annotation_private._annotation_api_pre_qualification(text,text,jsonb)', 'EXECUTE') as can_call_legacy_rpc,
        has_table_privilege('authenticated', 'annotation_private.qualification_keys', 'SELECT') as can_read_keys
    `);
    assert.deepEqual(grants.rows[0], { can_evaluate: false, can_call_legacy_rpc: false, can_read_keys: false });
    await withRole(db, 'authenticated', userId, async () => {
      await assert.rejects(db.query('select * from annotation_private.qualification_keys'), (error) => error.code === '42501');
    });
  } finally {
    await db.close();
  }
});

test('migration rerun leaves prior assignment rows intact and stays safe after activation', async () => {
  const { db, existing } = await openDatabase({ existingParticipant: true, settingVersion: 'pilot-synthetic-v1' });
  try {
    const before = await db.query(
      `select jsonb_agg(to_jsonb(a) order by a.kind, a.position) as rows
       from annotation_private.assignments a where participant_id = $1`,
      [existing.session.participant_id],
    );
    await applyQualificationMigration(db);
    const after = await db.query(
      `select jsonb_agg(to_jsonb(a) order by a.kind, a.position) as rows
       from annotation_private.assignments a where participant_id = $1`,
      [existing.session.participant_id],
    );
    assert.deepEqual(after.rows[0].rows, before.rows[0].rows);
    await assertPgCode(
      db.query("update annotation_private.qualification_sets set key_status = 'human_reviewed' where qualification_version = 'pilot-synthetic-v1'"),
      'PT409',
    );
    await assertPgCode(
      db.query("update annotation_private.qualification_sets set key_status = key_status where qualification_version = 'pilot-synthetic-v1'"),
      'PT409',
    );
    await assertPgCode(
      db.query("update annotation_private.qualification_keys set suggestions = suggestions where template_id = 'qualification-1-1'"),
      'PT409',
    );
    await assertPgCode(
      db.query("update annotation_private.templates set payload = payload where template_id = 'qualification-1-1'"),
      'PT409',
    );
    await assertPgCode(
      db.query("update annotation_private.templates set template_id = 'renamed-active-template' where template_id = 'qualification-1-1'"),
      'PT409',
    );
  } finally {
    await db.close();
  }
});
