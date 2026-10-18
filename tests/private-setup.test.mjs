import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const script = fileURLToPath(new URL('../scripts/build-private-setup.py', import.meta.url));
const root = fileURLToPath(new URL('../', import.meta.url));

function python(args, input) {
  const result = spawnSync('python3', ['-B', ...args], { input, encoding: 'utf8' });
  if (result.error) throw result.error;
  return result;
}

test('private-import quoting preserves exact text and JSON under PostgreSQL', async () => {
  const samples = [
    "A source with 'single quotes', \\ paths and \noriginal line breaks.",
    'Unicode: Zoë, Ελληνικά, 中文 and 😺.',
    '<context>Heading</context> Body with $item$ and $guard$ tokens.',
    "'; DROP TABLE materials; -- inert source text",
  ];
  const source = `import json,runpy,sys
m=runpy.run_path(sys.argv[1])
samples=json.load(sys.stdin)
print(json.dumps([{'literal':m['literal'](s),'json':m['json_literal']({'text':s}),'block':m['do_block']('BEGIN INSERT INTO materials (text_value) VALUES ('+m['literal'](s)+'); END;')} for s in samples]))`;
  const result = python(['-c', source, script], JSON.stringify(samples));
  assert.equal(result.status, 0, result.stderr);
  const encoded = JSON.parse(result.stdout);
  const db = new PGlite();
  try {
    await db.exec('create table materials (id bigint generated always as identity, text_value text);');
    for (const [index, record] of encoded.entries()) {
      const text = await db.query(`select ${record.literal} as value`);
      assert.equal(text.rows[0].value, samples[index]);
      const json = await db.query(`select ${record.json} as value`);
      assert.deepEqual(json.rows[0].value, { text: samples[index] });
      await db.exec(record.block);
    }
    const rows = await db.query('select text_value from materials order by id');
    assert.deepEqual(rows.rows.map(row => row.text_value), samples);
  } finally {
    await db.close();
  }
});

test('private import cannot be generated inside the public checkout', () => {
  const result = python([script, '--research-root', tmpdir(), '--output', path.join(root, 'private', 'forbidden-private.sql')]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /outside the public Git repository/);
});

