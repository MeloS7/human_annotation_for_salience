#!/usr/bin/env python3
"""Build a private, idempotent SQL activation for a frozen package plan.

The input plan and generated SQL belong in the coordinator's private research
checkout, never in this public GitHub Pages repository. The generated block
checksums pre-existing annotations and participant rows before and after the
plan is activated; it aborts atomically if activation changes any of them.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import sys


PUBLIC_ROOT = Path(__file__).resolve().parents[1]
ASSIGNMENT_VERSION = "fixed-packages-20261101-v1"
MAX_SQL_FILE_BYTES = 900_000


def canonical(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _private_helpers():
    path = PUBLIC_ROOT / "scripts" / "build-private-setup.py"
    spec = importlib.util.spec_from_file_location("_fixed_package_setup_private_helpers", path)
    if spec is None or spec.loader is None:
        raise RuntimeError("Could not load the private-output helper")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def validate_plan(plan: object) -> dict:
    if not isinstance(plan, dict) or set(plan) != {"version", "packages", "fingerprint"}:
        raise ValueError("The private plan must contain exactly version, packages, and fingerprint")
    if plan["version"] != ASSIGNMENT_VERSION:
        raise ValueError("The plan assignment version does not match this deployment")
    if not isinstance(plan["fingerprint"], str) or len(plan["fingerprint"]) != 64:
        raise ValueError("The plan fingerprint is invalid")
    body = {"version": plan["version"], "packages": plan["packages"]}
    expected = hashlib.sha256(canonical(body).encode("utf-8")).hexdigest()
    if plan["fingerprint"] != expected:
        raise ValueError("The plan fingerprint does not match its canonical contents")
    packages = plan["packages"]
    if not isinstance(packages, list) or len(packages) != 9:
        raise ValueError("The frozen plan must contain exactly nine packages")

    seen_items: dict[str, int] = {}
    for ordinal, package in enumerate(packages, start=1):
        expected_id = f"package_{ordinal:02d}"
        if (not isinstance(package, dict) or set(package) != {"package_id", "ordinal", "items"}
                or package["package_id"] != expected_id or package["ordinal"] != ordinal):
            raise ValueError("Package identifiers and ordinals must be the frozen package_01..09 sequence")
        items = package["items"]
        if not isinstance(items, list) or len(items) != 42:
            raise ValueError(f"{expected_id} must contain exactly 42 study items")
        positions: set[int] = set()
        local_items: set[str] = set()
        for item in items:
            if (not isinstance(item, dict) or set(item) != {"position", "item_id", "template_id"}
                    or type(item["position"]) is not int or not 1 <= item["position"] <= 42
                    or not isinstance(item["item_id"], str) or not item["item_id"]
                    or not isinstance(item["template_id"], str) or not item["template_id"]):
                raise ValueError(f"{expected_id} has a malformed task entry")
            if item["position"] in positions or item["item_id"] in local_items:
                raise ValueError(f"{expected_id} contains a duplicate position or item")
            positions.add(item["position"])
            local_items.add(item["item_id"])
            seen_items[item["item_id"]] = seen_items.get(item["item_id"], 0) + 1
        if positions != set(range(1, 43)):
            raise ValueError(f"{expected_id} must use every position from 1 through 42 exactly once")
    if len(seen_items) != 126 or any(count != 3 for count in seen_items.values()):
        raise ValueError("The plan must assign 126 distinct study pairs to exactly three packages each")
    return plan


def sql_literal(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def activation_sql(plan: dict) -> str:
    # Serialize only the package IDs and the pair/template/position mapping.
    # Summary text, references, participant identifiers, and answer keys are
    # not present in assignment_plan.private.json.
    plan_json = json.dumps(plan, ensure_ascii=False, separators=(",", ":"))
    plan_literal = sql_literal(plan_json) + "::jsonb"
    body = f"""DECLARE
  v_plan jsonb := {plan_literal};
  v_version text := v_plan ->> 'version';
  v_fingerprint text := v_plan ->> 'fingerprint';
  v_before_assignments text;
  v_before_qualification_results text;
  v_before_events text;
  v_before_participants text;
  v_after_assignments text;
  v_after_qualification_results text;
  v_after_events text;
  v_after_participants text;
  v_active_version text;
  v_policy annotation_private.qualification_policies%rowtype;
