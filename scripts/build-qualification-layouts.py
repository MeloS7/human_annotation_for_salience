#!/usr/bin/env python3
"""Merge verified qualification reading offsets into the code-only layout asset.

The local research corpus is read only. No source text, document ID, response,
reference, or answer suggestion is written to the public asset.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import re
import sys


PUBLIC_ROOT = Path(__file__).resolve().parents[1]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--research-root", type=Path, required=True)
    args = parser.parse_args()
    research = args.research_root.resolve()
    sys.path.insert(0, str(research))
    from src.common.summary_generation.human_preference_app.build_source_layouts import (
        HYBRID_RELATIVE_PATH, _document_layout, _load_hybrid_rows, render_javascript,
    )

    path = PUBLIC_ROOT / "web/source-layouts.js"
    match = re.search(r"^\s*const layouts = (.+);$", path.read_text(encoding="utf-8"), re.MULTILINE)
    if match is None:
        raise ValueError("The existing hash-only source layout asset has an unexpected format")
    document = json.loads(match[1])
    previous = dict(document["layouts"])
    annotations = _load_hybrid_rows(research / HYBRID_RELATIVE_PATH)
    packet = json.loads((research / "data/summary_generation/human_qualification_review_v1/qualification_materials.json").read_text(encoding="utf-8"))
    selected = [item for item in packet["items"] if item["dataset"] == "gumsum"]
    if len(selected) != 5:
        raise ValueError("Expected exactly five qualification GUMSum sources")
    for item in selected:
        source_hash = item["provenance"]["source_sha256"]
        pair = {
            "example_id": item["source_id"], "genre": item["genre"], "source": item["source"],
            "hashes": {"source_sha256": source_hash},
        }
        layout = _document_layout(pair, annotations[item["source_id"]])
        if source_hash in document["layouts"] and document["layouts"][source_hash] != layout:
            raise ValueError("An existing reading layout differs; refusing to replace it")
        document["layouts"][source_hash] = layout
    for key, value in previous.items():
        if document["layouts"][key] != value:
            raise ValueError("An existing study layout changed")
    document["layouts"] = dict(sorted(document["layouts"].items()))
    # The existing renderer contains only metadata hashes and numeric offsets.
    encoded = render_javascript(document)
    for item in selected:
        for private_value in (item["source"], item["reference"], item["source_id"]):
            if private_value in encoded:
                raise ValueError("Private material must not appear in the layout asset")
    path.write_text(encoded, encoding="utf-8", newline="\n")
    print(f"Verified reading offsets for five qualification sources; {len(previous)} existing layouts preserved.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