test('private import never overwrites an existing file', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'annotation-private-output-test-'));
  try {
    const output = path.join(temp, 'existing-private.sql');
    await writeFile(output, 'unchanged existing file');
    const result = python([script, '--research-root', tmpdir(), '--output', output]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Refusing to overwrite/);
    assert.equal(await readFile(output, 'utf8'), 'unchanged existing file');
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('template SQL keeps one exact JSON copy, is idempotent, and refuses changed material', async () => {
  const sourceText = "Heading\nApostrophe: ' / backslash: \\ / Unicode: ñ, 中文, 😺 / $seed_collision$";
  const row = {
    template_id: 'template-synthetic-1',
    kind: 'study',
    position: 1,
    payload: { request: 'A prompt', source: sourceText, summary_a: 'A', summary_b: 'B', reference: 'R' },
    hashes: { source_sha256: 'a'.repeat(64) },
    coordinator: null,
  };
  const source = `import json,runpy,sys
m=runpy.run_path(sys.argv[1])
row=json.load(sys.stdin)
print(m['template_statement'](row, 1))`;
  const result = python(['-c', source, script], JSON.stringify(row));
  assert.equal(result.status, 0, result.stderr);
  const statement = result.stdout.trim();
  assert.equal((statement.match(/Heading/g) ?? []).length, 1, 'payload should not be repeated in a guard and INSERT');

  const db = new PGlite();
  try {
    await db.exec(`
      create schema annotation_private;
      create table annotation_private.templates (
        template_id text primary key, scheme smallint not null, kind text not null,
        position integer not null, payload jsonb not null, hashes jsonb not null,
        coordinator jsonb
      );
    `);
    await db.exec(statement);
    const first = await db.query('select * from annotation_private.templates');
    assert.equal(first.rows.length, 1);
    assert.equal(first.rows[0].payload.source, sourceText);
    assert.deepEqual(first.rows[0].hashes, row.hashes);
    assert.equal(first.rows[0].coordinator, null);

    await db.exec(statement);
    const repeated = await db.query('select * from annotation_private.templates');
    assert.deepEqual(repeated.rows, first.rows, 'an exact retry must leave the row unchanged');

    await db.query("update annotation_private.templates set payload=jsonb_set(payload, '{source}', '" + JSON.stringify('edited') + "'::jsonb)");
    await assert.rejects(db.exec(statement), /Existing template material differs/);
    const preserved = await db.query('select payload from annotation_private.templates');
    assert.equal(preserved.rows[0].payload.source, 'edited', 'a mismatch must not overwrite existing material');
  } finally {
    await db.close();
  }
});

function syntheticResearchRoot(base) {
  const research = path.join(base, 'research');
  const moduleDir = path.join(research, 'src/common/summary_generation/human_preference_app');
  const manifestDir = path.join(research, 'data/summary_generation/human_preference_annotation_v1/study');
  return { research, moduleDir, manifestDir };
}

const SYNTHETIC_DATASET_MODULE = String.raw`
from types import SimpleNamespace

PARTICIPANT_IDS = ('annotator_1', 'annotator_2', 'annotator_3')

def _row(template_id, kind, position):
    large = ('Exact source text with apostrophe \' and slash \\; Unicode ñ 中文 😺;\n' + 'x' * 6000)
    source = large + f' [{template_id}]'
    payload = {
        'request': f'Request {template_id}', 'source': source,
        'summary_a': f'A {template_id}', 'summary_b': f'B {template_id}',
        'reference': f'Reference {template_id}',
    }
    hashes = {name: ('a' if name == 'source_sha256' else 'b') * 64 for name in (
        'request_sha256', 'source_sha256', 'summary_a_sha256', 'summary_b_sha256', 'reference_sha256')}
    return {'id': template_id, 'kind': kind, 'position': position, 'payload': payload,
            'hashes': hashes, 'coordinator': None}

def load_frozen_dataset(root):
    return SimpleNamespace(fingerprint='synthetic-study-fingerprint',
        instruction_fingerprint='synthetic-instruction-fingerprint',
        rubric={'criteria': [], 'choices': []}, guide_markdown='# Synthetic guide\n')

def materialize_assignments(dataset, plan):
    return {participant: [_row(f'scheme-{scheme}-study-{position}', 'study', position)
            for position in range(1, 127)]
        for scheme, participant in enumerate(PARTICIPANT_IDS, start=1)}

def build_practice_assignments(fingerprint, participant, seed):
    scheme = int(participant.rsplit('_', 1)[1])
    return [_row(f'scheme-{scheme}-practice-{position}', 'practice', position)
        for position in range(1, 9)]
`;

async function makeSyntheticResearch(temp) {
  const { research, moduleDir, manifestDir } = syntheticResearchRoot(temp);
  await mkdir(moduleDir, { recursive: true });
  await mkdir(manifestDir, { recursive: true });
  for (const dir of [
    path.join(research, 'src'), path.join(research, 'src/common'),
    path.join(research, 'src/common/summary_generation'), moduleDir,
  ]) {
    await writeFile(path.join(dir, '__init__.py'), '');
  }
  await writeFile(path.join(moduleDir, 'dataset.py'), SYNTHETIC_DATASET_MODULE);
  await writeFile(path.join(moduleDir, 'store.py'), "RUBRIC_VERSION = 'v2-two-stage-selection-only-v1'\n");
  await writeFile(path.join(manifestDir, 'coordinator_manifest.json'), JSON.stringify({
    mode: 'study', study_fingerprint: 'synthetic-study-fingerprint',
    instruction_fingerprint: 'synthetic-instruction-fingerprint', plan: { assignment_seed: 123 },
  }));
  return research;
}

test('split private initializer is bounded, atomic, ordered, rerunnable, and fail-closed until inventory is complete', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'annotation-split-import-test-'));
  try {
    const research = await makeSyntheticResearch(temp);
    const outputDir = path.join(temp, 'private-sql');
    const expectedPath = path.join(temp, 'expected.json');
    const result = python([
      script, '--research-root', research, '--output-dir', outputDir, '--expected-output', expectedPath,
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /template batches/);
    assert.match(result.stdout, /Run the final inventory check before inviting participants; enrollment rejects incomplete template inventories\./);

    const names = (await readdir(outputDir)).sort();
    assert.equal(names[0], '01_schema_settings.sql');
    assert.equal(names.at(-1), '03_final_inventory.sql');
    const files = await Promise.all(names.map(async (name) => ({
      name, contents: await readFile(path.join(outputDir, name), 'utf8'),
      metadata: await stat(path.join(outputDir, name)),
    })));
    assert.ok(files.length >= 5, 'fixture should force at least three template batches');
    assert.deepEqual(names.slice(1, -1), names.slice(1, -1).filter((name) => name.startsWith('02_templates_')));
    for (const file of files) {
      assert.ok(Buffer.byteLength(file.contents, 'utf8') <= 900_000, `${file.name} exceeds the editor cap`);
      assert.equal(file.metadata.mode & 0o777, 0o600);
      assert.match(file.contents, /\bBEGIN;/);
      assert.match(file.contents, /\bCOMMIT;/);
    }
    const outputStats = await stat(outputDir);
    assert.equal(outputStats.mode & 0o777, 0o700);
    const expectedStats = await stat(expectedPath);
    assert.equal(expectedStats.mode & 0o777, 0o600);
    const expected = JSON.parse(await readFile(expectedPath, 'utf8'));
    assert.equal(expected.templates.length, 402);
    const frozenSource = expected.templates.find((row) => row.template_id === 'scheme-1-study-1').payload.source;
    assert.match(frozenSource, /apostrophe ' and slash \\; Unicode ñ 中文 😺;\n/);

    const db = new PGlite();
    try {
      await db.exec(`
        create role anon nologin;
        create role authenticated nologin;
        create schema auth;
        create table auth.users (id uuid primary key, is_anonymous boolean not null default true);
        create function auth.uid() returns uuid language sql stable
          as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
        grant usage on schema auth to anon, authenticated;
        grant execute on function auth.uid() to anon, authenticated;
      `);
      for (const file of files) {
        if (file.name === '03_final_inventory.sql') break;
        await db.exec(file.contents);
        if (file.name === '02_templates_001.sql') {
          await assert.rejects(
            db.query('select annotation_private._assert_template_inventory()'),
            (error) => error.code === 'PT503',
            'enrollment inventory gate should reject a partial import',
          );
        }
      }
      const beforeFinal = await db.query('select count(*) as count from annotation_private.templates');
      assert.equal(Number(beforeFinal.rows[0].count), 402);
      const finalFile = files.find((file) => file.name === '03_final_inventory.sql');
      await db.exec(finalFile.contents);
      const counts = await db.query(`select scheme,kind,count(*) as n from annotation_private.templates group by 1,2 order by 1,2`);
      assert.deepEqual(counts.rows.map((row) => `${row.scheme}:${row.kind}:${row.n}`), [
        '1:practice:8', '1:study:126', '2:practice:8', '2:study:126', '3:practice:8', '3:study:126',
      ]);
      const retrieved = await db.query(
        "select payload->>'source' as source from annotation_private.templates where template_id='scheme-1-study-1'",
      );
      assert.equal(retrieved.rows[0].source, frozenSource);

      await db.exec(`
        insert into auth.users(id, is_anonymous) values ('00000000-0000-4000-8000-000000000001', true);
        insert into annotation_private.participants
          (participant_id, auth_user_id, display_name, recovery_hash, scheme)
        values ('participant-existing', '00000000-0000-4000-8000-000000000001', 'Existing volunteer',
          decode(repeat('a', 64), 'hex'), 1);
        insert into annotation_private.assignments
          (task_id, participant_id, template_id, kind, position, revision, stage1_answers)
        values ('task-existing', 'participant-existing', 'scheme-1-practice-1', 'practice', 1, 7,
          '{"readability":"B"}'::jsonb);
      `);

      for (const file of files) await db.exec(file.contents);
      const rerun = await db.query('select count(*) as count from annotation_private.templates');
      assert.equal(Number(rerun.rows[0].count), 402);
      const preservedProgress = await db.query(
        "select revision,stage1_answers from annotation_private.assignments where task_id='task-existing'",
      );
      assert.deepEqual(preservedProgress.rows[0], { revision: 7, stage1_answers: { readability: 'B' } });
      const settings = await db.query('select study_fingerprint, guide_md from annotation_private.settings where id=1');
      assert.equal(settings.rows[0].study_fingerprint, 'synthetic-study-fingerprint');
      assert.equal(settings.rows[0].guide_md, '# Synthetic guide\n');

      const changedRowSql = python([
        '-c',
        `import json,runpy,sys
m=runpy.run_path(sys.argv[1])
r=json.load(sys.stdin)
print(m['template_statement'](r, 1))`,
        script,
      ], JSON.stringify({
        ...expected.templates.find((row) => row.template_id === 'scheme-1-study-1'),
        payload: { ...expected.templates.find((row) => row.template_id === 'scheme-1-study-1').payload, source: 'changed' },
      }));
      assert.equal(changedRowSql.status, 0, changedRowSql.stderr);
      await assert.rejects(db.exec(changedRowSql.stdout.trim()), /Existing template material differs/);
      const afterMismatch = await db.query(
        "select payload->>'source' as source from annotation_private.templates where template_id='scheme-1-study-1'",
      );
      assert.equal(afterMismatch.rows[0].source, frozenSource);
    } finally {
      await db.close();
    }

    const before = await Promise.all(names.map((name) => readFile(path.join(outputDir, name), 'utf8')));
    const duplicate = python([
      script, '--research-root', research, '--output-dir', outputDir, '--expected-output', path.join(temp, 'other.json'),
    ]);
    assert.notEqual(duplicate.status, 0);
    assert.match(duplicate.stderr, /Refusing to overwrite/);
    assert.deepEqual(await Promise.all(names.map((name) => readFile(path.join(outputDir, name), 'utf8'))), before);
    assert.equal((await readdir(temp)).some((name) => name.includes('.building-')), false, 'no staged partial directory should remain');

    const oversizedModule = SYNTHETIC_DATASET_MODULE.replace(
      "'x' * 6000",
      "'x' * (1_000_000 if template_id == 'scheme-1-study-1' else 6000)",
    );
    await writeFile(path.join(syntheticResearchRoot(temp).moduleDir, 'dataset.py'), oversizedModule);
    const oversizedOutput = path.join(temp, 'oversized-private-sql');
    const oversizedExpected = path.join(temp, 'oversized-expected.json');
    const oversized = python([
      script, '--research-root', research, '--output-dir', oversizedOutput,
      '--expected-output', oversizedExpected,
    ]);
    assert.notEqual(oversized.status, 0);
    assert.match(oversized.stderr, /One frozen template is too large/);
    assert.equal(await stat(oversizedOutput).catch(() => null), null, 'target directory must not be published on planning failure');
    assert.equal(await stat(oversizedExpected).catch(() => null), null, 'expected fixture must not be published on planning failure');
    assert.equal((await readdir(temp)).some((name) => name.includes('.building-')), false, 'planning failure leaves no staged output');
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('single-file mode remains supported and validates expected-output path conflicts', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'annotation-single-import-test-'));
  try {
    const research = await makeSyntheticResearch(temp);
    const output = path.join(temp, 'single.sql');
    const result = python([script, '--research-root', research, '--output', output]);
    assert.equal(result.status, 0, result.stderr);
    const sql = await readFile(output, 'utf8');
    assert.match(sql, /Complete private study import/);
    assert.match(sql, /Unexpected template inventory/);
    assert.equal((await stat(output)).mode & 0o777, 0o600);
    await mkdir(path.join(temp, 'existing-expected'));
    const conflicting = python([
      script, '--research-root', research, '--output', path.join(temp, 'another.sql'),
      '--expected-output', path.join(temp, 'existing-expected'),
    ]);
    assert.notEqual(conflicting.status, 0);
    assert.match(conflicting.stderr, /Refusing to overwrite/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
