-- Dormant fixed-package allocation. Private plan import sets settings.assignment_version
-- only after the complete nine-package inventory has been imported and checked.
alter table annotation_private.settings add column if not exists assignment_version text;

create table if not exists annotation_private.fixed_package_sets (
  assignment_version text primary key,
  fingerprint text not null check (fingerprint ~ '^[a-f0-9]{64}$'),
  package_count integer not null check (package_count = 9),
  items_per_package integer not null check (items_per_package = 42),
  ratings_per_item integer not null check (ratings_per_item = 3),
  created_at timestamptz not null default now()
);
create table if not exists annotation_private.fixed_package_slots (
  assignment_version text not null references annotation_private.fixed_package_sets(assignment_version) on delete restrict,
  package_id text not null check (package_id ~ '^package_0[1-9]$'),
  ordinal integer not null check (ordinal between 1 and 9),
  primary key (assignment_version, package_id), unique (assignment_version, ordinal)
);
create table if not exists annotation_private.fixed_package_items (
  assignment_version text not null,
  package_id text not null,
  position integer not null check (position between 1 and 42),
  item_id text not null,
  template_id text not null references annotation_private.templates(template_id) on delete restrict,
  primary key (assignment_version, package_id, position),
  unique (assignment_version, package_id, item_id),
  foreign key (assignment_version, package_id)
    references annotation_private.fixed_package_slots(assignment_version, package_id) on delete restrict
);
create table if not exists annotation_private.fixed_package_participants (
  participant_id text primary key references annotation_private.participants(participant_id) on delete restrict,
  assignment_version text not null references annotation_private.fixed_package_sets(assignment_version) on delete restrict,
  mode text not null check (mode in ('fixed', 'legacy')),
  package_id text,
  canonical_qualification boolean not null default false,
  classified_at timestamptz not null default now(),
  unique (participant_id, assignment_version, package_id),
  foreign key (assignment_version, package_id)
    references annotation_private.fixed_package_slots(assignment_version, package_id) on delete restrict,
  check ((mode = 'legacy' and package_id is null) or mode = 'fixed')
);
create unique index if not exists fixed_package_one_participant_per_slot
  on annotation_private.fixed_package_participants (assignment_version, package_id)
  where mode = 'fixed' and package_id is not null;
create table if not exists annotation_private.fixed_package_task_assignments (
  assignment_version text not null,
  package_id text not null,
  participant_id text not null references annotation_private.fixed_package_participants(participant_id) on delete restrict,
  item_position integer not null check (item_position between 1 and 42),
  item_id text not null,
  task_id text not null unique references annotation_private.assignments(task_id) on delete restrict,
  primary key (assignment_version, participant_id, item_position),
  foreign key (assignment_version, package_id, item_position)
    references annotation_private.fixed_package_items(assignment_version, package_id, position) on delete restrict,
  foreign key (participant_id, assignment_version, package_id)
    references annotation_private.fixed_package_participants(participant_id, assignment_version, package_id) on delete restrict
);

alter table annotation_private.fixed_package_sets enable row level security;
alter table annotation_private.fixed_package_slots enable row level security;
alter table annotation_private.fixed_package_items enable row level security;
alter table annotation_private.fixed_package_participants enable row level security;
alter table annotation_private.fixed_package_task_assignments enable row level security;
revoke all on all tables in schema annotation_private from public, anon, authenticated;
revoke all on all sequences in schema annotation_private from public, anon, authenticated;
revoke all on all functions in schema annotation_private from public, anon, authenticated;

create or replace function annotation_private._assert_fixed_package_inventory(p_version text)
returns void language plpgsql stable security definer set search_path = '' as $$
declare
  v_set annotation_private.fixed_package_sets%rowtype;
  v_packages integer; v_items integer; v_unique_items integer;
  v_bad_packages integer; v_bad_items integer; v_bad_ratings integer;
