-- Private, open-participation backend for the local human-preference study.
-- The coordinator's private import inserts settings and the three balanced
-- template schemes. This migration never contains real study material.

create schema if not exists annotation_private;
revoke all on schema annotation_private from public, anon, authenticated;

-- Do not silently reuse the unpublished fixed-participant prototype. If a
-- project already contains its incompatible tables, stop without dropping or
-- rewriting volunteer state; a coordinator must provision a clean project.
do $migration_preflight$
declare
  v_rel regclass;
  v_column text;
begin
  v_rel := pg_catalog.to_regclass('annotation_private.settings');
  if v_rel is not null then
    foreach v_column in array array['schema_version', 'next_scheme', 'enrollment_open'] loop
      if not exists (
        select 1 from pg_catalog.pg_attribute a
        where a.attrelid = v_rel and a.attname = v_column
          and a.attnum > 0 and not a.attisdropped
      ) then
        raise exception 'Incompatible annotation_private.settings prototype; use a clean Supabase project.';
      end if;
    end loop;
  end if;
  v_rel := pg_catalog.to_regclass('annotation_private.templates');
  if v_rel is not null then
    foreach v_column in array array['template_id', 'scheme', 'kind', 'position', 'payload', 'hashes', 'coordinator'] loop
      if not exists (
        select 1 from pg_catalog.pg_attribute a
        where a.attrelid = v_rel and a.attname = v_column
          and a.attnum > 0 and not a.attisdropped
      ) then
        raise exception 'Incompatible annotation_private.templates prototype; use a clean Supabase project.';
      end if;
    end loop;
  end if;
  v_rel := pg_catalog.to_regclass('annotation_private.participants');
  if v_rel is not null then
    foreach v_column in array array['participant_id', 'auth_user_id', 'display_name', 'recovery_hash', 'scheme', 'guide_ack_at'] loop
      if not exists (
        select 1 from pg_catalog.pg_attribute a
        where a.attrelid = v_rel and a.attname = v_column
          and a.attnum > 0 and not a.attisdropped
      ) then
        raise exception 'Incompatible annotation_private.participants prototype; use a clean Supabase project.';
      end if;
    end loop;
  end if;
  v_rel := pg_catalog.to_regclass('annotation_private.assignments');
  if v_rel is not null then
    foreach v_column in array array['task_id', 'participant_id', 'template_id', 'kind', 'position', 'stage', 'status', 'revision', 'stage1_answers', 'stage2_answers', 'locked_at', 'reference_released_at', 'completed_at', 'paused_from_status', 'updated_at'] loop
      if not exists (
        select 1 from pg_catalog.pg_attribute a
        where a.attrelid = v_rel and a.attname = v_column
          and a.attnum > 0 and not a.attisdropped
      ) then
        raise exception 'Incompatible annotation_private.assignments prototype; use a clean Supabase project.';
      end if;
    end loop;
  end if;
end;
$migration_preflight$;

create table if not exists annotation_private.settings (
  id integer primary key check (id = 1),
  schema_version text not null default 'open-participation-v1',
  study_fingerprint text not null,
  instruction_fingerprint text not null,
  rubric_version text not null,
  rubric jsonb not null check (jsonb_typeof(rubric) = 'object'),
  guide_md text not null,
  next_scheme bigint not null default 0 check (next_scheme >= 0),
  enrollment_open boolean not null default true
);

create table if not exists annotation_private.templates (
  template_id text primary key,
  scheme smallint not null check (scheme between 1 and 3),
  kind text not null check (kind in ('practice', 'study')),
  position integer not null check (position > 0),
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  hashes jsonb not null check (jsonb_typeof(hashes) = 'object'),
  coordinator jsonb check (coordinator is null or jsonb_typeof(coordinator) in ('object', 'null')),
  unique (scheme, kind, position)
);

