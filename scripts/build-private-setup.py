#!/usr/bin/env python3
"""Create a coordinator-only SQL import from validated, frozen local materials.

Run from the private research checkout. This script contains no study data or
secrets. Its output is deliberately outside this public publishing repository.
"""

from __future__ import annotations

import argparse
import ctypes
import hashlib
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile


MAX_SQL_FILE_BYTES = 900_000
SQL_FILE_HEADER = """-- PRIVATE COORDINATOR IMPORT: contains study sources, references and method mappings.
-- Paste only into the SQL Editor of your own Supabase project. Never commit or share with annotators.
-- For split imports, execute numbered files in order, one file at a time.
-- This imports private templates only. Volunteers enroll through anonymous Auth; no fixed accounts are seeded.
-- Existing local responses are not migrated; this does not reset online responses.
"""


def literal(text: str) -> str:
    return "'" + text.replace("'", "''") + "'"


def json_literal(value: object) -> str:
    return literal(json.dumps(value, ensure_ascii=False, separators=(",", ":"))) + "::jsonb"


def do_block(body: str) -> str:
    """Choose a delimiter that cannot collide with any frozen source text."""
    tag = "$seed_" + hashlib.sha256(body.encode("utf-8")).hexdigest()[:24] + "$"
    while tag in body:
        tag = tag[:-1] + "x$"
    return f"DO {tag}\n{body}\n{tag};"


def template_statement(row: dict, scheme: int) -> str:
    """Insert one frozen row without duplicating its potentially large payload."""
    body = "\n".join([
        "DECLARE",
        "  v_payload jsonb := " + json_literal(row["payload"]) + ";",
        "  v_hashes jsonb := " + json_literal(row["hashes"]) + ";",
        "  v_coordinator jsonb := " + json_literal(row["coordinator"]) + ";",
        "BEGIN",
        "  IF EXISTS (SELECT 1 FROM annotation_private.templates WHERE template_id="
        + literal(row["template_id"]) + " AND (scheme IS DISTINCT FROM " + str(scheme)
        + " OR kind IS DISTINCT FROM " + literal(row["kind"])
        + " OR position IS DISTINCT FROM " + str(row["position"])
        + " OR payload IS DISTINCT FROM v_payload"
        + " OR hashes IS DISTINCT FROM v_hashes"
        + " OR coordinator IS DISTINCT FROM v_coordinator)) THEN",
        "    RAISE EXCEPTION 'Existing template material differs; refusing to overwrite';",
        "  END IF;",
        "  INSERT INTO annotation_private.templates",
        "    (template_id,scheme,kind,position,payload,hashes,coordinator)",
        "  VALUES (" + ",".join([
            literal(row["template_id"]), str(scheme), literal(row["kind"]),
            str(row["position"]), "v_payload", "v_hashes", "v_coordinator",
        ]) + ") ON CONFLICT (template_id) DO NOTHING;",
        "END;",
    ])
    return do_block(body)


def transaction_sql(statements: list[str], title: str, after_commit: list[str] | None = None) -> str:
    """Wrap a self-contained file so each SQL Editor submission is atomic."""
    pieces = [
        SQL_FILE_HEADER.rstrip(),
        "-- " + title,
        "BEGIN;",
        "SET LOCAL standard_conforming_strings = on;",
        *statements,
        "COMMIT;",
        *(after_commit or []),
    ]
    return "\n\n".join(pieces) + "\n"


def batch_statements(statements: list[str], max_bytes: int = MAX_SQL_FILE_BYTES) -> list[list[str]]:
    """Group whole template statements into files within a UTF-8 byte limit."""
    batches: list[list[str]] = []
    current: list[str] = []

    def size(items: list[str]) -> int:
        return len(transaction_sql(items, "Frozen template batch").encode("utf-8"))

    for statement in statements:
        candidate = current + [statement]
        if size(candidate) <= max_bytes:
            current = candidate
            continue
        if not current:
            statement_size = size([statement])
            raise ValueError(
                f"One frozen template is too large for the {max_bytes}-byte SQL Editor limit "
                f"({statement_size} UTF-8 bytes)."
            )
        batches.append(current)
        current = [statement]
        if size(current) > max_bytes:
            statement_size = size(current)
            raise ValueError(
                f"One frozen template is too large for the {max_bytes}-byte SQL Editor limit "
                f"({statement_size} UTF-8 bytes)."
            )
    if current:
        batches.append(current)
    return batches