begin
  select * into v_set from annotation_private.fixed_package_sets where assignment_version = p_version;
  if not found then raise exception using errcode = 'PT503', message = 'The fixed assignment plan is not available.'; end if;
  select count(*) into v_packages from annotation_private.fixed_package_slots where assignment_version = p_version;
  select count(*), count(distinct item_id) into v_items, v_unique_items from annotation_private.fixed_package_items where assignment_version = p_version;
  select count(*) into v_bad_packages from (
    select s.package_id from annotation_private.fixed_package_slots s
    left join annotation_private.fixed_package_items i using (assignment_version, package_id)
    where s.assignment_version = p_version group by s.package_id
    having count(i.position) <> 42 or count(distinct i.position) <> 42
  ) q;
  select count(*) into v_bad_items from (
    select i.package_id, i.item_id from annotation_private.fixed_package_items i
    join annotation_private.templates t on t.template_id = i.template_id
    where i.assignment_version = p_version
      and (t.kind <> 'study' or coalesce(t.coordinator ->> 'pair_id', '') <> i.item_id)
  ) q;
  select count(*) into v_bad_ratings from (
    select i.item_id from annotation_private.fixed_package_items i
    join annotation_private.templates t on t.template_id = i.template_id
    where i.assignment_version = p_version group by i.item_id
    having count(distinct i.package_id) <> 3 or count(distinct t.scheme) < 2
      or count(*) filter (where coalesce(t.coordinator ->> 'ours_side', '') not in ('A', 'B')) <> 0
      or count(distinct t.coordinator ->> 'ours_side') <> 2
  ) q;
  if v_packages <> 9 or v_items <> 378 or v_unique_items <> 126 or
     v_bad_packages <> 0 or v_bad_items <> 0 or v_bad_ratings <> 0 then
    raise exception using errcode = 'PT503', message = 'The fixed assignment plan failed its coverage checks.';
  end if;
end;
$$;

create or replace function annotation_private._fixed_plan_guard()
returns trigger language plpgsql set search_path = '' as $$
declare v_version text;
begin
  v_version := case when tg_op = 'DELETE' then old.assignment_version else new.assignment_version end;
  if exists (select 1 from annotation_private.settings where id = 1 and assignment_version = v_version)
     or (tg_op = 'UPDATE' and exists (
       select 1 from annotation_private.settings where id = 1 and assignment_version = old.assignment_version
     )) then
    raise exception using errcode = 'PT409', message = 'The active fixed assignment plan is immutable.';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
drop trigger if exists fixed_package_sets_guard on annotation_private.fixed_package_sets;
create trigger fixed_package_sets_guard before update or delete on annotation_private.fixed_package_sets for each row execute function annotation_private._fixed_plan_guard();
drop trigger if exists fixed_package_slots_guard on annotation_private.fixed_package_slots;
create trigger fixed_package_slots_guard before insert or update or delete on annotation_private.fixed_package_slots for each row execute function annotation_private._fixed_plan_guard();
drop trigger if exists fixed_package_items_guard on annotation_private.fixed_package_items;
create trigger fixed_package_items_guard before insert or update or delete on annotation_private.fixed_package_items for each row execute function annotation_private._fixed_plan_guard();

create or replace function annotation_private._fixed_assignment_setting_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  if old.assignment_version is not null and new.assignment_version is distinct from old.assignment_version then
    raise exception using errcode = 'PT409', message = 'The active fixed assignment plan cannot be replaced.';
  end if;
  if new.assignment_version is not null then perform annotation_private._assert_fixed_package_inventory(new.assignment_version); end if;
  return new;
end;
$$;
drop trigger if exists fixed_assignment_setting_guard on annotation_private.settings;
create trigger fixed_assignment_setting_guard before update of assignment_version on annotation_private.settings
for each row execute function annotation_private._fixed_assignment_setting_guard();

create or replace function annotation_private._fixed_package_participant_trigger()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_settings annotation_private.settings%rowtype;
begin
  select * into v_settings from annotation_private.settings where id = 1;
  if not found or v_settings.assignment_version is null then return new; end if;
  if tg_when = 'BEFORE' then new.scheme := 1; return new; end if;
  insert into annotation_private.fixed_package_participants (participant_id, assignment_version, mode, package_id)
  values (new.participant_id, v_settings.assignment_version, 'fixed', null)
  on conflict (participant_id) do nothing;
  update annotation_private.fixed_package_participants set canonical_qualification = true
  where participant_id = new.participant_id and mode = 'fixed';
  return new;