create table if not exists annotation_private.participants (
  participant_id text primary key,
  auth_user_id uuid unique references auth.users(id) on delete set null,
  display_name text not null check (char_length(display_name) between 1 and 40),
  recovery_hash bytea not null unique check (octet_length(recovery_hash) = 32),
  scheme smallint not null check (scheme between 1 and 3),
  guide_ack_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists annotation_private.assignments (
  task_id text primary key,
  participant_id text not null references annotation_private.participants(participant_id),
  template_id text not null references annotation_private.templates(template_id),
  kind text not null check (kind in ('practice', 'study')),
  position integer not null check (position > 0),
  stage integer not null default 1 check (stage in (1, 2)),
  status text not null default 'draft' check (status in ('draft', 'locked', 'complete', 'paused')),
  revision integer not null default 0 check (revision >= 0),
  stage1_answers jsonb not null default '{}'::jsonb check (jsonb_typeof(stage1_answers) = 'object'),
  stage2_answers jsonb not null default '{}'::jsonb check (jsonb_typeof(stage2_answers) = 'object'),
  locked_at timestamptz,
  reference_released_at timestamptz,
  completed_at timestamptz,
  paused_from_status text check (paused_from_status is null or paused_from_status in ('draft', 'locked')),
  updated_at timestamptz not null default now(),
  unique (participant_id, kind, position)
);

create table if not exists annotation_private.events (
  event_id bigint generated always as identity primary key,
  participant_id text not null references annotation_private.participants(participant_id),
  task_id text references annotation_private.assignments(task_id),
  event_type text not null,
  revision integer,
  payload jsonb not null default '{}'::jsonb check (jsonb_typeof(payload) = 'object'),
  created_at timestamptz not null default now()
);

create index if not exists annotation_assignments_participant_order
  on annotation_private.assignments (participant_id, kind, position);
create index if not exists annotation_events_participant_task
  on annotation_private.events (participant_id, task_id, event_id);

alter table annotation_private.settings enable row level security;
alter table annotation_private.templates enable row level security;
alter table annotation_private.participants enable row level security;
alter table annotation_private.assignments enable row level security;
alter table annotation_private.events enable row level security;

revoke all on all tables in schema annotation_private from public, anon, authenticated;
revoke all on all sequences in schema annotation_private from public, anon, authenticated;
revoke all on all functions in schema annotation_private from public, anon, authenticated;
alter default privileges in schema annotation_private revoke all on tables from public, anon, authenticated;
alter default privileges in schema annotation_private revoke all on sequences from public, anon, authenticated;
alter default privileges in schema annotation_private revoke all on functions from public, anon, authenticated;

create or replace function annotation_private._assert_payload_fields(
  p_payload jsonb,
  p_fields text[]
) returns void
language plpgsql
set search_path = ''
as $$
declare
  v_key text;
begin
  if pg_catalog.jsonb_typeof(p_payload) is distinct from 'object' then
    raise exception using errcode = 'PT400', message = 'The request payload is invalid.';
  end if;
  for v_key in select pg_catalog.jsonb_object_keys(p_payload) loop
    if not (v_key = any (p_fields)) then
      raise exception using errcode = 'PT400', message = 'The request contains an unexpected field.';
    end if;
  end loop;
  foreach v_key in array p_fields loop
    if not (p_payload ? v_key) then
      raise exception using errcode = 'PT400', message = 'The request is missing a required field.';
    end if;
  end loop;
end;
$$;

create or replace function annotation_private._integer_field(
  p_payload jsonb,
  p_field text,
  p_min integer,
  p_max integer
) returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_text text;
  v_numeric numeric;
begin
  if pg_catalog.jsonb_typeof(p_payload -> p_field) is distinct from 'number' then
    raise exception using errcode = 'PT400', message = 'A numeric request field is invalid.';
  end if;
  v_text := p_payload ->> p_field;
  if v_text !~ '^(0|[1-9][0-9]*)$' then
    raise exception using errcode = 'PT400', message = 'A numeric request field is invalid.';
  end if;
  v_numeric := v_text::numeric;
  if v_numeric < p_min or v_numeric > p_max then
    raise exception using errcode = 'PT400', message = 'A numeric request field is out of range.';
  end if;
  return v_numeric::integer;
end;
$$;

create or replace function annotation_private._normalize_recovery_code(p_value jsonb)
returns bytea
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_code text;
begin
  if pg_catalog.jsonb_typeof(p_value) is distinct from 'string' then
    raise exception using errcode = 'PT400', message = 'The recovery code is invalid.';
  end if;
  v_code := pg_catalog.upper(pg_catalog.regexp_replace(p_value #>> '{}', '^[[:space:]]+|[[:space:]]+$', '', 'g'));
  if v_code !~ '^SAL-[A-F0-9]{64}$' then
    raise exception using errcode = 'PT400', message = 'The recovery code is invalid.';
  end if;
  return pg_catalog.sha256(pg_catalog.convert_to(v_code, 'UTF8'));
end;
$$;

create or replace function annotation_private._normalize_display_name(p_value jsonb)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_name text;
begin
  if pg_catalog.jsonb_typeof(p_value) is distinct from 'string' then
    raise exception using errcode = 'PT400', message = 'Enter a nickname between 1 and 40 characters.';
  end if;
  v_name := pg_catalog.regexp_replace(p_value #>> '{}', '^[[:space:]]+|[[:space:]]+$', '', 'g');
  if pg_catalog.char_length(v_name) < 1 or pg_catalog.char_length(v_name) > 40 or v_name ~ '[[:cntrl:]]' then
    raise exception using errcode = 'PT400', message = 'Enter a nickname between 1 and 40 characters without control characters.';
  end if;
  return v_name;
end;
$$;

create or replace function annotation_private._check_revision(
  p_payload jsonb,
  p_current integer
) returns void
language plpgsql
set search_path = ''
as $$
declare
  v_revision integer;
begin
  v_revision := annotation_private._integer_field(p_payload, 'revision', 0, 2147483647);
  if v_revision <> p_current then
    raise exception using errcode = 'PT409', message = 'This comparison changed in another tab. Reload it before continuing.';
  end if;
end;
$$;

create or replace function annotation_private._validate_answers(
  p_answers jsonb,
  p_allowed text[],
  p_exact boolean
) returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_key text;
  v_value jsonb;
begin
  if pg_catalog.jsonb_typeof(p_answers) is distinct from 'object' or p_answers = '{}'::jsonb then
    raise exception using errcode = 'PT400', message = 'Select a preference before saving.';
  end if;
  for v_key, v_value in select key, value from pg_catalog.jsonb_each(p_answers) loop
    if not (v_key = any (p_allowed)) or pg_catalog.jsonb_typeof(v_value) is distinct from 'string' or
       (v_value #>> '{}') not in ('A', 'B', 'Tie') then
      raise exception using errcode = 'PT400', message = 'One or more selected preferences are invalid.';
    end if;
  end loop;
  if p_exact then
    foreach v_key in array p_allowed loop
      if not (p_answers ? v_key) then
        raise exception using errcode = 'PT400', message = 'Please select every required preference before submitting.';
      end if;
    end loop;
    if (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(p_answers)) <> pg_catalog.cardinality(p_allowed) then
      raise exception using errcode = 'PT400', message = 'The submitted preferences are invalid.';
    end if;
  end if;
  return p_answers;
end;
$$;

create or replace function annotation_private._validate_problem_criteria(p_criteria jsonb)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_item jsonb;
  v_criterion text;
  v_seen text[] := array[]::text[];
begin
  if pg_catalog.jsonb_typeof(p_criteria) is distinct from 'array' or pg_catalog.jsonb_array_length(p_criteria) = 0 then
    raise exception using errcode = 'PT400', message = 'Select at least one affected criterion.';
  end if;
  for v_item in select value from pg_catalog.jsonb_array_elements(p_criteria) as items(value) loop
    if pg_catalog.jsonb_typeof(v_item) is distinct from 'string' then
      raise exception using errcode = 'PT400', message = 'One or more affected criteria are invalid.';
    end if;
    v_criterion := v_item #>> '{}';
    if v_criterion not in ('source_coverage', 'readability', 'faithfulness', 'content_focus', 'reference_coverage') or
       v_criterion = any (v_seen) then
      raise exception using errcode = 'PT400', message = 'One or more affected criteria are invalid.';
    end if;
    v_seen := pg_catalog.array_append(v_seen, v_criterion);
  end loop;
  return p_criteria;
end;
$$;

create or replace function annotation_private._assert_settings(p_settings annotation_private.settings)
returns void
language plpgsql
set search_path = ''
as $$
begin
  if p_settings.id is null or p_settings.schema_version is distinct from 'open-participation-v1' then
    raise exception using errcode = 'PT503', message = 'The annotation study is not configured for enrollment.';
  end if;
end;
$$;

create or replace function annotation_private._assert_template_inventory()
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_scheme integer;
  v_practice integer;
  v_study integer;
  v_practice_min integer;
  v_practice_max integer;
  v_study_min integer;
  v_study_max integer;
begin
  for v_scheme in 1..3 loop
    select
      pg_catalog.count(*) filter (where kind = 'practice'),
      pg_catalog.count(*) filter (where kind = 'study'),
      pg_catalog.min(position) filter (where kind = 'practice'),
      pg_catalog.max(position) filter (where kind = 'practice'),
      pg_catalog.min(position) filter (where kind = 'study'),
      pg_catalog.max(position) filter (where kind = 'study')
      into v_practice, v_study, v_practice_min, v_practice_max, v_study_min, v_study_max
    from annotation_private.templates where scheme = v_scheme;
    if v_practice is distinct from 8 or v_study is distinct from 126 or
       v_practice_min is distinct from 1 or v_practice_max is distinct from 8 or
       v_study_min is distinct from 1 or v_study_max is distinct from 126 then
      raise exception using errcode = 'PT503', message = 'The annotation materials are incomplete; enrollment is temporarily unavailable.';
    end if;
  end loop;
  if exists (
    select 1 from annotation_private.templates t
    where pg_catalog.jsonb_typeof(t.payload -> 'request') is distinct from 'string'
       or pg_catalog.jsonb_typeof(t.payload -> 'source') is distinct from 'string'
       or pg_catalog.jsonb_typeof(t.payload -> 'summary_a') is distinct from 'string'
       or pg_catalog.jsonb_typeof(t.payload -> 'summary_b') is distinct from 'string'
       or pg_catalog.jsonb_typeof(t.payload -> 'reference') is distinct from 'string'
       or pg_catalog.jsonb_typeof(t.hashes -> 'request_sha256') is distinct from 'string'
       or pg_catalog.jsonb_typeof(t.hashes -> 'source_sha256') is distinct from 'string'
       or pg_catalog.jsonb_typeof(t.hashes -> 'summary_a_sha256') is distinct from 'string'
       or pg_catalog.jsonb_typeof(t.hashes -> 'summary_b_sha256') is distinct from 'string'
       or pg_catalog.jsonb_typeof(t.hashes -> 'reference_sha256') is distinct from 'string'
       or (t.hashes ->> 'request_sha256') !~ '^[a-f0-9]{64}$'
       or (t.hashes ->> 'source_sha256') !~ '^[a-f0-9]{64}$'
       or (t.hashes ->> 'summary_a_sha256') !~ '^[a-f0-9]{64}$'
       or (t.hashes ->> 'summary_b_sha256') !~ '^[a-f0-9]{64}$'
       or (t.hashes ->> 'reference_sha256') !~ '^[a-f0-9]{64}$'
  ) then
    raise exception using errcode = 'PT503', message = 'The annotation materials are invalid; enrollment is temporarily unavailable.';
  end if;
end;
$$;

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
  if p_kind = 'study' then
    select pg_catalog.count(*), pg_catalog.count(*) filter (where status = 'complete')
      into v_practice_total, v_practice_complete
    from annotation_private.assignments
    where participant_id = p_participant_id and kind = 'practice';
    if v_practice_total <> 8 or v_practice_complete <> 8 then
      raise exception using errcode = 'PT403', message = 'Complete the practice comparisons before starting the study.';
    end if;
  end if;
end;
$$;

create or replace function annotation_private._record_event(
  p_participant_id text,
  p_task_id text,
  p_event_type text,
  p_revision integer,
  p_payload jsonb
) returns void
language sql
set search_path = ''
as $$
  insert into annotation_private.events (participant_id, task_id, event_type, revision, payload)
  values (p_participant_id, p_task_id, p_event_type, p_revision, coalesce(p_payload, '{}'::jsonb));
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
  where participant_id = p_row.participant_id and kind = p_row.kind;
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
  select * into v_participant from annotation_private.participants where participant_id = p_participant_id;
  select * into v_settings from annotation_private.settings where id = 1;
  if not found or v_settings.id is null then
    raise exception using errcode = 'PT503', message = 'The annotation study is not currently available.';
  end if;
  perform annotation_private._assert_settings(v_settings);
  select
    pg_catalog.count(*) filter (where kind = 'study'),
    pg_catalog.count(*) filter (where kind = 'study' and status = 'complete'),
    pg_catalog.count(*) filter (where kind = 'practice'),
    pg_catalog.count(*) filter (where kind = 'practice' and status = 'complete'),
    pg_catalog.count(*) filter (where status = 'paused')
    into v_study_total, v_study_complete, v_practice_total, v_practice_complete, v_paused
  from annotation_private.assignments where participant_id = p_participant_id;
  select coalesce(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'id', task_id, 'kind', kind, 'position', position, 'status', status, 'stage', stage
      ) order by case kind when 'practice' then 0 else 1 end, position
    ), '[]'::jsonb
  ) into v_tasks
  from annotation_private.assignments where participant_id = p_participant_id;
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
      'paused', coalesce(v_paused, 0)
    ),
    'rubric', v_settings.rubric,
    'guide_md', v_settings.guide_md
  );
end;
$$;

create or replace function annotation_private._events_json(
  p_participant_id text,
  p_task_id text,
  p_problems_only boolean default false
) returns jsonb
language sql
stable
set search_path = ''
as $$
  select coalesce(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'event', e.event_type,
        'revision', e.revision,
        'data', e.payload,
        'timestamp', e.created_at
      ) order by e.event_id
    ), '[]'::jsonb
  )
  from annotation_private.events as e
  where e.participant_id = p_participant_id
    and e.task_id = p_task_id
    and (not p_problems_only or e.event_type = 'problem_reported');
