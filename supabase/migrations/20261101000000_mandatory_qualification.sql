-- Mandatory qualification workflow. The policy remains dormant until the
-- private deployment setup inserts and activates a confirmed policy row.

lock table annotation_private.participants in access exclusive mode;

create table if not exists annotation_private.qualification_policies (
  policy_version text primary key
    check (policy_version ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
  qualification_version text not null
    references annotation_private.qualification_sets(qualification_version) on delete restrict,
  fingerprint text not null check (fingerprint ~ '^[a-f0-9]{64}$'),
  pass_count integer not null check (pass_count = 14),
  scored_total integer not null check (scored_total = 18),
  key_status text not null check (key_status = 'human_confirmed_scored'),
  confirmed_scored_count integer not null check (confirmed_scored_count = 18),
  workflow_guide_md text not null check (char_length(pg_catalog.btrim(workflow_guide_md)) > 0),
  workflow_guide_sha256 text not null check (workflow_guide_sha256 ~ '^[a-f0-9]{64}$'),
  approved_at timestamptz not null default now()
);

alter table annotation_private.settings
  add column if not exists qualification_policy_version text;

do $mandatory_policy_foreign_key$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'annotation_private.settings'::regclass
      and conname = 'settings_qualification_policy_version_fkey'
  ) then
    alter table annotation_private.settings
      add constraint settings_qualification_policy_version_fkey
      foreign key (qualification_policy_version)
      references annotation_private.qualification_policies(policy_version)
      on delete restrict;
  end if;
end;
$mandatory_policy_foreign_key$;

alter table annotation_private.qualification_policies enable row level security;
revoke all on all tables in schema annotation_private from public, anon, authenticated;

-- Preserve the deployed API and helpers so the mandatory layer can delegate
-- unchanged enrollment, recovery, and task-state behavior.
do $preserve_mandatory_api$
begin
  if pg_catalog.to_regprocedure('annotation_private._annotation_api_pre_mandatory(text,text,jsonb)') is null then
    if pg_catalog.to_regprocedure('public.annotation_api(text,text,jsonb)') is null then
      raise exception 'Expected public.annotation_api(text,text,jsonb) before mandatory qualification migration.';
    end if;
    execute 'alter function public.annotation_api(text, text, jsonb) set schema annotation_private';
    execute 'alter function annotation_private.annotation_api(text, text, jsonb) rename to _annotation_api_pre_mandatory';
  end if;
end;
$preserve_mandatory_api$;

do $preserve_mandatory_helpers$
begin
  if pg_catalog.to_regprocedure('annotation_private._session_payload_pre_mandatory(text)') is null then
    if pg_catalog.to_regprocedure('annotation_private._session_payload(text)') is null then
      raise exception 'Expected annotation_private._session_payload(text) before mandatory qualification migration.';
    end if;
    execute 'alter function annotation_private._session_payload(text) rename to _session_payload_pre_mandatory';
  end if;
  if pg_catalog.to_regprocedure('annotation_private._check_access_gate_pre_mandatory(text,text)') is null then
    if pg_catalog.to_regprocedure('annotation_private._check_access_gate(text,text)') is null then
      raise exception 'Expected annotation_private._check_access_gate(text,text) before mandatory qualification migration.';
    end if;
    execute 'alter function annotation_private._check_access_gate(text, text) rename to _check_access_gate_pre_mandatory';
  end if;
  if pg_catalog.to_regprocedure('annotation_private._export_participant_pre_mandatory(text,boolean)') is null then
    if pg_catalog.to_regprocedure('annotation_private._export_participant(text,boolean)') is null then
      raise exception 'Expected annotation_private._export_participant(text,boolean) before mandatory qualification migration.';
    end if;
    execute 'alter function annotation_private._export_participant(text, boolean) rename to _export_participant_pre_mandatory';
  end if;
end;
$preserve_mandatory_helpers$;

create or replace function annotation_private._qualification_policy_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_fingerprint text;
begin
  if tg_op <> 'INSERT' then
    raise exception using errcode = 'PT409', message = 'Qualification policies are immutable.';
  end if;
  if exists (
    select 1 from annotation_private.settings
    where id = 1 and qualification_policy_version is not null
  ) then
    raise exception using errcode = 'PT409', message = 'An active qualification policy cannot be replaced.';
  end if;
  select fingerprint into v_fingerprint
  from annotation_private.qualification_sets
  where qualification_version = new.qualification_version;
  if not found or new.fingerprint is distinct from v_fingerprint then
    raise exception using errcode = 'PT503', message = 'The qualification policy does not match its confirmed materials.';
  end if;
  perform annotation_private._assert_qualification_inventory(new.qualification_version);
  if pg_catalog.encode(
       pg_catalog.sha256(pg_catalog.convert_to(new.workflow_guide_md, 'UTF8')),
       'hex'
     ) is distinct from new.workflow_guide_sha256 then
    raise exception using errcode = 'PT503', message = 'The workflow instructions failed integrity validation.';
  end if;
  return new;
