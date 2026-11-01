import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";

const MIGDIR = new URL("../supabase/migrations/", import.meta.url);
const SCRIPT = new URL("../scripts/build-fixed-packages-setup.py", import.meta.url);
const NAMES = ["20261018000000_annotation_api.sql","20261018010000_two_practice_tasks.sql",
  "20261020000000_qualification_pilot.sql","20261101000000_mandatory_qualification.sql","20261101010000_fixed_packages.sql"];
const SQL = await Promise.all(NAMES.map(n=>readFile(new URL(n,MIGDIR),"utf8")));
const KEY = "qualification-pilot-20261020-v1", POLICY = "qualification-required-20261101-v1";
const VERSION = "fixed-packages-20261101-v1";
const DIMS = ["source_coverage","readability","faithfulness","content_focus","reference_coverage"];
const MASK = [["source_coverage","readability"],["source_coverage","faithfulness"],["source_coverage","content_focus"],
  ["readability","faithfulness"],["readability","reference_coverage"],["readability","content_focus"],
  ["faithfulness","content_focus"],["faithfulness","reference_coverage"],["content_focus","reference_coverage"],[]];
const uid=n=>"10000000-0000-4000-8000-"+n.toString(16).padStart(12,"0");
const recovery=n=>"SAL-"+n.toString(16).slice(-1).repeat(64);
const sha=s=>createHash("sha256").update(s).digest("hex");
const canonical=value=>JSON.stringify(value,(_,v)=>v&&typeof v==="object"&&!Array.isArray(v)
  ?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))):v);
