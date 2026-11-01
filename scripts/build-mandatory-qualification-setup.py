#!/usr/bin/env python3
"""Prepare a private, additive approval of the mandatory qualification policy.

The coordinator must explicitly confirm the scored key. No candidate texts,
answer labels, participant IDs or recovery credentials enter the public repo.
The original pilot answers and evaluation snapshots are never overwritten.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import sys

PUBLIC_ROOT = Path(__file__).resolve().parents[1]
POLICY_VERSION = "qualification-required-20261101-v1"
KEY_VERSION = "qualification-pilot-20261020-v1"
KEY_STATUS = "human_confirmed_scored"
DIMENSIONS = {"source_coverage", "reference_coverage", "readability", "faithfulness", "content_focus"}


def sha(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def canonical(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def read_json(path: Path) -> dict:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError("Expected a JSON object")
    return value


def helpers():
    spec = importlib.util.spec_from_file_location("_private_sql_helpers", PUBLIC_ROOT / "scripts/build-private-setup.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def workflow_guide(original: str) -> str:
    before = "Read these instructions and complete the practice comparisons. Ask the study coordinator about anything that is unclear before starting the main study."
    after = ("Read these instructions and complete all 10 qualification comparisons before starting the main study. "
             "At least 14 of the 18 scored judgments must match the human-confirmed answer key. "
             "Study comparisons remain unavailable unless you pass. Your qualification result and feedback appear only after all 10 comparisons are complete; "
             "submitted qualification answers cannot be changed or retried after seeing feedback. "
             "Ask the study coordinator about anything that is unclear.")
    if not isinstance(original, str) or original.count(before) != 1:
        raise ValueError("The frozen guide does not match the expected workflow paragraph")
    updated = original.replace(before, after)
    if "practice" in updated.lower():
        raise ValueError("Unexpected practice workflow text remains in the guide")
    # Only the workflow paragraph changes, not any criterion or choice wording.
    if updated.split("## Choosing an answer", 1)[1] != original.split("## Choosing an answer", 1)[1]:
        raise ValueError("The rubric wording changed")
    return updated


def approve_review(review: dict, expected: dict, guide: str) -> tuple[dict, dict]:
    config = expected.get("config", {})
    if (config.get("qualification_version") != KEY_VERSION or config.get("item_count") != 10 or
            config.get("scored_total") != 18 or config.get("pass_count") != 15):
        raise ValueError("The frozen pilot fixture has an unexpected configuration")
    fingerprint = sha(canonical({"templates": expected.get("templates"), "keys": expected.get("keys")}))
    if fingerprint != config.get("fingerprint"):
        raise ValueError("The frozen qualification fixture fingerprint does not match its materials/key")
    if (review.get("version") != KEY_VERSION or review.get("key_status") != "llm_suggested_unvalidated" or
            review.get("total") != 18 or review.get("pass_count") != 15 or not isinstance(review.get("items"), list) or
            len(review["items"]) != 10):
        raise ValueError("The review export is not a complete original-pilot result")
    ids = {f"Q{i:02d}" for i in range(1, 11)}
    if {item.get("qualification_id") for item in review["items"]} != ids:
        raise ValueError("The ten review example IDs are invalid")
    template_schemes = {row["template_id"]: row["scheme"] for row in expected["templates"]}
    possible_schemes = []
    for scheme in (1, 2, 3):
        key_by_id = {key["qualification_id"]: key for key in expected["keys"] if template_schemes[key["template_id"]] == scheme}
        if set(key_by_id) != ids:
            raise ValueError("The frozen qualification key inventory is incomplete")
        valid = True
        for item in review["items"]:
            dims = item.get("dimensions", [])
            key = key_by_id[item["qualification_id"]]
            if len(dims) != 5 or {d.get("id") for d in dims} != DIMENSIONS or item.get("dataset") != key["dataset"]:
                valid = False
                break
            for dimension in dims:
                suggestion = key["suggestions"][dimension["id"]]
                if (dimension.get("suggested") != suggestion["label"] or dimension.get("scored") is not suggestion["scored"] or
                        dimension.get("answer") not in {"A", "B", "Tie"} or
                        dimension.get("matches") is not (dimension["answer"] == dimension["suggested"])):
                    valid = False
                    break
        if valid:
            possible_schemes.append(scheme)
    if not possible_schemes:
        raise ValueError("The review labels/masks do not match any frozen presentation scheme")
    scored = [d for item in review["items"] for d in item["dimensions"] if d["scored"]]
    if len(scored) != 18 or sum(d["matches"] for d in scored) != review.get("matched"):
        raise ValueError("The review score is inconsistent with the item answers")
    all_dims = [d for item in review["items"] for d in item["dimensions"]]
    if (review.get("overall", {}).get("total") != 50 or
            review.get("overall", {}).get("matched") != sum(d["matches"] for d in all_dims)):
        raise ValueError("The full review agreement is inconsistent")
    updated_guide = workflow_guide(guide)
    policy = {
        "policy_version": POLICY_VERSION, "qualification_version": KEY_VERSION,
        "fingerprint": fingerprint, "pass_count": 14, "scored_total": 18,
        "key_status": KEY_STATUS, "confirmed_scored_count": 18,
        "workflow_guide_md": updated_guide, "workflow_guide_sha256": sha(updated_guide),
    }
    # Use the original review orientation for the local adjudication record.
    # Every scored final label equals its existing suggestion by explicit
    # coordinator confirmation. Do not alter the reviewer's saved choices.
    approval = {
        "policy_version": POLICY_VERSION, "qualification_version": KEY_VERSION,
        "review_sha256": sha(canonical(review)), "human_reviewers": 1,
        "confirmation": "Coordinator confirmed all 18 scored suggested labels, including the initial disagreements.",
        "review_scored_matches": review["matched"], "review_scored_total": 18,
        "pass_count": 14, "confirmed_scored_count": 18, "exploratory_count": 32,
        "scored_labels": [{"qualification_id": item["qualification_id"], "dimension": d["id"],
                           "review_answer": d["answer"], "final_label": d["suggested"],
                           "initially_agreed": d["matches"]}
                          for item in review["items"] for d in item["dimensions"] if d["scored"]],
        "policy": policy,
    }
    return policy, approval


def build_sql(h, migration: str, policy: dict) -> str:
    literal = h.literal
    return h.transaction_sql([migration, h.do_block("\n".join([
        "DECLARE v_expected jsonb := " + h.json_literal(policy) + "; BEGIN",
        "IF EXISTS (SELECT 1 FROM annotation_private.qualification_policies p WHERE policy_version=" + literal(POLICY_VERSION)
        + " AND (to_jsonb(p)-'approved_at') IS DISTINCT FROM v_expected) THEN RAISE EXCEPTION 'Qualification policy differs; refusing to overwrite'; END IF;",
        "IF NOT EXISTS (SELECT 1 FROM annotation_private.qualification_policies WHERE policy_version=" + literal(POLICY_VERSION) + ") THEN",
        "INSERT INTO annotation_private.qualification_policies (policy_version,qualification_version,fingerprint,pass_count,scored_total,key_status,confirmed_scored_count,workflow_guide_md,workflow_guide_sha256) VALUES ("
        + ",".join([literal(policy[k]) for k in ("policy_version", "qualification_version", "fingerprint")])
        + ",14,18," + literal(KEY_STATUS) + ",18," + literal(policy["workflow_guide_md"]) + "," + literal(policy["workflow_guide_sha256"]) + "); END IF;",
        "IF EXISTS (SELECT 1 FROM annotation_private.settings WHERE id=1 AND qualification_policy_version IS NOT NULL AND qualification_policy_version <> "
        + literal(POLICY_VERSION) + ") THEN RAISE EXCEPTION 'Another qualification policy is active'; END IF;",
        "UPDATE annotation_private.settings SET qualification_policy_version=" + literal(POLICY_VERSION) + " WHERE id=1 AND qualification_policy_version IS NULL;",
        "END;",
    ]))], "Approve the human-confirmed scored key and require qualification; preserve all saved answers and original result snapshots", [
        "SELECT p.policy_version,p.pass_count,p.scored_total,p.confirmed_scored_count,p.key_status,(s.qualification_policy_version=p.policy_version) AS mandatory_enabled FROM annotation_private.qualification_policies p JOIN annotation_private.settings s ON s.id=1 WHERE p.policy_version=" + literal(POLICY_VERSION) + ";",
    ])


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--research-root", type=Path, required=True)
    parser.add_argument("--review-result", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--approval-output", type=Path, required=True)
    parser.add_argument("--confirm-scored-key", action="store_true", required=True)
    args = parser.parse_args()
    h = helpers()
    destination, approval_path = args.output.resolve(), args.approval_output.resolve()
    for path in (destination, approval_path):
        h._assert_private_destination(path, PUBLIC_ROOT, "mandatory qualification approval")
        if path.exists():
            raise ValueError("Existing approval files are never overwritten")
    if destination == approval_path:
        raise ValueError("Choose distinct SQL and approval paths")
    setup = args.research_root.resolve() / "data/summary_generation/human_preference_annotation_v1/online_setup"
    expected = read_json(setup / "qualification-pilot-expected-private.json")
    original = read_json(setup / "expected-private.json")["settings"]["guide_md"]
    policy, approval = approve_review(read_json(args.review_result), expected, original)
    migration = (PUBLIC_ROOT / "supabase/migrations/20261101000000_mandatory_qualification.sql").read_text(encoding="utf-8")
    sql = build_sql(h, migration, policy)
    if len(sql.encode("utf-8")) > h.MAX_SQL_FILE_BYTES:
        raise ValueError("The upgrade exceeds the SQL Editor size limit")
    approval["sql_sha256"] = sha(sql)
    approval["migration_sha256"] = sha(migration)
    staged = []
    published = []
    try:
        for path, text in ((destination, sql), (approval_path, json.dumps(approval, ensure_ascii=False, indent=2) + "\n")):
            staged.append((path, h._stage_private_file(path, text)))
        for path, temporary in staged:
            h._publish_private_file(temporary, path)
            published.append(path)
    except BaseException:
        for path in published:
            path.unlink(missing_ok=True)
        raise
    finally:
        for _, temporary in staged:
            temporary.unlink(missing_ok=True)
    print(f"Private mandatory qualification upgrade: {destination}")
    print(f"{len(sql.encode('utf-8')):,} bytes; 18 human-confirmed scored labels; pass >=14/18; original responses remain unchanged.")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, TypeError, KeyError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        raise SystemExit(2)
