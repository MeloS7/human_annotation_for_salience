-- Opt-in qualification pilot. This migration is intentionally dormant until a
-- private qualification set is imported and settings.qualification_version is
-- set. Existing participants remain on the two-practice flow until they invoke
-- start_qualification explicitly.

-- Match the RPC lock order: participant first, then assignments/templates.
lock table annotation_private.participants in access exclusive mode;

create table if not exists annotation_private.qualification_sets (
  qualification_version text primary key
    check (qualification_version ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
  fingerprint text not null check (fingerprint ~ '^[a-f0-9]{64}$'),
  item_count integer not null default 10 check (item_count = 10),
  scored_total integer not null default 18 check (scored_total = 18),
  pass_count integer not null default 15 check (pass_count between 1 and scored_total),
  key_status text not null check (key_status = 'llm_suggested_unvalidated')
);

create table if not exists annotation_private.qualification_keys (
  qualification_version text not null
    references annotation_private.qualification_sets(qualification_version) on delete restrict,
  template_id text not null
    references annotation_private.templates(template_id) on delete restrict,
  qualification_id text not null check (char_length(qualification_id) between 1 and 32),
  dataset text not null check (dataset in ('cnndm', 'gumsum')),
  title_zh text not null check (char_length(title_zh) between 1 and 160),
  suggestions jsonb not null check (jsonb_typeof(suggestions) = 'object'),
  primary key (template_id)
);

create table if not exists annotation_private.qualification_results (
  participant_id text primary key
    references annotation_private.participants(participant_id) on delete restrict,
  qualification_version text not null
    references annotation_private.qualification_sets(qualification_version) on delete restrict,
  result jsonb not null check (jsonb_typeof(result) = 'object'),
  evaluated_at timestamptz not null default now()
);

alter table annotation_private.settings
  add column if not exists qualification_version text;
alter table annotation_private.participants
  add column if not exists qualification_version text;

do $qualification_foreign_keys$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'annotation_private.settings'::regclass
      and conname = 'settings_qualification_version_fkey'
  ) then
    alter table annotation_private.settings
      add constraint settings_qualification_version_fkey
      foreign key (qualification_version)
      references annotation_private.qualification_sets(qualification_version)
      on delete restrict;
  end if;
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'annotation_private.participants'::regclass
      and conname = 'participants_qualification_version_fkey'
  ) then
    alter table annotation_private.participants
      add constraint participants_qualification_version_fkey
      foreign key (qualification_version)
      references annotation_private.qualification_sets(qualification_version)
      on delete restrict;
  end if;
end;
$qualification_foreign_keys$;

alter table annotation_private.templates
  drop constraint if exists templates_kind_check;
alter table annotation_private.assignments
  drop constraint if exists assignments_kind_check;
do $qualification_kind_constraints$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'annotation_private.templates'::regclass
      and conname = 'templates_kind_allowed_check'
  ) then
    alter table annotation_private.templates
      add constraint templates_kind_allowed_check
      check (kind in ('practice', 'study', 'qualification'));
  end if;
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'annotation_private.assignments'::regclass
      and conname = 'assignments_kind_allowed_check'
  ) then
    alter table annotation_private.assignments
      add constraint assignments_kind_allowed_check
      check (kind in ('practice', 'study', 'qualification'));
  end if;
end;
$qualification_kind_constraints$;

alter table annotation_private.qualification_sets enable row level security;
alter table annotation_private.qualification_keys enable row level security;
alter table annotation_private.qualification_results enable row level security;
revoke all on all tables in schema annotation_private from public, anon, authenticated;

-- Preserve the installed implementation as a private implementation detail;
-- the new public RPC is a narrow dispatcher for the two pilot-only actions.
do $preserve_annotation_api$
begin
  if pg_catalog.to_regprocedure('annotation_private._annotation_api_pre_qualification(text,text,jsonb)') is null then
    if pg_catalog.to_regprocedure('public.annotation_api(text,text,jsonb)') is null then
      raise exception 'Expected public.annotation_api(text,text,jsonb) before qualification migration.';
    end if;
    execute 'alter function public.annotation_api(text, text, jsonb) set schema annotation_private';
    execute 'alter function annotation_private.annotation_api(text, text, jsonb) rename to _annotation_api_pre_qualification';
  end if;
end;
$preserve_annotation_api$;

