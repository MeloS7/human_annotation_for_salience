#!/usr/bin/env python3
"""Build the private SQL activation for English qualification feedback.

The public migration contains only the overlay schema and dormant result/export
wrappers. English text and its expanded per-template variants are written only
to coordinator-owned files outside this GitHub Pages repository.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sys

from qualification_feedback import (
    FEEDBACK_VERSION,
    LANGUAGE,
    QUALIFICATION_VERSION,
    validate_and_expand,
)


PUBLIC_ROOT = Path(__file__).resolve().parents[1]
MAX_SQL_FILE_BYTES = 900_000


def private_helpers():
    path = PUBLIC_ROOT / "scripts" / "build-private-setup.py"
    spec = importlib.util.spec_from_file_location("_english_feedback_private_helpers", path)
    if spec is None or spec.loader is None:
        raise RuntimeError("Could not load the private-output helper")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def sql_literal(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def json_literal(value: object) -> str:
    return sql_literal(json.dumps(value, ensure_ascii=True, separators=(",", ":"))) + "::jsonb"


CORE_SNAPSHOT_TABLES = (
    ("settings", "id", "(pg_catalog.to_jsonb(row_value) - 'qualification_feedback_version')"),
    ("participants", "participant_id", "pg_catalog.to_jsonb(row_value)"),
    ("templates", "template_id", "pg_catalog.to_jsonb(row_value)"),
    ("qualification_sets", "qualification_version", "pg_catalog.to_jsonb(row_value)"),
    ("qualification_keys", "template_id", "pg_catalog.to_jsonb(row_value)"),
    ("qualification_policies", "policy_version", "pg_catalog.to_jsonb(row_value)"),
    ("qualification_results", "participant_id", "pg_catalog.to_jsonb(row_value)"),
    ("assignments", "task_id", "pg_catalog.to_jsonb(row_value)"),
    ("events", "event_id", "pg_catalog.to_jsonb(row_value)"),
    ("fixed_package_sets", "assignment_version", "pg_catalog.to_jsonb(row_value)"),
    ("fixed_package_slots", "assignment_version, package_id", "pg_catalog.to_jsonb(row_value)"),
    ("fixed_package_items", "assignment_version, package_id, position", "pg_catalog.to_jsonb(row_value)"),
    ("fixed_package_participants", "participant_id", "pg_catalog.to_jsonb(row_value)"),
    ("fixed_package_task_assignments", "assignment_version, participant_id, item_position", "pg_catalog.to_jsonb(row_value)"),
)


def snapshot_object_sql(variable: str) -> str:
    fields = []
    for table, order, projected in CORE_SNAPSHOT_TABLES:
        order_expr = ", ".join(f"row_value.{column.strip()}" for column in order.split(","))
        fields.append(
            f"'{table}', (SELECT pg_catalog.md5(coalesce("
            f"pg_catalog.jsonb_agg({projected} ORDER BY {order_expr})::text, '[]')) "
            f"FROM annotation_private.{table} AS row_value)"
        )
    return f"SELECT pg_catalog.jsonb_build_object({', '.join(fields)}) INTO {variable};"


def activation_block(expanded: dict) -> str:
    payload_literal = json_literal(expanded)
    body = f"""DECLARE
  v_payload jsonb := {payload_literal};
  v_rows jsonb;
  v_active_version text;
  v_policy annotation_private.qualification_policies%rowtype;
  v_inserted integer;
  v_before jsonb;
  v_after jsonb;
