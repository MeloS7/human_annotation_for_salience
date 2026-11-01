import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const builder = path.join(root, 'scripts/build-mturk-handoff.py');
const englishBuilder = path.join(root, 'scripts/build-english-handoff.py');
const sha = value => createHash('sha256').update(value).digest('hex');
const dimensions = ['source_coverage','reference_coverage','readability','faithfulness','content_focus'];
const han = String.fromCodePoint(0x4e2d);

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'mturk-handoff-synthetic-'));
  const qualification = Array.from({length:10}, (_,i) => ({item_id:`Q${String(i+1).padStart(2,'0')}`,template_id:`q_Q${String(i+1).padStart(2,'0')}_1`,
    kind:'qualification',position:i+1,payload:{request:'Request',source:'Qualification source',summary_a:'Alpha',summary_b:'Beta',reference:'Reference'}}));
  const entries = [];
  const packageFiles = {};
  for(let i=1;i<=9;i++) {
    const name = `package_${String(i).padStart(2,'0')}.json`;
    const payload = JSON.stringify({assignment_version:'SYNTHETIC-VERSION',package_id:`package_${String(i).padStart(2,'0')}`,
      qualification,study:Array.from({length:42},(_,j)=>{const itemId=`synthetic-${Math.floor((i-1)/3)*42+j}`;return {item_id:itemId,kind:'study',position:j+1,
        payload:{request:'Request',source:`Study source ${itemId}${itemId==='synthetic-0'?han:''}`,summary_a:'Alpha',summary_b:'Beta',reference:'Reference'}}})});
    await writeFile(path.join(directory,name),payload);
    entries.push({file:name,sha256:sha(payload)});
    packageFiles[name] = Buffer.from(payload);
  }
  const keyItems=qualification.map((item,index)=>({qualification_id:item.item_id,dataset:index<5?'cnndm':'gumsum',title_zh:`${han} title`,template_id:item.template_id,
    judgments:Object.fromEntries(dimensions.map((dimension,d)=>{const scored=index<9&&d<2;return [dimension,{label:(index+d)%2?'A':'Tie',scored,
      label_status:scored?'human_confirmed':'ai_provisional_exploratory',rationale_zh:`${han} rationale`}]}))}));
  const key=JSON.stringify({schema_version:'qualification-key-private-v1',assignment_version:'SYNTHETIC-VERSION',qualification_version:'qualification-pilot-20261020-v1',
    policy_version:'synthetic-policy',key_status:'human_confirmed_scored',pass_count:14,scored_total:18,confirmed_scored_count:18,exploratory_count:32,items:keyItems});
  const privateFiles={...packageFiles,'qualification_key.private.json':Buffer.from(key),'analysis_mapping.private.json':Buffer.from('{}'),
    'assignment_plan.private.json':Buffer.from('{}'),'validation_report.json':Buffer.from('{}')};
  const hashes=Object.fromEntries(Object.entries(privateFiles).map(([name,data])=>[name,sha(data)]));
  const manifest=JSON.stringify({assignment_version:'SYNTHETIC-VERSION',packages:entries,private_file_sha256:hashes});
  privateFiles['manifest.private.json']=Buffer.from(manifest);
  for(const [name,data] of Object.entries(privateFiles)) await writeFile(path.join(directory,name),data);
  return {directory, qualification, privateFiles};
}

test('private handoff packages frozen data and a sanitized source snapshot without production config',async()=>{
  const {directory}=await fixture();
  try {
    const output=path.join(directory,'handoff.zip');
    const result=spawnSync('python3',[builder,'--package-dir',directory,'--output',output],{encoding:'utf8'});
    assert.equal(result.status,0,result.stderr);
    const inspect=spawnSync('python3',['-c',`
import zipfile,json,hashlib,sys
with zipfile.ZipFile(sys.argv[1]) as z:
    names=z.namelist()
    checks=json.loads(z.read('handoff_checksums.json'))['files']
    assert set(names)==set(checks)|{'handoff_checksums.json'}
    assert all(hashlib.sha256(z.read(name)).hexdigest()==digest for name,digest in checks.items())
    assert all('..' not in name.split('/') and not name.startswith('/') for name in names)
    assert all('/.git/' not in name and 'node_modules/' not in name and '/dist/' not in name for name in names)
    config=z.read('frontend-source/config/public-config.js').decode()
    assert 'YOUR-PROJECT' in config and 'sb_publishable_' not in config
    assert len([name for name in names if name.startswith('package_') and name.endswith('.json')])==9
    assert 'MTURK_HANDOFF.md' in names and 'README_PRIVATE.md' in names
    print('sanitized-and-checksummed')
`,output],{encoding:'utf8'});
    assert.equal(inspect.status,0,inspect.stderr);
    assert.match(inspect.stdout,/sanitized-and-checksummed/);
    const original=await readFile(output);
    const retry=spawnSync('python3',[builder,'--package-dir',directory,'--output',output],{encoding:'utf8'});
    assert.notEqual(retry.status,0);
    assert.deepEqual(await readFile(output),original);
  } finally {await rm(directory,{recursive:true,force:true});}
});