do $preserve_legacy_helpers$
begin
  if pg_catalog.to_regprocedure('annotation_private._session_payload_pre_qualification(text)') is null then
    if pg_catalog.to_regprocedure('annotation_private._session_payload(text)') is null then
      raise exception 'Expected annotation_private._session_payload(text) before qualification migration.';
    end if;
    execute 'alter function annotation_private._session_payload(text) rename to _session_payload_pre_qualification';
  end if;
  if pg_catalog.to_regprocedure('annotation_private._check_access_gate_pre_qualification(text,text)') is null then
    if pg_catalog.to_regprocedure('annotation_private._check_access_gate(text,text)') is null then
      raise exception 'Expected annotation_private._check_access_gate(text,text) before qualification migration.';
    end if;
    execute 'alter function annotation_private._check_access_gate(text, text) rename to _check_access_gate_pre_qualification';
  end if;
  if pg_catalog.to_regprocedure('annotation_private._export_participant_pre_qualification(text,boolean)') is null then
    if pg_catalog.to_regprocedure('annotation_private._export_participant(text,boolean)') is null then
      raise exception 'Expected annotation_private._export_participant(text,boolean) before qualification migration.';
    end if;
    execute 'alter function annotation_private._export_participant(text, boolean) rename to _export_participant_pre_qualification';
  end if;
end;
$preserve_legacy_helpers$;

create or replace function annotation_private._assert_qualification_inventory(
  p_qualification_version text
) returns void
language plpgsql
set search_path = ''
as $$
declare
  v_set annotation_private.qualification_sets%rowtype;
  v_scheme integer;
  v_items integer;
  v_keys integer;
  v_scored integer;
  v_cnndm integer;
  v_gumsum integer;
  v_templates integer;
  v_min_position integer;
  v_max_position integer;
begin
  select * into v_set
  from annotation_private.qualification_sets
  where qualification_version = p_qualification_version;
  if not found then
    raise exception using errcode = 'PT503', message = 'The qualification set is not available.';
  end if;
  perform annotation_private._assert_template_inventory();

  for v_scheme in 1..3 loop
    select
      pg_catalog.count(*),
      pg_catalog.min(position),
      pg_catalog.max(position)
      into v_templates, v_min_position, v_max_position
    from annotation_private.templates
    where scheme = v_scheme and kind = 'qualification';

    if v_templates is distinct from 10 or v_min_position is distinct from 1 or v_max_position is distinct from 10 then
      raise exception using errcode = 'PT503', message = 'The qualification materials are incomplete.';
    end if;

    select
      pg_catalog.count(distinct t.template_id),
      pg_catalog.count(k.template_id),
      coalesce(pg_catalog.sum(scored.cell_count), 0),
      pg_catalog.count(*) filter (where k.dataset = 'cnndm'),
      pg_catalog.count(*) filter (where k.dataset = 'gumsum')
      into v_items, v_keys, v_scored, v_cnndm, v_gumsum
    from annotation_private.qualification_keys as k
    join annotation_private.templates as t on t.template_id = k.template_id
    cross join lateral (
      select pg_catalog.count(*)::integer as cell_count
      from pg_catalog.jsonb_each(k.suggestions) as dimension(key, value)
      where dimension.value -> 'scored' = 'true'::jsonb
    ) as scored
    where k.qualification_version = p_qualification_version
      and t.scheme = v_scheme
      and t.kind = 'qualification';

    if v_items is distinct from 10 or v_keys is distinct from 10 or
       v_scored is distinct from 18 or v_cnndm is distinct from 5 or v_gumsum is distinct from 5 then
      raise exception using errcode = 'PT503', message = 'The qualification materials are incomplete.';
    end if;

    if exists (
      select 1
      from annotation_private.qualification_keys as k
      join annotation_private.templates as t on t.template_id = k.template_id
      where k.qualification_version = p_qualification_version
        and t.scheme = v_scheme
        and (
          t.kind <> 'qualification' or t.position < 1 or t.position > 10 or
          k.qualification_id <> ('Q' || pg_catalog.lpad(t.position::text, 2, '0')) or
          pg_catalog.jsonb_typeof(t.coordinator) is distinct from 'object' or
          t.coordinator ->> 'qualification_version' is distinct from p_qualification_version or
          t.coordinator ->> 'qualification_id' is distinct from k.qualification_id or
          t.coordinator ->> 'dataset' is distinct from k.dataset or
          pg_catalog.jsonb_typeof(k.suggestions) is distinct from 'object' or
          (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(k.suggestions)) <> 5 or
          exists (
            select 1
            from pg_catalog.jsonb_each(k.suggestions) as dimension(key, value)
            where dimension.key not in (
                    'source_coverage', 'readability', 'faithfulness',
                    'content_focus', 'reference_coverage'
                  )
               or pg_catalog.jsonb_typeof(dimension.value) is distinct from 'object'
               or (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(dimension.value)) <> 4
               or dimension.value ->> 'label' is null
               or dimension.value ->> 'label' not in ('A', 'B', 'Tie')
               or pg_catalog.jsonb_typeof(dimension.value -> 'scored') is distinct from 'boolean'
               or pg_catalog.jsonb_typeof(dimension.value -> 'rationale_zh') is distinct from 'string'
               or pg_catalog.length(pg_catalog.btrim(dimension.value ->> 'rationale_zh')) = 0
               or pg_catalog.jsonb_typeof(dimension.value -> 'confidence') is distinct from 'string'
               or pg_catalog.length(pg_catalog.btrim(dimension.value ->> 'confidence')) = 0
               or (dimension.value ->> 'scored' = 'true' and dimension.value ->> 'confidence' <> 'high')
          )
        )
    ) then
      raise exception using errcode = 'PT503', message = 'The qualification answer key is invalid.';
    end if;
  end loop;