end;
$$;

drop trigger if exists qualification_policy_guard on annotation_private.qualification_policies;
create trigger qualification_policy_guard
before insert or update or delete on annotation_private.qualification_policies
for each row execute function annotation_private._qualification_policy_guard();

create or replace function annotation_private._mandatory_policy_setting_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_policy annotation_private.qualification_policies%rowtype;
begin
  if old.qualification_policy_version is not null and
     new.qualification_policy_version is distinct from old.qualification_policy_version then
    raise exception using errcode = 'PT409', message = 'The active qualification policy cannot be replaced.';
  end if;
  if old.qualification_policy_version is not null and
     new.qualification_version is distinct from old.qualification_version then
    raise exception using errcode = 'PT409', message = 'The qualification materials cannot change while a policy is active.';
  end if;
  if new.qualification_policy_version is not null then
    select * into v_policy
    from annotation_private.qualification_policies
    where policy_version = new.qualification_policy_version;
    if not found or new.qualification_version is distinct from v_policy.qualification_version then
      raise exception using errcode = 'PT503', message = 'The mandatory qualification policy is not configured correctly.';
    end if;
    perform annotation_private._assert_qualification_inventory(v_policy.qualification_version);
    if pg_catalog.encode(
         pg_catalog.sha256(pg_catalog.convert_to(v_policy.workflow_guide_md, 'UTF8')),
         'hex'
       ) is distinct from v_policy.workflow_guide_sha256 then
      raise exception using errcode = 'PT503', message = 'The workflow instructions failed integrity validation.';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists mandatory_policy_setting_guard on annotation_private.settings;
create trigger mandatory_policy_setting_guard
before update of qualification_policy_version, qualification_version on annotation_private.settings
for each row execute function annotation_private._mandatory_policy_setting_guard();

create or replace function annotation_private._assert_mandatory_policy()
returns annotation_private.qualification_policies
language plpgsql
stable
set search_path = ''
as $$
declare
  v_settings annotation_private.settings%rowtype;
  v_policy annotation_private.qualification_policies%rowtype;
begin
  select * into v_settings from annotation_private.settings where id = 1;
  if not found or v_settings.qualification_policy_version is null then
    raise exception using errcode = 'PT503', message = 'The mandatory qualification policy is not currently available.';
  end if;
  select * into v_policy from annotation_private.qualification_policies
  where policy_version = v_settings.qualification_policy_version;
  if not found or v_settings.qualification_version is distinct from v_policy.qualification_version then
    raise exception using errcode = 'PT503', message = 'The mandatory qualification policy is not configured correctly.';
  end if;
  perform annotation_private._assert_qualification_inventory(v_policy.qualification_version);
  if pg_catalog.encode(
       pg_catalog.sha256(pg_catalog.convert_to(v_policy.workflow_guide_md, 'UTF8')),
       'hex'
     ) is distinct from v_policy.workflow_guide_sha256 then
    raise exception using errcode = 'PT503', message = 'The workflow instructions failed integrity validation.';
  end if;
  return v_policy;
end;
$$;

create or replace function annotation_private._current_qualification_result(
  p_participant_id text
) returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_policy annotation_private.qualification_policies%rowtype;
  v_result jsonb;
begin
  v_policy := annotation_private._assert_mandatory_policy();
  select result into v_result
  from annotation_private.qualification_results
  where participant_id = p_participant_id
    and qualification_version = v_policy.qualification_version;
  if not found then
    return null;
  end if;
  return v_result || pg_catalog.jsonb_build_object(
    'policy_version', v_policy.policy_version,
    'key_status', v_policy.key_status,
    'original_key_status', v_result -> 'key_status',
    'pass_count', v_policy.pass_count,
    'confirmed_scored_count', v_policy.confirmed_scored_count,
    'state', case
      when (v_result ->> 'matched')::integer >= v_policy.pass_count then 'passed'
      else 'failed'
    end
  );
end;
$$;

create or replace function annotation_private._adopt_mandatory_qualification(
  p_participant_id text
) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_policy annotation_private.qualification_policies%rowtype;
  v_participant annotation_private.participants%rowtype;