BEGIN
  {snapshot_object_sql('v_before')}

  IF v_payload ->> 'feedback_version' IS DISTINCT FROM {sql_literal(FEEDBACK_VERSION)}
     OR v_payload ->> 'qualification_version' IS DISTINCT FROM {sql_literal(QUALIFICATION_VERSION)}
     OR v_payload ->> 'language' IS DISTINCT FROM {sql_literal(LANGUAGE)}
     OR pg_catalog.jsonb_typeof(v_payload -> 'items') IS DISTINCT FROM 'array'
     OR pg_catalog.jsonb_array_length(v_payload -> 'items') IS DISTINCT FROM 30 THEN
    RAISE EXCEPTION 'The private English qualification feedback file is incomplete or targets another version';
  END IF;
  v_rows := v_payload -> 'items';

  SELECT qualification_feedback_version INTO v_active_version
  FROM annotation_private.settings WHERE id = 1;
  IF NOT FOUND THEN RAISE EXCEPTION 'The annotation settings row is missing'; END IF;
  IF v_active_version IS NOT NULL AND v_active_version IS DISTINCT FROM {sql_literal(FEEDBACK_VERSION)} THEN
    RAISE EXCEPTION 'A different English qualification feedback version is already active';
  END IF;

  SELECT policy.* INTO v_policy
  FROM annotation_private.settings settings
  JOIN annotation_private.qualification_policies policy
    ON policy.policy_version = settings.qualification_policy_version
  WHERE settings.id = 1
    AND settings.qualification_version = {sql_literal(QUALIFICATION_VERSION)};
  IF NOT FOUND OR v_policy.pass_count <> 14 OR v_policy.scored_total <> 18
     OR v_policy.confirmed_scored_count <> 18
     OR v_policy.key_status <> 'human_confirmed_scored'
     OR v_policy.qualification_version IS DISTINCT FROM {sql_literal(QUALIFICATION_VERSION)}
     OR v_policy.fingerprint IS DISTINCT FROM (v_payload ->> 'qualification_fingerprint') THEN
    RAISE EXCEPTION 'The active qualification policy is not the matching confirmed 14-of-18 policy';
  END IF;
  PERFORM annotation_private._assert_qualification_inventory({sql_literal(QUALIFICATION_VERSION)});

  IF v_active_version IS NULL THEN
    IF EXISTS (
      SELECT 1 FROM annotation_private.qualification_feedback_sets existing
      WHERE existing.feedback_version = {sql_literal(FEEDBACK_VERSION)}
        AND (existing.qualification_version IS DISTINCT FROM {sql_literal(QUALIFICATION_VERSION)}
          OR existing.qualification_fingerprint IS DISTINCT FROM (v_payload ->> 'qualification_fingerprint')
          OR existing.language IS DISTINCT FROM {sql_literal(LANGUAGE)}
          OR existing.item_count IS DISTINCT FROM 30)
    ) THEN
      RAISE EXCEPTION 'An existing English feedback set conflicts with the private file';
    END IF;

    INSERT INTO annotation_private.qualification_feedback_sets
      (feedback_version, qualification_version, qualification_fingerprint, language, item_count)
    VALUES (
      {sql_literal(FEEDBACK_VERSION)}, {sql_literal(QUALIFICATION_VERSION)},
      v_payload ->> 'qualification_fingerprint', {sql_literal(LANGUAGE)}, 30
    ) ON CONFLICT (feedback_version) DO NOTHING;

    IF EXISTS (
      SELECT 1
      FROM pg_catalog.jsonb_to_recordset(v_rows) AS expected(
        template_id text, qualification_id text, title_en text, rationales_en jsonb
      )
      LEFT JOIN annotation_private.qualification_feedback_items actual
        ON actual.feedback_version = {sql_literal(FEEDBACK_VERSION)}
       AND actual.template_id = expected.template_id
      WHERE actual.template_id IS NOT NULL
        AND (actual.qualification_id IS DISTINCT FROM expected.qualification_id
          OR actual.title_en IS DISTINCT FROM expected.title_en
          OR actual.rationales_en IS DISTINCT FROM expected.rationales_en)
    ) THEN
      RAISE EXCEPTION 'An existing English feedback item conflicts with the private file';
    END IF;

    INSERT INTO annotation_private.qualification_feedback_items
      (feedback_version, template_id, qualification_id, title_en, rationales_en)
    SELECT {sql_literal(FEEDBACK_VERSION)}, expected.template_id,
           expected.qualification_id, expected.title_en, expected.rationales_en
    FROM pg_catalog.jsonb_to_recordset(v_rows) AS expected(
      template_id text, qualification_id text, title_en text, rationales_en jsonb
    )
    ON CONFLICT (feedback_version, template_id) DO NOTHING;

    IF EXISTS (
      SELECT 1
      FROM pg_catalog.jsonb_to_recordset(v_rows) AS expected(
        template_id text, qualification_id text, title_en text, rationales_en jsonb
      )
      LEFT JOIN annotation_private.qualification_feedback_items actual
        ON actual.feedback_version = {sql_literal(FEEDBACK_VERSION)}
       AND actual.template_id = expected.template_id
      WHERE actual.template_id IS NULL
        OR actual.qualification_id IS DISTINCT FROM expected.qualification_id
        OR actual.title_en IS DISTINCT FROM expected.title_en
        OR actual.rationales_en IS DISTINCT FROM expected.rationales_en
    ) THEN
      RAISE EXCEPTION 'The imported English feedback rows do not match the private file';
    END IF;

    PERFORM annotation_private._assert_qualification_feedback_inventory({sql_literal(FEEDBACK_VERSION)});
    UPDATE annotation_private.settings
       SET qualification_feedback_version = {sql_literal(FEEDBACK_VERSION)}
     WHERE id = 1 AND qualification_feedback_version IS NULL;
    GET DIAGNOSTICS v_inserted = ROW_COUNT;
    IF v_inserted <> 1 THEN RAISE EXCEPTION 'English qualification feedback could not be activated'; END IF;
  ELSE
    PERFORM annotation_private._assert_qualification_feedback_inventory(v_active_version);
    IF EXISTS (
      SELECT 1
      FROM pg_catalog.jsonb_to_recordset(v_rows) AS expected(
        template_id text, qualification_id text, title_en text, rationales_en jsonb
      )
      LEFT JOIN annotation_private.qualification_feedback_items actual
        ON actual.feedback_version = {sql_literal(FEEDBACK_VERSION)}
       AND actual.template_id = expected.template_id
      WHERE actual.template_id IS NULL
        OR actual.qualification_id IS DISTINCT FROM expected.qualification_id
        OR actual.title_en IS DISTINCT FROM expected.title_en
        OR actual.rationales_en IS DISTINCT FROM expected.rationales_en
    ) THEN
      RAISE EXCEPTION 'The active English feedback differs from the private file';
    END IF;
  END IF;

  {snapshot_object_sql('v_after')}
  IF v_before IS DISTINCT FROM v_after THEN
    RAISE EXCEPTION 'English feedback activation changed existing annotation, key, assignment, or participant data; transaction rolled back';
  END IF;