end;
$$;

create or replace function annotation_private._assert_qualification_inventory()
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_version text;
begin
  select qualification_version into v_version
  from annotation_private.settings where id = 1;
  if v_version is null then
    raise exception using errcode = 'PT503', message = 'The qualification set is not configured.';
  end if;
  perform annotation_private._assert_qualification_inventory(v_version);
end;
$$;

create or replace function annotation_private._ensure_qualification_assignments(
  p_participant_id text
) returns void
language plpgsql
set search_path = ''
as $$
declare
  v_participant annotation_private.participants%rowtype;
  v_version text;
  v_existing integer;
  v_updated integer;
begin
  select * into v_participant
  from annotation_private.participants
  where participant_id = p_participant_id
  for update;
  if not found then
    raise exception using errcode = 'PT404', message = 'The requested participant was not found.';
  end if;
  -- Availability is deliberately not enrollment: only start_qualification
  -- pins a participant to a version and creates any missing pilot rows.
  if v_participant.qualification_version is null then
    return;
  end if;

  v_version := v_participant.qualification_version;
  perform annotation_private._assert_qualification_inventory(v_version);
  select pg_catalog.count(*) into v_existing
  from annotation_private.assignments
  where participant_id = p_participant_id and kind = 'qualification';
  if v_existing = 10 then
    if exists (
      select 1
      from annotation_private.assignments as a
      join annotation_private.templates as t on t.template_id = a.template_id
      left join annotation_private.qualification_keys as k
        on k.template_id = a.template_id
       and k.qualification_version = v_version
      where a.participant_id = p_participant_id
        and a.kind = 'qualification'
        and (
          k.template_id is null or
          t.scheme is distinct from v_participant.scheme or
          t.kind is distinct from 'qualification' or
          a.position < 1 or a.position > 10
        )
    ) or (
      select pg_catalog.count(distinct template_id)
      from annotation_private.assignments
      where participant_id = p_participant_id and kind = 'qualification'
    ) <> 10 then
      raise exception using errcode = 'PT503', message = 'The participant qualification assignments are inconsistent.';
    end if;
    return;
  elsif v_existing <> 0 then
    raise exception using errcode = 'PT503', message = 'The participant qualification assignments are incomplete.';
  end if;

  with digested as (
    select
      t.template_id,
      pg_catalog.sha256(pg_catalog.convert_to(p_participant_id || '|' || t.template_id, 'UTF8')) as order_key
    from annotation_private.qualification_keys as k
    join annotation_private.templates as t on t.template_id = k.template_id
    where k.qualification_version = v_version
      and t.scheme = v_participant.scheme
      and t.kind = 'qualification'
  ), numbered as (
    select template_id, order_key,
      pg_catalog.row_number() over (order by order_key, template_id)::integer as assigned_position
    from digested
  )
  insert into annotation_private.assignments (task_id, participant_id, template_id, kind, position)
  select
    'task_' || pg_catalog.encode(order_key, 'hex'),
    p_participant_id,
    template_id,
    'qualification',
    assigned_position
  from numbered;

  get diagnostics v_updated = row_count;
  if v_updated <> 10 then
    raise exception using errcode = 'PT503', message = 'The participant qualification assignments could not be prepared.';
  end if;
end;
$$;