test('handoff rejects altered packages instead of silently publishing different material',async()=>{
  const {directory}=await fixture();
  try {
    await writeFile(path.join(directory,'package_01.json'),'{}');
    const result=spawnSync('python3',[builder,'--package-dir',directory,'--output',path.join(directory,'handoff.zip')],{encoding:'utf8'});
    assert.notEqual(result.status,0);
    assert.match(result.stderr,/checksum differs/);
  } finally {await rm(directory,{recursive:true,force:true});}
});

test('English private handoff includes the expanded feedback and keeps Han text only in frozen study sources',async()=>{
  const {directory,qualification,privateFiles}=await fixture();
  try {
    const feedbackPath=path.join(directory,'qualification_feedback_en.private.json');
    const items=[];
    for(let i=0;i<10;i++){
      const qid=`Q${String(i+1).padStart(2,'0')}`;
      for(let scheme=1;scheme<=3;scheme++) items.push({template_id:`q_${qid}_${scheme}`,qualification_id:qid,title_en:`Synthetic title ${qid}`,
        rationales_en:Object.fromEntries(dimensions.map(d=>[d,`Synthetic rationale ${qid} ${scheme} ${d}`]))});
    }
    await writeFile(feedbackPath,JSON.stringify({feedback_version:'qualification-feedback-en-20261101-v1',qualification_version:'qualification-pilot-20261020-v1',
      qualification_fingerprint:'a'.repeat(64),language:'en',items}));
    const derived=path.join(directory,'english_handoff_v1');
    const derive=spawnSync('python3',[englishBuilder,'--package-dir',directory,'--feedback-json',feedbackPath,'--output-dir',derived],{encoding:'utf8'});
    assert.equal(derive.status,0,derive.stderr);
    for(const name of Object.keys(privateFiles)) if(name!=='manifest.private.json'&&name!=='qualification_key.private.json')
      assert.deepEqual(await readFile(path.join(derived,name)),privateFiles[name],name);

    const output=path.join(directory,'english-handoff.zip');
    const result=spawnSync('python3',[builder,'--package-dir',derived,'--output',output],{encoding:'utf8'});
    assert.equal(result.status,0,result.stderr);
    const inspect=spawnSync('python3',['-c',`
import zipfile,json,hashlib,sys,re
han=re.compile(r'[\\u3400-\\u4dbf\\u4e00-\\u9fff\\U00020000-\\U000323af]')
with zipfile.ZipFile(sys.argv[1]) as z:
    names=z.namelist()
    checks=json.loads(z.read('handoff_checksums.json'))['files']
    assert set(names)==set(checks)|{'handoff_checksums.json'}
    assert all(hashlib.sha256(z.read(name)).hexdigest()==digest for name,digest in checks.items())
    assert 'qualification_feedback_en.private.json' in names
    key=json.loads(z.read('qualification_key.private.json'))
    assert key['schema_version']=='qualification-key-private-en-v1' and key['pass_count']==14
    assert all('title_zh' not in item and 'title_en' in item for item in key['items'])
    for name in names:
        raw=z.read(name)
        if not han.search(raw.decode('utf8')): continue
        assert re.fullmatch(r'package_0[1-9]\\.json',name), name
        package=json.loads(raw)
        for item in package['study']:
            source=item.get('payload',{}).get('source','')
            if source: raw=raw.replace(source.encode('utf8'),b'')
        assert not han.search(raw.decode('utf8')), name
    print('english-private-packet-checks-out')
`,output],{encoding:'utf8'});
    assert.equal(inspect.status,0,inspect.stderr);
    assert.match(inspect.stdout,/english-private-packet-checks-out/);
  } finally {await rm(directory,{recursive:true,force:true});}
});
