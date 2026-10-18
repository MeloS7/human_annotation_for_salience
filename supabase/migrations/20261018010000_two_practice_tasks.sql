-- Reduce the active practice gate to two tasks without deleting or resetting
-- any of the eight retained practice assignments per participant.
-- The coordinator executes this migration transactionally.

-- Annotation RPCs lock participant rows before touching assignments. Take the
-- participant-table lock first so this migration cannot hold an assignments
-- DDL lock while waiting for a participant row held by an in-flight RPC.
lock table annotation_private.participants in access exclusive mode;

alter table annotation_private.assignments
  add column if not exists practice_required boolean not null default false;

do $practice_required_constraint$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'annotation_private.assignments'::regclass
      and conname = 'assignments_practice_required_only_practice_check'
  ) then
    alter table annotation_private.assignments
      add constraint assignments_practice_required_only_practice_check
      check (kind = 'practice' or practice_required = false);
  end if;
end;
$practice_required_constraint$;

create or replace function annotation_private._ensure_practice_subset(
  p_participant_id text
) returns void
language plpgsql
set search_path = ''
as $$
declare
  v_locked_participant text;
  v_pool_count integer;
  v_required_count integer;
  v_updated_count integer;
begin
  select participant_id into v_locked_participant
  from annotation_private.participants
  where participant_id = p_participant_id
  for update;
  if not found then
    raise exception using errcode = 'PT404', message = 'The requested participant was not found.';
  end if;

  select pg_catalog.count(*) into v_pool_count
  from annotation_private.assignments
  where participant_id = p_participant_id and kind = 'practice';
  if v_pool_count <> 8 then
    raise exception using errcode = 'PT503', message = 'The practice assignment pool is incomplete.';
  end if;

  select pg_catalog.count(*) into v_required_count
  from annotation_private.assignments
  where participant_id = p_participant_id and kind = 'practice' and practice_required;
  if v_required_count = 2 then
    return;
  elsif v_required_count <> 0 then
    raise exception using errcode = 'PT503', message = 'The active practice assignment set is inconsistent.';
  end if;

  with ranked as (
    select task_id,
      pg_catalog.row_number() over (
        order by
          case
            when status = 'complete' then 0
            when status <> 'paused' and (
              stage1_answers <> '{}'::jsonb or
              stage2_answers <> '{}'::jsonb or
              locked_at is not null or
              reference_released_at is not null
            ) then 1
            when status <> 'paused' then 2
            else 3
          end,
          position,
          task_id
      ) as selection_order
    from annotation_private.assignments
    where participant_id = p_participant_id and kind = 'practice'
  )
  update annotation_private.assignments as assignment
  set practice_required = true
  from ranked
  where assignment.task_id = ranked.task_id
    and ranked.selection_order <= 2;

  get diagnostics v_updated_count = row_count;
  if v_updated_count <> 2 then
    raise exception using errcode = 'PT503', message = 'The active practice assignment set could not be prepared.';
  end if;
end;
$$;

revoke all on function annotation_private._ensure_practice_subset(text)
  from public, anon, authenticated;

-- Existing participants are ranked and flagged once. The helper is a no-op
-- after exactly two rows have been selected, so re-running this migration
-- preserves a participant's chosen IDs even if their states later change.
do $backfill_practice_subset$
declare
  v_participant_id text;
begin
  for v_participant_id in
    select participant_id from annotation_private.participants order by participant_id
  loop
    perform annotation_private._ensure_practice_subset(v_participant_id);
  end loop;
end;
$backfill_practice_subset$;

create or replace function annotation_private._check_access_gate(
  p_participant_id text,
  p_kind text
) returns void
language plpgsql
set search_path = ''
as $$
declare
  v_ack timestamptz;
  v_practice_total integer;
  v_practice_complete integer;
begin
  select guide_ack_at into v_ack
  from annotation_private.participants
  where participant_id = p_participant_id;
  if v_ack is null then
    raise exception using errcode = 'PT403', message = 'Please read and acknowledge the instructions first.';
  end if;

  -- Also protects direct task requests for retained records if the subset was
  -- not yet materialised for a newly enrolled participant.
  perform annotation_private._ensure_practice_subset(p_participant_id);
  if p_kind = 'study' then
    select
      pg_catalog.count(*),
      pg_catalog.count(*) filter (where status = 'complete')
      into v_practice_total, v_practice_complete
    from annotation_private.assignments
    where participant_id = p_participant_id
      and kind = 'practice'
      and practice_required;
    if v_practice_total <> 2 or v_practice_complete <> 2 then
      raise exception using errcode = 'PT403', message = 'Complete the practice comparisons before starting the study.';
    end if;
  end if;
end;
$$;

create or replace function annotation_private._task_payload(
  p_row annotation_private.assignments,
  p_template annotation_private.templates
) returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_answers jsonb;
  v_total integer;
