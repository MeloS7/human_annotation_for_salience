import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const builder = path.join(root, 'scripts/build-english-handoff.py');
const sha = value => createHash('sha256').update(value).digest('hex');
const dimensions = ['source_coverage', 'reference_coverage', 'readability', 'faithfulness', 'content_focus'];
const han = String.fromCodePoint(0x4e2d);

async function fixture(directory) {
  const source = path.join(directory, 'human_fixed_packages_v1');
  await import('node:fs/promises').then(fs => fs.mkdir(source, {recursive:true}));
  const files = {};
  const qualification = Array.from({length:10}, (_, index) => {
    const qid = `Q${String(index + 1).padStart(2, '0')}`;
    return {item_id:qid, kind:'qualification', position:index + 1, template_id:`q_${qid}_1`,
      payload:{request:'Synthetic request', source:'Synthetic qualification source', summary_a:'Alpha', summary_b:'Beta', reference:'Synthetic reference'},
      hashes:{source_sha256:'0'.repeat(64)}};
  });
  const entries = [];
  const packageFiles = [];
  for (let packageIndex = 1; packageIndex <= 9; packageIndex++) {
    const name = `package_${String(packageIndex).padStart(2, '0')}.json`;
    const study = Array.from({length:42}, (_, index) => {
      const itemId = `study-${Math.floor((packageIndex - 1) / 3) * 42 + index}`;
      return {item_id:itemId, kind:'study', position:index + 1,
        payload:{request:'Synthetic request', source:`Synthetic study source ${itemId}${itemId === 'study-0' ? han : ''}`,
          summary_a:'Alpha', summary_b:'Beta', reference:'Synthetic reference'}};
    });
    files[name] = Buffer.from(JSON.stringify({schema_version:'annotation-package-v1', assignment_version:'SYNTHETIC-VERSION',
      package_id:`package_${String(packageIndex).padStart(2, '0')}`, qualification, study}));
    packageFiles.push({file:name, sha256:sha(files[name])});
  }

  const keyItems = qualification.map((item, index) => {
    const judgments = Object.fromEntries(dimensions.map((dimension, dimensionIndex) => {
      const scored = index < 9 && dimensionIndex < 2;
      return [dimension, {label:(index + dimensionIndex) % 2 ? 'A' : 'Tie', scored,
        label_status:scored ? 'human_confirmed' : 'ai_provisional_exploratory', rationale_zh:`${han} rationale`}];
    }));
    return {qualification_id:item.item_id, dataset:index < 5 ? 'cnndm' : 'gumsum', title_zh:`${han} title`,
      template_id:item.template_id, judgments};
  });
  files['qualification_key.private.json'] = Buffer.from(JSON.stringify({schema_version:'qualification-key-private-v1',
    assignment_version:'SYNTHETIC-VERSION', qualification_version:'qualification-pilot-20261020-v1',
    policy_version:'synthetic-policy', key_status:'human_confirmed_scored', pass_count:14, scored_total:18,
    confirmed_scored_count:18, exploratory_count:32, items:keyItems}));
  files['analysis_mapping.private.json'] = Buffer.from('{}');
  files['assignment_plan.private.json'] = Buffer.from('{}');
  files['validation_report.json'] = Buffer.from('{}');
  const checksums = Object.fromEntries(Object.entries(files).map(([name, data]) => [name, sha(data)]));
  files['manifest.private.json'] = Buffer.from(JSON.stringify({assignment_version:'SYNTHETIC-VERSION',
    packages:packageFiles, private_file_sha256:checksums}));

  const feedbackItems = [];
  for (let index = 0; index < 10; index++) {
    const qid = `Q${String(index + 1).padStart(2, '0')}`;
    for (let scheme = 1; scheme <= 3; scheme++) {
      feedbackItems.push({template_id:`q_${qid}_${scheme}`, qualification_id:qid, title_en:`Synthetic English title ${qid}`,
        rationales_en:Object.fromEntries(dimensions.map(dimension => [dimension, `Synthetic English rationale ${qid} ${scheme} ${dimension}`]))});
    }
  }
  const feedback = {feedback_version:'qualification-feedback-en-20261101-v1',
    qualification_version:'qualification-pilot-20261020-v1', qualification_fingerprint:'a'.repeat(64), language:'en', items:feedbackItems};
  const feedbackPath = path.join(directory, 'qualification_feedback_en.private.json');
  await writeFile(feedbackPath, JSON.stringify(feedback));
  for (const [name, data] of Object.entries(files)) await writeFile(path.join(source, name), data);
  return {source, feedbackPath, files, feedback};
}

function build({source, feedbackPath, output}) {
  return spawnSync('python3', [builder, '--package-dir', source, '--feedback-json', feedbackPath, '--output-dir', output], {encoding:'utf8'});
}

