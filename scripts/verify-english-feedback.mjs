// Read real private fixtures into a disposable database only; no network calls.
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import {PGlite} from '@electric-sql/pglite';
import {qualificationResultsReady,qualificationProtocolReady,studyGateOpen} from '../web/stage-state.js';

if(process.argv.length!==8)throw new Error('Usage: node scripts/verify-english-feedback.mjs ORIGINAL_SQL_DIR PILOT_SQL MANDATORY_SQL FIXED_SQL ENGLISH_SQL EXPANDED_FEEDBACK_JSON');
const [initialDir,...files]=process.argv.slice(2);
const [pilot,mandatory,fixed,english,feedbackText]=await Promise.all(files.map(f=>readFile(f,'utf8')));
const feedback=JSON.parse(feedbackText);
const db=new PGlite();
const uid=n=>`99000000-0000-4000-8000-${n.toString(16).padStart(12,'0')}`;
const code=n=>`SAL-${n.toString(16).padStart(2,'0').repeat(32)}`;
const firstFour=['source_coverage','readability','faithfulness','content_focus'];
const presentationFields=new Set(['title_zh','rationale_zh','title_en','rationale_en','feedback_language','feedback_version']);
const han=/[\u3400-\u4dbf\u4e00-\u9fff\u{20000}-\u{323af}]/u;
let phase='initialize frozen private installation';
function checkpoint(value){phase=value;console.log(`CHECK: ${phase}`);}
function nonText(value){
  if(Array.isArray(value))return value.map(nonText);
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([k])=>!presentationFields.has(k)).map(([k,v])=>[k,nonText(v)]));
  return value;
}
async function api(n,action,id=null,payload={}){
  await db.query("select set_config('request.jwt.claim.sub',$1,false)",[uid(n)]);await db.exec('set role authenticated');
  try{return(await db.query('select public.annotation_api($1,$2,$3::jsonb) value',[action,id,JSON.stringify(payload)])).rows[0].value;}
  finally{await db.exec('reset role');}
}
async function denied(promise,code){await assert.rejects(promise,e=>{assert.equal(e.code,code);return true;});}
async function enroll(n){
  await db.query('insert into auth.users(id) values($1)',[uid(n)]);
  const session=await api(n,'enroll',null,{display_name:'OFFLINE_ENGLISH_FEEDBACK_QA',recovery_code:code(n)});
  await api(n,'acknowledge',null,{accepted:true});return session;
}
async function complete(n,id,answers){
  const task=await api(n,'task',id);assert.equal(Object.hasOwn(task,'reference'),false);
  await denied(api(n,'reference',id),'PT403');
  await api(n,'lock',id,{revision:task.revision,answers:Object.fromEntries(firstFour.map(d=>[d,answers[d]]))});
  const ref=await api(n,'reference',id);
  return api(n,'complete',id,{revision:ref.revision,answers:{reference_coverage:answers.reference_coverage}});
}
async function qualify(n,errors){
  let remaining=errors;const session=await api(n,'session');
  for(const task of session.tasks.filter(t=>t.kind==='qualification')){
    const key=(await db.query('select k.suggestions from annotation_private.assignments a join annotation_private.qualification_keys k using(template_id) where a.task_id=$1',[task.id])).rows[0].suggestions;
    const answers={};
    for(const [id,s]of Object.entries(key)){
      answers[id]=s.label;if(s.scored&&remaining>0){answers[id]=s.label==='A'?'B':'A';remaining--;}
    }
    await complete(n,task.id,answers);
  }
  assert.equal(remaining,0);return api(n,'qualification_results');
}
async function snapshot(){
  const out={};
  for(const [table,order]of [['participants','participant_id'],['assignments','task_id'],['events','event_id'],
    ['qualification_results','participant_id'],['qualification_keys','template_id'],['templates','template_id'],
    ['qualification_sets','qualification_version'],['qualification_policies','policy_version'],
    ['fixed_package_participants','participant_id'],['fixed_package_task_assignments','task_id']])
    out[table]=(await db.query(`select * from annotation_private.${table} order by ${order}`)).rows;
  return out;
}
async function checkEnglish(result,original){
  assert.equal(qualificationResultsReady(result),true);assert.equal(result.feedback_language,'en');
  assert.equal(result.feedback_version,feedback.feedback_version);
  assert.deepEqual(nonText(result),nonText(original));
  assert.equal(han.test(JSON.stringify(result)),false);
  for(const item of result.items){
    const row=(await db.query('select template_id from annotation_private.assignments where task_id=$1',[item.id])).rows[0];
    const expected=feedback.items.find(v=>v.template_id===row.template_id);assert.ok(expected);
    assert.equal(item.title_en,expected.title_en);assert.equal(Object.hasOwn(item,'title_zh'),false);
    for(const dimension of item.dimensions){
      assert.equal(dimension.rationale_en,expected.rationales_en[dimension.id]);
      assert.equal(Object.hasOwn(dimension,'rationale_zh'),false);
    }
  }
}
try{
  await db.exec(`create role anon nologin;create role authenticated nologin;create schema auth;
    create table auth.users(id uuid primary key,is_anonymous boolean not null default true);
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    grant usage on schema auth to anon,authenticated;grant execute on function auth.uid() to anon,authenticated;`);
  for(const f of(await readdir(initialDir)).filter(f=>f.endsWith('.sql')).sort())await db.exec(await readFile(path.join(initialDir,f),'utf8'));
  await db.exec(pilot);await db.exec(mandatory);
  checkpoint('create immutable results across all three historical A/B schemes');
  const oldResults=new Map();
  for(const [n,errors]of [[1,4],[2,5],[3,2]]){
    await enroll(n);const result=await qualify(n,errors);assert.equal(result.matched,18-errors);oldResults.set(n,result);
  }
  const oldSession=await api(1,'session');
  const oldStudy=oldSession.tasks.find(t=>t.kind==='study');const task=await api(1,'task',oldStudy.id);
  await api(1,'lock',task.id,{revision:task.revision,answers:Object.fromEntries(firstFour.map(d=>[d,'Tie']))});
  const exposed=await api(1,'reference',task.id);
  await api(1,'save',task.id,{stage:2,revision:exposed.revision,answers:{reference_coverage:'A'}});
  await db.exec(fixed);
  const before=await snapshot();
  checkpoint('apply final English SQL without changing any original record');
  await db.exec(english);assert.deepEqual(await snapshot(),before);
  await db.exec(english);assert.deepEqual(await snapshot(),before);
  for(const n of [1,2,3])await checkEnglish(await api(n,'qualification_results'),oldResults.get(n));
  const preservedTask=await api(1,'task',oldStudy.id);
  assert.equal(preservedTask.stage,2);assert.equal(preservedTask.status,'locked');
  assert.deepEqual(preservedTask.answers,{reference_coverage:'A'});
  checkpoint('verify 13 fails, 14 passes and original/current exports remain semantically identical');
  for(const [n,passed]of [[1,true],[2,false],[3,true]]){
    const session=await api(n,'session');assert.equal(qualificationProtocolReady(session),true);assert.equal(studyGateOpen(session),passed);
    const own=await api(n,'export');await checkEnglish(own.qualification_result,oldResults.get(n));
    const raw=before.qualification_results.find(row=>row.participant_id===session.participant_id).result;
    assert.deepEqual(nonText(own.qualification_original_result),nonText(raw));
    assert.equal(han.test(JSON.stringify(own.qualification_original_result)),false);
  }
  const admin=(await db.query('select annotation_private.export_all() value')).rows[0].value;
  for(const payload of Object.values(admin.participants)){
    assert.equal(han.test(JSON.stringify(payload.qualification_result)),false);
    assert.equal(han.test(JSON.stringify(payload.qualification_original_result)),false);
  }
  checkpoint('English feedback remains hidden until completion and applies to newly saved results');
  const fresh=await enroll(4);assert.equal(fresh.progress.study_total,0);await denied(api(4,'qualification_results'),'PT403');
  assert.equal(JSON.stringify(fresh).includes('rationale_en'),false);
  const unfinishedExport=await api(4,'export');
  assert.ok(unfinishedExport);assert.equal(unfinishedExport.qualification_result,null);
  assert.equal(unfinishedExport.qualification_original_result,null);
  const unfinishedAdmin=(await db.query('select annotation_private.export_all() value')).rows[0].value;
  assert.equal(unfinishedAdmin.participants[fresh.participant_id].qualification_result,null);
  const newResult=await qualify(4,4);assert.equal(newResult.matched,14);assert.equal(newResult.state,'passed');
  assert.equal(qualificationResultsReady(newResult),true);assert.equal(han.test(JSON.stringify(newResult)),false);
  const saved=await api(4,'session');assert.equal(saved.progress.study_total,42);
  await db.query('insert into auth.users(id) values($1)',[uid(100)]);
  const recovered=await api(100,'recover',null,{recovery_code:code(4),new_recovery_code:code(100)});
  assert.deepEqual(recovered.tasks,saved.tasks);assert.deepEqual(recovered.allocation,saved.allocation);
  const originalRecords=await snapshot();await db.exec(english);assert.deepEqual(await snapshot(),originalRecords);
  console.log('PASS: real English feedback across all three schemes; labels, masks, scores, 14/18 policy, raw snapshots, original materials and saved/locked work preserved; pre-completion secrecy, old/new results, exports, recovery and repeat activation verified offline.');
}catch(error){
  console.error(`FAIL during ${phase}: ${error.code||error.name}; ${String(error.message).split('\n')[0].slice(0,220)}`);process.exitCode=1;
}finally{await db.close();}
