#!/usr/bin/env python3
"""Archive the frozen PRIVATE packages and a credential-free UI source snapshot.

This never connects to a service and never includes saved participant records,
database dumps, local configuration, Git history or recovery credentials.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import zipfile
import re

ROOT = Path(__file__).resolve().parents[1]
PACKAGE_FILES = [f"package_{i:02d}.json" for i in range(1, 10)]
BASE_PRIVATE_FILES = [*PACKAGE_FILES, "manifest.private.json", "qualification_key.private.json",
                      "analysis_mapping.private.json", "assignment_plan.private.json",
                      "validation_report.json"]
ENGLISH_EXTRA_FILES = ["qualification_feedback_en.private.json", "english_handoff_report.private.json"]
FEEDBACK_VERSION = "qualification-feedback-en-20261101-v1"
QUALIFICATION_VERSION = "qualification-pilot-20261020-v1"
DIMENSIONS = {"source_coverage", "reference_coverage", "readability", "faithfulness", "content_focus"}
CHOICES = {"A", "B", "Tie"}
HAN = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff\U00020000-\U000323af]")


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _valid_english(value: object, maximum: int = 500) -> bool:
    return (isinstance(value, str) and bool(value) and len(value) <= maximum and value.strip() == value
            and all(0x20 <= ord(char) <= 0x7E for char in value))


def _assert_english_feedback(inputs: dict[str, bytes], manifest: dict, packages: list[dict]) -> None:
    key = json.loads(inputs["qualification_key.private.json"])
    feedback_raw = inputs["qualification_feedback_en.private.json"]
    feedback = json.loads(feedback_raw)
    report = json.loads(inputs["english_handoff_report.private.json"])
    if (manifest.get("language") != "en" or manifest.get("feedback_version") != FEEDBACK_VERSION
            or manifest.get("handoff_revision") != "english-qualification-feedback-20261101-v1"):
        raise ValueError("The English handoff manifest metadata is invalid")
    if (not isinstance(feedback, dict) or set(feedback) != {
            "feedback_version", "qualification_version", "qualification_fingerprint", "language", "items"}
            or feedback.get("feedback_version") != FEEDBACK_VERSION
            or feedback.get("qualification_version") != QUALIFICATION_VERSION or feedback.get("language") != "en"
            or not re.fullmatch(r"[0-9a-f]{64}", str(feedback.get("qualification_fingerprint", "")))):
        raise ValueError("The English qualification feedback version or fingerprint is invalid")
    if (not isinstance(report, dict) or report.get("schema_version") != "english-handoff-validation-v1"
            or report.get("feedback_file_sha256") != _sha(feedback_raw)
            or report.get("derived_key_sha256") != _sha(inputs["qualification_key.private.json"])
            or report.get("feedback_version") != FEEDBACK_VERSION or report.get("language") != "en"
            or report.get("qualification_fingerprint") != feedback.get("qualification_fingerprint")
            or report.get("handoff_revision") != manifest.get("handoff_revision")):
        raise ValueError("The English handoff validation report does not match its key and feedback files")
    checks = report.get("checks")
    if (not isinstance(checks, dict) or checks.get("qualification_labels_masks_and_metadata_unchanged") is not True
            or checks.get("qualification_scored_total") != 18 or checks.get("qualification_exploratory_total") != 32
            or checks.get("qualification_pass_count") != 14 or checks.get("feedback_templates") != 30
            or checks.get("all_feedback_ascii_english") is not True or checks.get("raw_source_documents_preserved") is not True
            or checks.get("study_item_count") != 126 or checks.get("ratings") != 378):
        raise ValueError("The English handoff report does not confirm the required preserved design")

    items = feedback.get("items")
    if not isinstance(items, list) or len(items) != 30:
        raise ValueError("The English feedback inventory must contain 30 rows")
    by_template: dict[str, dict] = {}
    by_qid: dict[str, list[dict]] = {}
    for row in items:
        if (not isinstance(row, dict) or set(row) != {"template_id", "qualification_id", "title_en", "rationales_en"}
                or not isinstance(row.get("template_id"), str) or not row["template_id"]
                or not _valid_english(row.get("title_en"), 160) or not isinstance(row.get("rationales_en"), dict)
                or set(row["rationales_en"]) != DIMENSIONS):
            raise ValueError("An English feedback row does not match the required schema")
        if row["template_id"] in by_template:
            raise ValueError("The English feedback repeats a template ID")
        for rationale in row["rationales_en"].values():
            if not _valid_english(rationale):
                raise ValueError("A qualification rationale is not non-empty ASCII English")
        by_template[row["template_id"]] = row
        by_qid.setdefault(row.get("qualification_id"), []).append(row)
    expected_qids = {f"Q{i:02d}" for i in range(1, 11)}
    if set(by_qid) != expected_qids or any(len(rows) != 3 for rows in by_qid.values()):
        raise ValueError("The English feedback must cover ten qualification items in three schemes each")
    if any(len({row["title_en"] for row in rows}) != 1 for rows in by_qid.values()):
        raise ValueError("An English title differs across schemes for the same qualification item")

    if (not isinstance(key, dict) or key.get("schema_version") != "qualification-key-private-en-v1"
            or key.get("feedback_version") != FEEDBACK_VERSION or key.get("feedback_language") != "en"
            or key.get("qualification_version") != QUALIFICATION_VERSION
            or key.get("pass_count") != 14 or key.get("scored_total") != 18
            or key.get("confirmed_scored_count") != 18 or key.get("key_status") != "human_confirmed_scored"):
        raise ValueError("The English qualification key does not retain the confirmed 14/18 policy")
    key_items = key.get("items")
    if not isinstance(key_items, list) or len(key_items) != 10:
        raise ValueError("The English qualification key must contain ten canonical items")
    expected_qids = {f"Q{i:02d}" for i in range(1, 11)}
    if ({item.get("qualification_id") for item in key_items if isinstance(item, dict)} != expected_qids
            or len({item.get("template_id") for item in key_items if isinstance(item, dict)}) != 10):
        raise ValueError("The English qualification key must contain Q01–Q10 and unique templates")
    qualification = packages[0]["qualification"]
    package_by_template = {row.get("template_id"): row for row in qualification}
    scored = 0
    exploratory = 0
    for item in key_items:
        if (not isinstance(item, dict) or "title_zh" in item or not _valid_english(item.get("title_en"), 160)
                or not isinstance(item.get("judgments"), dict)
                or set(item["judgments"]) != DIMENSIONS):
            raise ValueError("The English qualification key retains untranslated or malformed fields")
        template_id = item.get("template_id")
        feedback_row = by_template.get(template_id)
        package_item = package_by_template.get(template_id)
        if (feedback_row is None or package_item is None or feedback_row["qualification_id"] != item.get("qualification_id")
                or package_item.get("item_id") != item.get("qualification_id") or feedback_row["title_en"] != item["title_en"]):
            raise ValueError("The canonical English key does not align with the frozen package and feedback")
        for dimension, judgment in item["judgments"].items():
            if (not isinstance(judgment, dict) or "rationale_zh" in judgment
                    or not _valid_english(judgment.get("rationale_en"))
                    or judgment["rationale_en"] != feedback_row["rationales_en"][dimension]
                    or judgment.get("label") not in CHOICES or type(judgment.get("scored")) is not bool):
                raise ValueError("The English qualification key contains a missing or mismatched rationale/label")
            is_scored = judgment.get("scored") is True
            if judgment.get("label_status") != ("human_confirmed" if is_scored else "ai_provisional_exploratory"):
                raise ValueError("The English key's scored mask and label status are inconsistent")
            scored += int(is_scored)
            exploratory += int(not is_scored)
    if scored != 18 or exploratory != 32:
        raise ValueError("The English qualification key must retain 18 scored and 32 exploratory cells")


def _assert_no_han_outside_source(archive_files: dict[str, bytes]) -> None:
    """English handoffs may retain Han only in frozen study source strings."""
    def visit(value, path: tuple[str, ...], package_name: str) -> None:
        if isinstance(value, str):
            allowed_source = (len(path) == 4 and path[0] == "study" and path[2] == "payload" and path[3] == "source")
            if HAN.search(value) and not allowed_source:
                raise ValueError(f"Unexpected non-English text outside package study source: {package_name}")
        elif isinstance(value, dict):
            for key, child in value.items():
                visit(child, (*path, str(key)), package_name)
        elif isinstance(value, list):
            for index, child in enumerate(value):
                visit(child, (*path, str(index)), package_name)

    for name, data in archive_files.items():
        try:
            text = data.decode("utf-8")
        except UnicodeDecodeError as error:
            raise ValueError(f"Archive entry is not UTF-8 text: {name}") from error
        if not HAN.search(text):
            continue
        if name not in PACKAGE_FILES:
            raise ValueError(f"Unexpected non-English text in archive entry: {name}")
        package = json.loads(data)
        visit(package, (), name)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--package-dir", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    if args.package_dir.is_symlink() or args.output.is_symlink():
        raise ValueError("Package and output paths must not be symlinks")
    source, output = args.package_dir.resolve(), args.output.resolve()
    spec = importlib.util.spec_from_file_location("_private_helpers", ROOT / "scripts/build-private-setup.py")
    helper = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(helper)
    helper._assert_private_destination(source, ROOT, "package directory")
    helper._assert_private_destination(output, ROOT, "private handoff archive")
    if output.exists():
        raise ValueError("An existing handoff archive is never overwritten")
    manifest_path = source / "manifest.private.json"
    if not manifest_path.is_file() or manifest_path.is_symlink():
        raise ValueError("The private packet manifest is missing or is not a regular file")
    manifest = json.loads(manifest_path.read_bytes())
    private_hashes = manifest.get("private_file_sha256", {})
    legacy_inventory = set(BASE_PRIVATE_FILES) - {"manifest.private.json"}
    english_inventory = (set(BASE_PRIVATE_FILES) | set(ENGLISH_EXTRA_FILES)) - {"manifest.private.json"}
    if set(private_hashes) == legacy_inventory:
        private_files = BASE_PRIVATE_FILES
        english_handoff = False
    elif set(private_hashes) == english_inventory:
        private_files = [*BASE_PRIVATE_FILES, *ENGLISH_EXTRA_FILES]
        english_handoff = True
    else:
        raise ValueError("The private packet checksum inventory matches neither the original nor English handoff format")
    inputs = {name: (source / name).read_bytes() for name in private_files}
    manifest = json.loads(inputs["manifest.private.json"])
    if any(hashlib.sha256(inputs[name]).hexdigest() != digest for name, digest in private_hashes.items()):
        raise ValueError("A private file checksum differs from its frozen manifest")
    expected_files = set(PACKAGE_FILES)
    entries = manifest.get("packages", [])
    if len(entries) != 9 or {row.get("file") for row in entries} != expected_files:
        raise ValueError("The package manifest inventory is invalid")
    for row in entries:
        if hashlib.sha256(inputs[row["file"]]).hexdigest() != row.get("sha256"):
            raise ValueError("A package checksum differs from its frozen manifest")
    # Generator-specific balance validation is performed at generation time and
    # by its tests. The handoff adds an independent cross-file inventory check.
    packages = [json.loads(inputs[name]) for name in PACKAGE_FILES]
    if len({p["assignment_version"] for p in packages}) != 1 or packages[0]["assignment_version"] != manifest.get("assignment_version"):
        raise ValueError("Mixed package versions")
    qualification = packages[0]["qualification"]
    counts: dict[str, int] = {}
    for package in packages:
        if package["qualification"] != qualification or len(qualification) != 10 or len(package["study"]) != 42:
            raise ValueError("Unexpected qualification or study inventory")
        ids = [item["item_id"] for item in package["study"]]
        if len(set(ids)) != 42:
            raise ValueError("Repeated item within a package")
        for item_id in ids:
            counts[item_id] = counts.get(item_id, 0) + 1
    if len(counts) != 126 or set(counts.values()) != {3}:
        raise ValueError("Study coverage is not 126 items with three raters each")
    if english_handoff:
        _assert_english_feedback(inputs, manifest, packages)
    version = packages[0]["assignment_version"]
    readme = f"""# PRIVATE MTurk engineering handoff