end;
$$;
drop trigger if exists fixed_package_participant_scheme on annotation_private.participants;
create trigger fixed_package_participant_scheme before insert on annotation_private.participants
for each row execute function annotation_private._fixed_package_participant_trigger();
drop trigger if exists fixed_package_participant_enroll on annotation_private.participants;
create trigger fixed_package_participant_enroll after insert on annotation_private.participants
for each row execute function annotation_private._fixed_package_participant_trigger();

create or replace function annotation_private._canonical_fixed_qualification_trigger()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_version text;
  v_id text;
  v_template_id text;
begin
  if new.kind <> 'qualification' then return new; end if;
  select assignment_version into v_version from annotation_private.fixed_package_participants
  where participant_id = new.participant_id and mode = 'fixed' and canonical_qualification;
  if not found then return new; end if;
  select k.qualification_id into v_id
  from annotation_private.qualification_keys k
  where k.qualification_version = (select qualification_version from annotation_private.settings where id = 1)
    and k.template_id = new.template_id;
  if not found then return new; end if;
  select k.template_id into v_template_id
  from annotation_private.qualification_keys k
  join annotation_private.templates t on t.template_id = k.template_id
  where k.qualification_version = (select qualification_version from annotation_private.settings where id = 1)
    and k.qualification_id = v_id and t.scheme = 1 and t.kind = 'qualification';
  if not found then raise exception using errcode = 'PT503', message = 'The common qualification materials are incomplete.'; end if;
  new.template_id := v_template_id;
  new.position := substring(v_id from 2)::integer;
  return new;
end;
$$;
drop trigger if exists canonical_fixed_qualification on annotation_private.assignments;
create trigger canonical_fixed_qualification before insert on annotation_private.assignments
for each row execute function annotation_private._canonical_fixed_qualification_trigger();

create or replace function annotation_private._classify_fixed_package_participants()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if old.assignment_version is null and new.assignment_version is not null then
    perform annotation_private._assert_fixed_package_inventory(new.assignment_version);
    insert into annotation_private.fixed_package_participants (participant_id, assignment_version, mode, package_id)
    select p.participant_id, new.assignment_version,
      case when exists (
        select 1 from annotation_private.assignments a where a.participant_id = p.participant_id and a.kind = 'study'
          and (a.status <> 'draft' or a.stage <> 1 or a.revision <> 0
            or a.stage1_answers <> '{}'::jsonb or a.stage2_answers <> '{}'::jsonb
            or a.locked_at is not null or a.reference_released_at is not null
            or a.completed_at is not null or a.paused_from_status is not null
            or exists (select 1 from annotation_private.events e where e.task_id = a.task_id))
      ) then 'legacy' else 'fixed' end,
      null
    from annotation_private.participants p on conflict (participant_id) do nothing;
  end if;
  return null;
end;
$$;
drop trigger if exists fixed_package_participant_classification on annotation_private.settings;
create trigger fixed_package_participant_classification after update of assignment_version on annotation_private.settings
for each row execute function annotation_private._classify_fixed_package_participants();

create or replace function annotation_private._claim_fixed_package(p_participant_id text)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_state annotation_private.fixed_package_participants%rowtype;
  v_settings annotation_private.settings%rowtype;
  v_result jsonb;
  v_package text;
  v_base integer;
  v_inserted integer;