begin
  v_policy := annotation_private._assert_mandatory_policy();
  select * into v_participant from annotation_private.participants
  where participant_id = p_participant_id for update;
  if not found then
    raise exception using errcode = 'PT404', message = 'The requested participant was not found.';
  end if;
  if v_participant.qualification_version is null then
    update annotation_private.participants
    set qualification_version = v_policy.qualification_version
    where participant_id = p_participant_id
    returning * into v_participant;
    perform annotation_private._record_event(
      p_participant_id, null, 'qualification_started', null,
      pg_catalog.jsonb_build_object(
        'version', v_policy.qualification_version,
        'policy_version', v_policy.policy_version
      )
    );
  elsif v_participant.qualification_version is distinct from v_policy.qualification_version then
    raise exception using errcode = 'PT503', message = 'The participant qualification version does not match the active policy.';
  end if;
  perform annotation_private._ensure_qualification_assignments(p_participant_id);
end;
$$;

create or replace function annotation_private._session_payload(p_participant_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_settings annotation_private.settings%rowtype;
  v_policy annotation_private.qualification_policies%rowtype;
  v_legacy jsonb;
  v_raw_result jsonb;
  v_result jsonb;
  v_qualification jsonb;
begin
  select * into v_settings from annotation_private.settings where id = 1;
  if not found or v_settings.qualification_policy_version is null then
    return annotation_private._session_payload_pre_mandatory(p_participant_id);
  end if;
  v_policy := annotation_private._assert_mandatory_policy();
  perform annotation_private._adopt_mandatory_qualification(p_participant_id);
  v_legacy := annotation_private._session_payload_pre_mandatory(p_participant_id);
  select result into v_raw_result from annotation_private.qualification_results
  where participant_id = p_participant_id
    and qualification_version = v_policy.qualification_version;
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
    'score', case when v_result is null then null else
      pg_catalog.jsonb_build_object('matched', v_result -> 'matched', 'total', v_result -> 'total') end,
    'completed_at', v_raw_result -> 'evaluated_at'
  );
  return (v_legacy - 'qualification_available' - 'tasks' - 'progress') ||
    pg_catalog.jsonb_build_object(
      'qualification_required', true,
      'workflow_version', v_policy.policy_version,
      'workflow_guide_md', v_policy.workflow_guide_md,
      'workflow_guide_sha256', v_policy.workflow_guide_sha256,
      'tasks', coalesce(v_legacy -> 'tasks', '[]'::jsonb),
      'qualification', v_qualification,
      'progress', (coalesce(v_legacy -> 'progress', '{}'::jsonb) || pg_catalog.jsonb_build_object(
        'practice_total', 0,
        'practice_completed', 0,
        'practice_requirement', 0,
        'qualification_total', 10,
        'qualification_completed', coalesce((v_legacy -> 'qualification' ->> 'completed')::integer, 0)
      ))
    );
end;
$$;

create or replace function annotation_private._check_access_gate(
  p_participant_id text,
  p_kind text
) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_settings annotation_private.settings%rowtype;
  v_participant annotation_private.participants%rowtype;
  v_result jsonb;
begin
  select * into v_settings from annotation_private.settings where id = 1;
  if not found or v_settings.qualification_policy_version is null then
    perform annotation_private._check_access_gate_pre_mandatory(p_participant_id, p_kind);
    return;
  end if;
  select * into v_participant from annotation_private.participants
  where participant_id = p_participant_id;
  if not found then
    raise exception using errcode = 'PT404', message = 'The requested participant was not found.';
  end if;
  if v_participant.guide_ack_at is null then
    raise exception using errcode = 'PT403', message = 'Please read and acknowledge the instructions first.';
  end if;
  perform annotation_private._adopt_mandatory_qualification(p_participant_id);
  if p_kind = 'practice' then
    raise exception using errcode = 'PT403', message = 'Practice comparisons are not part of this study.';
  elsif p_kind = 'qualification' then
    return;
  elsif p_kind = 'study' then
    perform annotation_private._evaluate_qualification(p_participant_id);
    v_result := annotation_private._current_qualification_result(p_participant_id);
    if v_result is null or v_result ->> 'state' is distinct from 'passed' then
      raise exception using errcode = 'PT403', message = 'Complete and pass the qualification before starting the study.';
    end if;
  else
    raise exception using errcode = 'PT404', message = 'This comparison is not available in your assignment.';
  end if;
end;
$$;