begin
  if (p_row.stage = 1 and p_row.status = 'draft') or
     (p_row.stage = 1 and p_row.status = 'paused' and p_row.paused_from_status = 'draft') then
    v_answers := p_row.stage1_answers;
  else
    v_answers := p_row.stage2_answers;
  end if;
  select pg_catalog.count(*) into v_total
  from annotation_private.assignments
  where participant_id = p_row.participant_id
    and kind = p_row.kind
    and (p_row.kind <> 'practice' or practice_required);
  return pg_catalog.jsonb_build_object(
    'id', p_row.task_id,
    'kind', p_row.kind,
    'position', p_row.position,
    'total', v_total,
    'stage', p_row.stage,
    'status', p_row.status,
    'revision', p_row.revision,
    'request', p_template.payload -> 'request',
    'source', p_template.payload -> 'source',
    'source_sha256', p_template.hashes -> 'source_sha256',
    'summary_a', p_template.payload -> 'summary_a',
    'summary_b', p_template.payload -> 'summary_b',
    'answers', coalesce(v_answers, '{}'::jsonb),
    'locked_at', p_row.locked_at,
    'completed_at', p_row.completed_at,
    'reference_released_at', p_row.reference_released_at
  );
end;
$$;

create or replace function annotation_private._session_payload(p_participant_id text)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_settings annotation_private.settings%rowtype;
  v_participant annotation_private.participants%rowtype;
  v_tasks jsonb;
  v_study_total integer;
  v_study_complete integer;
  v_practice_total integer;
  v_practice_complete integer;
  v_paused integer;
begin
  perform annotation_private._ensure_practice_subset(p_participant_id);
  select * into v_participant from annotation_private.participants where participant_id = p_participant_id;
  if not found then
    raise exception using errcode = 'PT404', message = 'The requested participant was not found.';
  end if;
  select * into v_settings from annotation_private.settings where id = 1;
  if not found or v_settings.id is null then
    raise exception using errcode = 'PT503', message = 'The annotation study is not currently available.';
  end if;
  perform annotation_private._assert_settings(v_settings);

  select
    pg_catalog.count(*) filter (where kind = 'study'),
    pg_catalog.count(*) filter (where kind = 'study' and status = 'complete'),
    pg_catalog.count(*) filter (where kind = 'practice' and practice_required),
    pg_catalog.count(*) filter (where kind = 'practice' and practice_required and status = 'complete'),
    pg_catalog.count(*) filter (where status = 'paused' and (kind <> 'practice' or practice_required))
    into v_study_total, v_study_complete, v_practice_total, v_practice_complete, v_paused
  from annotation_private.assignments where participant_id = p_participant_id;

  select coalesce(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'id', task_id, 'kind', kind, 'position', position, 'status', status, 'stage', stage
      ) order by case kind when 'practice' then 0 else 1 end, position
    ), '[]'::jsonb
  ) into v_tasks
  from annotation_private.assignments
  where participant_id = p_participant_id
    and (kind = 'study' or practice_required);

  return pg_catalog.jsonb_build_object(
    'authenticated', true,
    'enrolled', true,
    'mode', 'study',
    'participant_id', p_participant_id,
    'display_name', v_participant.display_name,
    'accepted_instructions', v_participant.guide_ack_at is not null,
    'tasks', v_tasks,
    'progress', pg_catalog.jsonb_build_object(
      'study_total', coalesce(v_study_total, 0),
      'study_completed', coalesce(v_study_complete, 0),
      'practice_total', coalesce(v_practice_total, 0),
      'practice_completed', coalesce(v_practice_complete, 0),
      'practice_requirement', 2,
      'paused', coalesce(v_paused, 0)
    ),
    'rubric', v_settings.rubric,
    'guide_md', v_settings.guide_md
  );
end;
$$;

create or replace function annotation_private._export_assignments(
  p_participant_id text,
  p_kind text,
  p_include_mapping boolean
) returns jsonb
language sql
stable
set search_path = ''
as $$
  select coalesce(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'id', a.task_id,
        'position', a.position,
        'practice_required', a.practice_required,
        'status', a.status,
        'stage', a.stage,
        'revision', a.revision,
        'stage1_answers', a.stage1_answers,
        'stage2_answers', a.stage2_answers,
        'hashes', t.hashes,
        'locked_at', a.locked_at,
        'reference_released_at', a.reference_released_at,
        'completed_at', a.completed_at,
        'problem_reports', annotation_private._events_json(a.participant_id, a.task_id, true),
        'events', annotation_private._events_json(a.participant_id, a.task_id, false)
      ) || case
        when p_include_mapping then pg_catalog.jsonb_build_object(
          'coordinator', (case when t.coordinator is null or t.coordinator = 'null'::jsonb
                                then '{}'::jsonb else t.coordinator end) ||
            pg_catalog.jsonb_build_object('template_id', t.template_id)
        )
        else '{}'::jsonb
      end
      order by a.position
    ), '[]'::jsonb
  )
  from annotation_private.assignments as a
  join annotation_private.templates as t on t.template_id = a.template_id
  where a.participant_id = p_participant_id and a.kind = p_kind;
$$;
