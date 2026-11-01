#!/usr/bin/env python3
"""Create an English-feedback derivative of a frozen private task packet.

The source packet remains immutable. This builder copies its assignments and
materials byte-for-byte, translates only the qualification title/rationale
projection using a separately validated 30-template feedback file, and writes
the result to a new private directory.
"""
from __future__ import annotations

import argparse
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import tempfile

ROOT = Path(__file__).resolve().parents[1]
PACKAGE_FILES = [f"package_{i:02d}.json" for i in range(1, 10)]
PRIVATE_FILES = [*PACKAGE_FILES, "manifest.private.json", "qualification_key.private.json",
                 "analysis_mapping.private.json", "assignment_plan.private.json",
                 "validation_report.json"]
FEEDBACK_FILE = "qualification_feedback_en.private.json"
REPORT_FILE = "english_handoff_report.private.json"
FEEDBACK_VERSION = "qualification-feedback-en-20261101-v1"
QUALIFICATION_VERSION = "qualification-pilot-20261020-v1"
DIMENSIONS = ("source_coverage", "reference_coverage", "readability", "faithfulness", "content_focus")
CHOICES = {"A", "B", "Tie"}
HEX_64 = re.compile(r"^[0-9a-f]{64}$")


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _json_bytes(value: object) -> bytes:
    return (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def _load_json(raw: bytes, name: str) -> object:
    try:
        return json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError(f"{name} is not valid UTF-8 JSON") from error


def _private_helpers():
    path = ROOT / "scripts" / "build-private-setup.py"
    spec = importlib.util.spec_from_file_location("_english_handoff_private_helpers", path)
    if spec is None or spec.loader is None:
        raise RuntimeError("Could not load the private-output helper")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _verify_original_packet(source: Path) -> tuple[dict, dict[str, bytes], list[dict]]:
    if not source.is_dir():
        raise ValueError("The source packet directory does not exist")
    raw_files: dict[str, bytes] = {}
    for name in PRIVATE_FILES:
        path = source / name
        if not path.is_file() or path.is_symlink():
            raise ValueError(f"The frozen source packet is missing a regular file: {name}")
        raw_files[name] = path.read_bytes()

    manifest = _load_json(raw_files["manifest.private.json"], "manifest.private.json")
    if not isinstance(manifest, dict):
        raise ValueError("The source manifest must be a JSON object")
    expected_hashes = manifest.get("private_file_sha256")
    if not isinstance(expected_hashes, dict) or set(expected_hashes) != set(PRIVATE_FILES) - {"manifest.private.json"}:
        raise ValueError("The frozen source manifest checksum inventory is incomplete")
    for name, digest in expected_hashes.items():
        if not isinstance(digest, str) or _sha(raw_files[name]) != digest:
            raise ValueError(f"The frozen source checksum does not match {name}")

    expected_packages = set(PACKAGE_FILES)
    entries = manifest.get("packages")
    if (not isinstance(entries, list) or len(entries) != 9 or
            {row.get("file") for row in entries if isinstance(row, dict)} != expected_packages):
        raise ValueError("The package manifest inventory is invalid")
    for row in entries:
        if _sha(raw_files[row["file"]]) != row.get("sha256"):
            raise ValueError(f"The frozen package checksum does not match {row['file']}")

    packages = [_load_json(raw_files[name], name) for name in PACKAGE_FILES]
    if any(not isinstance(package, dict) for package in packages):
        raise ValueError("A frozen package is not a JSON object")
    assignment_version = manifest.get("assignment_version")
    if not assignment_version or any(package.get("assignment_version") != assignment_version for package in packages):
        raise ValueError("The frozen packages do not share the manifest assignment version")
    qualification = packages[0].get("qualification")
    if not isinstance(qualification, list) or len(qualification) != 10:
        raise ValueError("The frozen packages must contain ten common qualification items")
    for package in packages:
        if (package.get("qualification") != qualification or not isinstance(package.get("study"), list)
                or len(package["study"]) != 42):
            raise ValueError("The frozen package task inventory has changed")
        item_ids = [row.get("item_id") for row in package["study"]]
        if len(set(item_ids)) != 42:
            raise ValueError("A frozen package contains duplicate study items")
    assignment_counts: dict[str, int] = {}
    for package in packages:
        for item in package["study"]:
            item_id = item.get("item_id")
            if not isinstance(item_id, str) or not item_id:
                raise ValueError("A frozen package has an invalid study item ID")
            assignment_counts[item_id] = assignment_counts.get(item_id, 0) + 1
    if len(assignment_counts) != 126 or set(assignment_counts.values()) != {3}:
        raise ValueError("The frozen allocation is not 126 study items assigned three times each")
    return manifest, raw_files, packages


def _validate_english_text(text: object, label: str, maximum: int) -> str:
    if not isinstance(text, str) or not text or text.strip() != text:
        raise ValueError(f"{label} must be non-empty text")
    if len(text) > maximum or not all(0x20 <= ord(char) <= 0x7E for char in text):
        raise ValueError(f"{label} must use single-line printable ASCII English text")
    return text


def _validate_feedback(feedback: object, package_qualification: list[dict]) -> dict[str, dict]:
    expected_top = {"feedback_version", "qualification_version", "qualification_fingerprint", "language", "items"}
    if not isinstance(feedback, dict) or set(feedback) != expected_top:
        raise ValueError("The expanded feedback file does not match the approved top-level contract")
    if feedback.get("feedback_version") != FEEDBACK_VERSION or feedback.get("qualification_version") != QUALIFICATION_VERSION:
        raise ValueError("The expanded feedback version does not match the frozen qualification")
    if feedback.get("language") != "en" or not isinstance(feedback.get("qualification_fingerprint"), str) or not HEX_64.fullmatch(feedback["qualification_fingerprint"]):
        raise ValueError("The expanded feedback language or qualification fingerprint is invalid")
    items = feedback.get("items")
    if not isinstance(items, list) or len(items) != 30:
        raise ValueError("The expanded feedback must contain exactly 30 template-specific rows")
    by_template: dict[str, dict] = {}
    by_qid: dict[str, list[dict]] = {}
    expected_item = {"template_id", "qualification_id", "title_en", "rationales_en"}
    for row in items:
        if not isinstance(row, dict) or set(row) != expected_item:
            raise ValueError("An expanded feedback row does not match the approved contract")
        template_id, qid = row.get("template_id"), row.get("qualification_id")
        if not isinstance(template_id, str) or not template_id or qid not in {f"Q{i:02d}" for i in range(1, 11)}:
            raise ValueError("An expanded feedback row has an invalid template or qualification ID")
        if template_id in by_template:
            raise ValueError("The expanded feedback repeats a template ID")
        _validate_english_text(row.get("title_en"), f"{template_id} title", 160)
        rationales = row.get("rationales_en")
        if not isinstance(rationales, dict) or set(rationales) != set(DIMENSIONS):
            raise ValueError(f"{template_id} must provide English rationale for all five dimensions")
        for dimension in DIMENSIONS:
            _validate_english_text(rationales[dimension], f"{template_id} {dimension} rationale", 500)
        by_template[template_id] = row
        by_qid.setdefault(qid, []).append(row)

    if set(by_qid) != {f"Q{i:02d}" for i in range(1, 11)} or any(len(rows) != 3 for rows in by_qid.values()):
        raise ValueError("The expanded feedback must cover Q01–Q10 in all three presentation schemes")
    for qid, rows in by_qid.items():
        if len({row["title_en"] for row in rows}) != 1:
            raise ValueError(f"The English title differs across presentation schemes for {qid}")

    canonical_ids = {row.get("template_id") for row in package_qualification}
    if len(canonical_ids) != 10 or not all(canonical_ids):
        raise ValueError("The frozen package qualification template inventory is invalid")
    canonical_feedback_ids = {row["template_id"] for row in items if row["template_id"] in canonical_ids}
    if canonical_feedback_ids != canonical_ids:
        raise ValueError("The expanded feedback does not contain every canonical package template")
    for item in package_qualification:
        row = by_template[item["template_id"]]
        if row["qualification_id"] != item.get("item_id"):
            raise ValueError("An English feedback row does not match its frozen qualification item")
    return by_template


def _validate_key(key: object) -> list[dict]:
    if not isinstance(key, dict) or key.get("schema_version") != "qualification-key-private-v1":
        raise ValueError("The frozen qualification key schema is invalid")
    if (key.get("qualification_version") != QUALIFICATION_VERSION or key.get("pass_count") != 14
            or key.get("scored_total") != 18 or key.get("confirmed_scored_count") != 18
            or key.get("key_status") != "human_confirmed_scored"):
        raise ValueError("The frozen qualification key does not retain the confirmed 14/18 policy")
    items = key.get("items")
    if not isinstance(items, list) or len(items) != 10:
        raise ValueError("The frozen qualification key must contain ten canonical items")
    if ({row.get("qualification_id") for row in items if isinstance(row, dict)} != {f"Q{i:02d}" for i in range(1, 11)}
            or len({row.get("template_id") for row in items if isinstance(row, dict)}) != 10):
        raise ValueError("The frozen qualification key must cover Q01–Q10 exactly once")
    scored = 0
    exploratory = 0
    for item in items:
        if not isinstance(item, dict) or not isinstance(item.get("judgments"), dict):
            raise ValueError("A frozen qualification key item is malformed")
        if not isinstance(item.get("title_zh"), str):
            raise ValueError("A frozen qualification key item is missing its original title")
        if not isinstance(item.get("template_id"), str) or not item["template_id"]:
            raise ValueError("A frozen qualification key item is missing its canonical template ID")
        if set(item["judgments"]) != set(DIMENSIONS):
            raise ValueError("A frozen qualification item does not contain exactly five dimensions")
        for dimension, judgment in item["judgments"].items():
            if not isinstance(judgment, dict) or judgment.get("label") not in CHOICES:
                raise ValueError("A frozen qualification key contains an invalid answer label")
            if not isinstance(judgment.get("rationale_zh"), str):
                raise ValueError("A frozen qualification key judgment is missing its original rationale")
            if type(judgment.get("scored")) is not bool:
                raise ValueError("A qualification key scored mask must contain Boolean values")
            is_scored = judgment.get("scored") is True
            expected_status = "human_confirmed" if is_scored else "ai_provisional_exploratory"
            if judgment.get("label_status") != expected_status:
                raise ValueError("A qualification label status does not match its scored mask")
            scored += int(is_scored)
            exploratory += int(not is_scored)
    if scored != 18 or exploratory != 32:
        raise ValueError("The frozen qualification key must preserve 18 scored labels and 32 suggestions")
    return items


def _project_english_key(original: dict, feedback_by_template: dict[str, dict]) -> dict:
    translated = copy.deepcopy(original)
    for item in translated["items"]:
        template_id = item["template_id"]
        row = feedback_by_template.get(template_id)
        if row is None or row["qualification_id"] != item["qualification_id"]:
            raise ValueError("The expanded English feedback is missing a canonical key template")
        item["title_en"] = row["title_en"]
        del item["title_zh"]
        for dimension, judgment in item["judgments"].items():
            judgment["rationale_en"] = row["rationales_en"][dimension]
            del judgment["rationale_zh"]
    translated["schema_version"] = "qualification-key-private-en-v1"
    translated["feedback_version"] = FEEDBACK_VERSION
    translated["feedback_language"] = "en"
    return translated


def _assert_only_text_projection_changed(original: dict, translated: dict) -> None:
    old = copy.deepcopy(original)
    new = copy.deepcopy(translated)
    for item in old["items"]:
        item.pop("title_zh")
        for judgment in item["judgments"].values():
            judgment.pop("rationale_zh")
    for item in new["items"]:
        item.pop("title_en")
        for judgment in item["judgments"].values():
            judgment.pop("rationale_en")
    for metadata in (old, new):
        metadata.pop("schema_version", None)
        metadata.pop("feedback_version", None)
        metadata.pop("feedback_language", None)
    if old != new:
        raise ValueError("English projection changed a label, mask, status, or other key field")


def _verify_no_chinese_key(key: dict) -> None:
    serialized = json.dumps(key, ensure_ascii=False)
    if any("\u3400" <= char <= "\u4dbf" or "\u4e00" <= char <= "\u9fff" or "\U00020000" <= char <= "\U000323af" for char in serialized):
        raise ValueError("The derived qualification key still contains non-English Chinese text")


def build(source: Path, feedback_path: Path, destination: Path) -> None:
    helper = _private_helpers()
    helper._assert_private_destination(source, ROOT, "source package directory")
    helper._assert_private_destination(feedback_path, ROOT, "expanded feedback input")
    helper._assert_private_destination(destination, ROOT, "English handoff output")
    if destination.exists():
        raise FileExistsError(f"Refusing to overwrite an existing derived packet: {destination}")
    if destination == source or destination.parent != source or destination.name != "english_handoff_v1":
        raise ValueError("Output must be a new english_handoff_v1 child of the frozen source packet")
    if not feedback_path.is_file() or feedback_path.is_symlink():
        raise ValueError("The expanded English feedback input must be a regular file")

    source_manifest, original_bytes, packages = _verify_original_packet(source)
    original_key = _load_json(original_bytes["qualification_key.private.json"], "qualification_key.private.json")
    original_items = _validate_key(original_key)
    feedback_raw = feedback_path.read_bytes()
    feedback = _load_json(feedback_raw, FEEDBACK_FILE)
    feedback_by_template = _validate_feedback(feedback, packages[0]["qualification"])
    key_by_template = {item["template_id"]: item for item in original_items}
    if len(key_by_template) != 10:
        raise ValueError("The frozen key does not contain ten unique canonical templates")
    for template_id, item in key_by_template.items():
        row = feedback_by_template.get(template_id)
        if row is None or row["qualification_id"] != item["qualification_id"]:
            raise ValueError("Canonical key and expanded feedback template IDs do not align")

    translated_key = _project_english_key(original_key, feedback_by_template)
    _assert_only_text_projection_changed(original_key, translated_key)
    _verify_no_chinese_key(translated_key)
    translated_key_raw = _json_bytes(translated_key)

    output_files = dict(original_bytes)
    output_files["qualification_key.private.json"] = translated_key_raw
    output_files[FEEDBACK_FILE] = feedback_raw
    manifest = copy.deepcopy(source_manifest)
    manifest["language"] = "en"
    manifest["feedback_version"] = FEEDBACK_VERSION
    manifest["handoff_revision"] = "english-qualification-feedback-20261101-v1"
    report = {
        "schema_version": "english-handoff-validation-v1",
        "handoff_revision": manifest["handoff_revision"],
        "feedback_version": FEEDBACK_VERSION,
        "language": "en",
        "qualification_version": QUALIFICATION_VERSION,
        "qualification_fingerprint": feedback["qualification_fingerprint"],
        "source_manifest_sha256": _sha(original_bytes["manifest.private.json"]),
        "source_key_sha256": _sha(original_bytes["qualification_key.private.json"]),
        "derived_key_sha256": _sha(translated_key_raw),
        "feedback_file_sha256": _sha(feedback_raw),
        "checks": {
            "assignment_version_unchanged": manifest.get("assignment_version") == source_manifest.get("assignment_version"),
            "nine_package_files_byte_identical": all(output_files[name] == original_bytes[name] for name in PACKAGE_FILES),
            "assignment_plan_byte_identical": output_files["assignment_plan.private.json"] == original_bytes["assignment_plan.private.json"],
            "analysis_mapping_byte_identical": output_files["analysis_mapping.private.json"] == original_bytes["analysis_mapping.private.json"],
            "study_material_byte_identical": all(output_files[name] == original_bytes[name] for name in PACKAGE_FILES),
            "qualification_labels_masks_and_metadata_unchanged": True,
            "qualification_scored_total": 18,
            "qualification_exploratory_total": 32,
            "qualification_pass_count": 14,
            "feedback_templates": len(feedback_by_template),
            "all_feedback_ascii_english": True,
            "raw_source_documents_preserved": True,
            "study_item_count": 126,
            "ratings": 378,
        },
    }
    output_files[REPORT_FILE] = _json_bytes(report)
    manifest["private_file_sha256"] = {
        name: _sha(data) for name, data in output_files.items() if name != "manifest.private.json"
    }
    output_files["manifest.private.json"] = _json_bytes(manifest)

    destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    staging = Path(tempfile.mkdtemp(prefix=".english-handoff-building-", dir=destination.parent))
    os.chmod(staging, 0o700)
    try:
        for name, data in output_files.items():
            file_path = staging / name
            descriptor = os.open(file_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(descriptor, "wb") as stream:
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
        helper._rename_directory_noreplace(staging, destination)
    finally:
        if staging.exists():
            for path in staging.iterdir():
                path.unlink()
            staging.rmdir()

    print(f"Created English derived packet: {destination}")
    print("9 frozen package files unchanged; 126 study items × 3 assignments; qualification 14/18.")
    print("Only qualification titles/rationales were projected into English; raw task payloads are unchanged.")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--package-dir", required=True, type=Path, help="Original immutable private packet")
    parser.add_argument("--feedback-json", required=True, type=Path, help="Expanded 30-template English feedback JSON")
    parser.add_argument("--output-dir", required=True, type=Path, help="New english_handoff_v1 child directory")
    args = parser.parse_args(argv)
    if any(path.is_symlink() for path in (args.package_dir, args.feedback_json, args.output_dir)):
        raise ValueError("Source, feedback and output paths must not be symlinks")
    build(args.package_dir.resolve(), args.feedback_json.resolve(), args.output_dir.resolve())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
