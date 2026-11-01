# Comparing summaries

A browser-based, two-stage human preference annotation interface. The frontend is hosted on GitHub Pages; Supabase Auth and a restricted PostgreSQL RPC provide private storage and enforce the evaluation sequence.

## For participants

1. Enter a nickname. No email address or password is required. Nicknames are display labels, not account credentials; two people may use the same nickname without sharing data.
2. Save the private recovery code shown to you. It acts as an access key, so do not share it or include it in screenshots. Keep using the same browser to resume automatically.
3. Read the instructions and complete all ten qualification comparisons. At least **14 of 18** scored judgments must match the human-confirmed qualification key before the study opens. A failed or incomplete qualification cannot access study tasks. You may save, pause and return; there is no need to finish in one session.
4. Choose A, B or Tie for source coverage, readability, faithfulness and content focus. Review and lock these four preferences before the reference is shown. Then judge reference coverage. Locked preferences cannot be edited.
5. On another device, use **Recover progress** and your recovery code. Successful recovery issues a new code and invalidates the old one. The previous device loses access, but your answers, task order and lock states remain unchanged. Save the new code.

The source panel preserves the existing Reading view, original-text view and search. Reading view uses neutral grey structural blocks and verified source spacing. Original text preserves the exact source text used for the study's LLM judging. These presentation controls do not change the material or your answers.

Successful saves are confirmed by the server before being labelled saved. Keep the page open if saving fails. **Download my responses** exports your answer records for backup, not your recovery code. The recovery code has its own private download. Anyone with that code can recover the identity; a nickname alone cannot.

Qualification feedback appears only after all ten comparisons are submitted. Eighteen preselected judgments use a coordinator-confirmed standard; the other 32 retain exploratory AI suggestions and do not affect passing. Submitted qualification answers cannot be changed or retried after feedback. Stage 1 preferences are editable only before the reference is released; report an accidental submitted choice rather than overwriting it.

With the fixed-package upgrade active, a passed participant receives **42 study
comparisons**, in one persistent package. There are nine slots; an additional
passed participant sees a full notice rather than sharing an occupied slot.
Already-started historical study queues are protected separately so existing
answers and reference locks are not reset.

## Architecture and privacy

- Public repository/Pages: HTML, CSS, JavaScript, dependency lockfile, public Supabase project URL/publishable key, schema migrations and synthetic tests. The source-layout asset contains hashes and structural offsets only.
- Private Supabase schema: frozen article/summary/reference templates, per-participant assignments, responses, events and recovery-code hashes. Material is stored once, not repeated for each volunteer.
- Public application RPC: authenticates every request with the verified Supabase Auth UID. No anonymous-role access to the RPC and no browser table access. Nickname input and user metadata never authorize another person's data.
- Reference access: the database transaction locks all four initial preferences before a separate request may retrieve the reference. It is never included in static files, session listings, ordinary task responses or participant exports.
- Recovery: 256-bit browser-generated codes; only their SHA-256 hashes are stored. Recovery atomically rotates the code and rebinds the identity. Codes, hashes, access tokens and refresh tokens are excluded from exports and event payloads.

No service-role key, secret API key, database password or real study bundle belongs in this repository. A public/publishable key is intentionally public and does not grant application access without the authenticated RPC checks.

## Fixed packages and MTurk handoff

The coordinator privately generates nine self-contained JSON packages, each
containing the same ten qualification items plus 42 preassigned study items.
Each of the 126 distinct study items occurs in three packages. The static data
format is backend-neutral; the live site imports the same frozen membership
into Supabase, while another deployment may use its own private server storage.
**Complete packages and qualification keys must never be frontend assets.**

See [the engineer handoff](docs/MTURK_HANDOFF.md) for the workflow, file formats,
platform adapter boundary, security requirements and acceptance checklist.
`scripts/build-fixed-packages.py` generates the private packet;
`scripts/build-fixed-packages-setup.py` prepares an additive private SQL import;
`scripts/build-mturk-handoff.py` bundles the materials, documentation and a
credential-free source snapshot for private delivery. The scripts refuse public
output destinations and never connect to JZ or another data source.

The fixed allocation is versioned as `fixed-packages-20261101-v1`. Package claims
occur only after a qualification pass and survive recovery. Private imports and
migrations retain all historical records. The frontend accepts the preceding
mandatory-qualification contract during a rolling upgrade; the 42-item workflow
activates only when the coordinator has imported and enabled the private plan.

## Coordinator setup

Create a Supabase project and enable **Authentication → Sign In / Providers → Allow anonymous sign-ins**. New-user signups must be allowed. No fixed user accounts, SMTP setup or manual identity linking are required.

Set only the project URL and publishable key in `config/public-config.js`. Do not replace the publishable key with a secret key. The SQL migration in `supabase/migrations/` contains schema and functions only, not study materials.

