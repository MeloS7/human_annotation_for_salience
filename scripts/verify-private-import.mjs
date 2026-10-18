// Offline coordinator check only. No network calls and no production writes.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';

if (process.argv.length !== 4) throw new Error('Usage: node scripts/verify-private-import.mjs PRIVATE_SQL_OR_DIRECTORY EXPECTED_PRIVATE_JSON');
const inputPath = process.argv[2];
const sqlPaths = (await stat(inputPath)).isDirectory()
  ? (await readdir(inputPath)).filter(name => name.endsWith('.sql')).sort().map(name => path.join(inputPath, name))
  : [inputPath];
assert.ok(sqlPaths.length > 0, 'No private SQL files were found');
const sqlFiles = await Promise.all(sqlPaths.map(file => readFile(file, 'utf8')));
const expected = JSON.parse(await readFile(process.argv[3], 'utf8'));
const db = new PGlite();
const firstUID = '10000000-0000-4000-8000-000000000001';
const recoveredUID = '10000000-0000-4000-8000-000000000002';
const firstCode = `SAL-${'A'.repeat(64)}`;
const replacementCode = `SAL-${'B'.repeat(64)}`;
const answers = { source_coverage: 'Tie', readability: 'A', faithfulness: 'B', content_focus: 'Tie' };

async function api(uid, action, taskId = null, payload = {}) {
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [uid]);
  await db.exec('set role authenticated');
  try {
    const result = await db.query('select public.annotation_api($1,$2,$3::jsonb) as value', [action, taskId, JSON.stringify(payload)]);
    return result.rows[0].value;
  } finally {
    await db.exec('reset role');
  }
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
  for (const sql of sqlFiles) await db.exec(sql);
  const templates = (await db.query('select template_id,scheme,kind,position,payload,hashes,coordinator from annotation_private.templates order by template_id')).rows;
  assert.equal(templates.length, 402);
  const sortedExpected = [...expected.templates].sort((a,b) => a.template_id.localeCompare(b.template_id));
  assert.deepEqual(templates, sortedExpected);
  for (const template of templates) {
    for (const field of ['request', 'source', 'summary_a', 'summary_b', 'reference']) {
      assert.equal(createHash('sha256').update(template.payload[field], 'utf8').digest('hex'), template.hashes[`${field}_sha256`]);
    }
  }
  const settings = (await db.query('select study_fingerprint,instruction_fingerprint,rubric_version,rubric,guide_md from annotation_private.settings where id=1')).rows[0];
  assert.deepEqual(settings, expected.settings);
  assert.equal((await db.query('select count(*)::int as count from annotation_private.participants')).rows[0].count, 0);
  await db.query('insert into auth.users(id) values($1),($2)', [firstUID,recoveredUID]);
  const session = await api(firstUID, 'enroll', null, {display_name:'OFFLINE_QA',recovery_code:firstCode});
  assert.equal(session.progress.study_total,126);
  assert.equal(session.progress.practice_total,8);
  const practiceID = session.tasks.find(task => task.kind === 'practice' && task.position === 1).id;
  const studyID = session.tasks.find(task => task.kind === 'study' && task.position === 1).id;
  await assert.rejects(api(firstUID,'task',practiceID), {code:'PT403'});
  await api(firstUID,'acknowledge',null,{accepted:true});
  await assert.rejects(api(firstUID,'task',studyID), {code:'PT403'});
  let task = await api(firstUID,'task',practiceID);
  assert.ok(!Object.hasOwn(task,'reference'));
  await assert.rejects(api(firstUID,'reference',practiceID), {code:'PT403'});
  task = await api(firstUID,'lock',practiceID,{revision:task.revision,answers});
  assert.equal(task.stage,2);
  const reference = await api(firstUID,'reference',practiceID);
  assert.equal(typeof reference.reference,'string');
  await assert.rejects(api(firstUID,'save',practiceID,{stage:1,revision:reference.revision,answers:{source_coverage:'A'}}), {code:'PT409'});
  const before = (await db.query('select * from annotation_private.assignments where task_id=$1',[practiceID])).rows[0];
  const participantBefore = (await db.query('select * from annotation_private.participants where participant_id=$1',[session.participant_id])).rows[0];
  for (const sql of sqlFiles) await db.exec(sql);
  const after = (await db.query('select * from annotation_private.assignments where task_id=$1',[practiceID])).rows[0];
  assert.deepEqual(after,before);
  assert.deepEqual((await db.query('select * from annotation_private.participants where participant_id=$1',[session.participant_id])).rows[0], participantBefore);
  const beforeRecoverySession = await api(firstUID,'session');
  const restored = await api(recoveredUID,'recover',null,{recovery_code:firstCode,new_recovery_code:replacementCode});
  assert.equal(restored.participant_id,session.participant_id);
  assert.deepEqual(restored.tasks,beforeRecoverySession.tasks);
  assert.equal((await api(firstUID,'session')).enrolled,false);
  const restoredTask = await api(recoveredUID,'task',practiceID);
  assert.equal(restoredTask.locked_at,task.locked_at);
  assert.equal(restoredTask.reference_released_at,reference.reference_released_at);
  assert.equal(restoredTask.revision,reference.revision);
  const exported = await api(recoveredUID,'export');
  const exportText = JSON.stringify(exported);
  assert.ok(!exportText.includes(firstCode) && !exportText.includes(replacementCode));
  for (const template of templates) assert.ok(!exportText.includes(template.payload.reference));
  console.log('PASS: all402 frozen templates and hashes round-trip exactly; private schema import is idempotent and preserves work; recovery preserves lock/exposure and revokes old UID.');
} finally {
  await db.close();
}