Assignment version: `{version}`

Nine self-contained packages contain the SAME 10 qualification items plus 42
study items each. There are 126 unique study items, each in three packages.
Only 18 qualification judgments are scored; at least 14 must match the
human-confirmed key. The other 32 suggestions do not determine eligibility.

Read `MTURK_HANDOFF.md` first. `API_CONTRACT.md` describes our existing adapter;
your backend does not have to use Supabase. `frontend-source/` is the current
source snapshot with placeholder configuration, not access to our production DB.
Run its tests/build with the package manager recorded in its lockfile. The
existing nickname/recovery entry flow must be adapted for an MTurk launch.

KEEP THIS ENTIRE ARCHIVE PRIVATE. The JSONs contain references and private
qualification labels. Import them server-side; do not serve the complete files
to a worker browser or add them to a public repository. Stage 1 must never
receive reference text. Only release it after an authenticated, persisted lock
of the first four judgments. Retain server-side ownership and eligibility checks.

The files contain no saved responses, personal participant identities, recovery
codes, platform credentials or production secret keys. Store future results
separately. Do not interpret a task package ID as a person or an authentication
credential. One passed participant claims one package; never reuse an occupied
package automatically. See the handoff for dropout/replacement handling.
"""
    if english_handoff:
        readme += f"""
