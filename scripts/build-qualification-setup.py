#!/usr/bin/env python3
"""Prepare a PRIVATE, additive qualification pilot import for SQL Editor.

No real material or answer key belongs in this public repository. This helper
reads a reviewed local draft, validates its frozen hashes, and emits SQL only
outside the publishing checkout. Publishing availability never opts anyone in.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import sys


PUBLIC_ROOT = Path(__file__).resolve().parents[1]
REVIEW_RELATIVE = Path("data/summary_generation/human_qualification_review_v1")
MIGRATION_RELATIVE = Path("supabase/migrations/20261020000000_qualification_pilot.sql")
VERSION = "qualification-pilot-20261020-v1"
KEY_STATUS = "llm_suggested_unvalidated"
DIMENSIONS = (
    "source_coverage", "readability", "faithfulness", "content_focus", "reference_coverage",
)


def canonical(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def digest(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def read_json(path: Path) -> object:
    return json.loads(path.read_text(encoding="utf-8"))


def load_helpers():
    spec = importlib.util.spec_from_file_location(
        "_annotation_private_setup_helpers", PUBLIC_ROOT / "scripts/build-private-setup.py"
    )
    if spec is None or spec.loader is None:
        raise ValueError("The private setup helper could not be loaded")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def load_packet(research_root: Path) -> tuple[list[dict], list[dict], dict]:
    packet_root = research_root / REVIEW_RELATIVE
    materials = read_json(packet_root / "qualification_materials.json")
    gold = read_json(packet_root / "qualification_gold_suggestions.json")
    report = read_json(packet_root / "validation_report.json")
    if not all(isinstance(value, dict) for value in (materials, gold, report)):
        raise ValueError("The qualification review packet is invalid")
    if (materials.get("human_review_required") is not True or
            gold.get("review_status") != "draft_pending_human_review" or
            gold.get("human_review_required") is not True):
        raise ValueError("This helper only activates the explicitly provisional pilot key")
    if gold.get("qualification_materials_sha256") != digest(canonical(materials)):
        raise ValueError("The qualification answer draft does not match its exact materials")
    for name, expected in report.get("generated_file_sha256", {}).items():
        if name not in {
            "qualification_materials.json", "qualification_gold_suggestions.json", "QUALIFICATION_REVIEW.md",
        }:
            raise ValueError("Unexpected review artifact path")
        if hashlib.sha256((packet_root / name).read_bytes()).hexdigest() != expected:
            raise ValueError("A qualification review artifact changed; rebuild and review it first")
    if set(report.get("generated_file_sha256", {})) != {
        "qualification_materials.json", "qualification_gold_suggestions.json", "QUALIFICATION_REVIEW.md",
    }:
        raise ValueError("The review artifact inventory is incomplete")
    for name, expected in report.get("input_file_sha256", {}).items():
        path = (research_root / name).resolve()
        if not path.is_relative_to(research_root):
            raise ValueError("Unexpected review input path")
        if hashlib.sha256(path.read_bytes()).hexdigest() != expected:
            raise ValueError("A reviewed qualification input changed; rebuild and review it first")
    details = report.get("overlap_checks", {}).get("details", {})
    if any(details.get(key) != [] for key in (
        "source_id_overlap_with_formal_126", "source_content_overlap_with_formal_or_macsum_300",
        "within_qualification_source_duplicates",
    )):
        raise ValueError("The qualification article-disjoint checks are missing or failed")
    items = materials.get("items")
    keys = gold.get("items")
    if not isinstance(items, list) or not isinstance(keys, list) or len(items) != 10 or len(keys) != 10:
        raise ValueError("The pilot requires exactly ten material and answer records")
    by_id = {item["qualification_id"]: item for item in keys}
    if len(by_id) != 10 or set(by_id) != {f"Q{number:02d}" for number in range(1, 11)}:
        raise ValueError("The qualification draft IDs are incomplete")
    counts = {"cnndm": 0, "gumsum": 0}
    scored_count = 0
    for item in items:
        key = by_id[item["qualification_id"]]
        if item.get("dataset") not in counts or item.get("dataset") != key.get("dataset"):
            raise ValueError("Qualification material and answer datasets do not match")
        counts[item["dataset"]] += 1
        for field in ("request", "source", "reference", "summary_a", "summary_b", "title_zh"):
            if not isinstance(item.get(field), str) or not item[field].strip():
                raise ValueError("A required qualification material field is empty")
        if item.get("source_id") != key.get("source_id"):
            raise ValueError("Qualification source identities differ")
        suggestions = key.get("gold_suggestions")
        if not isinstance(suggestions, dict) or set(suggestions) != set(DIMENSIONS):
            raise ValueError("Qualification suggestions must cover exactly five dimensions")
        for suggestion in suggestions.values():
            if suggestion.get("label") not in ("A", "B", "Tie") or type(suggestion.get("scored")) is not bool:
                raise ValueError("A qualification answer suggestion is invalid")
            if suggestion["scored"]:
                scored_count += 1
                if suggestion.get("confidence") != "high":
                    raise ValueError("Only high-confidence suggestions can be scored in the pilot")
    if counts != {"cnndm": 5, "gumsum": 5} or scored_count != 18:
        raise ValueError("The pilot must use five articles per dataset and eighteen scored judgments")
    return items, keys, report


def prepare_records(items: list[dict], keys: list[dict]) -> tuple[dict, list[dict], list[dict]]:
    by_id = {key["qualification_id"]: key for key in keys}
    templates = []
    presented_keys = []
    for scheme in (1, 2, 3):
        for item in sorted(items, key=lambda value: value["qualification_id"]):
            number = int(item["qualification_id"][1:])
            swapped = scheme == 2 or (scheme == 3 and number % 2 == 0)
            payload = {field: item[field] for field in ("request", "source", "reference")}
            payload["summary_a"] = item["summary_b" if swapped else "summary_a"]
            payload["summary_b"] = item["summary_a" if swapped else "summary_b"]
            hashes = {f"{field}_sha256": digest(value) for field, value in payload.items()}
            template_id = "qualification_" + digest(f"{VERSION}|{scheme}|{item['qualification_id']}")[:32]
            templates.append({
                "template_id": template_id, "scheme": scheme, "kind": "qualification", "position": number,
                "payload": payload, "hashes": hashes,
                "coordinator": {
                    "qualification_version": VERSION, "qualification_id": item["qualification_id"],
                    "dataset": item["dataset"], "source_id": item["source_id"], "review_orientation_swapped": swapped,
                },
            })
            suggestions = {}
            for dimension, suggestion in by_id[item["qualification_id"]]["gold_suggestions"].items():
                label = suggestion["label"]
                if swapped and label in ("A", "B"):
                    label = "B" if label == "A" else "A"
                # The rationale names the original review orientation. Remap
                # isolated A/B tokens too, not letters inside ordinary words.
                rationale = suggestion["rationale_zh"]
                if swapped:
                    import re
                    rationale = re.sub(r"(?<![A-Za-z])[AB](?![A-Za-z])", lambda m: "B" if m[0] == "A" else "A", rationale)
                suggestions[dimension] = {
                    "label": label, "scored": suggestion["scored"], "rationale_zh": rationale,
                    "confidence": suggestion["confidence"],
                }
            presented_keys.append({
                "template_id": template_id, "qualification_version": VERSION,
                "qualification_id": item["qualification_id"], "dataset": item["dataset"],
                "title_zh": item["title_zh"], "suggestions": suggestions,
            })
    config = {
        "qualification_version": VERSION, "fingerprint": digest(canonical({"templates": templates, "keys": presented_keys})),
        "item_count": 10, "scored_total": 18, "pass_count": 15, "key_status": KEY_STATUS,
    }
    return config, templates, presented_keys


def build_sql(helpers, migration: str, config: dict, templates: list[dict], keys: list[dict]) -> str:
    sql_value = helpers.literal
    json_value = helpers.json_literal
    statements = [migration]
    config_json = json_value(config)
    statements.append(helpers.do_block("\n".join([
        "DECLARE v_expected jsonb := " + config_json + "; BEGIN",
        "IF EXISTS (SELECT 1 FROM annotation_private.qualification_sets q WHERE qualification_version=" + sql_value(VERSION)
        + " AND to_jsonb(q) IS DISTINCT FROM v_expected) THEN RAISE EXCEPTION 'Qualification version differs; refusing to overwrite'; END IF;",
        "IF NOT EXISTS (SELECT 1 FROM annotation_private.qualification_sets WHERE qualification_version=" + sql_value(VERSION) + ") THEN",
        "INSERT INTO annotation_private.qualification_sets (qualification_version,fingerprint,item_count,scored_total,pass_count,key_status) VALUES ("
        + ",".join([sql_value(VERSION), sql_value(config["fingerprint"]), "10", "18", "15", sql_value(KEY_STATUS)])
        + "); END IF; END;",
    ])))
    for template, key in zip(templates, keys):
        # Activated rows reject even no-op INSERTs in BEFORE triggers. Compare
        # first, then skip existing identical rows without attempting a write.
        statements.append(helpers.do_block("\n".join([
            "DECLARE v_expected jsonb := " + json_value(template) + "; BEGIN",
            "IF EXISTS (SELECT 1 FROM annotation_private.templates t WHERE template_id=" + sql_value(template["template_id"])
            + " AND to_jsonb(t) IS DISTINCT FROM v_expected) THEN RAISE EXCEPTION 'Existing template material differs; refusing to overwrite'; END IF;",
            "IF NOT EXISTS (SELECT 1 FROM annotation_private.templates WHERE template_id=" + sql_value(template["template_id"]) + ") THEN",
            "INSERT INTO annotation_private.templates (template_id,scheme,kind,position,payload,hashes,coordinator) VALUES ("
            + ",".join([sql_value(template["template_id"]), str(template["scheme"]), sql_value("qualification"), str(template["position"]),
                        "v_expected->'payload'", "v_expected->'hashes'", "v_expected->'coordinator'"])
            + "); END IF; END;",
        ])))
        statements.append(helpers.do_block("\n".join([
            "DECLARE v_expected jsonb := " + json_value(key) + "; BEGIN",
            "IF EXISTS (SELECT 1 FROM annotation_private.qualification_keys q WHERE template_id=" + sql_value(key["template_id"])
            + " AND to_jsonb(q) IS DISTINCT FROM v_expected) THEN RAISE EXCEPTION 'Qualification answer key differs; refusing to overwrite'; END IF;",
            "IF NOT EXISTS (SELECT 1 FROM annotation_private.qualification_keys WHERE template_id=" + sql_value(key["template_id"]) + ") THEN",
            "INSERT INTO annotation_private.qualification_keys (template_id,qualification_version,qualification_id,dataset,title_zh,suggestions) VALUES ("
            + ",".join([sql_value(key[field]) for field in ("template_id", "qualification_version", "qualification_id", "dataset", "title_zh")])
            + "," + json_value(key["suggestions"]) + "); END IF; END;",
        ])))
    statements.append(helpers.do_block("\n".join([
        "BEGIN",
        "IF NOT EXISTS (SELECT 1 FROM annotation_private.settings WHERE id=1) THEN RAISE EXCEPTION 'Initialize the existing study before adding the pilot'; END IF;",
        "IF EXISTS (SELECT 1 FROM annotation_private.settings WHERE id=1 AND qualification_version IS NOT NULL AND qualification_version <> "
        + sql_value(VERSION) + ") THEN RAISE EXCEPTION 'Another qualification version is available; refusing to replace it'; END IF;",
        "UPDATE annotation_private.settings SET qualification_version=" + sql_value(VERSION) + " WHERE id=1 AND qualification_version IS NULL;",
        "PERFORM annotation_private._assert_qualification_inventory();",
        # No participant UPDATE or historical-answer import here. Opt-in is
        # performed only by an authenticated start_qualification request.
        "END;",
    ])))
    return helpers.transaction_sql(statements, "Add the optional qualification pilot without enrolling or resetting any participant", [
        "SELECT qualification_version,item_count,scored_total,pass_count,key_status FROM annotation_private.qualification_sets WHERE qualification_version=" + sql_value(VERSION) + ";",
        "SELECT scheme,count(*) AS qualification_templates FROM annotation_private.templates WHERE kind='qualification' GROUP BY scheme ORDER BY scheme;",
    ])


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--research-root", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--expected-output", type=Path)
    args = parser.parse_args(argv)
    helpers = load_helpers()
    destination = args.output.resolve()
    expected_path = args.expected_output.resolve() if args.expected_output else None
    helpers._assert_private_destination(destination, PUBLIC_ROOT, "qualification SQL")
    if destination.exists():
        parser.error("Choose a new output path; existing private SQL is never overwritten")
    if expected_path:
        helpers._assert_private_destination(expected_path, PUBLIC_ROOT, "qualification verification fixture")
        if expected_path == destination or expected_path.exists():
            parser.error("Choose a distinct, new private verification path")
    items, keys, report = load_packet(args.research_root.resolve())
    config, templates, presented_keys = prepare_records(items, keys)
    migration_path = PUBLIC_ROOT / MIGRATION_RELATIVE
    sql = build_sql(helpers, migration_path.read_text(encoding="utf-8"), config, templates, presented_keys)
    if len(sql.encode("utf-8")) > helpers.MAX_SQL_FILE_BYTES:
        parser.error("The private upgrade exceeds the safe SQL Editor query limit")
    expected_text = None
    if expected_path:
        expected = {
            "config": config, "templates": templates, "keys": presented_keys,
            "sql_sha256": digest(sql), "migration_sha256": hashlib.sha256(migration_path.read_bytes()).hexdigest(),
            "formal_fingerprint": report["frozen_formal_dataset"]["fingerprint"],
        }
        expected_text = json.dumps(expected, ensure_ascii=False, indent=2) + "\n"
    staged = None
    staged_expected = None
    published = False
    published_expected = False
    try:
        staged = helpers._stage_private_file(destination, sql)
        if expected_path and expected_text:
            staged_expected = helpers._stage_private_file(expected_path, expected_text)
        helpers._publish_private_file(staged, destination)
        published = True
        if expected_path and staged_expected:
            helpers._publish_private_file(staged_expected, expected_path)
            published_expected = True
    except BaseException:
        # Remove only files created by this invocation, never an existing file.
        if published_expected:
            expected_path.unlink(missing_ok=True)
        if published:
            destination.unlink(missing_ok=True)
        raise
    finally:
        if staged:
            staged.unlink(missing_ok=True)
        if staged_expected:
            staged_expected.unlink(missing_ok=True)
    print(f"Private pilot import: {destination}")
    print(f"{len(sql.encode('utf-8')):,} UTF-8 bytes; 30 private templates; 18 scored judgments; provisional pass threshold 15.")
    print("Optional availability only. No participant is opted in and no historical response is reset.")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (ValueError, KeyError, OSError, TypeError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        raise SystemExit(2)