def _assert_private_destination(path: Path, public_root: Path, description: str) -> None:
    if path == public_root or public_root in path.parents:
        raise ValueError(f"The private {description} must be outside the public Git repository")


def _write_private_file(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8", newline="") as stream:
        stream.write(text)
        stream.flush()
        os.fsync(stream.fileno())


def _stage_private_file(destination: Path, text: str) -> Path:
    """Write and fsync a private sibling without publishing it yet."""
    destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    descriptor, name = tempfile.mkstemp(prefix=f".{destination.name}.building-", dir=destination.parent)
    staged = Path(name)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="") as stream:
            stream.write(text)
            stream.flush()
            os.fsync(stream.fileno())
    except BaseException:
        try:
            os.close(descriptor)
        except OSError:
            pass
        staged.unlink(missing_ok=True)
        raise
    return staged


def _publish_private_file(staged: Path, destination: Path) -> None:
    """Atomically publish a file without replacing an existing path."""
    os.link(staged, destination)


def _rename_directory_noreplace(staged: Path, destination: Path) -> None:
    """Atomically publish a staged directory, failing if its name is taken."""
    libc = ctypes.CDLL(None, use_errno=True)
    if sys.platform == "darwin":
        rename = libc.renamex_np
        rename.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint]
        rename.restype = ctypes.c_int
        result = rename(os.fsencode(staged), os.fsencode(destination), 0x00000004)  # RENAME_EXCL
    elif sys.platform.startswith("linux"):
        rename = getattr(libc, "renameat2", None)
        if rename is None:
            raise OSError("Atomic no-replace directory publication is unavailable on this Linux system")
        rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
        rename.restype = ctypes.c_int
        result = rename(-100, os.fsencode(staged), -100, os.fsencode(destination), 1)  # AT_FDCWD, RENAME_NOREPLACE
    else:
        raise OSError(f"Atomic no-replace directory publication is unsupported on {sys.platform}")
    if result != 0:
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error), str(destination))