BEGIN
  SELECT pg_catalog.md5(coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(a) ORDER BY a.task_id)::text, '[]'))
    INTO v_before_assignments FROM annotation_private.assignments a;
  SELECT pg_catalog.md5(coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(q) ORDER BY q.participant_id, q.qualification_version)::text, '[]'))
    INTO v_before_qualification_results FROM annotation_private.qualification_results q;
  SELECT pg_catalog.md5(coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(e) ORDER BY e.event_id)::text, '[]'))
    INTO v_before_events FROM annotation_private.events e;
  -- to_jsonb(participants.*) includes identity and recovery-code hash fields;
  -- only the checksum is kept locally inside this block and never selected.
  SELECT pg_catalog.md5(coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(p) ORDER BY p.participant_id)::text, '[]'))
    INTO v_before_participants FROM annotation_private.participants p;

  SELECT assignment_version INTO v_active_version
    FROM annotation_private.settings WHERE id = 1;
  IF NOT FOUND THEN RAISE EXCEPTION 'The annotation settings row is missing'; END IF;
  IF v_active_version IS NOT NULL AND v_active_version IS DISTINCT FROM v_version THEN
    RAISE EXCEPTION 'A different fixed assignment version is already active';
  END IF;
  SELECT policy.* INTO v_policy
    FROM annotation_private.settings settings
    JOIN annotation_private.qualification_policies policy
      ON policy.policy_version = settings.qualification_policy_version
   WHERE settings.id = 1;
  IF NOT FOUND OR v_policy.pass_count <> 14 OR v_policy.scored_total <> 18
     OR v_policy.confirmed_scored_count <> 18 OR v_policy.key_status <> 'human_confirmed_scored'
     OR v_policy.qualification_version IS DISTINCT FROM (
       SELECT qualification_version FROM annotation_private.settings WHERE id = 1
     ) THEN
    RAISE EXCEPTION 'The active qualification policy must be the confirmed 14-of-18 policy';
  END IF;
  IF v_active_version IS NULL THEN
    INSERT INTO annotation_private.fixed_package_sets
      (assignment_version, fingerprint, package_count, items_per_package, ratings_per_item)
    VALUES (v_version, v_fingerprint, 9, 42, 3)
    ON CONFLICT (assignment_version) DO NOTHING;
    IF NOT EXISTS (SELECT 1 FROM annotation_private.fixed_package_sets
                   WHERE assignment_version = v_version AND fingerprint = v_fingerprint
                     AND package_count = 9 AND items_per_package = 42 AND ratings_per_item = 3) THEN
      RAISE EXCEPTION 'An existing fixed package set conflicts with this plan';
    END IF;

    INSERT INTO annotation_private.fixed_package_slots (assignment_version, package_id, ordinal)
    SELECT v_version, p.package_id, p.ordinal
      FROM pg_catalog.jsonb_to_recordset(v_plan -> 'packages') AS p(package_id text, ordinal integer, items jsonb)
    ON CONFLICT (assignment_version, package_id) DO NOTHING;
    INSERT INTO annotation_private.fixed_package_items
      (assignment_version, package_id, position, item_id, template_id)
    SELECT v_version, p.package_id, (expanded.item ->> 'position')::integer,
           expanded.item ->> 'item_id', expanded.item ->> 'template_id'
      FROM pg_catalog.jsonb_to_recordset(v_plan -> 'packages') AS p(package_id text, ordinal integer, items jsonb)
      CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(p.items) AS expanded(item)
    ON CONFLICT (assignment_version, package_id, position) DO NOTHING;

    IF EXISTS (
      SELECT 1
        FROM pg_catalog.jsonb_to_recordset(v_plan -> 'packages') AS p(package_id text, ordinal integer, items jsonb)
        CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(p.items) AS expanded(item)
        LEFT JOIN annotation_private.fixed_package_items actual
          ON actual.assignment_version = v_version AND actual.package_id = p.package_id
         AND actual.position = (expanded.item ->> 'position')::integer
       WHERE actual.item_id IS DISTINCT FROM (expanded.item ->> 'item_id')
          OR actual.template_id IS DISTINCT FROM (expanded.item ->> 'template_id')
    ) THEN RAISE EXCEPTION 'Existing fixed package items conflict with this plan'; END IF;

    IF EXISTS (
      SELECT 1
        FROM pg_catalog.jsonb_to_recordset(v_plan -> 'packages') AS p(package_id text, ordinal integer, items jsonb)
        LEFT JOIN annotation_private.fixed_package_slots actual
          ON actual.assignment_version = v_version AND actual.package_id = p.package_id
       WHERE actual.ordinal IS DISTINCT FROM p.ordinal
    ) THEN RAISE EXCEPTION 'Existing fixed package slots conflict with this plan'; END IF;

    PERFORM annotation_private._assert_fixed_package_inventory(v_version);
    UPDATE annotation_private.settings SET assignment_version = v_version WHERE id = 1;
  ELSE
    IF NOT EXISTS (SELECT 1 FROM annotation_private.fixed_package_sets
                   WHERE assignment_version = v_version AND fingerprint = v_fingerprint) THEN
      RAISE EXCEPTION 'The active fixed package plan does not match this file';
    END IF;
    PERFORM annotation_private._assert_fixed_package_inventory(v_version);
  END IF;

  SELECT pg_catalog.md5(coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(a) ORDER BY a.task_id)::text, '[]'))
    INTO v_after_assignments FROM annotation_private.assignments a;
  SELECT pg_catalog.md5(coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(q) ORDER BY q.participant_id, q.qualification_version)::text, '[]'))
    INTO v_after_qualification_results FROM annotation_private.qualification_results q;
  SELECT pg_catalog.md5(coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(e) ORDER BY e.event_id)::text, '[]'))
    INTO v_after_events FROM annotation_private.events e;
  SELECT pg_catalog.md5(coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(p) ORDER BY p.participant_id)::text, '[]'))
    INTO v_after_participants FROM annotation_private.participants p;
  IF v_before_assignments IS DISTINCT FROM v_after_assignments
     OR v_before_qualification_results IS DISTINCT FROM v_after_qualification_results
     OR v_before_events IS DISTINCT FROM v_after_events
     OR v_before_participants IS DISTINCT FROM v_after_participants THEN
    RAISE EXCEPTION 'Fixed package activation changed existing annotation or participant data; transaction rolled back';
  END IF;
