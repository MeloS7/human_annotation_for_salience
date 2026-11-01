import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const root = fileURLToPath(new URL('../', import.meta.url));
const script = path.join(root, 'scripts/build-qualification-setup.py');
function python(args, input) {
  const result = spawnSync('python3', ['-B', ...args], { input, encoding: 'utf8' });
  if (result.error) throw result.error;
  return result;
}
const DIMS = ['source_coverage', 'readability', 'faithfulness', 'content_focus', 'reference_coverage'];
function fixture() {
  const positions = [[1, 2], [0, 4], [1], [2, 3], [0, 4], [1, 2], [0, 4], [1], [2, 3], [0, 4]];
  const items = Array.from({ length: 10 }, (_, index) => ({
    qualification_id: `Q${String(index + 1).padStart(2, '0')}`,
    dataset: index < 5 ? 'cnndm' : 'gumsum',
    source_id: `SYNTHETIC_SOURCE_${index}`, title_zh: `Synthetic sample ${index}`,
    request: 'Synthetic qualification request.',
    source: `Source ${index}: apostrophe ' and \\ / Ελληνικά / 😺 / $seed$; DROP TABLE marker; -- inert.`,
    reference: `Synthetic reference ${index}.`,
    summary_a: `Synthetic alpha ${index}.`, summary_b: `Synthetic beta ${index}.`,
  }));
  const keys = items.map((item, index) => ({
    qualification_id: item.qualification_id, source_id: item.source_id, dataset: item.dataset,
    gold_suggestions: Object.fromEntries(DIMS.map((id, dimension) => [id, {
      label: dimension % 2 ? 'B' : 'A', scored: positions[index].includes(dimension),
      confidence: 'high', rationale_zh: 'Summary A is stronger than summary B; ABC is not a choice; Tie stays unchanged.',
    }])),
  }));
  return { items, keys };
}
function preparedFixture() {
  const source = `import json,runpy,sys
m=runpy.run_path(sys.argv[1]); f=json.load(sys.stdin)
c,t,k=m['prepare_records'](f['items'],f['keys'])
sql=m['build_sql'](m['load_helpers'](),'-- synthetic schema prepared by test',c,t,k)
print(json.dumps({'config':c,'templates':t,'keys':k,'sql':sql},ensure_ascii=False))`;
  const result = python(['-c', source, script], JSON.stringify(fixture()));
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('qualification import remaps both summaries and provisional labels for every presentation scheme', () => {
  const prepared = preparedFixture();
  const original = fixture();
  assert.equal(prepared.templates.length, 30);
  assert.equal(prepared.keys.length, 30);
  assert.equal(prepared.config.key_status, 'llm_suggested_unvalidated');
  assert.equal(prepared.config.pass_count, 15);
  assert.equal(new Set(prepared.templates.map(row => row.template_id)).size, 30);
  for (let index = 0; index < prepared.templates.length; index += 1) {
    const row = prepared.templates[index];
    const key = prepared.keys[index];
    const number = row.position;
    const swapped = row.scheme === 2 || (row.scheme === 3 && number % 2 === 0);
    const source = original.items[number - 1];
    assert.equal(row.payload.source, source.source);
    assert.equal(row.payload.reference, source.reference);
    assert.equal(row.payload.summary_a, swapped ? source.summary_b : source.summary_a);
    assert.equal(row.payload.summary_b, swapped ? source.summary_a : source.summary_b);
    for (const id of DIMS) {
      const before = original.keys[number - 1].gold_suggestions[id];
      assert.equal(key.suggestions[id].label, swapped ? (before.label === 'A' ? 'B' : 'A') : before.label);
      assert.equal(key.suggestions[id].scored, before.scored);
      assert.equal(key.suggestions[id].rationale_zh, swapped ? 'Summary B is stronger than summary A; ABC is not a choice; Tie stays unchanged.' : before.rationale_zh);
    }
  }
});

test('private qualification SQL preserves text, is additive, and does not opt participants in', async () => {
  const prepared = preparedFixture();
  const db = new PGlite();
  try {
    await db.exec(`
      create schema annotation_private;
      create table marker(value text);
      create table annotation_private.settings(id integer primary key, qualification_version text);
      insert into annotation_private.settings values(1,null);
      create table annotation_private.qualification_sets(
        qualification_version text primary key,fingerprint text,item_count int,scored_total int,pass_count int,key_status text);
      create table annotation_private.templates(
        template_id text primary key,scheme int,kind text,position int,payload jsonb,hashes jsonb,coordinator jsonb);
      create table annotation_private.qualification_keys(
        template_id text primary key,qualification_version text,qualification_id text,dataset text,title_zh text,suggestions jsonb);
      create function annotation_private._assert_qualification_inventory() returns void language sql as $$ select $$;
    `);
    await db.exec(prepared.sql);
    const before = (await db.query('select * from annotation_private.templates order by template_id')).rows;
    assert.equal(before.length, 30);
    for (const row of before) assert.deepEqual(row, prepared.templates.find(item => item.template_id === row.template_id));
    assert.equal((await db.query('select * from annotation_private.qualification_keys')).rows.length, 30);
    assert.equal((await db.query('select * from marker')).rows.length, 0);
    assert.ok(!/update\s+annotation_private\.participants/i.test(prepared.sql));
    // Production guards reject attempted INSERTs even when ON CONFLICT would
    // be a no-op. Retry must verify existing rows and skip every such write.
    await db.exec(`
      create function annotation_private.reject_active_write() returns trigger language plpgsql as $$
      begin raise exception 'No writes to activated qualification rows'; end $$;
      create trigger guard_sets before insert or update or delete on annotation_private.qualification_sets
        for each row execute function annotation_private.reject_active_write();
      create trigger guard_templates before insert or update or delete on annotation_private.templates
        for each row execute function annotation_private.reject_active_write();
      create trigger guard_keys before insert or update or delete on annotation_private.qualification_keys
        for each row execute function annotation_private.reject_active_write();
    `);
    await db.exec(prepared.sql);
    assert.deepEqual((await db.query('select * from annotation_private.templates order by template_id')).rows, before);
    await db.exec('drop trigger guard_keys on annotation_private.qualification_keys');
    await db.query("update annotation_private.qualification_keys set suggestions='{}'::jsonb where template_id=$1", [prepared.keys[0].template_id]);
    await assert.rejects(db.exec(prepared.sql), /answer key differs/);
    await db.exec('rollback');
  } finally { await db.close(); }
});

test('qualification generator refuses a public destination or overwrite before reading private inputs', async () => {
  const forbidden = python([script, '--research-root', tmpdir(), '--output', path.join(root, 'private-key.sql')]);
  assert.notEqual(forbidden.status, 0);
  assert.match(forbidden.stderr, /outside the public Git repository/);
  const directory = await mkdtemp(path.join(tmpdir(), 'qualification-output-'));
  try {
    const output = path.join(directory, 'keep.sql');
    await writeFile(output, 'keep this file');
    const result = python([script, '--research-root', tmpdir(), '--output', output]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /existing private SQL is never overwritten/);
    assert.equal(await readFile(output, 'utf8'), 'keep this file');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
