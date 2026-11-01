# Fixed annotation packages: engineer handoff

This study has **nine precomputed task packages**. Do not resample, repartition,
rerank or rewrite their contents. You do not need to reproduce the allocation
algorithm to deploy the study on MTurk or another platform.

The companion ZIP is **private research material**, not a website asset bundle.
It contains the actual articles, summaries, references and qualification key.
Do not commit it to a public repository or serve its files directly to workers.

## 1. The entire participant workflow

1. Establish a stable, server-verified participant identity.
2. Present the ten common qualification comparisons. Each comparison has two
   stages, exactly like a study comparison.
3. Evaluate only the **18 scored cells** in the private key, after all ten
   comparisons are submitted. At least **14/18** must match. The other 32
   suggested judgments are exploratory and do not affect eligibility.
4. A failed participant cannot open study materials. Do not permit a retry after
   revealing qualification feedback under a new nickname or the same worker ID.
5. A passed participant atomically claims one unoccupied package, persistently
   linked to their identity. They complete that package's **42 study comparisons**.
6. Save progress on the server and resume the same package on return. Final
   platform submission follows confirmation that the relevant answers are saved.

Qualification is not part of the 42-item study quota. All nine packages contain
the same ten qualification payloads in the same canonical A/B orientation. Each
study item occurs in three different packages. Each package has 20 MACSum and
22 GUMSum comparisons. A package is a logical research allocation, not
necessarily one MTurk HIT; splitting it into paid sessions must not repartition
the underlying research items or repeat qualification.

Use one coordinated slot registry for a formal collection. If MTurk has a new,
independent backend, label its collection separately from this website's pilot.
Do not independently fill all nine slots on both platforms and pool the results
as though each item still had only three raters. Mixed-platform collection needs
explicit slot coordination and participant deduplication.

## 2. Private files supplied by the coordinator

| File | Use |
| --- | --- |
| `package_01.json` ... `package_09.json` | Self-contained, frozen materials in display order: `qualification` then `study`. |
| `manifest.private.json` | Package versions, checksums and inventory. Verify before import. |
| `qualification_key.private.json` | Private qualification labels, scored-cell mask and 14/18 threshold. |
| `qualification_feedback_en.private.json` (English packet only) | English titles and five dimension rationales for all 30 qualification presentation templates. It carries no answer labels. |
| `english_handoff_report.private.json` (English packet only) | Checksums and preservation checks for the English presentation-only derivative. |
| `analysis_mapping.private.json` | Coordinator-only canonical method/stratum mapping. Never send to workers. |
| `assignment_plan.private.json` | Private package membership and existing template identifiers for our Supabase importer. Another backend can use the package JSONs directly. |
| `validation_report.json` | Coverage, overlap and balance checks on the frozen allocation. |
| `frontend-source/` | Snapshot of the current reading/annotation interface, tests and backend contract. No production credentials or saved participant records. |

Each package uses `schema_version: annotation-package-v1`. `assignment_version`
identifies the complete fixed allocation; `package_id` identifies one of its nine
slots. Every item has a stable `item_id`, explicit `kind`, one-based `position`,
frozen `payload` and content `hashes`. Qualification positions and study positions
each start at one. Use explicit fields rather than inferring task kind from an
array offset. Preserve item IDs across platform-specific assignment IDs.

The package `template_id` is a private import aid, not a worker identity or a
public authorization token. A task's `payload` contains `request`, `source`,
`summary_a`, `summary_b`, and `reference`. Preserve these strings verbatim. The
reading view may format known context markers and original boundaries, but the
Original text view must retain the original source text. Keep the exact supplied
rubric and Tie definition; do not add justification-writing requirements.

For the English qualification handoff, the derived key uses schema
`qualification-key-private-en-v1` and exposes `title_en` plus
`judgments[dimension].rationale_en`. Its paired feedback catalog has one row per
qualification `template_id`, with `title_en` and `rationales_en` keyed by the
five dimension IDs. Scheme-specific rationale wording is already aligned to
that template's A/B order; do not swap it again. Keep the key and feedback file
server-side. The legacy Supabase audit snapshot may retain its original
`title_zh`/`rationale_zh`; this is not a request to rewrite historical database
rows. The package JSONs, assignment version, task order, labels and scored mask
are unchanged in this presentation-only derivative.

