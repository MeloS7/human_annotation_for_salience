// Real private inputs are checked only in an isolated offline database.
// Never connects to Supabase, GitHub, JZ or any other network service.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import {PGlite} from '@electric-sql/pglite';
import {qualificationProtocolReady,qualificationResultsReady,studyGateOpen} from '../web/stage-state.js';

if(process.argv.length!==8)throw new Error('Usage: node scripts/verify-mandatory-qualification.mjs ORIGINAL_SQL_DIR PILOT_SQL MANDATORY_SQL APPROVAL_JSON PILOT_EXPECTED_JSON REVIEW_RESULT_JSON');
const [initialDir,pilotPath,mandatoryPath,approvalPath,expectedPath,reviewPath]=process.argv.slice(2);
const [pilotSql,mandatorySql,approval,expected,review]=await Promise.all([
  readFile(pilotPath,'utf8'),readFile(mandatoryPath,'utf8'),readFile(approvalPath,'utf8').then(JSON.parse),
  readFile(expectedPath,'utf8').then(JSON.parse),readFile(reviewPath,'utf8').then(JSON.parse),
]);
assert.equal(createHash('sha256').update(mandatorySql).digest('hex'),approval.sql_sha256);
const db=new PGlite();
let phase='initialize original private setup';
const uid=n=>`90000000-0000-4000-8000-${n.toString(16).padStart(12,'0')}`;
const code=n=>`SAL-${n.toString(16).padStart(2,'0').repeat(32)}`;
const stageOne={source_coverage:'Tie',readability:'A',faithfulness:'B',content_focus:'Tie'};
async function api(n,action,taskId=null,payload={}){
  await db.query("select set_config('request.jwt.claim.sub',$1,false)",[uid(n)]);await db.exec('set role authenticated');
  try{return(await db.query('select public.annotation_api($1,$2,$3::jsonb) as value',[action,taskId,JSON.stringify(payload)])).rows[0].value;}
  finally{await db.exec('reset role');}
}
async function denied(promise,sqlstate='PT403'){await assert.rejects(promise,e=>e.code===sqlstate);}
async function enroll(n){await db.query('insert into auth.users(id) values($1)',[uid(n)]);return api(n,'enroll',null,{display_name:'OFFLINE_MANDATORY_QA',recovery_code:code(n)});}
async function complete(n,id,answers){
  const t=await api(n,'task',id);await denied(api(n,'reference',id));
  await api(n,'lock',id,{revision:t.revision,answers:Object.fromEntries(Object.entries(answers).filter(([d])=>d!=='reference_coverage'))});
  const r=await api(n,'reference',id);return api(n,'complete',id,{revision:r.revision,answers:{reference_coverage:answers.reference_coverage}});
}
async function fixedSnapshot(){return{
  assignments:(await db.query('select * from annotation_private.assignments order by task_id')).rows,
  results:(await db.query('select * from annotation_private.qualification_results order by participant_id')).rows,
  events:(await db.query('select * from annotation_private.events order by event_id')).rows,
  templates:(await db.query('select * from annotation_private.templates order by template_id')).rows,
  keys:(await db.query('select * from annotation_private.qualification_keys order by template_id')).rows,
};}
async function finishQualification(n,session,mistakes,{useReview=false}={}){
  let remaining=mistakes;
  for(const t of session.tasks.filter(t=>t.kind==='qualification')){
    const [row]=(await db.query(`select k.* from annotation_private.assignments a join annotation_private.qualification_keys k using(template_id) where a.task_id=$1`,[t.id])).rows;
    const answers={};
    const human=useReview?review.items.find(item=>item.qualification_id===row.qualification_id):null;
    const swapped=human?.dimensions.some(d=>d.suggested!=='Tie'&&d.suggested!==row.suggestions[d.id].label);
    for(const [id,s]of Object.entries(row.suggestions)){
      if(human){
        const value=human.dimensions.find(d=>d.id===id).answer;answers[id]=swapped&&value!=='Tie'?(value==='A'?'B':'A'):value;
      }else{
        answers[id]=s.label;if(s.scored&&remaining>0){answers[id]=s.label==='A'?'B':'A';remaining--;}
      }
    }
    await complete(n,t.id,answers);
  }
  if(!useReview)assert.equal(remaining,0);
}
async function denyStudyActions(n,task){
  const payloads={task:{},reference:{},save:{stage:2,revision:task.revision,answers:{reference_coverage:'A'}},
    lock:{revision:task.revision,answers:stageOne},complete:{revision:task.revision,answers:{reference_coverage:'A'}},
    problem:{revision:task.revision,category:'other_interface_problem',criteria:['source_coverage']}};
  for(const [action,payload]of Object.entries(payloads))await denied(api(n,action,task.task_id||task.id,payload));
}
try{
  await db.exec(`create role anon nologin;create role authenticated nologin;create schema auth;
    create table auth.users(id uuid primary key,is_anonymous boolean not null default true);
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    grant usage on schema auth to anon,authenticated;grant execute on function auth.uid() to anon,authenticated;`);
  for(const name of(await readdir(initialDir)).filter(n=>n.endsWith('.sql')).sort())await db.exec(await readFile(path.join(initialDir,name),'utf8'));
  await db.exec(pilotSql);
  phase='create legacy started study plus three completed pilot outcomes';
  const first=await enroll(1);await api(1,'acknowledge',null,{accepted:true});
  for(const t of first.tasks.filter(t=>t.kind==='practice'))await complete(1,t.id,{...stageOne,reference_coverage:'Tie'});
  const started=first.tasks.find(t=>t.kind==='study');const t=await api(1,'task',started.id);
  await api(1,'lock',started.id,{revision:t.revision,answers:stageOne});const ref=await api(1,'reference',started.id);
  await api(1,'save',started.id,{stage:2,revision:ref.revision,answers:{reference_coverage:'A'}});
  const participants=new Map();
  for(const [n,errors]of [[2,4],[3,5],[4,2]]){
    await enroll(n);await api(n,'acknowledge',null,{accepted:true});const s=await api(n,'start_qualification');
    participants.set(n,s.participant_id);await finishQualification(n,s,errors,{useReview:n===4});
    const r=await api(n,'qualification_results');assert.equal(r.matched,18-errors);
    if(n===4)assert.equal(r.overall.matched,review.overall.matched);
  }
  const before=await fixedSnapshot();
  phase='apply human-confirmed mandatory policy without rewriting history';
  await db.exec(mandatorySql);assert.deepEqual(await fixedSnapshot(),before);
  await db.exec(mandatorySql);assert.deepEqual(await fixedSnapshot(),before);
  const legacy=await api(1,'session');
  assert.equal(legacy.tasks.length,136);assert.equal(legacy.qualification.required_for_study,true);
  assert.equal(legacy.qualification_required,true);assert.equal(legacy.qualification.pass_count,14);
  assert.equal(qualificationProtocolReady(legacy),true,'Actual server session must satisfy the published frontend contract');
  assert.equal(studyGateOpen(legacy),false);
  assert.equal(legacy.tasks.filter(x=>x.kind==='practice').length,0);assert.equal(legacy.qualification.completed,0);
  const saved=(await db.query('select * from annotation_private.assignments where task_id=$1',[started.id])).rows[0];
  assert.deepEqual(saved,before.assignments.find(x=>x.task_id===started.id));await denyStudyActions(1,saved);
  const practice=before.assignments.find(x=>x.participant_id===legacy.participant_id&&x.kind==='practice');await denied(api(1,'task',practice.task_id));
  phase='verify 13 fails, 14 passes and the real 16-of-18 review is preserved';
  for(const [n,score]of [[2,14],[3,13],[4,16]]){
    const s=await api(n,'session');const r=await api(n,'qualification_results');
    assert.equal(s.qualification.protocol,'qualification-required-v2');assert.equal(s.qualification.confirmed_scored_count,18);
    assert.equal(r.pass_count,14);assert.equal(r.key_status,'human_confirmed_scored');assert.equal(r.policy_version,approval.policy_version);
    assert.equal(r.matched,score);assert.equal(r.state,score>=14?'passed':'failed');
    assert.equal(s.qualification.state,r.state);assert.equal(s.tasks.length,136);
    assert.equal(qualificationProtocolReady(s),true);
    assert.equal(qualificationResultsReady(r),true);
    assert.equal(studyGateOpen(s),score>=14);
    const study=s.tasks.find(x=>x.kind==='study');
    if(score<14){const row=(await db.query('select * from annotation_private.assignments where task_id=$1',[study.id])).rows[0];await denyStudyActions(n,row);}
    else assert.equal((await api(n,'task',study.id)).id,study.id);
    const exported=await api(n,'export');
    const original=before.results.find(x=>x.participant_id===s.participant_id).result;
    assert.deepEqual(exported.qualification_original_result,original);
    assert.equal(exported.qualification_result.pass_count,14);
    assert.equal(exported.practice_assignments.length,8);
    assert.equal(exported.study_assignments.length,126);
    assert.equal(exported.qualification_assignments.length,10);
    assert.ok(!JSON.stringify(exported).includes(code(n)));
    if(n===4){assert.equal(r.overall.matched,38);assert.equal(r.matched,16);}
  }
  phase='new enrollment, blind feedback, recovery and threshold-edge lifecycle';
  const fresh=await enroll(5);assert.equal(fresh.tasks.length,136);assert.equal(fresh.qualification.completed,0);
  assert.equal(qualificationProtocolReady(fresh),true);assert.equal(studyGateOpen(fresh),false);
  await api(5,'acknowledge',null,{accepted:true});await denied(api(5,'qualification_results'));
  const q=fresh.tasks.find(x=>x.kind==='qualification');await denied(api(5,'reference',q.id));
  await finishQualification(5,fresh,4);assert.equal((await api(5,'qualification_results')).state,'passed');
  const beforeRecovery=await api(5,'session');await db.query('insert into auth.users(id) values($1)',[uid(6)]);
  const recovered=await api(6,'recover',null,{recovery_code:code(5),new_recovery_code:code(6)});
  assert.deepEqual(recovered.tasks,beforeRecovery.tasks);assert.deepEqual(recovered.qualification,beforeRecovery.qualification);
  phase='retry activated upgrade and verify raw historical evaluation immutability';
  const final=await fixedSnapshot();await db.exec(mandatorySql);assert.deepEqual(await fixedSnapshot(),final);
  for(const r of before.results)assert.deepEqual(final.results.find(x=>x.participant_id===r.participant_id),r);
  const all=(await db.query('select annotation_private.export_all() as value')).rows[0].value;
  assert.equal(Object.keys(all.participants).length,5);
  console.log('PASS: real key/guide and historical data preserved; 13/18 blocked,14/18 allowed, user16/18 and38/50 preserved; new enrollment, reference lock, recovery, exports and reruns verified offline.');
}catch(error){
  console.error(`FAIL during ${phase}: ${error.code||error.name}; ${String(error.message).split('\n')[0].slice(0,200)}`);process.exitCode=1;
}finally{await db.close();}