END;"""
    tag = "$english_feedback_" + hashlib.sha256(body.encode("utf-8")).hexdigest()[:24] + "$"
    while tag in body:
        tag = tag[:-1] + "x$"
    return f"DO {tag}\n{body}\n{tag};"


def final_select_sql() -> str:
    return f"""SELECT
  feedback.language,
  count(item.template_id)::integer AS template_count,
  count(item.title_en)::integer AS title_count,
  sum(rationale.rationale_count)::integer AS rationale_count,
  policy.pass_count,
  policy.scored_total
FROM annotation_private.settings settings
JOIN annotation_private.qualification_feedback_sets feedback
  ON feedback.feedback_version = settings.qualification_feedback_version
JOIN annotation_private.qualification_feedback_items item
  ON item.feedback_version = feedback.feedback_version
JOIN LATERAL (
  SELECT pg_catalog.count(*)::integer AS rationale_count
  FROM pg_catalog.jsonb_object_keys(item.rationales_en)
) rationale ON true
JOIN annotation_private.qualification_policies policy
  ON policy.policy_version = settings.qualification_policy_version
GROUP BY feedback.language, policy.pass_count, policy.scored_total;
"""


def setup_sql(expanded: dict, migration: str) -> str:
    return (
        "-- PRIVATE COORDINATOR IMPORT: contains English qualification titles and rationales.\n"
        "-- Paste only into the SQL Editor of the coordinator's Supabase project. Never commit or publish this file.\n"
        "-- One transaction installs the dormant overlay, imports all 30 scheme-specific rows, and activates it.\n"
        "-- It verifies that all pre-existing annotation and participant records remain unchanged.\n\n"
        "BEGIN;\nSET LOCAL standard_conforming_strings = on;\n\n"
        + migration.rstrip()
        + "\n\n"
        + activation_block(expanded)
        + "\n\n"
        + "COMMIT;\n\n"
        + final_select_sql()
    )


def _write_both_private(h, outputs: list[tuple[Path, str]]) -> None:
    staged: list[tuple[Path, Path]] = []
    published: list[Path] = []
    try:
        for destination, text in outputs:
            staged.append((destination, h._stage_private_file(destination, text)))
        for destination, temporary in staged:
            h._publish_private_file(temporary, destination)
            published.append(destination)
    except BaseException:
        for destination in published:
            destination.unlink(missing_ok=True)
        raise
    finally:
        for _, temporary in staged:
            temporary.unlink(missing_ok=True)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--qualification-fixture", type=Path, required=True,
                        help="Private frozen qualification-pilot-expected-private.json")
    parser.add_argument("--feedback", type=Path, required=True,
                        help="Private canonical English catalog from the coordinator")
    parser.add_argument("--output-sql", type=Path, required=True,
                        help="New private SQL path outside this public repository")
    parser.add_argument("--expanded-output", type=Path, required=True,
                        help="New private expanded English catalog path outside this public repository")
    args = parser.parse_args(argv)

    h = private_helpers()
    qualification_path = args.qualification_fixture.resolve(strict=True)
    feedback_path = args.feedback.resolve(strict=True)
    sql_path = args.output_sql.resolve()
    expanded_path = args.expanded_output.resolve()
    for path, label in (
        (qualification_path, "qualification fixture input"),
        (feedback_path, "English feedback input"),
        (sql_path, "English feedback SQL"),
        (expanded_path, "expanded English feedback catalog"),
    ):
        h._assert_private_destination(path, PUBLIC_ROOT.resolve(), label)
    if sql_path == expanded_path or sql_path in expanded_path.parents or expanded_path in sql_path.parents:
        raise ValueError("Choose separate private locations for the SQL and expanded JSON outputs")
    if sql_path.exists() or expanded_path.exists():
        raise FileExistsError("Refusing to overwrite existing private feedback outputs")

    fixture = json.loads(qualification_path.read_text(encoding="utf-8"))
    canonical_catalog = json.loads(feedback_path.read_text(encoding="utf-8"))
    expanded = validate_and_expand(fixture, canonical_catalog)
    migration_path = PUBLIC_ROOT / "supabase/migrations/20261101020000_english_feedback.sql"
    migration = migration_path.read_text(encoding="utf-8")
    sql = setup_sql(expanded, migration)
    if len(sql.encode("utf-8")) > MAX_SQL_FILE_BYTES:
        raise ValueError("Generated private SQL is too large for the Supabase SQL Editor limit")
    expanded_text = json.dumps(expanded, ensure_ascii=True, indent=2) + "\n"
    _write_both_private(h, [(sql_path, sql), (expanded_path, expanded_text)])
    print(f"Created private English feedback SQL ({len(sql.encode('utf-8')):,} bytes): {sql_path}")
    print(f"Created private 30-template English catalog: {expanded_path}")
    print("The SQL preserves the confirmed 14/18 policy and checks existing participant progress before and after activation.")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, TypeError, KeyError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        raise SystemExit(2)