To build the derivative from the coordinator's immutable original packet, run
the included `scripts/build-english-handoff.py` with the original packet
directory, the private expanded English feedback JSON, and a new output path
named `english_handoff_v1` directly under the original packet directory. The
builder verifies the source manifest and refuses to overwrite either packet.
Then pass the derived directory to `scripts/build-mturk-handoff.py` to create
the private engineer ZIP. The coordinator must keep the original packet and
translation source private; neither belongs in this public repository.

## 3. Two-stage reference boundary (required)

For **every** qualification and study comparison:

- Stage 1 returns only request, source and summaries A/B. Collect
  `source_coverage`, `readability`, `faithfulness`, `content_focus`.
- Choices are exactly `A`, `B`, `Tie` for each dimension. Missing is not Tie.
- Save partial choices, then explicitly lock all four. Persist the lock and the
  four answers atomically. Reject later edits to them.
- Only a separate, authenticated request after that lock may return the reference.
  Record its first exposure time. The initial HTML, JavaScript and task response
  must not contain the reference, even hidden or encoded.
- Stage 2 collects `reference_coverage`. Save drafts; final submission makes the
  comparison immutable. Preserve incomplete work on interruption.

Keep references, qualification labels, scored-cell masks, rationales, method
names and ROUGE strata in private server storage. Do not download a complete
package into the browser and rely on JavaScript/CSS to hide these fields.

## 4. Backend-neutral application boundary

The current implementation uses Supabase, but the research data does not depend
on it. There is no requirement to share the coordinator's production database or
its administrator credentials. Import the private packages into your own storage
and implement the following authenticated operations.

This handoff is not a clone of the production Supabase database. Historical
import scripts assume the larger original template inventory, which is not
included here. A portable backend should read the supplied packages directly;
reusing the complete historical Supabase setup requires separate coordination.

| Operation | Input | Required server behavior |
| --- | --- | --- |
| Session | Verified identity | Return acknowledgement, qualification state, active task queue, progress and allocation; no material/reference/key. |
| Acknowledge | `accepted: true` | Persist instruction acknowledgement. |
| Task | Owned task ID | Check eligibility and return the Stage-1-safe task payload and saved stage/status. |
| Save | Task ID, stage, revision, partial answers | Validate allowed dimensions/choices and compare-and-swap revision; reject locked/completed edits. |
| Lock | Task ID, revision, four Stage-1 answers | Atomically persist the four answers and lock; identical retry is idempotent. |
| Reference | Owned task ID | Require persisted Stage-1 lock; return reference through this operation only, recording first exposure. |
| Complete | Task ID, revision, `reference_coverage` | Require lock and exposure; persist immutable completion; identical retry is idempotent. |
| Qualification result | Verified identity | Return score/feedback only after ten completed qualification comparisons. Eligibility is computed server-side. |
| Problem | Task ID, revision, structured category | Record a report without erasing answers or reopening a completed comparison. |
| Export | Verified identity/coordinator authorization | Return the appropriately scoped response records without credentials. |

Our existing RPC is `annotation_api(p_action, p_task_id, p_payload)`; see
`API_CONTRACT.md` and `web/backend-client.js` for exact request/response fields.
Its implementation is not a requirement for another backend. Use opaque,
participant-owned runtime task IDs; do not authorize access using a package ID,
nickname or an unverified URL parameter alone. Serialize concurrent slot claims
and enforce uniqueness in storage, not just in the browser.

The current UI calls `window.HumanAnnotationBackend.mapRequest(...)` and
`request(action, taskId, payload, {expectedUid})`. `web/stage-state.js` checks the
workflow contract; `web/app.js` implements reading, choices, saving and lock flow.
`web/backend.js` installs the current Supabase adapter. An MTurk port should
replace that adapter and the nickname/recovery entry flow with a verified MTurk
launch/session flow, not modify the criterion definitions or study allocation.
The entry UI also calls identity/recovery helpers exposed by the current adapter;
do not claim the entire UI can be ported by changing only a URL. Either replace
that entry flow or implement the compatible identity methods deliberately.

