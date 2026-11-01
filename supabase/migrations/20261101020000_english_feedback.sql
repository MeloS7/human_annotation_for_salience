-- Private English presentation overlay for qualification feedback. The
-- migration is dormant until the coordinator imports all 30 rows and activates
-- settings.qualification_feedback_version. Existing keys, results, and saved
-- annotations remain untouched in their original form.

create table if not exists annotation_private.qualification_feedback_sets (
  feedback_version text primary key
    check (feedback_version ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
  qualification_version text not null
    references annotation_private.qualification_sets(qualification_version) on delete restrict,
  qualification_fingerprint text not null check (qualification_fingerprint ~ '^[a-f0-9]{64}$'),
  language text not null check (language = 'en'),
  item_count integer not null check (item_count = 30)
);

create table if not exists annotation_private.qualification_feedback_items (
  feedback_version text not null
    references annotation_private.qualification_feedback_sets(feedback_version) on delete restrict,
  template_id text not null
    references annotation_private.templates(template_id) on delete restrict,
  qualification_id text not null check (qualification_id ~ '^Q(0[1-9]|10)$'),
  title_en text not null check (
    char_length(title_en) between 1 and 160
    and octet_length(title_en) = char_length(title_en)
    and title_en = btrim(title_en)
    and title_en ~ '^[ -~]+$'
  ),
  rationales_en jsonb not null check (jsonb_typeof(rationales_en) = 'object'),
  primary key (feedback_version, template_id)
);

alter table annotation_private.settings
  add column if not exists qualification_feedback_version text;

do $qualification_feedback_foreign_key$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'annotation_private.settings'::regclass
      and conname = 'settings_qualification_feedback_version_fkey'
  ) then
    alter table annotation_private.settings
      add constraint settings_qualification_feedback_version_fkey
      foreign key (qualification_feedback_version)
      references annotation_private.qualification_feedback_sets(feedback_version)
      on delete restrict;
  end if;
end;
$qualification_feedback_foreign_key$;

alter table annotation_private.qualification_feedback_sets enable row level security;
alter table annotation_private.qualification_feedback_items enable row level security;
revoke all on annotation_private.qualification_feedback_sets from public, anon, authenticated;
revoke all on annotation_private.qualification_feedback_items from public, anon, authenticated;

create or replace function annotation_private._assert_qualification_feedback_inventory(
  p_feedback_version text
) returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_set annotation_private.qualification_feedback_sets%rowtype;
  v_key_fingerprint text;
  v_rows integer;
  v_bad_rows integer;
