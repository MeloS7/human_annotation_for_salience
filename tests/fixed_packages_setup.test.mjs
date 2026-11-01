import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const script = path.join(root, 'scripts/build-fixed-packages.py');
const fixtureSource = String.raw`
import hashlib, json, runpy, sys
m=runpy.run_path(sys.argv[1])
dims=list(m['DIMENSIONS'])
settings={'study_fingerprint':'study-fixture-sha','instruction_fingerprint':'guide-fixture-sha','rubric_version':'rubric-fixture-v1',
 'rubric':{'criteria':[{'id':d} for d in dims],'choices':['A','B','Tie']},'guide_md':'Synthetic guide'}
templates=[]
def add_item(pair_id,dataset,genre,stratum,length):
  for scheme in (1,2,3):
    side='A' if scheme==1 else 'B'
    ours=f'Ours {pair_id}'
    standard=f'Standard {pair_id}'
    summary_a,summary_b=(ours,standard) if side=='A' else (standard,ours)
    a_id,b_id=(f'ours-id-{pair_id}',f'std-id-{pair_id}') if side=='A' else (f'std-id-{pair_id}',f'ours-id-{pair_id}')
    a_method,b_method=('ours','standard') if side=='A' else ('standard','ours')
    coordinator={'pair_id':pair_id,'example_id':pair_id,'dataset':dataset,'genre':genre,'macsum_length':length,'stratum':stratum,
      'ours_side':side,'summary_a_id':a_id,'summary_b_id':b_id,'summary_a_method':a_method,'summary_b_method':b_method}
    payload={'request':'Synthetic request','source':f'Synthetic source {pair_id}','summary_a':summary_a,'summary_b':summary_b,'reference':f'Synthetic ref {pair_id}'}
    hash_names={'request':'request_sha256','source':'source_sha256','summary_a':'summary_a_sha256','summary_b':'summary_b_sha256','reference':'reference_sha256'}
    hashes={hash_names[key]:hashlib.sha256(str(value).encode()).hexdigest() for key,value in payload.items()}
    templates.append({'template_id':f't_{pair_id}_{scheme}','scheme':scheme,'kind':'study','position':1,'payload':payload,'hashes':hashes,'coordinator':coordinator})
cell_counts={('improved','short'):7,('improved','normal'):7,('improved','long'):7,
 ('near','short'):6,('near','normal'):6,('near','long'):6,
 ('declined','short'):7,('declined','normal'):7,('declined','long'):7}
index=0
for (stratum,length),count in cell_counts.items():
  for _ in range(count):
    add_item(f'mac-{index:02}', 'macsum', None, stratum, length);index+=1
index=0
for genre in m['GUM_GENRES']:
  for stratum in m['STRATA']:
    for _ in range(2):
      add_item(f'gum-{index:02}', 'gumsum', genre, stratum, None);index+=1

q_templates=[];q_keys=[];human_scored=[]
for i in range(10):
  qid=f'Q{i+1:02}'
  dataset='cnndm' if i<5 else 'gumsum'
  for scheme in (1,2,3):
    swapped=scheme==2
    tid=f'q_{qid}_{scheme}'
    meta={'qualification_id':qid,'dataset':dataset,'source_id':f'qsource{i}','review_orientation_swapped':swapped}
    base={'source_coverage':'A' if i%2==0 else 'B','reference_coverage':'Tie','readability':'A' if i%3==0 else 'Tie',
      'faithfulness':'B' if i%2==0 else 'A','content_focus':'Tie'}
    suggestions={d:({'label': ('B' if base[d]=='A' else 'A') if swapped and base[d] in ('A','B') else base[d],
      'scored':i<9 and dims.index(d)<2,'rationale_zh':'synthetic rationale','confidence':'high'}) for d in dims}
    q_templates.append({'template_id':tid,'scheme':scheme,'kind':'qualification','position':i+1,'payload':{'request':'Qualification request','source':f'Q source {qid}',
      'summary_a':'Alpha summary' if not swapped else 'Beta summary','summary_b':'Beta summary' if not swapped else 'Alpha summary','reference':f'Q reference {qid}'},
      'hashes':{'source_sha256':'0'*64},'coordinator':meta})
    q_keys.append({'template_id':tid,'qualification_version':m['QUALIFICATION_VERSION'],'qualification_id':qid,'dataset':dataset,'title_zh':f'Synthetic {qid}','suggestions':suggestions})
    if scheme==2:
      for d,s in suggestions.items():
        if s['scored']: human_scored.append({'qualification_id':qid,'dimension':d,'review_answer':s['label'],'final_label':s['label'],'initially_agreed':True})
q_expected={'config':{'qualification_version':m['QUALIFICATION_VERSION'],'item_count':10,'scored_total':18,'fingerprint':'qualification-fixture-fingerprint'},
 'templates':q_templates,'keys':q_keys}
q_expected['config']['fingerprint']=hashlib.sha256(m['canonical']({'templates':q_templates,'keys':q_keys}).encode()).hexdigest()
guide='Qualification guide\n## Choosing an answer\nFrozen synthetic rubric.'
key={'policy_version':m['POLICY_VERSION'],'qualification_version':m['QUALIFICATION_VERSION'],'pass_count':14,'confirmed_scored_count':18,
 'scored_labels':human_scored,'policy':{'policy_version':m['POLICY_VERSION'],'qualification_version':m['QUALIFICATION_VERSION'],
  'fingerprint':q_expected['config']['fingerprint'],'pass_count':14,'scored_total':18,'confirmed_scored_count':18,
  'key_status':'human_confirmed_scored','workflow_guide_md':guide,'workflow_guide_sha256':hashlib.sha256(guide.encode()).hexdigest()}}
files=m['build_outputs']({'settings':settings,'templates':templates},q_expected,key)
print(json.dumps({name:text for name,text in files},ensure_ascii=False))
`;