$$;

create or replace function annotation_private._participant_events_json(p_participant_id text)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select coalesce(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'event', e.event_type,
        'task_id', e.task_id,
        'revision', e.revision,
        'data', e.payload,
        'timestamp', e.created_at
      ) order by e.event_id
    ), '[]'::jsonb
  )
  from annotation_private.events as e
  where e.participant_id = p_participant_id;
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

create or replace function annotation_private._export_participant(
  p_participant_id text,
  p_include_mapping boolean
) returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_settings annotation_private.settings%rowtype;
  v_participant annotation_private.participants%rowtype;
begin
  select * into v_settings from annotation_private.settings where id = 1;
  if not found then
    raise exception using errcode = 'PT503', message = 'The annotation study is not currently available.';
  end if;
  perform annotation_private._assert_settings(v_settings);
  select * into v_participant from annotation_private.participants where participant_id = p_participant_id;
  if not found then
    raise exception using errcode = 'PT404', message = 'The requested participant was not found.';
  end if;
  return pg_catalog.jsonb_build_object(
    'schema_version', v_settings.schema_version,
    'rubric_version', v_settings.rubric_version,
    'study_fingerprint', v_settings.study_fingerprint,
    'instruction_fingerprint', v_settings.instruction_fingerprint,
    'mode', 'study',
    'participant_id', p_participant_id,
    'display_name', v_participant.display_name,
    'instructions_acknowledged_at', v_participant.guide_ack_at,
    'exported_at', pg_catalog.clock_timestamp(),
    'events', annotation_private._participant_events_json(p_participant_id),
    'study_assignments', annotation_private._export_assignments(p_participant_id, 'study', p_include_mapping),
    'practice_assignments', annotation_private._export_assignments(p_participant_id, 'practice', p_include_mapping)
  );