begin
  select * into v_set
  from annotation_private.qualification_feedback_sets
  where feedback_version = p_feedback_version;
  if not found or v_set.language is distinct from 'en'
     or v_set.qualification_version is distinct from 'qualification-pilot-20261020-v1'
     or v_set.item_count is distinct from 30 then
    raise exception using errcode = 'PT503', message = 'The qualification feedback is not available.';
  end if;

  select fingerprint into v_key_fingerprint
  from annotation_private.qualification_sets
  where qualification_version = v_set.qualification_version;
  if not found or v_set.qualification_fingerprint is distinct from v_key_fingerprint then
    raise exception using errcode = 'PT503', message = 'The qualification feedback does not match the frozen qualification materials.';
  end if;

  select count(*)::integer into v_rows
  from annotation_private.qualification_feedback_items
  where feedback_version = p_feedback_version;
  select count(*)::integer into v_bad_rows
  from annotation_private.qualification_feedback_items item
  left join annotation_private.templates template on template.template_id = item.template_id
  left join annotation_private.qualification_keys key
    on key.template_id = item.template_id
   and key.qualification_version = v_set.qualification_version
  where item.feedback_version = p_feedback_version
    and (
      template.template_id is null
      or template.kind is distinct from 'qualification'
      or template.scheme not between 1 and 3
      or template.position not between 1 and 10
      or item.qualification_id is distinct from key.qualification_id
      or item.qualification_id is distinct from template.coordinator ->> 'qualification_id'
      or pg_catalog.jsonb_typeof(item.rationales_en) is distinct from 'object'
      or (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(item.rationales_en)) is distinct from 5
      or not (item.rationales_en ?& array[
        'source_coverage', 'reference_coverage', 'readability', 'faithfulness', 'content_focus'
      ])
      or exists (
        select 1 from pg_catalog.jsonb_each(item.rationales_en) rationale
        where rationale.key not in (
          'source_coverage', 'reference_coverage', 'readability', 'faithfulness', 'content_focus'
        ) or pg_catalog.jsonb_typeof(rationale.value) is distinct from 'string'
          or char_length(rationale.value #>> '{}') not between 1 and 500
          or (rationale.value #>> '{}') is distinct from btrim(rationale.value #>> '{}')
          or octet_length(rationale.value #>> '{}') <> char_length(rationale.value #>> '{}')
          or (rationale.value #>> '{}') !~ '^[ -~]+$'
      )
    );
  if v_rows is distinct from 30 or v_bad_rows is distinct from 0
     or exists (
       select 1
       from generate_series(1, 3) scheme(number)
       cross join generate_series(1, 10) position(number)
       left join annotation_private.templates template
         on template.scheme = scheme.number
        and template.kind = 'qualification'
        and template.position = position.number
       left join annotation_private.qualification_feedback_items item
         on item.template_id = template.template_id
        and item.feedback_version = p_feedback_version
       where template.template_id is null or item.template_id is null
     ) then
    raise exception using errcode = 'PT503', message = 'The qualification feedback inventory is incomplete or invalid.';
  end if;
end;
$$;

create or replace function annotation_private._qualification_feedback_items_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
begin
  if tg_op = 'DELETE' then
    if exists (select 1 from annotation_private.settings where id = 1 and qualification_feedback_version = old.feedback_version) then
      raise exception using errcode = 'PT409', message = 'Active English qualification feedback is immutable.';
    end if;
    return old;
  elsif tg_op = 'UPDATE' then
    if exists (select 1 from annotation_private.settings where id = 1
               and qualification_feedback_version in (old.feedback_version, new.feedback_version)) then
      raise exception using errcode = 'PT409', message = 'Active English qualification feedback is immutable.';
    end if;
  elsif exists (select 1 from annotation_private.settings where id = 1
                and qualification_feedback_version = new.feedback_version) then
    raise exception using errcode = 'PT409', message = 'Active English qualification feedback is immutable.';
  end if;
  return new;
end;
$$;

create or replace function annotation_private._qualification_feedback_set_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
begin
  if tg_op = 'DELETE' then
    if exists (select 1 from annotation_private.settings where id = 1 and qualification_feedback_version = old.feedback_version) then
      raise exception using errcode = 'PT409', message = 'Active English qualification feedback is immutable.';
    end if;
    return old;
  elsif tg_op = 'UPDATE' then
    if exists (select 1 from annotation_private.settings where id = 1
               and qualification_feedback_version in (old.feedback_version, new.feedback_version)) then
      raise exception using errcode = 'PT409', message = 'Active English qualification feedback is immutable.';
    end if;
  elsif exists (select 1 from annotation_private.settings where id = 1
                and qualification_feedback_version = new.feedback_version) then
    raise exception using errcode = 'PT409', message = 'Active English qualification feedback is immutable.';
  end if;
  return new;
end;
$$;

drop trigger if exists qualification_feedback_items_guard on annotation_private.qualification_feedback_items;
create trigger qualification_feedback_items_guard
before insert or update or delete on annotation_private.qualification_feedback_items
for each row execute function annotation_private._qualification_feedback_items_guard();

drop trigger if exists qualification_feedback_set_guard on annotation_private.qualification_feedback_sets;
create trigger qualification_feedback_set_guard
before insert or update or delete on annotation_private.qualification_feedback_sets
for each row execute function annotation_private._qualification_feedback_set_guard();

create or replace function annotation_private._qualification_feedback_setting_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.qualification_feedback_version is not null
     and new.qualification_feedback_version is distinct from old.qualification_feedback_version then
    raise exception using errcode = 'PT409', message = 'The active English qualification feedback cannot be replaced.';
  end if;
  if new.qualification_feedback_version is not null then
    perform annotation_private._assert_qualification_feedback_inventory(new.qualification_feedback_version);
  end if;
  return new;
end;
$$;

drop trigger if exists qualification_feedback_setting_guard on annotation_private.settings;
create trigger qualification_feedback_setting_guard
before update of qualification_feedback_version on annotation_private.settings
for each row execute function annotation_private._qualification_feedback_setting_guard();

-- Preserve the active mandatory qualification and export implementations.
-- These wrappers only localize completed feedback returned from the API/export;
-- the immutable result JSON in qualification_results remains unchanged.
do $preserve_english_feedback_helpers$
begin
  if pg_catalog.to_regprocedure('annotation_private._current_qualification_result_pre_english(text)') is null then
    if pg_catalog.to_regprocedure('annotation_private._current_qualification_result(text)') is null then
      raise exception 'Expected the mandatory qualification result helper before English feedback migration.';
    end if;
    execute 'alter function annotation_private._current_qualification_result(text) rename to _current_qualification_result_pre_english';
  end if;
  if pg_catalog.to_regprocedure('annotation_private._export_participant_pre_english(text,boolean)') is null then
    if pg_catalog.to_regprocedure('annotation_private._export_participant(text,boolean)') is null then
      raise exception 'Expected the fixed-package export helper before English feedback migration.';
    end if;
    execute 'alter function annotation_private._export_participant(text,boolean) rename to _export_participant_pre_english';
  end if;
end;
$preserve_english_feedback_helpers$;

create or replace function annotation_private._present_qualification_result_english(
  p_participant_id text,
  p_result jsonb
) returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_settings annotation_private.settings%rowtype;
  v_policy annotation_private.qualification_policies%rowtype;
  v_item jsonb;
  v_new_item jsonb;
  v_dimension jsonb;
  v_dimensions jsonb;
  v_items jsonb := '[]'::jsonb;
  v_title text;
  v_qualification_id text;
  v_rationales jsonb;
  v_item_count integer;
  v_dimension_count integer;
  v_dimension_ids integer;
  v_ordinal bigint;
begin
  if p_result is null or pg_catalog.jsonb_typeof(p_result) = 'null' then return p_result; end if;
  select * into v_settings from annotation_private.settings where id = 1;
  if not found or v_settings.qualification_feedback_version is null then return p_result; end if;
  v_policy := annotation_private._assert_mandatory_policy();
  perform annotation_private._assert_qualification_feedback_inventory(v_settings.qualification_feedback_version);
  if p_result ->> 'feedback_version' = v_settings.qualification_feedback_version
     and p_result ->> 'feedback_language' = 'en' then
    return p_result;
  end if;

  if pg_catalog.jsonb_typeof(p_result) is distinct from 'object'
     or pg_catalog.jsonb_typeof(p_result -> 'items') is distinct from 'array' then
    raise exception using errcode = 'PT503', message = 'The completed qualification feedback could not be prepared.';
  end if;
  select count(*)::integer into v_item_count from pg_catalog.jsonb_array_elements(p_result -> 'items');
  if v_item_count is distinct from 10 then
    raise exception using errcode = 'PT503', message = 'The completed qualification feedback is incomplete.';
  end if;

  for v_item, v_ordinal in
    select element.value, element.ordinality
    from pg_catalog.jsonb_array_elements(p_result -> 'items') with ordinality element(value, ordinality)
    order by element.ordinality
  loop
    select item.title_en, item.qualification_id, item.rationales_en
      into v_title, v_qualification_id, v_rationales
    from annotation_private.assignments assignment
    join annotation_private.templates template on template.template_id = assignment.template_id
    join annotation_private.qualification_keys key
      on key.template_id = template.template_id
     and key.qualification_version = v_policy.qualification_version
    join annotation_private.qualification_feedback_items item
      on item.template_id = template.template_id
     and item.feedback_version = v_settings.qualification_feedback_version
     and item.qualification_id = key.qualification_id
    where assignment.task_id = v_item ->> 'id'
      and assignment.participant_id = p_participant_id
      and assignment.kind = 'qualification'
      and template.kind = 'qualification'
      and template.scheme = (select participant.scheme from annotation_private.participants participant
                            where participant.participant_id = p_participant_id)
      and v_item ->> 'qualification_id' = key.qualification_id;
    if not found then
      raise exception using errcode = 'PT503', message = 'The completed qualification feedback is not available.';
    end if;

    if pg_catalog.jsonb_typeof(v_item -> 'dimensions') is distinct from 'array' then
      raise exception using errcode = 'PT503', message = 'The completed qualification feedback is incomplete.';
    end if;
    select count(*)::integer, count(distinct dimension.value ->> 'id')::integer
      into v_dimension_count, v_dimension_ids
    from pg_catalog.jsonb_array_elements(v_item -> 'dimensions') dimension(value);
    if v_dimension_count is distinct from 5 or v_dimension_ids is distinct from 5 then
      raise exception using errcode = 'PT503', message = 'The completed qualification feedback is incomplete.';
    end if;

    select coalesce(pg_catalog.jsonb_agg(
      (dimension.value - 'rationale_zh' - 'rationale_en') ||
        pg_catalog.jsonb_build_object(
          'rationale_en', v_rationales ->> (dimension.value ->> 'id')
        ) order by dimension.ordinality
    ), '[]'::jsonb) into v_dimensions
    from pg_catalog.jsonb_array_elements(v_item -> 'dimensions') with ordinality dimension(value, ordinality)
    where dimension.value ->> 'id' in (
      'source_coverage', 'reference_coverage', 'readability', 'faithfulness', 'content_focus'
    );
    if pg_catalog.jsonb_array_length(v_dimensions) is distinct from 5
       or exists (
         select 1 from pg_catalog.jsonb_array_elements(v_dimensions) dimension(value)
         where pg_catalog.jsonb_typeof(dimension.value -> 'rationale_en') is distinct from 'string'
           or pg_catalog.length(pg_catalog.btrim(dimension.value ->> 'rationale_en')) = 0
       ) then
      raise exception using errcode = 'PT503', message = 'The completed qualification feedback is incomplete.';
    end if;

    v_new_item := (v_item - 'title_zh' - 'title_en' - 'dimensions') ||
      pg_catalog.jsonb_build_object(
        'qualification_id', v_qualification_id,
        'title_en', v_title,
        'dimensions', v_dimensions
      );
    v_items := v_items || pg_catalog.jsonb_build_array(v_new_item);
  end loop;
  if pg_catalog.jsonb_array_length(v_items) is distinct from 10 then
    raise exception using errcode = 'PT503', message = 'The completed qualification feedback is incomplete.';
  end if;
  return (p_result - 'items' - 'feedback_language' - 'feedback_version') ||
    pg_catalog.jsonb_build_object(
      'items', v_items,
      'feedback_language', 'en',
      'feedback_version', v_settings.qualification_feedback_version
    );
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
  v_result jsonb;
begin
  v_result := annotation_private._current_qualification_result_pre_english(p_participant_id);
  return annotation_private._present_qualification_result_english(p_participant_id, v_result);
end;
$$;

create or replace function annotation_private._export_participant(
  p_participant_id text,
  p_include_mapping boolean
) returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_settings annotation_private.settings%rowtype;
  v_export jsonb;
begin
  v_export := annotation_private._export_participant_pre_english(p_participant_id, p_include_mapping);
  select * into v_settings from annotation_private.settings where id = 1;
  if not found or v_settings.qualification_feedback_version is null then return v_export; end if;
  if v_export ? 'qualification_result' then
    v_export := pg_catalog.jsonb_set(
      v_export,
      '{qualification_result}',
      annotation_private._present_qualification_result_english(p_participant_id, v_export -> 'qualification_result'),
      true
    );
  end if;
  if v_export ? 'qualification_original_result' then
    v_export := pg_catalog.jsonb_set(
      v_export,
      '{qualification_original_result}',
      annotation_private._present_qualification_result_english(p_participant_id, v_export -> 'qualification_original_result'),
      true
    );
  end if;
  return v_export;
end;
$$;

revoke all on function annotation_private._assert_qualification_feedback_inventory(text) from public, anon, authenticated;
revoke all on function annotation_private._qualification_feedback_items_guard() from public, anon, authenticated;
revoke all on function annotation_private._qualification_feedback_set_guard() from public, anon, authenticated;
revoke all on function annotation_private._qualification_feedback_setting_guard() from public, anon, authenticated;
revoke all on function annotation_private._present_qualification_result_english(text,jsonb) from public, anon, authenticated;
revoke all on function annotation_private._current_qualification_result(text) from public, anon, authenticated;
revoke all on function annotation_private._export_participant(text,boolean) from public, anon, authenticated;
