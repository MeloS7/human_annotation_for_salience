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
const sha = value => createHash('sha256').update(value).digest('hex');

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'mturk-handoff-synthetic-'));
  const qualification = Array.from({length:10}, (_,i) => ({item_id:`Q${i+1}`,kind:'qualification',position:i+1}));
  const entries = [];
  for(let i=1;i<=9;i++) {
    const name = `package_${String(i).padStart(2,'0')}.json`;
    const payload = JSON.stringify({assignment_version:'SYNTHETIC-VERSION',package_id:`package_${String(i).padStart(2,'0')}`,
      qualification,study:Array.from({length:42},(_,j)=>({item_id:`synthetic-${Math.floor((i-1)/3)*42+j}`,kind:'study',position:j+1}))});
    await writeFile(path.join(directory,name),payload);
    entries.push({file:name,sha256:sha(payload)});
  }
  const hashes=Object.fromEntries(entries.map(entry=>[entry.file,entry.sha256]));
  for(const name of ['qualification_key.private.json','analysis_mapping.private.json','assignment_plan.private.json','validation_report.json'])
    {await writeFile(path.join(directory,name),'{}');hashes[name]=sha('{}');}
  await writeFile(path.join(directory,'manifest.private.json'),JSON.stringify({assignment_version:'SYNTHETIC-VERSION',packages:entries,private_file_sha256:hashes}));
  return directory;
}

test('private handoff packages frozen data and a sanitized source snapshot without production config',async()=>{
  const directory=await fixture();
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
  const directory=await fixture();
  try {
    await writeFile(path.join(directory,'package_01.json'),'{}');
    const result=spawnSync('python3',[builder,'--package-dir',directory,'--output',path.join(directory,'handoff.zip')],{encoding:'utf8'});
    assert.notEqual(result.status,0);
    assert.match(result.stderr,/checksum differs/);
  } finally {await rm(directory,{recursive:true,force:true});}
});