begin
  select * into v_state from annotation_private.fixed_package_participants
  where participant_id = p_participant_id for update;
  if not found then raise exception using errcode = 'PT503', message = 'The fixed assignment state is not available.'; end if;
  if v_state.mode = 'legacy' then return 'legacy'; end if;
  if v_state.package_id is not null then return 'assigned'; end if;

  -- The settings row is the global allocator mutex; claims and task rows are
  -- committed atomically, and duplicate session/recovery calls reuse the claim.
  select * into v_settings from annotation_private.settings where id = 1 for update;
  if not found or v_settings.assignment_version is distinct from v_state.assignment_version then
    raise exception using errcode = 'PT503', message = 'The fixed assignment plan is not configured correctly.';
  end if;
  perform annotation_private._assert_fixed_package_inventory(v_state.assignment_version);
  perform annotation_private._evaluate_qualification(p_participant_id);
  v_result := annotation_private._current_qualification_result(p_participant_id);
  if v_result is null or v_result ->> 'state' is distinct from 'passed' then return 'qualification'; end if;

  select s.package_id into v_package
  from annotation_private.fixed_package_slots s
  where s.assignment_version = v_state.assignment_version
    and not exists (
      select 1 from annotation_private.fixed_package_participants p
      where p.assignment_version = s.assignment_version and p.package_id = s.package_id and p.mode = 'fixed'
    )
  order by s.ordinal limit 1;
  if v_package is null then return 'full'; end if;

  update annotation_private.fixed_package_participants set package_id = v_package
  where participant_id = p_participant_id and mode = 'fixed' and package_id is null;
  if not found then
    select package_id into v_package from annotation_private.fixed_package_participants where participant_id = p_participant_id;
    return case when v_package is null then 'full' else 'assigned' end;
  end if;

  select coalesce(max(position), 0) into v_base
  from annotation_private.assignments where participant_id = p_participant_id and kind = 'study';
  insert into annotation_private.assignments (task_id, participant_id, template_id, kind, position)
  select 'fixed_' || pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
      p_participant_id || '|' || v_state.assignment_version || '|' || v_package || '|' || i.position::text, 'UTF8')), 'hex'),
    p_participant_id, i.template_id, 'study', v_base + i.position
  from annotation_private.fixed_package_items i
  where i.assignment_version = v_state.assignment_version and i.package_id = v_package
  order by i.position;
  get diagnostics v_inserted = row_count;
  if v_inserted <> 42 then raise exception using errcode = 'PT503', message = 'The fixed task package could not be materialized.'; end if;

  insert into annotation_private.fixed_package_task_assignments
    (assignment_version, package_id, participant_id, item_position, item_id, task_id)
  select i.assignment_version, i.package_id, p_participant_id, i.position, i.item_id, a.task_id
  from annotation_private.fixed_package_items i
  join annotation_private.assignments a on a.participant_id = p_participant_id
    and a.kind = 'study' and a.position = v_base + i.position and a.template_id = i.template_id
  where i.assignment_version = v_state.assignment_version and i.package_id = v_package
  order by i.position;
  get diagnostics v_inserted = row_count;
  if v_inserted <> 42 then raise exception using errcode = 'PT503', message = 'The fixed task package mapping is incomplete.'; end if;
  return 'assigned';
end;
$$;

create or replace function annotation_private._task_payload(
  p_row annotation_private.assignments,
  p_template annotation_private.templates
) returns jsonb language plpgsql set search_path = '' as $$
declare
  v_answers jsonb;
  v_total integer;
  v_item_position integer;
  v_payload jsonb;
begin
  if (p_row.stage = 1 and p_row.status = 'draft') or
     (p_row.stage = 1 and p_row.status = 'paused' and p_row.paused_from_status = 'draft') then
    v_answers := p_row.stage1_answers;
  else
    v_answers := p_row.stage2_answers;
  end if;
  select pg_catalog.count(*) into v_total from annotation_private.assignments
  where participant_id = p_row.participant_id and kind = p_row.kind
    and (p_row.kind <> 'practice' or practice_required);
  v_payload := pg_catalog.jsonb_build_object(
    'id', p_row.task_id, 'kind', p_row.kind, 'position', p_row.position, 'total', v_total,
    'stage', p_row.stage, 'status', p_row.status, 'revision', p_row.revision,
    'request', p_template.payload -> 'request', 'source', p_template.payload -> 'source',
    'source_sha256', p_template.hashes -> 'source_sha256',
    'summary_a', p_template.payload -> 'summary_a', 'summary_b', p_template.payload -> 'summary_b',
    'answers', coalesce(v_answers, '{}'::jsonb), 'locked_at', p_row.locked_at,
    'completed_at', p_row.completed_at, 'reference_released_at', p_row.reference_released_at
  );
  select item_position into v_item_position
  from annotation_private.fixed_package_task_assignments where task_id = p_row.task_id;
  if found then return v_payload || pg_catalog.jsonb_build_object('position', v_item_position, 'total', 42); end if;
  return v_payload;