Fixed-package sessions use allocation protocol `fixed-packages-v1`. Before a
qualification pass the active queue contains ten qualification tasks and no
study tasks. After a successful slot claim it contains ten qualification tasks
and 42 study tasks. If all nine slots are occupied, return an explicit full state
and no study tasks; never silently reuse someone else's package.

## 5. MTurk-specific adapter responsibilities

MTurk appends `workerId`, `assignmentId`, `hitId` and `turkSubmitTo` to an
ExternalQuestion launch URL. Preview uses an unavailable assignment ID; do not
create an attempt, expose study content or accept work in preview. Treat these
URL values as platform context, not sufficient proof of ownership. Bind your
server session to the worker/assignment and reconcile submissions with MTurk.

Implement one research identity per worker, one qualification attempt and one
claimed package. Store MTurk identifiers separately from the research IDs.
Repeated launches, refreshes and retried requests must resume, not create a new
participant or consume a second package. Keep AWS credentials on the server.

Before posting the MTurk externalSubmit form, obtain confirmation that the
intended batch is fully saved. Use an idempotent server-issued completion receipt
bound to that worker, assignment and batch. Keep payment/submission status
separate from research qualification and annotation quality; qualification
failure must not automatically become rejection of already performed paid work.
The requester must set the payment and failed-qualification policy explicitly.

Official platform references:

- [ExternalQuestion rendering and launch parameters](https://docs.aws.amazon.com/AWSMechTurk/latest/AWSMechanicalTurkRequester/mturk-hits-defining-questions-html-rendered.html)
- [External form submission](https://docs.aws.amazon.com/AWSMechTurk/latest/AWSMechanicalTurkRequester/mturk-hits-defining-questions-html-define.html)

## 6. Results contract for joint analysis

Retain at least: assignment version, rubric/instruction version, internal
participant ID, package ID, item ID, runtime task ID, A/B presentation mapping
identifier, task kind, all five choices, stage/status, revision, lock time,
reference exposure time, completion time, and problem reports. Incomplete
responses must remain distinguishable from completed ones. Qualification records
and study records must remain separate. Export private canonical method mapping
only to the coordinator; never rely on A alone meaning the proposed method.

Put platform worker/HIT/assignment IDs in a separate private platform namespace.
Do not export tokens, API secrets, recovery codes or recovery hashes. The final
analysis includes only eligible study responses and counts distinct human
raters, not browser sessions. Label existing pilot/test records explicitly before
combining them with a formal collection.

## 7. Preservation and acceptance checklist

Our live database may contain historical 126-item queues. The fixed-package
migration never deletes or overwrites them. Participants who have already
started a study comparison keep a protected legacy queue rather than losing or
reorienting work; they do not consume one of the nine new package slots. Existing
qualification answers, score snapshots, order/orientation and recovery access are
preserved, even where they differ from the new canonical qualification order.
Other participants enter the fixed-package workflow. Archival legacy rows are
not additional active tasks and are not automatically formal-study ratings.

Before collecting real MTurk work, test in the sandbox:

- All nine package files pass their checksums; 126 unique study items each occur
  in three packages, with no item repeated inside a package.
- Qualification score 13 fails and 14 passes. No feedback before completion;
  no study access through direct/stale task URLs after failure.
- Concurrent successful claims give different packages. Refresh/recovery does
  not change package or task order. A tenth eligible participant receives full.
- Reference is absent from pre-lock responses/assets and cannot be requested
  before a persisted lock. All four locked choices remain immutable.
- Incomplete work survives reload; stale revisions fail safely; identical
  completion retries do not duplicate records.
- Worker duplication, preview, abandoned sessions and a repeated MTurk submit
  cannot create additional ratings or claims.
- Re-importing identical packages/migrations does not alter existing answers,
  IDs, timestamps, qualification snapshots or recovery state.
- Coordinator export includes current allocation and retained historical data,
  clearly distinguishing active and archival study records.

Do not automatically release a claimed package after a timeout. A replacement
worker must not redo all 42 comparisons if some ratings are already complete.
Dropout replacement needs a coordinator-approved residual assignment, exported
under a new version, with completed work retained and final per-item coverage
checked again. Nine workers is the complete-design target, not a promise that
nine recruited workers will all finish.