create or replace function annotation_private._evaluate_qualification(
  p_participant_id text
) returns void
language plpgsql
set search_path = ''
as $$
declare
  v_participant annotation_private.participants%rowtype;
  v_set annotation_private.qualification_sets%rowtype;
  v_total integer;
  v_completed integer;
  v_scored_total integer;
  v_scored_matched integer;
  v_all_matched integer;
  v_dimensions jsonb;
  v_items jsonb;
  v_now timestamptz;
  v_result jsonb;
begin
  select * into v_participant
  from annotation_private.participants
  where participant_id = p_participant_id
  for update;
  if not found or v_participant.qualification_version is null then
    return;
  end if;

  if exists (
    select 1 from annotation_private.qualification_results
    where participant_id = p_participant_id
  ) then
    return;
  end if;

  perform annotation_private._ensure_qualification_assignments(p_participant_id);
  perform annotation_private._assert_qualification_inventory(v_participant.qualification_version);
  select * into v_set
  from annotation_private.qualification_sets
  where qualification_version = v_participant.qualification_version;

  select
    pg_catalog.count(*),
    pg_catalog.count(*) filter (where a.status = 'complete')
    into v_total, v_completed
  from annotation_private.assignments as a
  where a.participant_id = p_participant_id and a.kind = 'qualification';
  if v_total <> 10 or v_completed <> 10 then
    return;
  end if;

  select
    pg_catalog.count(*) filter (where k.suggestions -> dimension.id ->> 'scored' = 'true'),
    pg_catalog.count(*) filter (
      where k.suggestions -> dimension.id ->> 'scored' = 'true'
        and answer.label = k.suggestions -> dimension.id ->> 'label'
    ),
    pg_catalog.count(*) filter (
      where answer.label = k.suggestions -> dimension.id ->> 'label'
    )
    into v_scored_total, v_scored_matched, v_all_matched
  from annotation_private.assignments as a
  join annotation_private.qualification_keys as k
    on k.template_id = a.template_id
   and k.qualification_version = v_participant.qualification_version
  cross join lateral unnest(array[
    'source_coverage', 'readability', 'faithfulness', 'content_focus', 'reference_coverage'
  ]::text[]) as dimension(id)
  cross join lateral (
    select coalesce(a.stage1_answers, '{}'::jsonb) || coalesce(a.stage2_answers, '{}'::jsonb) as answers
  ) as merged
  cross join lateral (select merged.answers ->> dimension.id as label) as answer
  where a.participant_id = p_participant_id
    and a.kind = 'qualification'
    and a.status = 'complete';

  if v_scored_total <> v_set.scored_total then
    raise exception using errcode = 'PT503', message = 'The qualification score could not be computed.';
  end if;

  select coalesce(pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'id', dimension.id,
      'scored_matched', stats.scored_matched,
      'scored_total', stats.scored_total,
      'scored_percent', case
        when stats.scored_total = 0 then null
        else round(stats.scored_matched::numeric * 100 / stats.scored_total, 2)
      end,
      'all_matched', stats.all_matched,
      'all_total', stats.all_total,
      'all_percent', round(stats.all_matched::numeric * 100 / stats.all_total, 2)
    ) order by dimension.ordinality
  ), '[]'::jsonb) into v_dimensions
  from unnest(array[
    'source_coverage', 'readability', 'faithfulness', 'content_focus', 'reference_coverage'
  ]::text[]) with ordinality as dimension(id, ordinality)
  cross join lateral (
    select
      count(*) filter (
        where k.suggestions -> dimension.id ->> 'scored' = 'true'
          and (coalesce(a.stage1_answers, '{}'::jsonb) || coalesce(a.stage2_answers, '{}'::jsonb)) ->> dimension.id = k.suggestions -> dimension.id ->> 'label'
      ) as scored_matched,
      count(*) filter (where k.suggestions -> dimension.id ->> 'scored' = 'true') as scored_total,
      count(*) filter (
        where (coalesce(a.stage1_answers, '{}'::jsonb) || coalesce(a.stage2_answers, '{}'::jsonb)) ->> dimension.id = k.suggestions -> dimension.id ->> 'label'
      ) as all_matched,
      count(*) as all_total
    from annotation_private.assignments as a
    join annotation_private.qualification_keys as k
      on k.template_id = a.template_id
     and k.qualification_version = v_participant.qualification_version
    where a.participant_id = p_participant_id and a.kind = 'qualification' and a.status = 'complete'
  ) as stats;

  select coalesce(pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'id', a.task_id,
      'number', a.position,
      'qualification_id', k.qualification_id,
      'dataset', k.dataset,
      'title_zh', k.title_zh,
      'dimensions', (
        select coalesce(pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'id', dimension.id,
            'answer', merged.answers ->> dimension.id,
            'suggested', k.suggestions -> dimension.id ->> 'label',
            'matches', merged.answers ->> dimension.id = k.suggestions -> dimension.id ->> 'label',
            'scored', k.suggestions -> dimension.id ->> 'scored' = 'true',
            'rationale_zh', k.suggestions -> dimension.id ->> 'rationale_zh'
          ) order by dimension.ordinality
        ), '[]'::jsonb)
        from unnest(array[
          'source_coverage', 'readability', 'faithfulness', 'content_focus', 'reference_coverage'
        ]::text[]) with ordinality as dimension(id, ordinality)
      )
    ) order by a.position
  ), '[]'::jsonb) into v_items
  from annotation_private.assignments as a
  join annotation_private.qualification_keys as k
    on k.template_id = a.template_id
   and k.qualification_version = v_participant.qualification_version
  cross join lateral (
    select coalesce(a.stage1_answers, '{}'::jsonb) || coalesce(a.stage2_answers, '{}'::jsonb) as answers
  ) as merged
  where a.participant_id = p_participant_id
    and a.kind = 'qualification'
    and a.status = 'complete';

  v_now := pg_catalog.clock_timestamp();
  v_result := pg_catalog.jsonb_build_object(
    'version', v_participant.qualification_version,
    'key_status', v_set.key_status,
    'state', case when v_scored_matched >= v_set.pass_count then 'passed' else 'failed' end,
    'matched', v_scored_matched,
    'total', v_scored_total,
    'pass_count', v_set.pass_count,
    'percent', round(v_scored_matched::numeric * 100 / v_scored_total, 2),
    'overall', pg_catalog.jsonb_build_object(
      'matched', v_all_matched,
      'total', 50,
      'percent', round(v_all_matched::numeric * 100 / 50, 2)
    ),
    'dimensions', v_dimensions,
    'items', v_items,
    'evaluated_at', v_now
  );
  insert into annotation_private.qualification_results (
    participant_id, qualification_version, result, evaluated_at
  ) values (
    p_participant_id, v_participant.qualification_version, v_result, v_now
  ) on conflict (participant_id) do nothing;