end;
$$;

-- Snapshot the current 14/18 session construction without modifying its
-- protocol; the active wrapper below only replaces its study queue.
create or replace function annotation_private._session_payload_pre_fixed(p_participant_id text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_settings annotation_private.settings%rowtype;
  v_policy annotation_private.qualification_policies%rowtype;
  v_legacy jsonb;
  v_raw_result jsonb;
  v_result jsonb;
  v_qualification jsonb;
begin
  select * into v_settings from annotation_private.settings where id = 1;
  if not found then
    raise exception using errcode = 'PT503', message = 'The annotation study is not currently available.';
  end if;
  if v_settings.qualification_policy_version is null then
    return annotation_private._session_payload_pre_mandatory(p_participant_id);
  end if;
  v_policy := annotation_private._assert_mandatory_policy();
  perform annotation_private._adopt_mandatory_qualification(p_participant_id);
  v_legacy := annotation_private._session_payload_pre_mandatory(p_participant_id);
  select result into v_raw_result from annotation_private.qualification_results
  where participant_id = p_participant_id and qualification_version = v_policy.qualification_version;
  v_result := annotation_private._current_qualification_result(p_participant_id);
  v_qualification := pg_catalog.jsonb_build_object(
    'protocol', 'qualification-required-v2',
    'policy_version', v_policy.policy_version,
    'required_for_study', true,
    'version', v_policy.qualification_version,
    'key_status', v_policy.key_status,
    'confirmed_scored_count', v_policy.confirmed_scored_count,
    'required', 10,
    'completed', coalesce((v_legacy -> 'qualification' ->> 'completed')::integer, 0),
    'state', coalesce(v_result ->> 'state', 'in_progress'),
    'scored_total', v_policy.scored_total,
    'pass_count', v_policy.pass_count,
    'score', case when v_result is null then null else pg_catalog.jsonb_build_object('matched', v_result -> 'matched', 'total', v_result -> 'total') end,
    'completed_at', v_raw_result -> 'evaluated_at'
  );
  return (v_legacy - 'qualification_available' - 'tasks' - 'progress') || pg_catalog.jsonb_build_object(
    'qualification_required', true,
    'workflow_version', v_policy.policy_version,
    'workflow_guide_md', v_policy.workflow_guide_md,
    'workflow_guide_sha256', v_policy.workflow_guide_sha256,
    'tasks', coalesce(v_legacy -> 'tasks', '[]'::jsonb),
    'qualification', v_qualification,
    'progress', (coalesce(v_legacy -> 'progress', '{}'::jsonb) || pg_catalog.jsonb_build_object(
      'practice_total', 0, 'practice_completed', 0, 'practice_requirement', 0,
      'qualification_total', 10,
      'qualification_completed', coalesce((v_legacy -> 'qualification' ->> 'completed')::integer, 0)
    ))
  );
end;
$$;

create or replace function annotation_private._session_payload(p_participant_id text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_settings annotation_private.settings%rowtype;
  v_state annotation_private.fixed_package_participants%rowtype;
  v_legacy jsonb;
  v_tasks jsonb;
  v_q_tasks jsonb;
  v_study_total integer := 0;
  v_study_complete integer := 0;
  v_paused integer := 0;
  v_allocation_state text;
  v_package text;
begin
  v_legacy := annotation_private._session_payload_pre_fixed(p_participant_id);
  select * into v_settings from annotation_private.settings where id = 1;
  if not found or v_settings.assignment_version is null then return v_legacy; end if;
  select * into v_state from annotation_private.fixed_package_participants where participant_id = p_participant_id;
  if not found or v_state.assignment_version is distinct from v_settings.assignment_version then
    raise exception using errcode = 'PT503', message = 'The fixed assignment state is not available.';
  end if;
  if v_state.mode = 'legacy' then
    return v_legacy || pg_catalog.jsonb_build_object('allocation', pg_catalog.jsonb_build_object(
      'protocol', 'fixed-packages-v1', 'version', v_state.assignment_version,
      'mode', 'legacy', 'state', 'legacy', 'package_id', null, 'study_target', 126
    ));
  end if;

  v_allocation_state := annotation_private._claim_fixed_package(p_participant_id);
  select * into v_state from annotation_private.fixed_package_participants where participant_id = p_participant_id;
  v_package := v_state.package_id;
  select coalesce(pg_catalog.jsonb_agg(task order by (task ->> 'position')::integer), '[]'::jsonb)
    into v_q_tasks
  from pg_catalog.jsonb_array_elements(v_legacy -> 'tasks') task
  where task ->> 'kind' = 'qualification';
  if v_package is null then
    v_tasks := v_q_tasks;
  else
    select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', a.task_id, 'kind', 'study', 'position', m.item_position, 'status', a.status, 'stage', a.stage
    ) order by m.item_position), '[]'::jsonb)
    into v_tasks
    from annotation_private.fixed_package_task_assignments m
    join annotation_private.assignments a on a.task_id = m.task_id
    where m.participant_id = p_participant_id and m.assignment_version = v_state.assignment_version;
    v_tasks := v_q_tasks || v_tasks;
    select count(*), count(*) filter (where a.status = 'complete'), count(*) filter (where a.status = 'paused')
      into v_study_total, v_study_complete, v_paused
    from annotation_private.fixed_package_task_assignments m
    join annotation_private.assignments a on a.task_id = m.task_id
    where m.participant_id = p_participant_id and m.assignment_version = v_state.assignment_version;
  end if;
  select coalesce(v_paused, 0) + count(*) filter (where task ->> 'status' = 'paused')
    into v_paused from pg_catalog.jsonb_array_elements(v_q_tasks) task;

  return (v_legacy - 'tasks' - 'progress') || pg_catalog.jsonb_build_object(
    'tasks', coalesce(v_tasks, '[]'::jsonb),
    'allocation', pg_catalog.jsonb_build_object(
      'protocol', 'fixed-packages-v1', 'version', v_state.assignment_version,
      'mode', 'fixed', 'state', v_allocation_state, 'package_id', v_package, 'study_target', 42
    ),
    'progress', (coalesce(v_legacy -> 'progress', '{}'::jsonb) || pg_catalog.jsonb_build_object(
      'study_total', v_study_total, 'study_completed', v_study_complete,
      'practice_total', 0, 'practice_completed', 0, 'practice_requirement', 0, 'paused', coalesce(v_paused, 0)
    ))
  );