end;
$$;

create or replace function annotation_private.resolve_problem(
  p_participant_id text,
  p_task_id text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row annotation_private.assignments%rowtype;
  v_now timestamptz := pg_catalog.clock_timestamp();
begin
  select * into v_row from annotation_private.assignments
  where participant_id = p_participant_id and task_id = p_task_id
  for update;
  if not found then
    raise exception using errcode = 'PT404', message = 'The requested assignment was not found.';
  end if;
  if v_row.status <> 'paused' then
    raise exception using errcode = 'PT409', message = 'This comparison is not paused.';
  end if;
  if v_row.paused_from_status is null or v_row.paused_from_status not in ('draft', 'locked') then
    raise exception using errcode = 'PT409', message = 'This comparison cannot be resumed from its current state.';
  end if;
  update annotation_private.assignments
     set status = v_row.paused_from_status,
         paused_from_status = null,
         revision = v_row.revision + 1,
         updated_at = v_now
   where task_id = p_task_id
   returning * into v_row;
  perform annotation_private._record_event(
    p_participant_id, p_task_id, 'problem_resolved', v_row.revision,
    pg_catalog.jsonb_build_object('restored_status', v_row.status)
  );
  return pg_catalog.jsonb_build_object(
    'ok', true,
    'id', v_row.task_id,
    'status', v_row.status,
    'revision', v_row.revision
  );
end;
$$;

create or replace function annotation_private.export_all() returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_settings annotation_private.settings%rowtype;
  v_participants jsonb;
begin
  select * into v_settings from annotation_private.settings where id = 1;
  if not found then
    raise exception using errcode = 'PT503', message = 'The annotation study is not currently available.';
  end if;
  perform annotation_private._assert_settings(v_settings);
  select coalesce(
    pg_catalog.jsonb_object_agg(
      p.participant_id,
      annotation_private._export_participant(p.participant_id, true)
      order by p.participant_id
    ), '{}'::jsonb
  ) into v_participants
  from annotation_private.participants as p;
  return pg_catalog.jsonb_build_object(
    'schema_version', v_settings.schema_version,
    'rubric_version', v_settings.rubric_version,
    'study_fingerprint', v_settings.study_fingerprint,
    'instruction_fingerprint', v_settings.instruction_fingerprint,
    'mode', 'study',
    'exported_at', pg_catalog.clock_timestamp(),
    'participants', v_participants
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
  v_locked_user_id uuid;
  v_is_anonymous boolean;
  v_participant_id text;
  v_participant annotation_private.participants%rowtype;
  v_settings annotation_private.settings%rowtype;
  v_row annotation_private.assignments%rowtype;
  v_updated annotation_private.assignments%rowtype;
  v_template annotation_private.templates%rowtype;
  v_answers jsonb;
  v_criteria jsonb;
  v_category text;
  v_name text;
  v_code_hash bytea;
  v_new_hash bytea;
  v_scheme smallint;
  v_stage integer;
  v_now timestamptz;
  v_reference_released_at timestamptz;
begin
  v_user_id := auth.uid();
  if v_user_id is null then
    raise exception using errcode = 'PT401', message = 'Sign in to continue.';
  end if;
  select u.is_anonymous into v_is_anonymous
  from auth.users as u
  where u.id = v_user_id;
  if not found or v_is_anonymous is distinct from true then
    raise exception using errcode = 'PT401', message = 'Use an anonymous participant session to continue.';
  end if;
  if p_action is null or p_action not in (
    'session', 'enroll', 'recover', 'rotate_recovery', 'acknowledge',
    'task', 'save', 'lock', 'reference', 'complete', 'problem', 'export'
  ) then
    raise exception using errcode = 'PT400', message = 'The requested action is invalid.';
  end if;
  if pg_catalog.jsonb_typeof(p_payload) is distinct from 'object' then
    raise exception using errcode = 'PT400', message = 'The request payload is invalid.';
  end if;

  if p_action in ('session', 'enroll', 'recover', 'rotate_recovery', 'acknowledge', 'export') then
    if p_task_id is not null then
      raise exception using errcode = 'PT400', message = 'This action does not accept a task identifier.';
    end if;
  elsif p_task_id is null or p_task_id = '' then
    raise exception using errcode = 'PT400', message = 'A task identifier is required.';
  end if;

  if p_action = 'session' then
    perform annotation_private._assert_payload_fields(p_payload, array[]::text[]);
    select * into v_participant
    from annotation_private.participants
    where auth_user_id = v_user_id
    for update;
    if not found then
      return pg_catalog.jsonb_build_object('authenticated', true, 'enrolled', false, 'needs_enrollment', true);
    end if;
    return annotation_private._session_payload(v_participant.participant_id);
  elsif p_action = 'enroll' then
    perform annotation_private._assert_payload_fields(p_payload, array['display_name', 'recovery_code']::text[]);
    v_name := annotation_private._normalize_display_name(p_payload -> 'display_name');
    v_new_hash := annotation_private._normalize_recovery_code(p_payload -> 'recovery_code');
    select u.id, u.is_anonymous into v_locked_user_id, v_is_anonymous
    from auth.users as u where u.id = v_user_id for update;
    if not found or v_is_anonymous is distinct from true then
      raise exception using errcode = 'PT401', message = 'Use an anonymous participant session to continue.';
    end if;
    select * into v_participant
    from annotation_private.participants
    where auth_user_id = v_user_id
    for update;
    if found then
      if v_participant.display_name = v_name and v_participant.recovery_hash = v_new_hash then
        return annotation_private._session_payload(v_participant.participant_id);
      end if;
      raise exception using errcode = 'PT409', message = 'This account is already linked to an annotation record.';
    end if;
    select * into v_settings from annotation_private.settings where id = 1 for update;
    if not found then
      raise exception using errcode = 'PT503', message = 'The annotation study is not currently available.';
    end if;
    perform annotation_private._assert_settings(v_settings);
    if not v_settings.enrollment_open then
      raise exception using errcode = 'PT503', message = 'Enrollment is temporarily closed.';
    end if;
    perform annotation_private._assert_template_inventory();
    if exists (select 1 from annotation_private.participants where recovery_hash = v_new_hash) then
      raise exception using errcode = 'PT409', message = 'The recovery code cannot be used. Generate a new code and try again.';
    end if;
    v_scheme := (mod(v_settings.next_scheme, 3) + 1)::smallint;
    v_participant_id := 'participant_' || pg_catalog.gen_random_uuid()::text;
    begin
      update annotation_private.settings set next_scheme = next_scheme + 1 where id = 1;
      insert into annotation_private.participants (
        participant_id, auth_user_id, display_name, recovery_hash, scheme
      ) values (v_participant_id, v_user_id, v_name, v_new_hash, v_scheme)
      returning * into v_participant;
      with digested as (
        select
          t.template_id,
          t.kind,
          pg_catalog.sha256(pg_catalog.convert_to(v_participant_id || '|' || t.template_id, 'UTF8')) as order_key
        from annotation_private.templates t
        where t.scheme = v_scheme
      ), numbered as (
        select
          template_id,
          kind,
          order_key,
          pg_catalog.row_number() over (partition by kind order by order_key, template_id)::integer as assigned_position
        from digested
      )
      insert into annotation_private.assignments (task_id, participant_id, template_id, kind, position)
      select
        'task_' || pg_catalog.encode(order_key, 'hex'),
        v_participant_id,
        template_id,
        kind,
        assigned_position
      from numbered;
      perform annotation_private._record_event(v_participant_id, null, 'participant_enrolled', null, '{}'::jsonb);
    exception when unique_violation then
      raise exception using errcode = 'PT409', message = 'This account or recovery code is already in use.';
    end;
    return annotation_private._session_payload(v_participant_id);
  elsif p_action = 'recover' then
    perform annotation_private._assert_payload_fields(p_payload, array['recovery_code', 'new_recovery_code']::text[]);
    v_code_hash := annotation_private._normalize_recovery_code(p_payload -> 'recovery_code');
    v_new_hash := annotation_private._normalize_recovery_code(p_payload -> 'new_recovery_code');
    select u.id, u.is_anonymous into v_locked_user_id, v_is_anonymous
    from auth.users as u where u.id = v_user_id for update;
    if not found or v_is_anonymous is distinct from true then
      raise exception using errcode = 'PT401', message = 'Use an anonymous participant session to continue.';
    end if;
    select * into v_participant
    from annotation_private.participants
    where auth_user_id = v_user_id
    for update;
    if found then
      if v_participant.recovery_hash = v_new_hash then
        return annotation_private._session_payload(v_participant.participant_id);
      end if;
      raise exception using errcode = 'PT409', message = 'This account is already linked to a different annotation record.';
    end if;
    select * into v_settings from annotation_private.settings where id = 1;
    if not found then
      raise exception using errcode = 'PT503', message = 'The annotation study is not currently available.';
    end if;
    perform annotation_private._assert_settings(v_settings);
    if v_code_hash = v_new_hash then
      raise exception using errcode = 'PT400', message = 'The replacement recovery code must be different.';
    end if;
    select * into v_participant
    from annotation_private.participants
    where recovery_hash = v_code_hash
    for update;
    if not found then
      raise exception using errcode = 'PT400', message = 'The recovery code is invalid or unavailable.';
    end if;
    if exists (
      select 1 from annotation_private.participants
      where recovery_hash = v_new_hash and participant_id <> v_participant.participant_id
    ) then
      raise exception using errcode = 'PT409', message = 'The replacement recovery code cannot be used.';
    end if;
    begin
      update annotation_private.participants
      set recovery_hash = v_new_hash, auth_user_id = v_user_id
      where participant_id = v_participant.participant_id
      returning * into v_participant;
      perform annotation_private._record_event(v_participant.participant_id, null, 'identity_recovered', null, '{}'::jsonb);
    exception when unique_violation then
      raise exception using errcode = 'PT409', message = 'This recovery cannot be completed. Sign in with the intended account and try again.';
    end;
    return annotation_private._session_payload(v_participant.participant_id);
  end if;

  if p_action = 'acknowledge' then
    perform annotation_private._assert_payload_fields(p_payload, array['accepted']::text[]);
  elsif p_action = 'export' then
    perform annotation_private._assert_payload_fields(p_payload, array[]::text[]);
  elsif p_action = 'rotate_recovery' then
    perform annotation_private._assert_payload_fields(p_payload, array['new_recovery_code']::text[]);
    v_new_hash := annotation_private._normalize_recovery_code(p_payload -> 'new_recovery_code');
  end if;

  select * into v_participant
  from annotation_private.participants
  where auth_user_id = v_user_id
  for update;
  if not found then
    raise exception using errcode = 'PT401', message = 'This participant account is not registered.';
  end if;
  v_participant_id := v_participant.participant_id;
  select * into v_settings from annotation_private.settings where id = 1;
  if not found then
    raise exception using errcode = 'PT503', message = 'The annotation study is not currently available.';
  end if;
  perform annotation_private._assert_settings(v_settings);

  if p_action = 'rotate_recovery' then
    if v_participant.recovery_hash = v_new_hash then
      return annotation_private._session_payload(v_participant_id);
    end if;
    if exists (
      select 1 from annotation_private.participants
      where recovery_hash = v_new_hash and participant_id <> v_participant_id
    ) then
      raise exception using errcode = 'PT409', message = 'The replacement recovery code cannot be used.';
    end if;
    begin
      update annotation_private.participants set recovery_hash = v_new_hash
      where participant_id = v_participant_id returning * into v_participant;
      perform annotation_private._record_event(v_participant_id, null, 'recovery_code_rotated', null, '{}'::jsonb);
    exception when unique_violation then
      raise exception using errcode = 'PT409', message = 'The replacement recovery code cannot be used.';
    end;
    return annotation_private._session_payload(v_participant_id);
  elsif p_action = 'session' then
    return annotation_private._session_payload(v_participant_id);
  elsif p_action = 'acknowledge' then
    if pg_catalog.jsonb_typeof(p_payload -> 'accepted') is distinct from 'boolean' or p_payload -> 'accepted' <> 'true'::jsonb then
      raise exception using errcode = 'PT400', message = 'Please confirm that you have read the instructions.';
    end if;
    if v_participant.guide_ack_at is null then
      v_now := pg_catalog.clock_timestamp();
      update annotation_private.participants set guide_ack_at = v_now
      where participant_id = v_participant_id returning * into v_participant;
      perform annotation_private._record_event(v_participant_id, null, 'guide_acknowledged', null, '{}'::jsonb);
    end if;
    return pg_catalog.jsonb_build_object('ok', true);
  elsif p_action = 'export' then
    return annotation_private._export_participant(v_participant_id, false);
  end if;

  select * into v_row
  from annotation_private.assignments as a
  where a.task_id = p_task_id and a.participant_id = v_participant_id
  for update;
  if not found then
    raise exception using errcode = 'PT404', message = 'This comparison is not available in your assignment.';
  end if;
  select * into v_template
  from annotation_private.templates
  where template_id = v_row.template_id;
  if not found then
    raise exception using errcode = 'PT503', message = 'The annotation materials are incomplete.';
  end if;
  perform annotation_private._check_access_gate(v_participant_id, v_row.kind);

  if p_action = 'task' then
    perform annotation_private._assert_payload_fields(p_payload, array[]::text[]);
    return annotation_private._task_payload(v_row, v_template);
  elsif p_action = 'reference' then
    perform annotation_private._assert_payload_fields(p_payload, array[]::text[]);
    if v_row.status = 'paused' then
      raise exception using errcode = 'PT403', message = 'This comparison is paused while a reported problem is reviewed.';
    end if;
    if v_row.locked_at is null or v_row.stage <> 2 then
      raise exception using errcode = 'PT403', message = 'Lock the four source-based answers before opening the reference.';
    end if;
    v_reference_released_at := v_row.reference_released_at;
    if v_reference_released_at is null then
      v_now := pg_catalog.clock_timestamp();
      if v_now < v_row.locked_at then
        v_now := v_row.locked_at;
      end if;
      update annotation_private.assignments
        set reference_released_at = v_now, revision = v_row.revision + 1, updated_at = v_now
      where task_id = p_task_id returning * into v_row;
      perform annotation_private._record_event(
        v_participant_id, p_task_id, 'reference_released', v_row.revision,
        pg_catalog.jsonb_build_object('locked_at', v_row.locked_at)
      );
      v_reference_released_at := v_row.reference_released_at;
    end if;
    return pg_catalog.jsonb_build_object(
      'reference', v_template.payload -> 'reference',
      'revision', v_row.revision,
      'reference_released_at', v_reference_released_at
    );
  elsif p_action = 'save' then
    perform annotation_private._assert_payload_fields(p_payload, array['stage', 'revision', 'answers']::text[]);
    v_stage := annotation_private._integer_field(p_payload, 'stage', 1, 2);
    if v_row.status = 'paused' then
      raise exception using errcode = 'PT403', message = 'This comparison is paused while a reported problem is reviewed.';
    end if;
    if v_row.status = 'complete' then
      raise exception using errcode = 'PT409', message = 'This comparison has already been submitted and cannot be changed.';
    end if;
    if v_stage <> v_row.stage then
      raise exception using errcode = 'PT409', message = 'This comparison is at a different stage. Reload it before continuing.';
    end if;
    perform annotation_private._check_revision(p_payload, v_row.revision);
    if v_stage = 1 then
      if v_row.status <> 'draft' or v_row.locked_at is not null then
        raise exception using errcode = 'PT409', message = 'The source-based answers have already been locked.';
      end if;
      v_answers := annotation_private._validate_answers(
        p_payload -> 'answers',
        array['source_coverage', 'readability', 'faithfulness', 'content_focus']::text[],
        false
      );
      update annotation_private.assignments
        set stage1_answers = stage1_answers || v_answers,
            revision = v_row.revision + 1,
            updated_at = pg_catalog.clock_timestamp()
      where task_id = p_task_id returning * into v_updated;
    else
      if v_row.status <> 'locked' or v_row.reference_released_at is null then
        raise exception using errcode = 'PT403', message = 'Open the reference after locking Stage 1 before saving this answer.';
      end if;
      v_answers := annotation_private._validate_answers(p_payload -> 'answers', array['reference_coverage']::text[], false);
      update annotation_private.assignments
        set stage2_answers = stage2_answers || v_answers,
            revision = v_row.revision + 1,
            updated_at = pg_catalog.clock_timestamp()
      where task_id = p_task_id returning * into v_updated;
    end if;
    perform annotation_private._record_event(
      v_participant_id, p_task_id, 'stage' || v_stage || '_saved', v_updated.revision,
      pg_catalog.jsonb_build_object('criteria', (
        select pg_catalog.to_jsonb(pg_catalog.array_agg(key order by key))
        from pg_catalog.jsonb_object_keys(v_answers) as keys(key)
      ))
    );
    return annotation_private._task_payload(v_updated, v_template);
  elsif p_action = 'lock' then
    perform annotation_private._assert_payload_fields(p_payload, array['revision', 'answers']::text[]);
    -- Idempotent retries may carry an old integer revision, but never a value
    -- of the wrong JSON type or outside the accepted range.
    perform annotation_private._integer_field(p_payload, 'revision', 0, 2147483647);
    v_answers := annotation_private._validate_answers(
      p_payload -> 'answers',
      array['source_coverage', 'readability', 'faithfulness', 'content_focus']::text[],
      true
    );
    if v_row.status = 'paused' then
      raise exception using errcode = 'PT403', message = 'This comparison is paused while a reported problem is reviewed.';
    end if;
    if v_row.locked_at is not null then
      if v_row.stage1_answers = v_answers then
        return annotation_private._task_payload(v_row, v_template);
      end if;
      raise exception using errcode = 'PT409', message = 'These source-based answers are already locked and cannot be changed.';
    end if;
    if v_row.status <> 'draft' or v_row.stage <> 1 then
      raise exception using errcode = 'PT409', message = 'This comparison is not accepting Stage 1 answers.';
    end if;
    perform annotation_private._check_revision(p_payload, v_row.revision);
    v_now := pg_catalog.clock_timestamp();
    update annotation_private.assignments
       set stage1_answers = v_answers,
           status = 'locked',
           stage = 2,
           revision = v_row.revision + 1,
           locked_at = v_now,
           updated_at = v_now
     where task_id = p_task_id returning * into v_updated;
    perform annotation_private._record_event(
      v_participant_id, p_task_id, 'stage1_locked', v_updated.revision,
      pg_catalog.jsonb_build_object('criteria', array['source_coverage', 'readability', 'faithfulness', 'content_focus'])
    );
    return annotation_private._task_payload(v_updated, v_template);
  elsif p_action = 'complete' then
    perform annotation_private._assert_payload_fields(p_payload, array['revision', 'answers']::text[]);
    -- Validate type/range before the same-answer idempotency shortcut below.
    perform annotation_private._integer_field(p_payload, 'revision', 0, 2147483647);
    v_answers := annotation_private._validate_answers(p_payload -> 'answers', array['reference_coverage']::text[], true);
    if v_row.status = 'paused' then
      raise exception using errcode = 'PT403', message = 'This comparison is paused while a reported problem is reviewed.';
    end if;
    if v_row.status = 'complete' then
      if v_row.stage2_answers = v_answers then
        return annotation_private._task_payload(v_row, v_template);
      end if;
      raise exception using errcode = 'PT409', message = 'This comparison has already been submitted and cannot be changed.';
    end if;
    if v_row.status <> 'locked' or v_row.stage <> 2 or v_row.reference_released_at is null then
      raise exception using errcode = 'PT403', message = 'Open the reference before submitting the final answer.';
    end if;
    perform annotation_private._check_revision(p_payload, v_row.revision);
    v_now := pg_catalog.clock_timestamp();
    update annotation_private.assignments
       set stage2_answers = v_answers,
           status = 'complete',
           revision = v_row.revision + 1,
           completed_at = v_now,
           updated_at = v_now
     where task_id = p_task_id returning * into v_updated;
    perform annotation_private._record_event(
      v_participant_id, p_task_id, 'comparison_completed', v_updated.revision,
      pg_catalog.jsonb_build_object('criteria', array['reference_coverage'])
    );
    return annotation_private._task_payload(v_updated, v_template);
  elsif p_action = 'problem' then
    perform annotation_private._assert_payload_fields(p_payload, array['revision', 'category', 'criteria']::text[]);
    if pg_catalog.jsonb_typeof(p_payload -> 'category') is distinct from 'string' then
      raise exception using errcode = 'PT400', message = 'Select a problem category from the list.';
    end if;
    v_category := p_payload ->> 'category';
    if v_category not in (
      'text_missing_or_unreadable', 'materials_appear_mismatched',
      'cannot_interpret_material_reliably', 'accidental_selection_after_submission',
      'other_interface_problem'
    ) then
      raise exception using errcode = 'PT400', message = 'Select a problem category from the list.';
    end if;
    v_criteria := annotation_private._validate_problem_criteria(p_payload -> 'criteria');
    if v_row.stage = 1 and v_criteria ? 'reference_coverage' then
      raise exception using errcode = 'PT400', message = 'Reference coverage is not available before the reference is shown.';
    end if;
    perform annotation_private._check_revision(p_payload, v_row.revision);
    v_now := pg_catalog.clock_timestamp();
    if v_row.status not in ('complete', 'paused') then
      update annotation_private.assignments
         set status = 'paused',
             paused_from_status = v_row.status,
             revision = v_row.revision + 1,
             updated_at = v_now
       where task_id = p_task_id returning * into v_updated;
    else
      update annotation_private.assignments
         set revision = v_row.revision + 1,
             updated_at = v_now
       where task_id = p_task_id returning * into v_updated;
    end if;
    perform annotation_private._record_event(
      v_participant_id, p_task_id, 'problem_reported', v_updated.revision,
      pg_catalog.jsonb_build_object('category', v_category, 'criteria', v_criteria)
    );
    return annotation_private._task_payload(v_updated, v_template);
  end if;
  raise exception using errcode = 'PT400', message = 'The requested action is invalid.';
end;
$$;

revoke all on function annotation_private.resolve_problem(text, text) from public, anon, authenticated;
revoke all on function annotation_private.export_all() from public, anon, authenticated;
revoke all on all functions in schema annotation_private from public, anon, authenticated;
revoke all on function public.annotation_api(text, text, jsonb) from public, anon, authenticated;
grant execute on function public.annotation_api(text, text, jsonb) to authenticated;