end;
$$;

create or replace function annotation_private._session_payload(p_participant_id text)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_participant annotation_private.participants%rowtype;
  v_settings annotation_private.settings%rowtype;
  v_legacy jsonb;
  v_tasks jsonb;
  v_qualification_total integer;
  v_qualification_completed integer;
  v_paused integer;
  v_study_paused integer;
  v_result jsonb;
  v_state text;
  v_score jsonb;
begin
  select * into v_participant
  from annotation_private.participants
  where participant_id = p_participant_id;
  if not found then
    raise exception using errcode = 'PT404', message = 'The requested participant was not found.';
  end if;
  select * into v_settings from annotation_private.settings where id = 1;
  if not found then
    raise exception using errcode = 'PT503', message = 'The annotation study is not currently available.';
  end if;

  if v_participant.qualification_version is null then
    v_legacy := annotation_private._session_payload_pre_qualification(p_participant_id);
    if v_settings.qualification_version is null then
      return v_legacy;
    end if;
    perform annotation_private._assert_qualification_inventory(v_settings.qualification_version);
    return v_legacy || pg_catalog.jsonb_build_object(
      'qualification_available', pg_catalog.jsonb_build_object(
        'protocol', 'qualification-pilot-v1',
        'version', v_settings.qualification_version,
        'key_status', (
          select key_status from annotation_private.qualification_sets
          where qualification_version = v_settings.qualification_version
        ),
        'required', 10,
        'scored_total', 18,
        'pass_count', 15
      )
    );
  end if;

  perform annotation_private._ensure_qualification_assignments(p_participant_id);
  v_legacy := annotation_private._session_payload_pre_qualification(p_participant_id);
  select
    pg_catalog.count(*),
    pg_catalog.count(*) filter (where status = 'complete'),
    pg_catalog.count(*) filter (where status = 'paused')
    into v_qualification_total, v_qualification_completed, v_paused
  from annotation_private.assignments
  where participant_id = p_participant_id and kind = 'qualification';
  select pg_catalog.count(*) filter (where status = 'paused') into v_study_paused
  from annotation_private.assignments
  where participant_id = p_participant_id and kind = 'study';
  select coalesce(pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'id', task_id, 'kind', kind, 'position', position, 'status', status, 'stage', stage
    ) order by case kind when 'qualification' then 0 else 1 end, position
  ), '[]'::jsonb) into v_tasks
  from annotation_private.assignments
  where participant_id = p_participant_id and kind in ('qualification', 'study');
  select result into v_result
  from annotation_private.qualification_results
  where participant_id = p_participant_id;
  v_state := coalesce(v_result ->> 'state', 'in_progress');
  if v_result is null then
    v_score := null;
  else
    v_score := pg_catalog.jsonb_build_object('matched', v_result -> 'matched', 'total', v_result -> 'total');
  end if;

  return (v_legacy - 'tasks' - 'progress') || pg_catalog.jsonb_build_object(
    'tasks', v_tasks,
    'qualification', pg_catalog.jsonb_build_object(
      'protocol', 'qualification-pilot-v1',
      'version', v_participant.qualification_version,
      'key_status', (
        select key_status from annotation_private.qualification_sets
        where qualification_version = v_participant.qualification_version
      ),
      'required', 10,
      'completed', coalesce(v_qualification_completed, 0),
      'state', v_state,
      'scored_total', 18,
      'pass_count', 15,
      'score', v_score,
      'completed_at', v_result -> 'evaluated_at'
    ),
    'progress', pg_catalog.jsonb_build_object(
      'study_total', v_legacy -> 'progress' -> 'study_total',
      'study_completed', v_legacy -> 'progress' -> 'study_completed',
      'practice_total', 0,
      'practice_completed', 0,
      'practice_requirement', 0,
      'qualification_total', coalesce(v_qualification_total, 0),
      'qualification_completed', coalesce(v_qualification_completed, 0),
      'paused', coalesce(v_paused, 0) + coalesce(v_study_paused, 0)
    )
  );
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
  v_participant annotation_private.participants%rowtype;
  v_completed integer;
  v_state text;