end;
$$;

create or replace function annotation_private._export_participant(p_participant_id text, p_include_mapping boolean)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_settings annotation_private.settings%rowtype;
  v_state annotation_private.fixed_package_participants%rowtype;
  v_policy annotation_private.qualification_policies%rowtype;
  v_raw_result jsonb;
  v_result jsonb;
  v_legacy jsonb;
  v_rows jsonb;
  v_allocation jsonb;
  v_slot_available boolean;
begin
  v_legacy := annotation_private._export_participant_pre_mandatory(p_participant_id, p_include_mapping);
  select * into v_settings from annotation_private.settings where id = 1;
  if not found or v_settings.qualification_policy_version is null then return v_legacy; end if;
  v_policy := annotation_private._assert_mandatory_policy();
  select result into v_raw_result from annotation_private.qualification_results
  where participant_id = p_participant_id and qualification_version = v_policy.qualification_version;
  v_result := annotation_private._current_qualification_result(p_participant_id);
  v_legacy := (v_legacy - 'qualification_result') || pg_catalog.jsonb_build_object(
    'qualification_result', v_result,
    'qualification_original_result', v_raw_result,
    'qualification_policy', pg_catalog.jsonb_build_object(
      'policy_version', v_policy.policy_version, 'qualification_version', v_policy.qualification_version,
      'fingerprint', v_policy.fingerprint, 'key_status', v_policy.key_status,
      'pass_count', v_policy.pass_count, 'scored_total', v_policy.scored_total,
      'confirmed_scored_count', v_policy.confirmed_scored_count,
      'workflow_guide_sha256', v_policy.workflow_guide_sha256, 'approved_at', v_policy.approved_at
    )
  );
  if v_settings.assignment_version is null then return v_legacy; end if;
  select * into v_state from annotation_private.fixed_package_participants where participant_id = p_participant_id;
  if not found then raise exception using errcode = 'PT503', message = 'The fixed assignment state is not available.'; end if;
  if v_state.mode = 'legacy' then
    v_allocation := pg_catalog.jsonb_build_object('protocol','fixed-packages-v1','version',v_state.assignment_version,
      'mode','legacy','state','legacy','package_id',null,'study_target',126);
  elsif v_state.package_id is null then
    select exists (
      select 1 from annotation_private.fixed_package_slots s
      where s.assignment_version = v_state.assignment_version
        and not exists (select 1 from annotation_private.fixed_package_participants p
          where p.assignment_version = s.assignment_version and p.package_id = s.package_id and p.mode = 'fixed')
    ) into v_slot_available;
    v_allocation := pg_catalog.jsonb_build_object('protocol','fixed-packages-v1','version',v_state.assignment_version,
      'mode','fixed','state',case when v_result ->> 'state' <> 'passed' or v_result is null then 'qualification'
        when v_slot_available then 'awaiting_assignment' else 'full' end,
      'package_id',null,'study_target',42);
  else
    v_allocation := pg_catalog.jsonb_build_object('protocol','fixed-packages-v1','version',v_state.assignment_version,
      'mode','fixed','state','assigned','package_id',v_state.package_id,'study_target',42);
  end if;
  select coalesce(pg_catalog.jsonb_agg(
    e.value || pg_catalog.jsonb_build_object(
      'allocation_role', case
        when v_state.mode = 'legacy' then 'legacy_active'
        when m.task_id is not null then 'active_package'
        else 'archival_legacy'
      end
    ) || case when m.task_id is not null then pg_catalog.jsonb_build_object('package_id',m.package_id,'package_position',m.item_position) else '{}'::jsonb end
    order by (e.value ->> 'position')::integer
  ), '[]'::jsonb) into v_rows
  from pg_catalog.jsonb_array_elements(coalesce(v_legacy -> 'study_assignments','[]'::jsonb)) e(value)
  left join annotation_private.fixed_package_task_assignments m
    on m.participant_id = p_participant_id and m.assignment_version = v_state.assignment_version
      and m.task_id = e.value ->> 'id';
  return (v_legacy - 'study_assignments') || pg_catalog.jsonb_build_object(
    'study_assignments',v_rows,'allocation',v_allocation
  );