END;"""
    tag = "$fixed_activation_" + hashlib.sha256(body.encode("utf-8")).hexdigest()[:24] + "$"
    while tag in body:
        tag = tag[:-1] + "x$"
    return f"DO {tag}\n{body}\n{tag};\n"


def setup_sql(plan: dict) -> str:
    migration_path = PUBLIC_ROOT / "supabase" / "migrations" / "20261101010000_fixed_packages.sql"
    migration = migration_path.read_text(encoding="utf-8")
    return (
        "-- Private coordinator setup. Run in a quiet window with no active annotation saves.\n"
        "-- This file contains task IDs and package assignment mappings; do not publish or commit it.\n"
        "-- It atomically applies the additive database migration, imports the frozen plan, activates it,\n"
        "-- and verifies that existing assignments, qualification results, events, and participant rows\n"
        "-- (including identity/recovery fields) remain byte-for-byte equivalent.\n"
        "BEGIN;\n"
        "SET LOCAL standard_conforming_strings = on;\n\n"
        + migration.rstrip()
        + "\n\n"
        + activation_sql(plan)
        + "\n"
        + "SELECT\n"
        + "  plan.assignment_version,\n"
        + "  plan.package_count,\n"
        + "  plan.unique_study_pairs,\n"
        + "  plan.package_item_memberships,\n"
        + "  policy.pass_count AS qualification_pass_count,\n"
        + "  policy.scored_total AS qualification_scored_total,\n"
        + "  counts.legacy_participants,\n"
        + "  counts.fixed_participants\n"
        + "FROM (\n"
        + "  SELECT s.assignment_version, count(DISTINCT slot.package_id)::integer AS package_count,\n"
        + "         count(DISTINCT item.item_id)::integer AS unique_study_pairs, count(item.position)::integer AS package_item_memberships\n"
        + "    FROM annotation_private.fixed_package_sets s\n"
        + "    JOIN annotation_private.fixed_package_slots slot USING (assignment_version)\n"
        + "    JOIN annotation_private.fixed_package_items item USING (assignment_version, package_id)\n"
        + "   WHERE s.assignment_version = " + sql_literal(plan["version"]) + "\n"
        + "   GROUP BY s.assignment_version\n"
        + ") plan\n"
        + "JOIN annotation_private.settings settings ON settings.id = 1 AND settings.assignment_version = plan.assignment_version\n"
        + "JOIN annotation_private.qualification_policies policy ON policy.policy_version = settings.qualification_policy_version\n"
        + "CROSS JOIN (\n"
        + "  SELECT count(*) FILTER (WHERE mode = 'legacy')::integer AS legacy_participants,\n"
        + "         count(*) FILTER (WHERE mode = 'fixed')::integer AS fixed_participants\n"
        + "    FROM annotation_private.fixed_package_participants WHERE assignment_version = " + sql_literal(plan["version"]) + "\n"
        + ") counts;\n\n"
        + "COMMIT;\n"
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--plan", type=Path, required=True, help="Private assignment_plan.private.json from build-fixed-packages.py")
    parser.add_argument("--output-sql", type=Path, required=True, help="New private SQL path outside the public repository")
    args = parser.parse_args(argv)
    helpers = _private_helpers()
    plan_path = args.plan.resolve(strict=True)
    destination = args.output_sql.resolve()
    helpers._assert_private_destination(plan_path, PUBLIC_ROOT.resolve(), "fixed package plan input")
    helpers._assert_private_destination(destination, PUBLIC_ROOT.resolve(), "fixed package activation SQL")
    plan = validate_plan(json.loads(plan_path.read_text(encoding="utf-8")))
    text = setup_sql(plan)
    size = len(text.encode("utf-8"))
    if size > MAX_SQL_FILE_BYTES:
        raise ValueError(f"Generated activation SQL is too large for the SQL Editor limit ({size} bytes)")
    helpers._write_private_file(destination, text)
    print(f"Created private fixed-package setup SQL ({size} bytes) at {destination}")
    print("The single transaction applies the dormant-capable migration, imports and activates 9 packages × 42 items (126 pairs × 3 raters), and checks that existing assignments, qualification results, events, and participant rows are unchanged.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