const suggestions=(position,scheme)=>Object.fromEntries(DIMS.map((id,i)=>[id,{
  label:((position+scheme+i)%2)?"A":"B",scored:MASK[position-1].includes(id),rationale_zh:"synthetic",confidence:"high"
}]));
async function asRole(db,role,user,fn){
  await db.query("select set_config('request.jwt.claim.sub',$1,false)",[user||""]);
  await db.exec("set role "+role);try{return await fn();}finally{await db.exec("reset role");}
}
async function api(db,user,action,task=null,payload={}){
  return asRole(db,"authenticated",user,async()=>{
    const result=await db.query("select public.annotation_api($1,$2,$3::jsonb) response",
      [action,task,payload===null?null:JSON.stringify(payload)]);
    return result.rows[0].response;
  });
}
async function expectCode(promise,code){
  await assert.rejects(promise,e=>{assert.equal(e.code,code,e.message);return true;});
}
function packagePlan(){
  const packs=Array.from({length:9},(_,i)=>({package_id:"package_"+String(i+1).padStart(2,"0"),ordinal:i+1,items:[]}));
  for(let item=0;item<126;item++) for(let offset=0;offset<3;offset++){
    const p=(item+offset)%9,scheme=(item+offset)%3+1;
    packs[p].items.push({position:packs[p].items.length+1,item_id:"pair-"+String(item+1).padStart(3,"0"),
      template_id:"study-"+scheme+"-"+(item+1)});
  }
  return packs;
}
async function importPlan(db){
  const packages=packagePlan();
  const body={version:VERSION,packages};
  const plan={...body,fingerprint:sha(canonical(body))};
  const scratch=await mkdtemp(path.join(os.tmpdir(),"fixed-plan-setup-"));
  const planPath=path.join(scratch,"assignment_plan.private.json");
  const sqlPath=path.join(scratch,"activate-fixed-packages.private.sql");
  try{
    await writeFile(planPath,JSON.stringify(plan));
    const build=spawnSync("python3",["-B",SCRIPT.pathname,"--plan",planPath,"--output-sql",sqlPath],{encoding:"utf8"});
    assert.equal(build.status,0,build.stderr);
    const activation=await readFile(sqlPath,"utf8");
    assert.match(activation,/v_before_assignments/);
    assert.match(activation,/v_before_qualification_results/);
    assert.match(activation,/v_before_events/);
    assert.match(activation,/v_before_participants/);
    assert.match(activation,/annotation_private\.settings SET assignment_version/);
    assert.match(activation,/qualification_pass_count/);
    assert.match(activation,/package_item_memberships/);
    assert.match(activation,/qualification_original_result/);
    assert.match(activation,/legacy_participants/);
    await db.exec(activation);
    return activation;
  }finally{await rm(scratch,{recursive:true,force:true});}
}
async function coreSnapshot(db){
  const snapshot={};
  for(const [table,key] of [["assignments","task_id"],["qualification_results","participant_id"],["events","event_id"],["participants","participant_id"]]){
    snapshot[table]=(await db.query(`select * from annotation_private.${table} order by ${key}`)).rows;
  }
  return snapshot;
}
async function bootstrap(){
  const db=new PGlite();
  await db.exec("create role anon nologin;create role authenticated nologin;create schema auth;"+
    "create table auth.users(id uuid primary key,is_anonymous boolean not null default true);"+
    "create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;"+
    "grant usage on schema auth to anon,authenticated;grant execute on function auth.uid() to anon,authenticated;");
  await db.exec(SQL[0]);await db.exec("begin;"+SQL[1]+"commit;");
  const rubric={criteria:DIMS.map((id,n)=>({id,label:id,stage:n===4?2:1,question:id,bullets:["synthetic"]})),
    choices:[{value:"A",definition:"A"},{value:"B",definition:"B"},{value:"Tie",definition:"Tie"}],
    reference_intro:"Review the reference.",shared_instructions:["Choose a preference."]};
  await db.query("insert into annotation_private.settings(id,study_fingerprint,instruction_fingerprint,rubric_version,rubric,guide_md,enrollment_open)"+
    " values(1,'synthetic','synthetic','r1',$1::jsonb,'# Synthetic',true)",[JSON.stringify(rubric)]);
  for(let scheme=1;scheme<=3;scheme++){
    for(let position=1;position<=126;position++){
      const id="study-"+scheme+"-"+position;
      const payload={request:"Request "+id,source:"Source "+id,summary_a:"A "+id,summary_b:"B "+id,reference:"Reference "+id};
      const hashes=Object.fromEntries(Object.entries(payload).map(([k,v])=>[k+"_sha256",sha(v)]));
      const coordinator={pair_id:"pair-"+String(position).padStart(3,"0"),
        dataset:position<=60?"macsum":"gumsum",genre:position<=60?"news":"genre-"+(position%11),
        stratum:["improved","near","declined"][position%3],ours_side:((position+scheme)%2)?"A":"B",
        macsum_length:position<=60?["short","normal","long"][position%3]:null};
      await db.query("insert into annotation_private.templates(template_id,scheme,kind,position,payload,hashes,coordinator)"+
        " values($1,$2,'study',$3,$4::jsonb,$5::jsonb,$6::jsonb)",
        [id,scheme,position,JSON.stringify(payload),JSON.stringify(hashes),JSON.stringify(coordinator)]);
    }
    for(let position=1;position<=8;position++){
      const id="practice-"+scheme+"-"+position;
      const payload={request:id,source:id,summary_a:id,summary_b:id,reference:id};
      const hashes=Object.fromEntries(Object.entries(payload).map(([k,v])=>[k+"_sha256",sha(v)]));
      await db.query("insert into annotation_private.templates(template_id,scheme,kind,position,payload,hashes,coordinator)"+
        " values($1,$2,'practice',$3,$4::jsonb,$5::jsonb,null)",[id,scheme,position,JSON.stringify(payload),JSON.stringify(hashes)]);
    }
  }
  await db.exec("begin;"+SQL[2]+"commit;");
  const keyFingerprint=sha("qualification-inventory");
  await db.query("insert into annotation_private.qualification_sets(qualification_version,fingerprint,item_count,scored_total,pass_count,key_status)"+
    " values($1,$2,10,18,15,'llm_suggested_unvalidated')",[KEY,keyFingerprint]);
  for(let scheme=1;scheme<=3;scheme++)for(let pos=1;pos<=10;pos++){
    const id="qualification-"+scheme+"-"+pos,qid="Q"+String(pos).padStart(2,"0");
    const payload={request:id,source:"Source "+id,summary_a:"A "+id,summary_b:"B "+id,reference:"Reference "+id};
    const hashes=Object.fromEntries(Object.entries(payload).map(([k,v])=>[k+"_sha256",sha(v)]));
    await db.query("insert into annotation_private.templates(template_id,scheme,kind,position,payload,hashes,coordinator)"+
      " values($1,$2,'qualification',$3,$4::jsonb,$5::jsonb,$6::jsonb)",
      [id,scheme,pos,JSON.stringify(payload),JSON.stringify(hashes),JSON.stringify({qualification_version:KEY,qualification_id:qid,dataset:pos<=5?"cnndm":"gumsum",source_id:"Q"+pos})]);
    await db.query("insert into annotation_private.qualification_keys(qualification_version,template_id,qualification_id,dataset,title_zh,suggestions)"+
      " values($1,$2,$3,$4,$5,$6::jsonb)",
      [KEY,id,qid,pos<=5?"cnndm":"gumsum","Question "+pos,JSON.stringify(suggestions(pos,scheme))]);
  }
  await db.query("update annotation_private.settings set qualification_version=$1 where id=1",[KEY]);
  await db.exec("begin;"+SQL[3]+"commit;");
  const guide="# Before you begin\n\nComplete qualification first.";
  await db.query("insert into annotation_private.qualification_policies"+
    "(policy_version,qualification_version,fingerprint,pass_count,scored_total,key_status,confirmed_scored_count,workflow_guide_md,workflow_guide_sha256)"+
    " values($1,$2,$3,14,18,'human_confirmed_scored',18,$4,$5)",[POLICY,KEY,keyFingerprint,guide,sha(guide)]);
  await db.query("update annotation_private.settings set qualification_policy_version=$1 where id=1",[POLICY]);
  const oldUid=uid(1);await db.query("insert into auth.users(id) values($1)",[oldUid]);
  const old=await api(db,oldUid,"enroll",null,{display_name:"Existing",recovery_code:recovery(1)});
  await api(db,oldUid,"acknowledge",null,{accepted:true});
  await db.query("update annotation_private.assignments set stage1_answers='{\"readability\":\"B\"}'::jsonb,revision=1"+
    " where participant_id=$1 and kind='study' and position=1",[old.participant_id]);
  const before=await db.query("select jsonb_agg(to_jsonb(a) order by a.kind,a.position) rows from annotation_private.assignments a where participant_id=$1",[old.participant_id]);
  await db.exec("begin;"+SQL[4]+"commit;");const activation=await importPlan(db);
  return {db,oldUid,oldId:old.participant_id,before:before.rows[0].rows,activation};
}
async function enroll(db,n){
  const user=uid(n);await db.query("insert into auth.users(id) values($1)",[user]);
  const session=await api(db,user,"enroll",null,{display_name:"User "+n,recovery_code:recovery(n)});
  await api(db,user,"acknowledge",null,{accepted:true});
  return {user,id:session.participant_id,session};
}
async function completeQualification(db,user,task,remaining){
  const key=(await db.query("select k.suggestions from annotation_private.assignments a"+
    " join annotation_private.qualification_keys k using(template_id) where a.task_id=$1",[task.id])).rows[0].suggestions;
  const selected={};
  for(const id of DIMS.slice(0,4)){
    const label=key[id].label;
    selected[id]=key[id].scored&&remaining.value>0?(remaining.value--,label==="A"?"B":"A"):label;
  }
  const loaded=await api(db,user,"task",task.id);
  await expectCode(api(db,user,"reference",task.id),"PT403");
  const locked=await api(db,user,"lock",task.id,{revision:loaded.revision,answers:selected});
  const ref=await api(db,user,"reference",task.id);
  const label=key.reference_coverage.label;
  const final=key.reference_coverage.scored&&remaining.value>0?(remaining.value--,label==="A"?"B":"A"):label;
  await api(db,user,"complete",task.id,{revision:ref.revision,answers:{reference_coverage:final}});
  assert.equal(locked.stage,2);
}
async function finishQualification(db,user,session,mismatches){
  const remaining={value:mismatches};
  for(const task of session.tasks.filter(t=>t.kind==="qualification")) await completeQualification(db,user,task,remaining);
  assert.equal(remaining.value,0);
  return api(db,user,"qualification_results");
}
async function seedPassedQualification(db,user,id,matched=14){
  const session=await api(db,user,"session");
  const q=session.tasks.filter(t=>t.kind==="qualification");
  assert.equal(q.length,10);
  await db.query("update annotation_private.assignments a set status='complete',stage=2,revision=2,"+
    "stage1_answers=jsonb_build_object('source_coverage',k.suggestions->'source_coverage'->>'label',"+
    "'readability',k.suggestions->'readability'->>'label','faithfulness',k.suggestions->'faithfulness'->>'label',"+
    "'content_focus',k.suggestions->'content_focus'->>'label'),"+
    "stage2_answers=jsonb_build_object('reference_coverage',k.suggestions->'reference_coverage'->>'label'),"+
    "locked_at=now(),reference_released_at=now(),completed_at=now()"+
    " from annotation_private.qualification_keys k where a.template_id=k.template_id and a.participant_id=$1 and a.kind='qualification'",[id]);
  const result=await api(db,user,"qualification_results");
  assert.equal(result.matched,18);
  return q;
}