end;
$$;

do $preserve_fixed_dispatcher$
begin
  if pg_catalog.to_regprocedure('public.annotation_api_pre_fixed(text,text,jsonb)') is null then
    execute 'alter function public.annotation_api(text, text, jsonb) rename to annotation_api_pre_fixed';
  end if;
end;
$preserve_fixed_dispatcher$;

create or replace function public.annotation_api(
  p_action text,
  p_task_id text default null,
  p_payload jsonb default '{}'::jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid;
  v_participant annotation_private.participants%rowtype;
  v_state annotation_private.fixed_package_participants%rowtype;
  v_kind text;
begin
  v_uid := auth.uid();
  if p_action in ('task','save','lock','reference','complete','problem') and p_task_id is not null then
    select * into v_participant from annotation_private.participants where auth_user_id = v_uid;
    if found then
      select * into v_state from annotation_private.fixed_package_participants
      where participant_id = v_participant.participant_id;
      if found and v_state.mode = 'fixed' then
        select kind into v_kind from annotation_private.assignments
        where task_id = p_task_id and participant_id = v_participant.participant_id;
        if v_kind = 'study' and not exists (
          select 1 from annotation_private.fixed_package_task_assignments
          where participant_id = v_participant.participant_id
            and assignment_version = v_state.assignment_version and task_id = p_task_id
        ) then
          raise exception using errcode = 'PT404', message = 'This comparison is not available in your assignment.';
        end if;
      end if;
    end if;
  end if;
  return public.annotation_api_pre_fixed(p_action, p_task_id, p_payload);
end;
$$;

revoke all on all functions in schema annotation_private from public, anon, authenticated;
revoke all on function public.annotation_api_pre_fixed(text, text, jsonb) from public, anon, authenticated;
revoke all on function public.annotation_api(text, text, jsonb) from public, anon, authenticated;
grant execute on function public.annotation_api(text, text, jsonb) to authenticated;