create or replace function annotation_private._export_participant(
  p_participant_id text,
  p_include_mapping boolean
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_settings annotation_private.settings%rowtype;
  v_policy annotation_private.qualification_policies%rowtype;
  v_legacy jsonb;
  v_raw_result jsonb;
begin
  v_legacy := annotation_private._export_participant_pre_mandatory(p_participant_id, p_include_mapping);
  select * into v_settings from annotation_private.settings where id = 1;
  if not found or v_settings.qualification_policy_version is null then
    return v_legacy;
  end if;
  v_policy := annotation_private._assert_mandatory_policy();
  select result into v_raw_result from annotation_private.qualification_results
  where participant_id = p_participant_id
    and qualification_version = v_policy.qualification_version;
  return (v_legacy - 'qualification_result') || pg_catalog.jsonb_build_object(
    'qualification_result', annotation_private._current_qualification_result(p_participant_id),
    'qualification_original_result', v_raw_result,
    'qualification_policy', pg_catalog.jsonb_build_object(
      'policy_version', v_policy.policy_version,
      'qualification_version', v_policy.qualification_version,
      'fingerprint', v_policy.fingerprint,
      'key_status', v_policy.key_status,
      'pass_count', v_policy.pass_count,
      'scored_total', v_policy.scored_total,
      'confirmed_scored_count', v_policy.confirmed_scored_count,
      'workflow_guide_sha256', v_policy.workflow_guide_sha256,
      'approved_at', v_policy.approved_at
    )
  );
end;
$$;

create or replace function public.annotation_api(
  p_action text,
  p_task_id text default null,
  p_payload jsonb default '{}'::jsonb
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_anonymous boolean;
  v_participant annotation_private.participants%rowtype;
  v_settings annotation_private.settings%rowtype;
  v_policy annotation_private.qualification_policies%rowtype;
  v_response jsonb;
begin
  v_user_id := auth.uid();
  if v_user_id is null then
    raise exception using errcode = 'PT401', message = 'Sign in to continue.';
  end if;
  select is_anonymous into v_anonymous from auth.users where id = v_user_id;
  if not found or v_anonymous is distinct from true then
    raise exception using errcode = 'PT401', message = 'Use an anonymous participant session to continue.';
  end if;
  if p_action is null or p_action not in (
    'session', 'enroll', 'recover', 'rotate_recovery', 'acknowledge',
    'task', 'save', 'lock', 'reference', 'complete', 'problem', 'export',
    'start_qualification', 'qualification_results'
  ) then
    raise exception using errcode = 'PT400', message = 'The requested action is invalid.';
  end if;
  if pg_catalog.jsonb_typeof(p_payload) is distinct from 'object' then
    raise exception using errcode = 'PT400', message = 'The request payload is invalid.';
  end if;
  if p_action in (
    'session', 'enroll', 'recover', 'rotate_recovery', 'acknowledge', 'export',
    'start_qualification', 'qualification_results'
  ) and p_task_id is not null then
    raise exception using errcode = 'PT400', message = 'This action does not accept a task identifier.';
  elsif p_action not in (
    'session', 'enroll', 'recover', 'rotate_recovery', 'acknowledge', 'export',
    'start_qualification', 'qualification_results'
  ) and (p_task_id is null or p_task_id = '') then
    raise exception using errcode = 'PT400', message = 'A task identifier is required.';
  end if;

  select * into v_settings from annotation_private.settings where id = 1;
  if p_action in ('start_qualification', 'qualification_results') and
     v_settings.qualification_policy_version is not null then
    if p_task_id is not null then
      raise exception using errcode = 'PT400', message = 'This action does not accept a task identifier.';
    end if;
    if pg_catalog.jsonb_typeof(p_payload) is distinct from 'object' or p_payload <> '{}'::jsonb then
      raise exception using errcode = 'PT400', message = 'The request payload is invalid.';
    end if;
    v_policy := annotation_private._assert_mandatory_policy();
    select * into v_participant from annotation_private.participants
    where auth_user_id = v_user_id for update;
    if not found then
      raise exception using errcode = 'PT401', message = 'This participant account is not registered.';
    end if;
    if v_participant.guide_ack_at is null then
      raise exception using errcode = 'PT403', message = 'Please read and acknowledge the instructions first.';
    end if;
    perform annotation_private._adopt_mandatory_qualification(v_participant.participant_id);
    if p_action = 'start_qualification' then
      return annotation_private._session_payload(v_participant.participant_id);
    end if;
    perform annotation_private._evaluate_qualification(v_participant.participant_id);
    v_response := annotation_private._current_qualification_result(v_participant.participant_id);
    if v_response is null then
      raise exception using errcode = 'PT403', message = 'Complete all ten qualification comparisons before requesting results.';
    end if;
    return v_response;
  end if;

  -- Existing participants are enrolled before any API action, including
  -- acknowledgement/export. Session and recovery also auto-adopt through the
  -- replacement session helper after the legacy dispatcher creates the link.
  select * into v_participant from annotation_private.participants
  where auth_user_id = v_user_id for update;
  if found and v_settings.qualification_policy_version is not null then
    perform annotation_private._adopt_mandatory_qualification(v_participant.participant_id);
  end if;

  return annotation_private._annotation_api_pre_mandatory(p_action, p_task_id, p_payload);
end;
$$;

revoke all on all functions in schema annotation_private from public, anon, authenticated;
revoke all on function public.annotation_api(text, text, jsonb) from public, anon, authenticated;
grant execute on function public.annotation_api(text, text, jsonb) to authenticated;