function syntheticBuild() {
  const result = spawnSync('python3', ['-B', '-c', fixtureSource, script], {encoding: 'utf8'});
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('fixed package output is deterministic and preserves exact 9 × (10 + 42) design', () => {
  const first = syntheticBuild();
  const second = syntheticBuild();
  assert.deepEqual(first, second);

  const manifest = JSON.parse(first['manifest.private.json']);
  const plan = JSON.parse(first['assignment_plan.private.json']);
  const report = JSON.parse(first['validation_report.json']);
  const key = JSON.parse(first['qualification_key.private.json']);
  const mapping = JSON.parse(first['analysis_mapping.private.json']);
  assert.equal(manifest.packages.length, 9);
  assert.equal(plan.packages.length, 9);
  assert.equal(report.valid, true);
  assert.deepEqual(report.counts, {
    packages: 9, qualification_per_package: 10, study_per_package: 42,
    macsum_per_package: 20, gumsum_per_package: 22, formal_items: 126,
    ratings: 378, ratings_per_item: 3, qualification_scored: 18, qualification_pass_count: 14,
  });
  assert.deepEqual(report.requirements.macsum_per_package.lengths,
    '6/7/7 per package; the length group with six items rotates');
  assert.deepEqual(report.requirements.gumsum_per_package.genres,
    Object.fromEntries(['academic','bio','conversation','fiction','interview','news','speech','textbook','vlog','voyage','whow'].map(g => [g, 2])));
  assert.deepEqual(report.requirements.pairwise_package_overlap_range, [10, 11]);
  assert.equal(key.items.reduce((n, item) => n + Object.values(item.judgments).filter(j => j.scored).length, 0), 18);
  assert.equal(key.items.reduce((n, item) => n + Object.values(item.judgments).filter(j => !j.scored).length, 0), 32);
  assert.equal(key.items.flatMap(item => Object.values(item.judgments)).filter(j => j.label_status === 'human_confirmed').length, 18);

  const packages = manifest.packages.map(row => {
    const pack = JSON.parse(first[row.file]);
    assert.equal(pack.qualification.length, 10);
    assert.equal(pack.study.length, 42);
    assert.deepEqual(pack.qualification.map(item => item.item_id), Array.from({length: 10}, (_, i) => `Q${String(i+1).padStart(2,'0')}`));
    assert.deepEqual(pack.study.map(item => item.position), Array.from({length: 42}, (_, i) => i + 1));
    assert.ok(pack.study.every(item => !('coordinator' in item)));
    assert.equal(pack.qualification.some(item => 'suggestions' in item), false);
    return pack;
  });
  for (const pack of packages.slice(1)) assert.deepEqual(pack.qualification, packages[0].qualification);
  const counts = new Map();
  const sides = new Map();
  const perPackage = new Map();
  for (const row of mapping.items) {
    counts.set(row.item_id, (counts.get(row.item_id) || 0) + 1);
    if (!sides.has(row.item_id)) sides.set(row.item_id, new Set());
    sides.get(row.item_id).add(row.ours_side);
    if (!perPackage.has(row.package_id)) perPackage.set(row.package_id, []);
    perPackage.get(row.package_id).push(row);
    assert.equal(row.summary_a_method === 'ours', row.ours_side === 'A');
    assert.equal(row.summary_b_method === 'ours', row.ours_side === 'B');
  }
  assert.equal(counts.size, 126);
  assert.ok([...counts.values()].every(n => n === 3));
  assert.ok([...sides.values()].every(s => s.has('A') && s.has('B')));
  for (const rows of perPackage.values()) {
    const mac = rows.filter(row => row.dataset === 'macsum');
    const gum = rows.filter(row => row.dataset === 'gumsum');
    const count = (list, field) => Object.fromEntries([...new Set(list.map(row => row[field]))].map(value => [value, list.filter(row => row[field] === value).length]));
    assert.deepEqual(count(mac, 'stratum'), {improved: 7, near: 6, declined: 7});
    assert.deepEqual(Object.values(count(mac, 'macsum_length')).sort(), [6, 7, 7]);
    assert.deepEqual(Object.values(count(gum, 'stratum')).sort(), [7, 7, 8]);
    assert.ok(Object.values(count(gum, 'genre')).every(n => n === 2));
    assert.equal(rows.filter(row => row.ours_side === 'A').length, 21);
  }
});

test('generator refuses public output and never overwrites an existing private destination', async () => {
  const forbidden = spawnSync('python3', ['-B', script, '--research-root', tmpdir(), '--output-dir', path.join(root, 'must-not-publish')], {encoding: 'utf8'});
  assert.notEqual(forbidden.status, 0);
  assert.match(forbidden.stderr, /outside the public Git repository/);

  const parent = await mkdtemp(path.join(tmpdir(), 'fixed-package-private-'));
  try {
    const target = path.join(parent, 'existing');
    const sentinel = path.join(target, 'keep.json');
    const {mkdir, writeFile} = await import('node:fs/promises');
    await mkdir(target);
    await writeFile(sentinel, 'keep existing data');
    const result = spawnSync('python3', ['-B', script, '--research-root', tmpdir(), '--output-dir', target], {encoding: 'utf8'});
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Refusing to overwrite an existing private package directory/);
    assert.equal(await readFile(sentinel, 'utf8'), 'keep existing data');
  } finally {
    await rm(parent, {recursive: true, force: true});
  }
});
