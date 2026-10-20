// Offline coordinator check: exact private inputs in disposable PGlite only.
// Never contacts Supabase, GitHub, JZ, or any other network service.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';

if (process.argv.length !== 5) {
  throw new Error('Usage: node scripts/verify-qualification-upgrade.mjs OLD_PRIVATE_SQL_DIRECTORY QUALIFICATION_SQL EXPECTED_PRIVATE_JSON');
}
const [initialDirectory, upgradePath, expectedPath] = process.argv.slice(2);
const expected = JSON.parse(await readFile(expectedPath, 'utf8'));
const upgrade = await readFile(upgradePath, 'utf8');
assert.equal(createHash('sha256').update(upgrade).digest('hex'), expected.sql_sha256, 'Upgrade checksum mismatch');
const db = new PGlite();
let phase = 'initialize isolated database';
const uid = index => `80000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;
const code = index => `SAL-${index.toString(16).padStart(2, '0').repeat(32)}`;
const firstAnswers = { source_coverage: 'Tie', readability: 'A', faithfulness: 'B', content_focus: 'Tie' };
async function api(userId, action, taskId = null, payload = {}) {
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [userId]);
  await db.exec('set role authenticated');
  try {
    return (await db.query('select public.annotation_api($1,$2,$3::jsonb) as value', [action, taskId, JSON.stringify(payload)])).rows[0].value;
  } finally { await db.exec('reset role'); }
}
async function rejected(promise, codeValue) {
  await assert.rejects(promise, error => error.code === codeValue);
}
async function enroll(index) {
  await db.query('insert into auth.users(id) values($1)', [uid(index)]);
  return api(uid(index), 'enroll', null, { display_name: 'OFFLINE_QUALIFICATION_QA', recovery_code: code(index) });
}
async function complete(userId, id, answers) {
  const task = await api(userId, 'task', id);
  await rejected(api(userId, 'reference', id), 'PT403');
  await api(userId, 'lock', id, { revision: task.revision, answers: Object.fromEntries(Object.entries(answers).filter(([key]) => key !== 'reference_coverage')) });
  const reference = await api(userId, 'reference', id);
  return api(userId, 'complete', id, { revision: reference.revision, answers: { reference_coverage: answers.reference_coverage } });
}
async function historicalSnapshot() {
  return {
    participants: (await db.query(`select participant_id,auth_user_id,display_name,recovery_hash,scheme,guide_ack_at,created_at
      from annotation_private.participants order by participant_id`)).rows,
    assignments: (await db.query("select * from annotation_private.assignments where kind in ('practice','study') order by task_id")).rows,
    events: (await db.query('select * from annotation_private.events order by event_id')).rows,
    templates: (await db.query("select * from annotation_private.templates where kind in ('practice','study') order by template_id")).rows,
  };
}
async function participantQualificationSnapshot(participantId) {
  return {
    assignments: (await db.query("select * from annotation_private.assignments where participant_id=$1 and kind='qualification' order by task_id", [participantId])).rows,
    results: (await db.query('select * from annotation_private.qualification_results where participant_id=$1', [participantId])).rows,
  };
}

try {
  await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create schema auth;
    create table auth.users(id uuid primary key,is_anonymous boolean not null default true);
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    grant usage on schema auth to anon,authenticated;
    grant execute on function auth.uid() to anon,authenticated;
  `);
  for (const name of (await readdir(initialDirectory)).filter(name => name.endsWith('.sql')).sort()) {
    await db.exec(await readFile(path.join(initialDirectory, name), 'utf8'));
  }
  phase = 'prepare historical partial and locked work';
  const historicalSession = await enroll(1);
  assert.equal(historicalSession.tasks.length, 128);
  await api(uid(1), 'acknowledge', null, { accepted: true });
  for (const task of historicalSession.tasks.filter(item => item.kind === 'practice')) {
    await complete(uid(1), task.id, { ...firstAnswers, reference_coverage: 'Tie' });
  }
  const oldStudy = historicalSession.tasks.find(task => task.kind === 'study');
  const task = await api(uid(1), 'task', oldStudy.id);
  await api(uid(1), 'lock', oldStudy.id, { revision: task.revision, answers: firstAnswers });
  const exposed = await api(uid(1), 'reference', oldStudy.id);
  await api(uid(1), 'save', oldStudy.id, { stage: 2, revision: exposed.revision, answers: { reference_coverage: 'A' } });
  const before = await historicalSnapshot();

  phase = 'apply additive qualification SQL without opting anyone in';
  await db.exec(upgrade);
  assert.deepEqual(await historicalSnapshot(), before);
  const stillLegacy = await api(uid(1), 'session');
  assert.equal(stillLegacy.tasks.length, 128);
  assert.equal(stillLegacy.qualification, undefined);
  assert.equal(stillLegacy.qualification_available.version, expected.config.qualification_version);
  assert.equal((await api(uid(1), 'task', oldStudy.id)).stage, 2);
  await db.exec(upgrade);
  assert.deepEqual(await historicalSnapshot(), before);

  phase = 'verify exact private payload and remapped key round trips';
  const templates = (await db.query("select * from annotation_private.templates where kind='qualification' order by template_id")).rows;
  assert.equal(templates.length, 30);
  for (const row of templates) {
    assert.deepEqual(row, expected.templates.find(item => item.template_id === row.template_id));
  }
  const keys = (await db.query('select * from annotation_private.qualification_keys')).rows;
  assert.equal(keys.length, 30);
  for (const row of keys) assert.deepEqual(row, expected.keys.find(item => item.template_id === row.template_id));
  assert.equal((await db.query('select count(*)::int as n from annotation_private.qualification_results')).rows[0].n, 0);

  const tested = [];
  for (const [index, mistakes] of [[1, 0], [2, 4], [3, 3]]) {
    phase = `exercise presentation scheme ${index}, including the blind gate`;
    let session = index === 1 ? await api(uid(index), 'session') : await enroll(index);
    await api(uid(index), 'acknowledge', null, { accepted: true });
    const beforeOpt = await historicalSnapshot();
    session = await api(uid(index), 'start_qualification');
    assert.equal(session.tasks.length, 136);
    assert.equal(session.qualification.completed, 0);
    assert.equal(session.qualification.score, null);
    const afterOpt = await historicalSnapshot();
    for (const field of ['participants', 'assignments', 'templates']) {
      assert.deepEqual(afterOpt[field], beforeOpt[field], `Opt-in must preserve historical ${field}`);
    }
    for (const event of beforeOpt.events) {
      assert.deepEqual(afterOpt.events.find(item => item.event_id === event.event_id), event, 'Opt-in must preserve every historic event');
    }
    assert.deepEqual((await api(uid(index), 'start_qualification')).tasks, session.tasks);
    const qualTasks = session.tasks.filter(item => item.kind === 'qualification');
    assert.equal(qualTasks.length, 10);
    const studyTask = session.tasks.find(item => item.kind === 'study');
    await rejected(api(uid(index), 'task', studyTask.id), 'PT403');
    await rejected(api(uid(index), 'qualification_results'), 'PT403');
    const privateRows = (await db.query(`select a.task_id,k.suggestions from annotation_private.assignments a
      join annotation_private.qualification_keys k on k.template_id=a.template_id
      where a.participant_id=$1 and a.kind='qualification'`, [session.participant_id])).rows;
    let remainingMistakes = mistakes;
    for (const [number, comparison] of qualTasks.entries()) {
      const key = privateRows.find(item => item.task_id === comparison.id);
      const answers = {};
      for (const [id, suggestion] of Object.entries(key.suggestions)) {
        answers[id] = suggestion.label;
        if (suggestion.scored && remainingMistakes > 0) {
          answers[id] = suggestion.label === 'A' ? 'B' : 'A';
          remainingMistakes -= 1;
        }
      }
      await complete(uid(index), comparison.id, answers);
      if (number < 9) {
        const partial = await api(uid(index), 'session');
        assert.equal(partial.qualification.score, null);
        await rejected(api(uid(index), 'qualification_results'), 'PT403');
      }
    }
    assert.equal(remainingMistakes, 0);
    phase = `validate immutable final result for presentation scheme ${index}`;
    const result = await api(uid(index), 'qualification_results');
    assert.equal(result.matched, 18 - mistakes);
    assert.equal(result.total, 18);
    assert.equal(result.overall.matched, 50 - mistakes);
    assert.equal(result.overall.total, 50);
    assert.equal(result.items.length, 10);
    assert.equal(result.state, mistakes <= 3 ? 'passed' : 'failed');
    assert.equal(result.dimensions.reduce((sum, dimension) => sum + dimension.scored_matched, 0), 18 - mistakes);
    if (mistakes > 3) await rejected(api(uid(index), 'task', studyTask.id), 'PT403');
    else assert.equal((await api(uid(index), 'task', studyTask.id)).id, studyTask.id);
    const snapshot = await participantQualificationSnapshot(session.participant_id);
    await db.exec(upgrade);
    assert.deepEqual(await participantQualificationSnapshot(session.participant_id), snapshot, 'Repeated upgrade must not reset answers/results');
    const ownExport = await api(uid(index), 'export');
    assert.equal(ownExport.qualification_assignments.length, 10);
    assert.equal(ownExport.qualification_result.matched, 18 - mistakes);
    assert.equal(ownExport.study_assignments.length, 126);
    assert.equal(ownExport.practice_assignments.length, 8);
    assert.ok(!JSON.stringify(ownExport).includes(code(index)));
    assert.ok(!JSON.stringify(ownExport).includes('recovery_hash'));
    tested.push({ scheme: index, matched: result.matched, total: result.total, state: result.state });
  }
  phase = 'verify recovery and coordinator export retain results';
  const previous = await api(uid(3), 'session');
  await db.query('insert into auth.users(id) values($1)', [uid(4)]);
  const recovered = await api(uid(4), 'recover', null, { recovery_code: code(3), new_recovery_code: code(4) });
  assert.equal(recovered.participant_id, previous.participant_id);
  assert.deepEqual(recovered.qualification, previous.qualification);
  assert.deepEqual(recovered.tasks, previous.tasks);
  const all = (await db.query('select annotation_private.export_all() as value')).rows[0].value;
  assert.equal(Object.keys(all.participants).length, 3);
  console.log(`PASS: exact private import and retry preserve all historic work; all three schemes exercise blind/recovery/export gates (${tested.map(row => `${row.matched}/${row.total} ${row.state}`).join(', ')}).`);
} catch (error) {
  // An unhandled PGlite error may print the full private SQL/materials. Keep
  // diagnostics short and never emit query strings or private answer keys.
  console.error(`FAIL during ${phase}: ${error.code || error.name}; ${String(error.message).split('\n')[0].slice(0, 180)}`);
  process.exitCode = 1;
} finally { await db.close(); }