This derived packet uses English qualification titles and scoring rationales
(`{FEEDBACK_VERSION}`). It retains the original package files, assignment plan
and analysis mapping byte-for-byte. The human-confirmed key remains 18 scored
judgments with a 14/18 pass threshold. The legacy Supabase database may retain
its original Chinese audit snapshot; this English packet is the delivery
projection for new participants and the MTurk implementation.
"""
    readme += """
`handoff_checksums.json` covers every archived file other than itself. Material
and source versions must be recorded alongside collected answers.
"""
    archive_files = {**inputs, "README_PRIVATE.md": readme.encode()}
    for name in ("MTURK_HANDOFF.md", "API_CONTRACT.md"):
        archive_files[name] = (ROOT / "docs" / name).read_bytes()
    for directory in ("web", "docs", "scripts", "supabase", "tests"):
        for path in sorted((ROOT / directory).rglob("*")):
            if path.is_file() and not path.is_symlink() and "__pycache__" not in path.parts and path.suffix in {".js", ".mjs", ".cjs", ".py", ".md", ".html", ".css", ".sql"}:
                archive_files["frontend-source/" + path.relative_to(ROOT).as_posix()] = path.read_bytes()
    for name in ("package.json", "pnpm-lock.yaml", "README.md", ".gitignore"):
        archive_files["frontend-source/" + name] = (ROOT / name).read_bytes()
    archive_files["frontend-source/config/public-config.js"] = (
        "// Configure YOUR backend; this snapshot grants no production access.\n"
        "window.HUMAN_ANNOTATION_CONFIG = Object.freeze({\n"
        "  supabaseUrl: 'https://YOUR-PROJECT.supabase.co',\n"
        "  publishableKey: 'YOUR-PUBLISHABLE-KEY'\n});\n"
    ).encode()
    if english_handoff:
        _assert_no_han_outside_source(archive_files)
    archive_files["handoff_checksums.json"] = (json.dumps({
        "assignment_version": version,
        "files": {name: hashlib.sha256(data).hexdigest() for name, data in sorted(archive_files.items())},
    }, sort_keys=True, indent=2) + "\n").encode()
    output.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(prefix=".mturk-handoff-", suffix=".zip", dir=output.parent)
    temporary = Path(temporary_name)
    os.close(descriptor)
    try:
        with zipfile.ZipFile(temporary, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
            for name, data in sorted(archive_files.items()):
                info = zipfile.ZipInfo(name, date_time=(2026, 11, 1, 0, 0, 0))
                info.compress_type = zipfile.ZIP_DEFLATED
                info.external_attr = 0o100600 << 16
                archive.writestr(info, data)
        # link() publishes without replacing a concurrently created archive.
        os.link(temporary, output)
    finally:
        temporary.unlink(missing_ok=True)
    print(f"Private handoff: {output}")
    print(f"{len(archive_files)} files; {output.stat().st_size:,} bytes; 9 x (10 + 42); 126 x 3.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