begin
  select * into v_participant from annotation_private.participants
  where participant_id = p_participant_id;
  if not found then
    raise exception using errcode = 'PT404', message = 'The requested participant was not found.';
  end if;
  if v_participant.guide_ack_at is null then
    raise exception using errcode = 'PT403', message = 'Please read and acknowledge the instructions first.';
  end if;

  if v_participant.qualification_version is null then
    if p_kind = 'qualification' then
      raise exception using errcode = 'PT403', message = 'Start the qualification pilot before opening these comparisons.';
    end if;
    perform annotation_private._check_access_gate_pre_qualification(p_participant_id, p_kind);
    return;
  end if;

  perform annotation_private._ensure_qualification_assignments(p_participant_id);
  if p_kind = 'practice' then
    raise exception using errcode = 'PT403', message = 'Practice comparisons are not part of the qualification pilot.';
  elsif p_kind = 'qualification' then
    return;
  elsif p_kind = 'study' then
    perform annotation_private._evaluate_qualification(p_participant_id);
    select result ->> 'state' into v_state
    from annotation_private.qualification_results
    where participant_id = p_participant_id;
    if v_state is distinct from 'passed' then
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
stable
set search_path = ''
as $$
declare
  v_legacy jsonb;
  v_result jsonb;
begin
  v_legacy := annotation_private._export_participant_pre_qualification(p_participant_id, p_include_mapping);
  select result into v_result from annotation_private.qualification_results
  where participant_id = p_participant_id;
  return v_legacy || pg_catalog.jsonb_build_object(
    'qualification_assignments', annotation_private._export_assignments(
      p_participant_id, 'qualification', p_include_mapping
    ),
    'qualification_result', v_result
  );
end;
$$;

create or replace function annotation_private._qualification_assignment_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    if old.kind = 'qualification' then
      raise exception using errcode = 'PT409', message = 'Qualification assignments cannot be removed or reset.';
    end if;
    return old;
  end if;
  if old.kind = 'qualification' then
    if new.task_id is distinct from old.task_id or
       new.participant_id is distinct from old.participant_id or
       new.template_id is distinct from old.template_id or
       new.kind is distinct from old.kind or
       new.position is distinct from old.position then
      raise exception using errcode = 'PT409', message = 'Qualification assignment identity cannot be changed.';
    end if;
    if old.status = 'complete' and (
      new.status is distinct from 'complete' or
      new.stage is distinct from old.stage or
      new.stage1_answers is distinct from old.stage1_answers or
      new.stage2_answers is distinct from old.stage2_answers or
      new.locked_at is distinct from old.locked_at or
      new.reference_released_at is distinct from old.reference_released_at or
      new.completed_at is distinct from old.completed_at
    ) then
      raise exception using errcode = 'PT409', message = 'Completed qualification answers cannot be changed.';
    end if;
    if old.locked_at is not null and new.stage1_answers is distinct from old.stage1_answers then
      raise exception using errcode = 'PT409', message = 'Locked qualification answers cannot be changed.';
    end if;
    if old.reference_released_at is not null and new.reference_released_at is distinct from old.reference_released_at then
      raise exception using errcode = 'PT409', message = 'The qualification reference cannot be relocked.';
    end if;
  end if;
  return new;