test("fixed package plan protects old work and yields exactly nine unique 42-item assignments",async()=>{
  const {db,oldUid,oldId,before,activation}=await bootstrap();
  try{
    const coreBeforeRerun=await coreSnapshot(db);
    await db.exec(activation);
    assert.deepEqual(await coreSnapshot(db),coreBeforeRerun);
    const state=(await db.query("select mode,package_id from annotation_private.fixed_package_participants where participant_id=$1",[oldId])).rows[0];
    assert.deepEqual(state,{mode:"legacy",package_id:null});
    const oldSession=await api(db,oldUid,"session");
    assert.equal(oldSession.allocation.mode,"legacy");assert.equal(oldSession.tasks.filter(t=>t.kind==="study").length,126);
    const after=await db.query("select jsonb_agg(to_jsonb(a) order by a.kind,a.position) rows from annotation_private.assignments a where participant_id=$1",[oldId]);
    assert.deepEqual(after.rows[0].rows,before);

    const failed=await enroll(db,2);
    assert.equal(failed.session.allocation.state,"qualification");
    assert.equal(failed.session.tasks.filter(t=>t.kind==="study").length,0);
    const failedResult=await finishQualification(db,failed.user,failed.session,5);
    assert.equal(failedResult.matched,13);assert.equal(failedResult.state,"failed");
    const failedSession=await api(db,failed.user,"session");
    assert.equal(failedSession.allocation.state,"qualification");
    assert.equal(failedSession.allocation.package_id,null);
    const failClaim=(await db.query("select package_id from annotation_private.fixed_package_participants where participant_id=$1",[failed.id])).rows[0];
    assert.equal(failClaim.package_id,null);

    const first=await enroll(db,3);
    const pScheme=(await db.query("select scheme from annotation_private.participants where participant_id=$1",[first.id])).rows[0].scheme;
    assert.equal(pScheme,1);
    const qMeta=await db.query("select t.position,t.scheme,k.qualification_id from annotation_private.assignments a"+
      " join annotation_private.templates t using(template_id) join annotation_private.qualification_keys k using(template_id)"+
      " where a.participant_id=$1 and a.kind='qualification' order by a.position",[first.id]);
    assert.deepEqual(qMeta.rows.map(r=>[r.position,r.scheme,r.qualification_id]),
      Array.from({length:10},(_,i)=>[i+1,1,"Q"+String(i+1).padStart(2,"0")]));
    const passed=await finishQualification(db,first.user,first.session,4);
    assert.equal(passed.matched,14);assert.equal(passed.state,"passed");
    const assigned=await api(db,first.user,"session");
    assert.equal(assigned.allocation.state,"assigned");assert.equal(assigned.allocation.package_id,"package_01");
    assert.equal(assigned.tasks.filter(t=>t.kind==="study").length,42);
    assert.equal(assigned.tasks.filter(t=>t.kind==="qualification").length,10);
    assert.equal(assigned.progress.study_total,42);assert.equal(assigned.progress.study_completed,0);
    const study=assigned.tasks.find(t=>t.kind==="study");
    const loaded=await api(db,first.user,"task",study.id);
    assert.equal(loaded.position,1);assert.equal(loaded.total,42);assert.equal("reference" in loaded,false);
    const oldTask=(await db.query("select task_id from annotation_private.assignments where participant_id=$1 and kind='study' and position=1",[first.id])).rows[0].task_id;
    await expectCode(api(db,first.user,"task",oldTask),"PT404");
    await expectCode(api(db,first.user,"reference",study.id),"PT403");
    const locked=await api(db,first.user,"lock",study.id,{revision:loaded.revision,answers:{
      source_coverage:"Tie",readability:"Tie",faithfulness:"Tie",content_focus:"Tie"}});
    const ref=await api(db,first.user,"reference",study.id);
    assert.equal(ref.reference,"Reference "+(await db.query("select template_id from annotation_private.assignments where task_id=$1",[study.id])).rows[0].template_id);
    assert.equal(locked.stage,2);

    const allocated=[assigned.allocation.package_id];
    for(let n=4;n<=11;n++){
      const person=await enroll(db,n);await seedPassedQualification(db,person.user,person.id,14);
      const session=await api(db,person.user,"session");
      assert.equal(session.allocation.state,"assigned");
      assert.ok(!allocated.includes(session.allocation.package_id));
      allocated.push(session.allocation.package_id);
      assert.equal(session.tasks.filter(t=>t.kind==="study").length,42);
    }
    assert.equal(allocated.length,9);
    const extra=await enroll(db,12);await seedPassedQualification(db,extra.user,extra.id,14);
    const extraSession=await api(db,extra.user,"session");
    assert.equal(extraSession.allocation.state,"full");
    assert.equal(extraSession.tasks.filter(t=>t.kind==="study").length,0);
    const counts=await db.query("select item_id,count(distinct participant_id)::int n from annotation_private.fixed_package_task_assignments"+
      " group by item_id order by item_id");
    assert.equal(counts.rows.length,126);assert.ok(counts.rows.every(row=>row.n===3));
    const exported=await api(db,first.user,"export");
    assert.equal(exported.allocation.package_id,"package_01");
    assert.equal(exported.study_assignments.filter(a=>a.allocation_role==="active_package").length,42);
    assert.equal(exported.study_assignments.filter(a=>a.allocation_role==="archival_legacy").length,126);
    const coordinator=await db.query("select annotation_private.export_all() data");
    const map=coordinator.rows[0].data.participants[first.id];
    assert.ok(map.study_assignments.some(a=>a.allocation_role==="active_package"&&a.package_position===1));
  }finally{await db.close();}
});
test("fixed inventory rejects duplicate/invalid package contents and remains immutable",async()=>{
  const {db}=await bootstrap();
  try{
    const original=(await db.query("select count(*)::int n from annotation_private.fixed_package_items")).rows[0].n;
    await db.query("update annotation_private.fixed_package_items set position=42 where assignment_version=$1 and package_id='package_01' and position=1",[VERSION]).catch(()=>{});
    assert.equal((await db.query("select count(*)::int n from annotation_private.fixed_package_items")).rows[0].n,original);
    await assert.rejects(db.query("update annotation_private.settings set assignment_version='other-v1' where id=1"),
      e=>e.code==="PT409");
    await assert.rejects(db.query("update annotation_private.fixed_package_items set assignment_version='other-v1' where assignment_version=$1 and package_id='package_01' and position=1",[VERSION]),
      e=>e.code==="PT409");
    const selected=(await db.query("select template_id from annotation_private.fixed_package_items where assignment_version=$1 and package_id='package_01' and position=1",[VERSION])).rows[0].template_id;
    await db.query("update annotation_private.templates set coordinator=jsonb_set(coordinator,'{ours_side}','\"invalid\"'::jsonb) where template_id=$1",[selected]);
    await assert.rejects(db.query("select annotation_private._assert_fixed_package_inventory($1)",[VERSION]),
      e=>e.code==="PT503");
  }finally{await db.close();}
});