From the private research checkout, generate the coordinator-only import:

```bash
python3 scripts/build-private-setup.py \
  --research-root /path/to/private/research-checkout \
  --output-dir /path/to/private/sql-editor-import
```

The generator validates the frozen materials and assignment plans and refuses to write inside this public repository. Execute the numbered `.sql` files in order, one file per query, in your project's Supabase SQL Editor. Each file is a transaction kept below the editor's query-size limit. Enrollment fails closed until the full private inventory is present; the final file checks it and reports six counts (three schemes, each with eight practice and126 study templates). Rerunning matching files is additive: it does not replace participants or reset any responses. Changed materials and incompatible schemas fail closed. Do not post generated SQL in GitHub, a public issue or participant instructions. For a direct database connection without the editor's limit, `--output /path/to/private/initialize.sql` generates one atomic import instead.

An optional `--expected-output /path/to/private/expected-private.json` writes a private verification fixture. Check a complete import offline with `node scripts/verify-private-import.mjs /path/to/private/sql-editor-import /path/to/private/expected-private.json`. This verifies exact material hashes, repeat-import persistence and recovery against a disposable database, not the production project.

The original installation rotates three prevalidated presentation schemes across enrollments and stores each volunteer's shuffled order. Recovery retains that order. The private template pool retains eight historical practice examples per scheme for storage compatibility, but the mandatory workflow displays none of them. Before the fixed-package upgrade, its active queue is ten qualification plus 126 study comparisons. The fixed-package upgrade above replaces that allocation for eligible fixed-mode participants without deleting historical practice or study records. The online installation does not import earlier local preview answers.

### Upgrading an existing eight-practice installation

Apply `supabase/migrations/20261018010000_two_practice_tasks.sql` in a transaction before deploying the matching frontend. Do not reimport the study materials. The migration selects two persistent practice IDs per participant, prioritizing completed work and then unpaused work already started. Someone who has completed at least two practice comparisons can proceed directly to the study. It does not change existing task IDs, ordering, answers, revisions, lock/exposure timestamps or recovery credentials. Historical extra practice records remain in exports, identified by `practice_required: false`. Rerunning the migration does not reselect the two tasks. The frontend checks the server's two-practice protocol marker and fails closed if the database upgrade is missing.

### Historical optional qualification pilot

This section documents the retired opt-in workflow. Apply the mandatory policy below for the current collection workflow.

The qualification pilot is a one-time, explicit opt-in from the workspace. Merely deploying it does not enroll anyone or change the existing two-practice workflow. Starting the pilot preserves saved responses but replaces the active practice queue with ten qualification comparisons. Study access is then blocked by the database until qualification is passed. The same four-preferences-first, reference-second sequence applies to every item.

The initial key is **LLM-suggested and not yet human-validated**. Only 18 preselected, relatively clear judgments count toward the provisional threshold of 15 matches. All 50 judgments are compared after completion, with overall, per-dimension and item-by-item exact agreement. The remaining judgments are exploratory. No suggested labels, counted-cell indicators or partial scores are returned before all ten comparisons are complete. A failed result does not establish poor annotation ability; this pilot is for checking the materials and key. There is no automatic reset or same-key retake after feedback has been revealed.

Generate the private additive upgrade from the local review packet, outside this checkout:

```bash
python3 scripts/build-qualification-setup.py \
  --research-root /path/to/private/research-checkout \
  --output /path/to/private/qualification-pilot.sql \
  --expected-output /path/to/private/qualification-expected.json
```

Execute that single SQL file in the Supabase SQL Editor. It includes the migration, private material/key import and final inventory checks in one transaction. It never opts participants in or overwrites answers; matching reruns skip immutable rows. Do not use the original study initializer to upgrade an activated pilot. Never commit the generated SQL or expected fixture, which contain sources, references and the answer key. The public migration alone contains no key and leaves the feature unavailable until the private inventory is complete.

Before applying the upgrade online, verify the actual import in an isolated database:

```bash
node scripts/verify-qualification-upgrade.mjs \
  /path/to/private/original-sql-editor-import \
  /path/to/private/qualification-pilot.sql \
  /path/to/private/qualification-expected.json
```

This checks exact material/orientation matching, legacy-progress preservation, repeat imports, blind feedback, pass/fail access, all three presentation schemes, recovery and exports. It does not contact the production database. Qualification outcomes are included in participant and coordinator exports, separately from formal study responses. Review the provisional key before using it as a recruitment filter.

### Mandatory qualification and confirmed scored key

The current workflow supersedes the historical optional pilot. Qualification is required for every new or existing participant; the two-practice route is no longer an access path. Archival practice responses remain in storage and exports. Existing qualification answers, orders and locks are reused, so completing the pilot does not require a second attempt. Previously started study tasks are also gated until qualification is passed.

