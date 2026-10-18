# Comparing summaries

A browser-based, two-stage human preference annotation interface. The frontend is hosted on GitHub Pages; Supabase Auth and a restricted PostgreSQL RPC provide private storage and enforce the evaluation sequence.

## For participants

1. Enter a nickname. No email address or password is required. Nicknames are display labels, not account credentials; two people may use the same nickname without sharing data.
2. Save the private recovery code shown to you. It acts as an access key, so do not share it or include it in screenshots. Keep using the same browser to resume automatically.
3. Read the instructions and complete the practice comparisons, then the study comparisons. You may save, pause and return; there is no need to finish in one session.
4. Choose A, B or Tie for source coverage, readability, faithfulness and content focus. Review and lock these four preferences before the reference is shown. Then judge reference coverage. Locked preferences cannot be edited.
5. On another device, use **Recover progress** and your recovery code. Successful recovery issues a new code and invalidates the old one. The previous device loses access, but your answers, task order and lock states remain unchanged. Save the new code.

The source panel preserves the existing Reading view, original-text view and search. Reading view uses neutral grey structural blocks and verified source spacing. Original text preserves the exact source text used for the study's LLM judging. These presentation controls do not change the material or your answers.

Successful saves are confirmed by the server before being labelled saved. Keep the page open if saving fails. **Download my responses** exports your answer records for backup, not your recovery code. The recovery code has its own private download. Anyone with that code can recover the identity; a nickname alone cannot.

## Architecture and privacy

- Public repository/Pages: HTML, CSS, JavaScript, dependency lockfile, public Supabase project URL/publishable key, schema migrations and synthetic tests. The source-layout asset contains hashes and structural offsets only.
- Private Supabase schema: frozen article/summary/reference templates, per-participant assignments, responses, events and recovery-code hashes. Material is stored once, not repeated for each volunteer.
- Public application RPC: authenticates every request with the verified Supabase Auth UID. No anonymous-role access to the RPC and no browser table access. Nickname input and user metadata never authorize another person's data.
- Reference access: the database transaction locks all four initial preferences before a separate request may retrieve the reference. It is never included in static files, session listings, ordinary task responses or participant exports.
- Recovery: 256-bit browser-generated codes; only their SHA-256 hashes are stored. Recovery atomically rotates the code and rebinds the identity. Codes, hashes, access tokens and refresh tokens are excluded from exports and event payloads.

No service-role key, secret API key, database password or real study bundle belongs in this repository. A public/publishable key is intentionally public and does not grant application access without the authenticated RPC checks.

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

Each volunteer receives the complete frozen study plus separate practice tasks. Three prevalidated, balanced presentation schemes are rotated across enrollments; each volunteer's task order is independently shuffled and stored. Recovery retains the same scheme/order. The online installation does not import earlier local preview answers.

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
