import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {PGlite} from '@electric-sql/pglite';

const root=fileURLToPath(new URL('../',import.meta.url));
const script=`${root}scripts/build-mandatory-qualification-setup.py`;
const fixtureSource=`import json,runpy,sys
m=runpy.run_path(sys.argv[1]); old=runpy.run_path(sys.argv[2])
dims=['source_coverage','readability','faithfulness','content_focus','reference_coverage']
masks=[[1,2],[0,4],[1],[2,3],[0,4],[1,2],[0,4],[1],[2,3],[0,4]]
items=[dict(qualification_id=f'Q{i+1:02}',dataset='cnndm' if i<5 else 'gumsum',source_id=f'SYNTHETIC_{i}',title_zh='Synthetic',request='Synthetic',source='Synthetic source',reference='Synthetic reference',summary_a='Synthetic A',summary_b='Synthetic B') for i in range(10)]
keys=[dict(qualification_id=x['qualification_id'],dataset=x['dataset'],gold_suggestions={d:dict(label='A' if j%2==0 else 'Tie',scored=j in masks[i],rationale_zh='Synthetic rationale',confidence='high') for j,d in enumerate(dims)}) for i,x in enumerate(items)]
c,t,k=old['prepare_records'](items,keys); e=dict(config=c,templates=t,keys=k)
scheme={x['template_id']:x['scheme'] for x in t}; selected=[x for x in k if scheme[x['template_id']]==2]
reviewitems=[]; errors=2
for i,key in enumerate(selected):
  cells=[]
  for d,s in key['suggestions'].items():
    match=not(s['scored'] and errors>0)
    if not match: errors-=1
    cells.append(dict(id=d,answer=s['label'] if match else 'A' if s['label']!='A' else 'B',suggested=s['label'],scored=s['scored'],matches=match))
  reviewitems.append(dict(qualification_id=key['qualification_id'],dataset=key['dataset'],number=i+1,dimensions=cells))
r=dict(version=c['qualification_version'],key_status='llm_suggested_unvalidated',total=18,matched=16,pass_count=15,items=reviewitems,overall=dict(total=50,matched=48))
guide='Read these instructions and complete the practice comparisons. Ask the study coordinator about anything that is unclear before starting the main study.\\n\\n## Choosing an answer\\nFrozen exact rubric.'
case=sys.argv[3]
if case=='bad_mask': r['items'][0]['dimensions'][0]['scored']=not r['items'][0]['dimensions'][0]['scored']
if case=='bad_fingerprint': e['config']['fingerprint']='0'*64
if case=='bad_score': r['matched']=18
if case=='bad_guide': guide='Unexpected guide'
p,a=m['approve_review'](r,e,guide)
sql=m['build_sql'](m['helpers'](),'-- synthetic migration fixture',p)
print(json.dumps(dict(policy=p,approval=a,review=r,guide=guide,sql=sql)))`;
function fixture(caseName='valid'){
  return spawnSync('python3',['-B','-c',fixtureSource,script,`${root}scripts/build-qualification-setup.py`,caseName],{encoding:'utf8'});
}

test('approval confirms only the 18 scored suggestions without changing either initial answer',()=>{
  const raw=fixture();assert.equal(raw.status,0,raw.stderr);const out=JSON.parse(raw.stdout);
  assert.equal(out.policy.pass_count,14);
  assert.equal(out.policy.confirmed_scored_count,18);
  assert.equal(out.policy.key_status,'human_confirmed_scored');
  assert.equal(out.approval.scored_labels.length,18);
  assert.equal(out.approval.scored_labels.filter(x=>!x.initially_agreed).length,2);
  assert.equal(out.approval.exploratory_count,32);
  assert.equal(out.approval.human_reviewers,1);
  for(const row of out.approval.scored_labels){
    const cell=out.review.items.find(x=>x.qualification_id===row.qualification_id).dimensions.find(x=>x.id===row.dimension);
    assert.equal(row.review_answer,cell.answer);assert.equal(row.final_label,cell.suggested);
  }
  assert.equal(out.policy.workflow_guide_md.split('## Choosing an answer')[1],out.guide.split('## Choosing an answer')[1]);
  assert.doesNotMatch(out.policy.workflow_guide_md,/practice/i);
  assert.match(out.policy.workflow_guide_md,/14 of the 18/);
});

test('approval rejects a changed scored mask, inconsistent score, altered fixture or unexpected guide',()=>{
  for(const name of ['bad_mask','bad_fingerprint','bad_score','bad_guide']){
    const result=fixture(name);assert.notEqual(result.status,0,name);
  }
});

test('mandatory policy SQL is additive, rerunnable under immutable guards, and has one final result query',async()=>{
  const raw=fixture();assert.equal(raw.status,0,raw.stderr);const {policy,sql}=JSON.parse(raw.stdout);
  const db=new PGlite();
  try{
    await db.exec(`create schema annotation_private;
      create table annotation_private.settings(id int primary key,qualification_policy_version text);
      insert into annotation_private.settings values(1,null);
      create table annotation_private.qualification_policies(
        policy_version text primary key,qualification_version text,fingerprint text,pass_count int,scored_total int,
        key_status text,confirmed_scored_count int,workflow_guide_md text,workflow_guide_sha256 text,approved_at timestamptz default now());`);
    await db.exec(sql);
    const actual=(await db.query("select to_jsonb(p)-'approved_at' as value from annotation_private.qualification_policies p")).rows[0].value;
    assert.deepEqual(actual,policy);
    await db.exec(`create function annotation_private.deny_mutation() returns trigger language plpgsql as $$begin raise exception 'Immutable'; end$$;
      create trigger immutable_policy before insert or update or delete on annotation_private.qualification_policies
      for each row execute function annotation_private.deny_mutation();`);
    await db.exec(sql);
    assert.equal((await db.query('select count(*)::int as n from annotation_private.qualification_policies')).rows[0].n,1);
    assert.doesNotMatch(sql,/update\s+annotation_private\.(?:assignments|qualification_results|qualification_keys|participants)\b/i);
    const afterCommit=sql.split('COMMIT;')[1];assert.equal((afterCommit.match(/SELECT /g)||[]).length,1);
  }finally{await db.close();}
});

test('approval CLI requires explicit confirmation and refuses public outputs before reading private inputs',()=>{
  const args=[script,'--research-root','/private/tmp','--review-result','/private/tmp/absent.json','--output',`${root}unsafe.sql`,'--approval-output','/private/tmp/approval.json'];
  const unconfirmed=spawnSync('python3',args,{encoding:'utf8'});assert.notEqual(unconfirmed.status,0);assert.match(unconfirmed.stderr,/confirm-scored-key/);
  const publicPath=spawnSync('python3',[...args,'--confirm-scored-key'],{encoding:'utf8'});assert.notEqual(publicPath.status,0);assert.match(publicPath.stderr,/outside the public Git repository/);
});