The coordinator confirmed all 18 existing scored labels after a blind review. This confirms only those scored cells, not all 50 suggested judgments. The mandatory policy uses a **14/18** pass threshold. Original pilot snapshots (including their 15/18 threshold and initial key status) remain immutable. Current session/results project the new policy without rewriting those records; exports retain both the current `qualification_result` and the historical `qualification_original_result`.

After the private study and pilot materials have been imported, explicitly generate the coordinator approval:

```bash
python3 scripts/build-mandatory-qualification-setup.py \
  --research-root /path/to/private/research-checkout \
  --review-result /path/to/private/completed-pilot-result.json \
  --confirm-scored-key \
  --output /path/to/private/mandatory-qualification.sql \
  --approval-output /path/to/private/qualification-approval.json
```

Use `--confirm-scored-key` only after the coordinator has reviewed and approved the 18 scored suggestions, including initial disagreements. The script checks the review against the exact frozen presentation key. The generated SQL contains the additive migration and approval in one transaction; execute it once in Supabase SQL Editor. Matching reruns preserve work. The only displayed final query reports the current threshold, confirmed count and activation state. No candidate source or answer key is copied to public files.

The workflow guide changes only its introductory practice/qualification paragraph. The five criteria and A/B/Tie definitions stay exactly as before. Both original instruction and new workflow metadata are retained for audit; an old acknowledgement is not represented as a new workflow acknowledgement.

Offline integration check (no production connection):

```bash
node scripts/verify-mandatory-qualification.mjs \
  /path/to/private/original-sql-editor-import \
  /path/to/private/qualification-pilot.sql \
  /path/to/private/mandatory-qualification.sql \
  /path/to/private/qualification-approval.json \
  /path/to/private/qualification-expected.json \
  /path/to/private/completed-pilot-result.json
```

The current frontend fails closed if the mandatory policy is not installed. Stale clients cannot use the historical practice path to bypass the database gate. Do not re-run the original full study initializer over an activated policy; use additive upgrades only.

### Access control and collection

Keep `annotation_private` out of Supabase's exposed API schemas. Do not disable RLS or grant direct table/function access to make an error disappear. Only the public `annotation_api` boundary is granted to authenticated users. The SQL tests exercise deny paths as well as allowed operations.

The initial deployment is for a small invited trial without CAPTCHA. Supabase's anonymous-auth rate limits still apply; this is not a claim of comprehensive bot protection. Before broad public recruitment, configure Cloudflare Turnstile in Supabase and set its public site key in the frontend configuration. Never publish the CAPTCHA secret. The frontend loads the CAPTCHA provider only when its site key is configured.

Anonymous identity does not prove a distinct natural person: the same individual may create multiple identities by changing browsers. Vet participants and duplicate/incomplete observations before formal analysis; do not equate anonymous account counts with annotator counts. Agree participant information, consent, compensation and the research protocol before collecting formal data.

### Exports, paused tasks and backups

In the private Supabase SQL Editor, the coordinator can run:

```sql
select annotation_private.export_all();
```

Save the returned JSON outside this public repository. This coordinator export includes private matching metadata and must not be shared with participants. Recovery credentials are excluded. To resume a task after reviewing a reported issue:

```sql
select annotation_private.resolve_problem('PARTICIPANT_ID', 'TASK_ID');
```

This cannot change answers or unlock submitted preferences. Enrollment can be paused without deleting data:

```sql
update annotation_private.settings set enrollment_open = false where id = 1;
```

This stops new enrollments, not existing participants' work or recovery. Do not automatically prune anonymous Auth users or study records. The free Supabase tier may pause inactive projects and does not include automatic database backups; export regularly and check availability before inviting participants.

## Development and deployment

Requires Node.js 24, pnpm 11.25.0 and Python 3 for the private import generator. No public source materials are needed to run the synthetic tests.

```bash
pnpm install --frozen-lockfile --ignore-scripts
pnpm test
pnpm build
```

`dist/` is created from an explicit code-only asset list. GitHub Actions tests/builds on `main` and publishes only that directory. GitHub Pages should use **GitHub Actions** as its source. Relative asset paths support a project URL such as `/human_annotation_for_salience/`.

Backend tests execute the real SQL under a disposable PostgreSQL-compatible PGlite instance with Auth-role/JWT test shims; they do not access or modify production. Production Supabase Auth, network configuration and final private SQL setup also require an online smoke check. Never label the app ready for collection merely because the static page is reachable.

See [the API contract](docs/API_CONTRACT.md) for the full persistence and authorization boundary. Source-corpus permissions remain applicable to privately distributed study material; no corpus license is changed by this interface.