def write_output_directory(destination: Path, files: list[tuple[str, str]]) -> None:
    """Publish all generated files at once; never leave a partial output tree."""
    if destination.exists():
        raise FileExistsError(f"Refusing to overwrite an existing private import directory: {destination}")
    destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    staging = Path(tempfile.mkdtemp(prefix=f".{destination.name}.building-", dir=destination.parent))
    try:
        for filename, contents in files:
            size_bytes = len(contents.encode("utf-8"))
            if size_bytes > MAX_SQL_FILE_BYTES:
                raise ValueError(f"Generated SQL file {filename} is {size_bytes} bytes; limit is {MAX_SQL_FILE_BYTES}.")
            _write_private_file(staging / filename, contents)
        if destination.exists():
            raise FileExistsError(f"Refusing to overwrite an existing private import directory: {destination}")
        # Reserve the final name while publishing. The exclusive lock protects
        # concurrent invocations of this generator; the final existence check
        # also catches a destination created by another process mid-build.
        lock = destination.parent / f".{destination.name}.publish-lock"
        lock_fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        published = False
        try:
            os.close(lock_fd)
            if destination.exists():
                raise FileExistsError(f"Refusing to overwrite an existing private import directory: {destination}")
            _rename_directory_noreplace(staging, destination)
            published = True
        finally:
            try:
                lock.unlink(missing_ok=True)
            except OSError:
                if published and destination.exists():
                    shutil.rmtree(destination)
                raise
    except BaseException:
        if staging.exists():
            shutil.rmtree(staging)
        raise


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--research-root", type=Path, required=True)
    output = parser.add_mutually_exclusive_group(required=True)
    output.add_argument("--output", type=Path, help="Write one SQL file (existing behavior)")
    output.add_argument("--output-dir", type=Path, help="Write ordered SQL Editor files, each at most 900,000 UTF-8 bytes")
    parser.add_argument("--expected-output", type=Path, help="Optional private round-trip verification fixture")
    args = parser.parse_args()
    research = args.research_root.resolve()
    split_output = args.output_dir is not None
    destination = (args.output_dir if split_output else args.output).resolve()
    expected_destination = args.expected_output.resolve() if args.expected_output else None
    public_root = Path(__file__).resolve().parents[1]
    try:
        _assert_private_destination(destination, public_root, "SQL output")
    except ValueError as error:
        parser.error(str(error))
    if destination.exists():
        parser.error("Refusing to overwrite an existing private import; choose a new output path")
    if expected_destination is not None:
        try:
            _assert_private_destination(expected_destination, public_root, "verification fixture")
        except ValueError as error:
            parser.error(str(error))
        if (expected_destination == destination or destination in expected_destination.parents
                or expected_destination in destination.parents or expected_destination.exists()):
            parser.error("Refusing to overwrite an existing private verification fixture")
    sys.path.insert(0, str(research))
    from src.common.summary_generation.human_preference_app.dataset import (
        PARTICIPANT_IDS, build_practice_assignments, load_frozen_dataset,
        materialize_assignments,
    )
    from src.common.summary_generation.human_preference_app.store import RUBRIC_VERSION

    dataset = load_frozen_dataset(research)
    manifest_path = research / "data/summary_generation/human_preference_annotation_v1/study/coordinator_manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if (manifest.get("mode") != "study" or manifest.get("study_fingerprint") != dataset.fingerprint
            or manifest.get("instruction_fingerprint") != dataset.instruction_fingerprint):
        raise ValueError("The private study manifest does not match the frozen dataset and instructions")
    assignments = materialize_assignments(dataset, manifest["plan"])
    for participant in PARTICIPANT_IDS:
        assignments[participant] = build_practice_assignments(
            dataset.fingerprint, participant, manifest["plan"]["assignment_seed"]
        ) + assignments[participant]
        if len(assignments[participant]) != 134:
            raise ValueError("Expected exactly eight practice and126 study assignments per participant")

    migrations = sorted((public_root / "supabase/migrations").glob("*.sql"))
    if not migrations:
        raise ValueError("Finish and test the schema migration before generating the private import")
    settings_statements = [
        do_block("BEGIN IF EXISTS (SELECT 1 FROM annotation_private.settings WHERE id=1 AND (schema_version <> 'open-participation-v1' OR study_fingerprint <> "
        + literal(dataset.fingerprint) + " OR instruction_fingerprint <> "
        + literal(dataset.instruction_fingerprint) + " OR rubric_version IS DISTINCT FROM "
        + literal(RUBRIC_VERSION) + " OR rubric IS DISTINCT FROM " + json_literal(dataset.rubric)
        + " OR guide_md IS DISTINCT FROM " + literal(dataset.guide_markdown) + ")) THEN "
        "RAISE EXCEPTION 'Existing online study has different frozen materials; refusing to replace it'; END IF; END;"),
        "INSERT INTO annotation_private.settings (id,study_fingerprint,instruction_fingerprint,rubric_version,rubric,guide_md) VALUES (1,"
        + ",".join([
            literal(dataset.fingerprint), literal(dataset.instruction_fingerprint),
            literal(RUBRIC_VERSION), json_literal(dataset.rubric), literal(dataset.guide_markdown),
        ]) + ") ON CONFLICT (id) DO NOTHING;",
    ]
    expected_templates = []
    template_statements = []
    for participant in PARTICIPANT_IDS:
        scheme = int(participant.rsplit("_", 1)[1])
        for row in assignments[participant]:
            expected_templates.append({
                "template_id": row["id"], "scheme": scheme, "kind": row["kind"],
                "position": row["position"], "payload": row["payload"],
                "hashes": row["hashes"], "coordinator": row["coordinator"],
            })
            template_statements.append(template_statement(expected_templates[-1], scheme))

    final_statements = [
        do_block("BEGIN IF (SELECT count(*) FROM annotation_private.templates)<>402 OR "
        "EXISTS (SELECT 1 FROM (VALUES (1),(2),(3)) AS schemes(scheme) "
        "WHERE (SELECT count(*) FROM annotation_private.templates t WHERE t.scheme=schemes.scheme AND t.kind='study')<>126 "
        "OR (SELECT count(*) FROM annotation_private.templates t WHERE t.scheme=schemes.scheme AND t.kind='practice')<>8) "
        "THEN RAISE EXCEPTION 'Unexpected template inventory'; END IF; END;"),
    ]
    inventory_report = [
        "SELECT scheme,kind,count(*) AS templates FROM annotation_private.templates GROUP BY 1,2 ORDER BY 1,2;"
    ]
    migrations_sql = [migration.read_text(encoding="utf-8") for migration in migrations]

    expected_text = None
    if expected_destination is not None:
        expected_text = json.dumps({"settings": {
            "study_fingerprint": dataset.fingerprint,
            "instruction_fingerprint": dataset.instruction_fingerprint,
            "rubric_version": RUBRIC_VERSION, "rubric": dataset.rubric,
            "guide_md": dataset.guide_markdown,
        }, "templates": expected_templates}, ensure_ascii=False, separators=(",", ":"))

    staged_expected = None
    published_expected = False
    published_sql = False
    try:
        if expected_destination is not None and expected_text is not None:
            staged_expected = _stage_private_file(expected_destination, expected_text)

        if split_output:
            schema_statements = [*migrations_sql, *settings_statements]
            sql_files = [(
                "01_schema_settings.sql",
                transaction_sql(schema_statements, "Schema and frozen study instructions"),
            )]
            batches = batch_statements(template_statements)
            for index, batch in enumerate(batches, start=1):
                sql_files.append((
                    f"02_templates_{index:03d}.sql",
                    transaction_sql(batch, f"Frozen template batch {index:03d}"),
                ))
            sql_files.append((
                "03_final_inventory.sql",
                transaction_sql(final_statements, "Final template inventory check", inventory_report),
            ))
            write_output_directory(destination, sql_files)
            published_sql = True
        else:
            all_statements = [*migrations_sql, *settings_statements, *template_statements, *final_statements]
            sql_text = transaction_sql(all_statements, "Complete private study import", inventory_report)
            staged_sql = _stage_private_file(destination, sql_text)
            try:
                _publish_private_file(staged_sql, destination)
                published_sql = True
            finally:
                staged_sql.unlink(missing_ok=True)

        if staged_expected is not None and expected_destination is not None:
            _publish_private_file(staged_expected, expected_destination)
            published_expected = True
            staged_expected.unlink()
            staged_expected = None
    except BaseException:
        if staged_expected is not None:
            staged_expected.unlink(missing_ok=True)
        if published_expected and expected_destination is not None:
            expected_destination.unlink(missing_ok=True)
        if published_sql and split_output and destination.exists():
            shutil.rmtree(destination)
        elif published_sql and not split_output and destination.exists():
            destination.unlink()
        raise

    print(f"Prepared private SQL import: {destination}")
    if split_output:
        print(f"{len(batches)} template batches; execute numbered files in order, one SQL Editor submission at a time.")
        for filename, sql_text in sql_files:
            print(f"  {filename}: {len(sql_text.encode('utf-8')):,} UTF-8 bytes")
        print("Run the final inventory check before inviting participants; enrollment rejects incomplete template inventories.")
    print("402 private templates; source content and A/B mappings reused exactly. No participants or responses reset/imported.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