function withoutTextProjection(key) {
  const clone = structuredClone(key);
  delete clone.schema_version;
  delete clone.feedback_version;
  delete clone.feedback_language;
  for (const item of clone.items) {
    delete item.title_zh;
    delete item.title_en;
    for (const judgment of Object.values(item.judgments)) {
      delete judgment.rationale_zh;
      delete judgment.rationale_en;
    }
  }
  return clone;
}

test('English packet derives a title/rationale-only projection and keeps frozen allocation bytes', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'english-handoff-synthetic-'));
  const {source, feedbackPath, files} = await fixture(directory);
  const output = path.join(source, 'english_handoff_v1');
  try {
    const result = build({source, feedbackPath, output});
    assert.equal(result.status, 0, result.stderr);
    const originalKey = JSON.parse(files['qualification_key.private.json']);
    const translatedKeyBytes = await readFile(path.join(output, 'qualification_key.private.json'));
    const translatedKey = JSON.parse(translatedKeyBytes);
    assert.equal(translatedKey.schema_version, 'qualification-key-private-en-v1');
    assert.equal(translatedKey.feedback_version, 'qualification-feedback-en-20261101-v1');
    assert.equal(translatedKey.feedback_language, 'en');
    assert.deepEqual(withoutTextProjection(translatedKey), withoutTextProjection(originalKey));
    assert.equal(translatedKey.items.length, 10);
    assert.ok(translatedKey.items.every(item => !('title_zh' in item) && item.title_en.startsWith('Synthetic English')));
    assert.ok(translatedKey.items.every(item => Object.values(item.judgments).every(judgment =>
      !('rationale_zh' in judgment) && judgment.rationale_en.startsWith('Synthetic English'))));
    assert.doesNotMatch(translatedKeyBytes.toString('utf8'), /[\u3400-\u4dbf\u4e00-\u9fff]/);

    for (const name of ['package_01.json','package_02.json','package_03.json','package_04.json','package_05.json',
      'package_06.json','package_07.json','package_08.json','package_09.json','assignment_plan.private.json',
      'analysis_mapping.private.json','validation_report.json']) {
      assert.deepEqual(await readFile(path.join(output, name)), files[name]);
      assert.deepEqual(await readFile(path.join(source, name)), files[name]);
    }
    const manifest = JSON.parse(await readFile(path.join(output, 'manifest.private.json'), 'utf8'));
    assert.equal(manifest.assignment_version, 'SYNTHETIC-VERSION');
    assert.equal(manifest.feedback_version, 'qualification-feedback-en-20261101-v1');
    assert.equal(manifest.language, 'en');
    assert.equal(Object.keys(manifest.private_file_sha256).length, 15);
    for (const [name, digest] of Object.entries(manifest.private_file_sha256)) {
      assert.equal(sha(await readFile(path.join(output, name))), digest, name);
    }
    const report = JSON.parse(await readFile(path.join(output, 'english_handoff_report.private.json'), 'utf8'));
    assert.equal(report.checks.qualification_scored_total, 18);
    assert.equal(report.checks.qualification_pass_count, 14);
    assert.equal(report.checks.study_item_count, 126);
    assert.equal(report.checks.ratings, 378);

    const retry = build({source, feedbackPath, output});
    assert.notEqual(retry.status, 0);
    assert.match(retry.stderr, /Refusing to overwrite/);
  } finally {
    await rm(directory, {recursive:true, force:true});
  }
});

test('English packet builder rejects incomplete or non-English feedback and altered frozen inputs', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'english-handoff-invalid-'));
  const {source, feedbackPath, feedback} = await fixture(directory);
  try {
    const partial = {...feedback, items:feedback.items.slice(1)};
    await writeFile(feedbackPath, JSON.stringify(partial));
    let result = build({source, feedbackPath, output:path.join(source, 'english_handoff_v1')});
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /exactly 30/);

    feedback.items[0].rationales_en.source_coverage += String.fromCodePoint(0x4e2d);
    await writeFile(feedbackPath, JSON.stringify(feedback));
    result = build({source, feedbackPath, output:path.join(source, 'english_handoff_v1')});
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /printable ASCII English/);

    const packet = JSON.parse(await readFile(path.join(source, 'package_01.json'), 'utf8'));
    packet.study[0].payload.summary_a = 'Altered summary';
    await writeFile(path.join(source, 'package_01.json'), JSON.stringify(packet));
    result = build({source, feedbackPath, output:path.join(source, 'english_handoff_v1')});
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /checksum does not match package_01/);
  } finally {
    await rm(directory, {recursive:true, force:true});
  }
});