end;
$$;

create or replace function annotation_private._qualification_result_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception using errcode = 'PT409', message = 'Qualification results are immutable.';
end;
$$;

create or replace function annotation_private._qualification_template_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.kind = 'qualification' and exists (
      select 1 from annotation_private.settings where id = 1 and qualification_version is not null
    ) then
      raise exception using errcode = 'PT409', message = 'Activated qualification materials are immutable.';
    end if;
    return new;
  elsif tg_op = 'DELETE' then
    if exists (
      select 1 from annotation_private.qualification_keys as k
      join annotation_private.settings as s on s.id = 1
      where k.template_id = old.template_id
        and k.qualification_version = s.qualification_version
    ) then
      raise exception using errcode = 'PT409', message = 'Activated qualification materials are immutable.';
    end if;
    return old;
  elsif exists (
    select 1 from annotation_private.qualification_keys as k
    join annotation_private.settings as s on s.id = 1
    where k.template_id in (old.template_id, new.template_id)
      and k.qualification_version = s.qualification_version
  ) then
    raise exception using errcode = 'PT409', message = 'Activated qualification materials are immutable.';
  end if;
  return new;
end;
$$;

create or replace function annotation_private._qualification_key_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_version text;
begin
  if tg_op = 'INSERT' then
    v_version := new.qualification_version;
  elsif tg_op = 'DELETE' then
    v_version := old.qualification_version;
  else
    if exists (
      select 1 from annotation_private.settings
      where id = 1 and qualification_version in (old.qualification_version, new.qualification_version)
    ) then
      raise exception using errcode = 'PT409', message = 'Activated qualification keys are immutable.';
    end if;
    return new;
  end if;
  if exists (
    select 1 from annotation_private.settings
    where id = 1 and qualification_version = v_version
  ) then
    raise exception using errcode = 'PT409', message = 'Activated qualification keys are immutable.';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

create or replace function annotation_private._qualification_set_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_version text;
begin
  if tg_op = 'INSERT' then
    v_version := new.qualification_version;
  elsif tg_op = 'DELETE' then
    v_version := old.qualification_version;
  else
    if exists (
      select 1 from annotation_private.settings
      where id = 1 and qualification_version in (old.qualification_version, new.qualification_version)
    ) then
      raise exception using errcode = 'PT409', message = 'Activated qualification settings are immutable.';
    end if;
    return new;
  end if;
  if exists (
    select 1 from annotation_private.settings
    where id = 1 and qualification_version = v_version
  ) then
    raise exception using errcode = 'PT409', message = 'Activated qualification settings are immutable.';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

create or replace function annotation_private._qualification_version_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.qualification_version is not null and
     new.qualification_version is distinct from old.qualification_version then
    raise exception using errcode = 'PT409', message = 'A participant cannot switch qualification versions.';
  end if;
  return new;
end;
$$;

create or replace function annotation_private._qualification_setting_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.qualification_version is not null and
     new.qualification_version is distinct from old.qualification_version then
    raise exception using errcode = 'PT409', message = 'The configured qualification version cannot be replaced.';
  end if;
  if new.qualification_version is not null then
    perform annotation_private._assert_qualification_inventory(new.qualification_version);
  end if;
  return new;
end;
$$;

create or replace function annotation_private._evaluate_qualification_after_complete()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.kind = 'qualification' and new.status = 'complete' and old.status is distinct from 'complete' then
    perform annotation_private._evaluate_qualification(new.participant_id);
  end if;
  return new;
end;
$$;

drop trigger if exists qualification_assignment_guard on annotation_private.assignments;
create trigger qualification_assignment_guard
before update or delete on annotation_private.assignments
for each row execute function annotation_private._qualification_assignment_guard();

