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

ROOT = Path(__file__).resolve().parents[1]
PRIVATE_FILES = [*(f"package_{i:02d}.json" for i in range(1, 10)),
                 "manifest.private.json", "qualification_key.private.json",
                 "analysis_mapping.private.json", "assignment_plan.private.json",
                 "validation_report.json"]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--package-dir", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    source, output = args.package_dir.resolve(), args.output.resolve()
    spec = importlib.util.spec_from_file_location("_private_helpers", ROOT / "scripts/build-private-setup.py")
    helper = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(helper)
    helper._assert_private_destination(source, ROOT, "package directory")
    helper._assert_private_destination(output, ROOT, "private handoff archive")
    if output.exists():
        raise ValueError("An existing handoff archive is never overwritten")
    inputs = {name: (source / name).read_bytes() for name in PRIVATE_FILES}
    manifest = json.loads(inputs["manifest.private.json"])
    private_hashes = manifest.get("private_file_sha256", {})
    if set(private_hashes) != set(PRIVATE_FILES) - {"manifest.private.json"}:
        raise ValueError("The private packet checksum inventory is incomplete")
    if any(hashlib.sha256(inputs[name]).hexdigest() != digest for name, digest in private_hashes.items()):
        raise ValueError("A private file checksum differs from its frozen manifest")
    expected_files = {f"package_{i:02d}.json" for i in range(1, 10)}
    entries = manifest.get("packages", [])
    if len(entries) != 9 or {row.get("file") for row in entries} != expected_files:
        raise ValueError("The package manifest inventory is invalid")
    for row in entries:
        if hashlib.sha256(inputs[row["file"]]).hexdigest() != row.get("sha256"):
            raise ValueError("A package checksum differs from its frozen manifest")
    # Generator-specific balance validation is performed at generation time and
    # by its tests. The handoff adds an independent cross-file inventory check.
    packages = [json.loads(inputs[f"package_{i:02d}.json"]) for i in range(1, 10)]
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
