// Coordinator-only offline regression. Never contacts the live database.
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';

if (process.argv.length !== 6) {
  throw new Error('Usage: node scripts/verify-practice-upgrade.mjs OLD_SQL_DIRECTORY UPGRADE_SQL EXPECTED_PRIVATE_JSON QA_EXPORT_JSON');
}
const [oldDirectory, upgradePath, expectedPath, exportPath] = process.argv.slice(2);
const expected = JSON.parse(await readFile(expectedPath, 'utf8'));
const historical = JSON.parse(await readFile(exportPath, 'utf8'));
const upgradeSQL = await readFile(upgradePath, 'utf8');
const uid = '90000000-0000-4000-8000-000000000001';
const assignments = [...historical.practice_assignments, ...historical.study_assignments];
const sameHashes = (left, right) => Object.keys(left).length === Object.keys(right).length &&
  Object.keys(left).every(key => left[key] === right[key]);
const matchingSchemes = [1, 2, 3].filter(scheme => assignments.every(row =>
  expected.templates.some(template => template.scheme === scheme &&
    template.kind === (historical.practice_assignments.includes(row) ? 'practice' : 'study') &&
    sameHashes(template.hashes, row.hashes))));
assert.ok(matchingSchemes.length > 0, 'Historical export must match a frozen presentation scheme');
const scheme = matchingSchemes[0];
const db = new PGlite();
const firstSQL = upgradeSQL.replace(/^\s*--[^\n]*$/gm, '').trimStart();
const applyUpgrade = () => db.exec(/^(?:BEGIN\s*;|DO\s+\$)/i.test(firstSQL)
  ? upgradeSQL : `BEGIN;\n${upgradeSQL}\nCOMMIT;`);

async function session() {
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [uid]);
  await db.exec('set role authenticated');
  try {
    return (await db.query("select public.annotation_api('session') as value")).rows[0].value;
  } finally {
    await db.exec('reset role');
  }
}

async function snapshot() {
  const result = {};
  for (const [table, order] of [['participants', 'participant_id'], ['assignments', 'task_id'], ['events', 'event_id'], ['templates', 'template_id']]) {
    result[table] = (await db.query(`select * from annotation_private.${table} order by ${order}`)).rows;
  }
  return result;
}

function omitPracticeFlag(snapshotValue) {
  return {
    ...snapshotValue,
    assignments: snapshotValue.assignments.map(({ practice_required: _flag, ...row }) => row),
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
  for (const file of (await readdir(oldDirectory)).filter(name => name.endsWith('.sql')).sort()) {
    await db.exec(await readFile(path.join(oldDirectory, file), 'utf8'));
  }
  await db.query('insert into auth.users(id) values($1)', [uid]);
  await db.query(`insert into annotation_private.participants
    (participant_id,auth_user_id,display_name,recovery_hash,scheme,guide_ack_at)
    values($1,$2,$3,decode(repeat('C',64),'hex'),$4,$5)`,
  [historical.participant_id, uid, historical.display_name, scheme, historical.instructions_acknowledged_at]);
  for (const [kind, rows] of [['practice', historical.practice_assignments], ['study', historical.study_assignments]]) {
    for (const row of rows) {
      const template = expected.templates.find(item => item.scheme === scheme && item.kind === kind && sameHashes(item.hashes, row.hashes));
      assert.ok(template);
      await db.query(`insert into annotation_private.assignments
        (task_id,participant_id,template_id,kind,position,status,stage,revision,
         stage1_answers,stage2_answers,locked_at,reference_released_at,completed_at,updated_at)
        values($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11,$12,$13,'2026-10-18T00:00:00Z')`,
      [row.id,historical.participant_id,template.template_id,kind,row.position,row.status,row.stage,row.revision,
        JSON.stringify(row.stage1_answers),JSON.stringify(row.stage2_answers),row.locked_at,row.reference_released_at,row.completed_at]);
    }
  }
  for (const event of historical.events) {
    await db.query(`insert into annotation_private.events
      (participant_id,task_id,event_type,revision,payload,created_at) values($1,$2,$3,$4,$5::jsonb,$6)`,
    [historical.participant_id,event.task_id,event.event,event.revision,JSON.stringify(event.data),event.timestamp]);
  }
  const before = await snapshot();
  await applyUpgrade();
  const after = await snapshot();
  assert.deepEqual(omitPracticeFlag(after),before,'Only the new practice-selection flag may change');
  assert.equal(after.assignments.filter(row => row.practice_required).length,2);
  const current = await session();
  assert.equal(current.progress.practice_requirement,2);
  assert.equal(current.progress.practice_total,2);
  assert.equal(current.tasks.length,128);
  const completedBefore = historical.practice_assignments.filter(row => row.status === 'complete');
  assert.equal(current.progress.practice_completed,Math.min(2,completedBefore.length));
  const completedIds = new Set(completedBefore.map(row => row.id));
  if (completedBefore.length <= 2) {
    for (const id of completedIds) assert.ok(current.tasks.some(row => row.id === id));
  }
  await applyUpgrade();
  assert.deepEqual(await snapshot(),after,'A repeated upgrade must preserve every row and the selected IDs');
  assert.deepEqual(await session(),current);
  console.log('PASS: historical QA export replays against exact frozen templates; upgrade and rerun preserve all prior rows, answers, locks, events, task order and identity; only two persistent practice flags are added.');
} finally {
  await db.close();
}