drop trigger if exists qualification_result_guard on annotation_private.qualification_results;
create trigger qualification_result_guard
before update or delete on annotation_private.qualification_results
for each row execute function annotation_private._qualification_result_guard();

drop trigger if exists qualification_template_guard on annotation_private.templates;
create trigger qualification_template_guard
before insert or update or delete on annotation_private.templates
for each row
execute function annotation_private._qualification_template_guard();

drop trigger if exists qualification_key_guard on annotation_private.qualification_keys;
create trigger qualification_key_guard
before insert or update or delete on annotation_private.qualification_keys
for each row execute function annotation_private._qualification_key_guard();

drop trigger if exists qualification_set_guard on annotation_private.qualification_sets;
create trigger qualification_set_guard
before insert or update or delete on annotation_private.qualification_sets
for each row execute function annotation_private._qualification_set_guard();

drop trigger if exists qualification_version_guard on annotation_private.participants;
create trigger qualification_version_guard
before update of qualification_version on annotation_private.participants
for each row execute function annotation_private._qualification_version_guard();

drop trigger if exists qualification_setting_guard on annotation_private.settings;
create trigger qualification_setting_guard
before update of qualification_version on annotation_private.settings
for each row execute function annotation_private._qualification_setting_guard();

drop trigger if exists qualification_evaluate_after_complete on annotation_private.assignments;
create trigger qualification_evaluate_after_complete
after update of status on annotation_private.assignments
for each row when (new.kind = 'qualification' and new.status = 'complete' and old.status is distinct from 'complete')
execute function annotation_private._evaluate_qualification_after_complete();

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
  v_version text;
  v_result jsonb;
begin
  if p_action is null or p_action not in ('start_qualification', 'qualification_results') then
    return annotation_private._annotation_api_pre_qualification(p_action, p_task_id, p_payload);
  end if;

  v_user_id := auth.uid();
  if v_user_id is null then
    raise exception using errcode = 'PT401', message = 'Sign in to continue.';
  end if;
  select is_anonymous into v_anonymous from auth.users where id = v_user_id;
  if not found or v_anonymous is distinct from true then
    raise exception using errcode = 'PT401', message = 'Use an anonymous participant session to continue.';
  end if;
  if p_task_id is not null then
    raise exception using errcode = 'PT400', message = 'This action does not accept a task identifier.';
  end if;
  if pg_catalog.jsonb_typeof(p_payload) is distinct from 'object' or p_payload <> '{}'::jsonb then
    raise exception using errcode = 'PT400', message = 'The request payload is invalid.';
  end if;
  select * into v_participant from annotation_private.participants
  where auth_user_id = v_user_id for update;
  if not found then
    raise exception using errcode = 'PT401', message = 'This participant account is not registered.';
  end if;

  if p_action = 'start_qualification' then
    if v_participant.guide_ack_at is null then
      raise exception using errcode = 'PT403', message = 'Please read and acknowledge the instructions first.';
    end if;
    if v_participant.qualification_version is null then
      select * into v_settings from annotation_private.settings where id = 1 for update;
      if not found or v_settings.qualification_version is null then
        raise exception using errcode = 'PT503', message = 'The qualification pilot is not currently available.';
      end if;
      v_version := v_settings.qualification_version;
      perform annotation_private._assert_qualification_inventory(v_version);
      update annotation_private.participants
      set qualification_version = v_version
      where participant_id = v_participant.participant_id
      returning * into v_participant;
      perform annotation_private._record_event(
        v_participant.participant_id, null, 'qualification_started', null,
        pg_catalog.jsonb_build_object('version', v_version)
      );
    end if;
    perform annotation_private._ensure_qualification_assignments(v_participant.participant_id);
    return annotation_private._session_payload(v_participant.participant_id);
  end if;

  if v_participant.qualification_version is null then
    raise exception using errcode = 'PT403', message = 'Start the qualification pilot before requesting its results.';
  end if;
  perform annotation_private._ensure_qualification_assignments(v_participant.participant_id);
  perform annotation_private._evaluate_qualification(v_participant.participant_id);
  select result into v_result
  from annotation_private.qualification_results
  where participant_id = v_participant.participant_id;
  if not found then
    raise exception using errcode = 'PT403', message = 'Complete all ten qualification comparisons before requesting results.';
  end if;
  return v_result;
end;
$$;

revoke all on all functions in schema annotation_private from public, anon, authenticated;
revoke all on function public.annotation_api(text, text, jsonb) from public, anon, authenticated;
grant execute on function public.annotation_api(text, text, jsonb) to authenticated;
