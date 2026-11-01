// Isolated real-material integration QA. No network or production writes.
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import {PGlite} from '@electric-sql/pglite';
import {qualificationProtocolReady,studyGateOpen} from '../web/stage-state.js';

if(process.argv.length!==8) throw new Error('Usage: node scripts/verify-fixed-packages.mjs ORIGINAL_SQL_DIR PILOT_SQL MANDATORY_SQL FIXED_SQL PLAN_JSON PACKAGE_DIR');
const [initialDir,pilotPath,mandatoryPath,fixedPath,planPath,packageDir]=process.argv.slice(2);
const [pilot,mandatory,fixed,plan]=await Promise.all([
  ...[pilotPath,mandatoryPath,fixedPath].map(file=>readFile(file,'utf8')),
  readFile(planPath,'utf8').then(JSON.parse),
]);
const packages=new Map();
for(const p of plan.packages)packages.set(p.package_id,JSON.parse(await readFile(path.join(packageDir,`${p.package_id}.json`),'utf8')));
const db=new PGlite();
let phase='bootstrap frozen private installation';
function checkpoint(value){phase=value;console.log(`CHECK: ${phase}`);}
const uid=n=>`98000000-0000-4000-8000-${n.toString(16).padStart(12,'0')}`;
const code=n=>`SAL-${n.toString(16).padStart(2,'0').repeat(32)}`;
const dimensions=['source_coverage','readability','faithfulness','content_focus'];
async function api(n,action,id=null,payload={}){
  await db.query("select set_config('request.jwt.claim.sub',$1,false)",[uid(n)]);
  await db.exec('set role authenticated');
  try{return(await db.query('select public.annotation_api($1,$2,$3::jsonb) value',[action,id,JSON.stringify(payload)])).rows[0].value;}
  finally{await db.exec('reset role');}
}
async function denied(promise,state){await assert.rejects(promise,e=>{
  assert.equal(e.code,state,'Unexpected denial SQLSTATE');return true;
});}
async function enroll(n){
  await db.query('insert into auth.users(id) values($1)',[uid(n)]);
  const result=await api(n,'enroll',null,{display_name:'OFFLINE_FIXED_PACKAGE_QA',recovery_code:code(n)});
  await api(n,'acknowledge',null,{accepted:true});
  return result;
}
async function finish(n,id,answers){
  const t=await api(n,'task',id);assert.equal(Object.hasOwn(t,'reference'),false);
  await denied(api(n,'reference',id),'PT403');
  const stage1=Object.fromEntries(dimensions.map(d=>[d,answers[d]]));
  const locked=await api(n,'lock',id,{revision:t.revision,answers:stage1});
  assert.equal(Object.hasOwn(locked,'reference'),false);
  const reference=await api(n,'reference',id);
  await denied(api(n,'save',id,{stage:1,revision:reference.revision,answers:{source_coverage:'A'}}),'PT409');
  const done=await api(n,'complete',id,{revision:reference.revision,answers:{reference_coverage:answers.reference_coverage}});
  assert.equal(done.status,'complete');
  return done;
}
async function qualify(n,errors){
  const session=await api(n,'session');let remaining=errors;
  for(const t of session.tasks.filter(t=>t.kind==='qualification')){
    const key=(await db.query('select k.suggestions from annotation_private.assignments a join annotation_private.qualification_keys k using(template_id) where a.task_id=$1',[t.id])).rows[0].suggestions;
    const answers={};
    for(const [dimension,suggestion]of Object.entries(key)){
      answers[dimension]=suggestion.label;
      if(suggestion.scored&&remaining>0){answers[dimension]=suggestion.label==='A'?'B':'A';remaining--;}
    }
    await finish(n,t.id,answers);
  }
  assert.equal(remaining,0);
  const result=await api(n,'qualification_results');assert.equal(result.matched,18-errors);
  return api(n,'session');
}
async function snapshot(){
  const result={};
  for(const [table,order]of [['assignments','task_id'],['qualification_results','participant_id'],['participants','participant_id'],['events','event_id']])
    result[table]=(await db.query(`select * from annotation_private.${table} order by ${order}`)).rows;
  return result;
}
try{
  await db.exec(`create role anon nologin;create role authenticated nologin;create schema auth;
    create table auth.users(id uuid primary key,is_anonymous boolean not null default true);
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    grant usage on schema auth to anon,authenticated;grant execute on function auth.uid() to anon,authenticated;`);
  for(const file of(await readdir(initialDir)).filter(n=>n.endsWith('.sql')).sort())await db.exec(await readFile(path.join(initialDir,file),'utf8'));
  await db.exec(pilot);await db.exec(mandatory);

  checkpoint('create protected legacy progress and original qualification snapshot');
  await enroll(1);const legacy=await qualify(1,2);
  const oldTask=legacy.tasks.find(t=>t.kind==='study');
  const t=await api(1,'task',oldTask.id);
  await api(1,'lock',t.id,{revision:t.revision,answers:Object.fromEntries(dimensions.map(d=>[d,'Tie']))});
  await api(1,'reference',t.id);
  const before=await snapshot();
  checkpoint('activate real frozen plan without rewriting old records');
  await db.exec(fixed);assert.deepEqual(await snapshot(),before);
  await db.exec(fixed);assert.deepEqual(await snapshot(),before);
  const oldSession=await api(1,'session');assert.equal(qualificationProtocolReady(oldSession),true);
  assert.equal(oldSession.allocation.mode,'legacy');assert.equal(oldSession.progress.study_total,126);
  assert.equal(studyGateOpen(oldSession),true);

  checkpoint('13-of-18 failure consumes no package and cannot bypass the gate');
  const failed=await enroll(9);assert.equal(qualificationProtocolReady(failed),true);
  assert.equal(failed.progress.study_total,0);assert.equal(failed.tasks.length,10);
  const failedSession=await qualify(9,5);assert.equal(failedSession.qualification.state,'failed');
  assert.equal(failedSession.allocation.package_id,null);assert.equal(studyGateOpen(failedSession),false);
  const archival=(await db.query("select task_id from annotation_private.assignments where participant_id=$1 and kind='study' limit 1",[failed.participant_id])).rows[0].task_id;
  await denied(api(9,'task',archival),'PT404');
  assert.equal((await db.query('select count(*)::int n from annotation_private.fixed_package_participants where package_id is not null')).rows[0].n,0);

  checkpoint('nine distinct passed participants receive the exact nine real packages');
  const seen=new Set();let firstSession;
  for(let n=10;n<19;n++){
    const fresh=await enroll(n);assert.equal(qualificationProtocolReady(fresh),true);
    const qrows=(await db.query(`select k.qualification_id,t.scheme from annotation_private.assignments a
      join annotation_private.templates t using(template_id) join annotation_private.qualification_keys k using(template_id)
      where a.participant_id=$1 and a.kind='qualification' order by a.position`,[fresh.participant_id])).rows;
    assert.deepEqual(qrows.map(x=>x.scheme),Array(10).fill(1));
    assert.deepEqual(qrows.map(x=>x.qualification_id),Array.from({length:10},(_,i)=>`Q${String(i+1).padStart(2,'0')}`));
    const s=await qualify(n,4);assert.equal(s.qualification.state,'passed');assert.equal(s.qualification.score.matched,14);
    assert.equal(qualificationProtocolReady(s),true);assert.equal(studyGateOpen(s),true);
    assert.equal(s.progress.study_total,42);assert.equal(s.tasks.length,52);assert.equal(seen.has(s.allocation.package_id),false);
    seen.add(s.allocation.package_id);if(n===10)firstSession=s;
    const pack=packages.get(s.allocation.package_id);assert.ok(pack);
    const mapped=(await db.query(`select m.item_id,m.item_position,a.template_id,t.payload from annotation_private.fixed_package_task_assignments m
      join annotation_private.assignments a using(task_id) join annotation_private.templates t using(template_id)
      where m.participant_id=$1 order by m.item_position`,[s.participant_id])).rows;
    assert.deepEqual(mapped.map(x=>({item_id:x.item_id,position:x.item_position,template_id:x.template_id,payload:x.payload})),
      pack.study.map(x=>({item_id:x.item_id,position:x.position,template_id:x.template_id,payload:x.payload})));
    const qpayloads=(await db.query(`select t.payload from annotation_private.assignments a join annotation_private.templates t using(template_id)
      where a.participant_id=$1 and a.kind='qualification' order by a.position`,[s.participant_id])).rows;
    assert.deepEqual(qpayloads.map(x=>x.payload),pack.qualification.map(x=>x.payload));
    const repeated=await api(n,'session');assert.deepEqual(repeated.tasks,s.tasks);assert.deepEqual(repeated.allocation,s.allocation);
  }
  assert.equal(seen.size,9);
  const coverage=(await db.query('select item_id,count(distinct participant_id)::int n from annotation_private.fixed_package_task_assignments group by item_id')).rows;
  assert.equal(coverage.length,126);assert.ok(coverage.every(x=>x.n===3));

  checkpoint('tenth eligible participant receives full rather than duplicate assignment');
  await enroll(19);const full=await qualify(19,4);assert.equal(qualificationProtocolReady(full),true);
  assert.equal(full.allocation.state,'full');assert.equal(full.progress.study_total,0);assert.equal(studyGateOpen(full),false);
  assert.equal((await db.query('select count(*)::int n from annotation_private.fixed_package_task_assignments')).rows[0].n,378);

  checkpoint('reference lock, stale IDs, ownership and recovery preserve the fixed package');
  const owned=firstSession.tasks.find(x=>x.kind==='study');
  const ownedPayload=await api(10,'task',owned.id);assert.equal(ownedPayload.total,42);assert.equal(ownedPayload.position,1);
  const other=await api(11,'session');await denied(api(11,'task',owned.id),'PT404');
  assert.notEqual(other.participant_id,firstSession.participant_id);
  await finish(10,owned.id,Object.fromEntries([...dimensions,'reference_coverage'].map(d=>[d,'Tie'])));
  const unselected=(await db.query(`select a.task_id from annotation_private.assignments a where a.participant_id=$1 and a.kind='study'
    and not exists(select 1 from annotation_private.fixed_package_task_assignments m where m.task_id=a.task_id) limit 1`,[firstSession.participant_id])).rows[0].task_id;
  await denied(api(10,'task',unselected),'PT404');await denied(api(10,'reference',unselected),'PT404');
  const saved=await api(10,'session');await db.query('insert into auth.users(id) values($1)',[uid(100)]);
  const recovered=await api(100,'recover',null,{recovery_code:code(10),new_recovery_code:code(100)});
  assert.deepEqual(recovered.tasks,saved.tasks);assert.deepEqual(recovered.allocation,saved.allocation);
  await denied(api(10,'task',owned.id),'PT401');

  checkpoint('exports distinguish active/archival rows and identical upgrade retry preserves all work');
  const own=await api(100,'export');assert.equal(own.allocation.package_id,firstSession.allocation.package_id);
  assert.equal(own.study_assignments.filter(x=>x.allocation_role==='active_package').length,42);
  assert.equal(own.study_assignments.filter(x=>x.allocation_role==='archival_legacy').length,126);
  const all=(await db.query('select annotation_private.export_all() value')).rows[0].value;
  assert.equal(Object.keys(all.participants).length,12);
  const final=await snapshot();await db.exec(fixed);assert.deepEqual(await snapshot(),final);
  for(const key of ['assignments','qualification_results','events'])
    for(const row of before[key])assert.ok(final[key].some(value=>JSON.stringify(value)===JSON.stringify(row)));
  console.log('PASS: actual 9×(10+42) JSONs match private server payloads; 126×3 coverage; 13 fails/14 passes; ninth unique/tenth full; canonical qualification, legacy preservation, reference lock, stale-ID denial, recovery, exports and reruns verified offline.');
}catch(error){
  console.error(`FAIL during ${phase}: ${error.code||error.name}; ${String(error.message).split('\n')[0].slice(0,220)}`);
  process.exitCode=1;
}finally{await db.close();}
