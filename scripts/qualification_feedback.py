#!/usr/bin/env python3
"""Validate and expand the private English qualification-feedback catalog.

This module contains no qualification material. It reads the existing frozen
qualification fixture and a coordinator-owned English-only presentation file,
then emits one rationale variant for each of the three answer orientations.
"""

from __future__ import annotations

import hashlib
import json
import re
from typing import Any


FEEDBACK_VERSION = "qualification-feedback-en-20261101-v1"
QUALIFICATION_VERSION = "qualification-pilot-20261020-v1"
LANGUAGE = "en"
DIMENSIONS = (
    "source_coverage",
    "reference_coverage",
    "readability",
    "faithfulness",
    "content_focus",
)
QUALIFICATION_IDS = tuple(f"Q{index:02d}" for index in range(1, 11))
PRINTABLE_ASCII = re.compile(r"^[\x20-\x7e]+$")


def canonical(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def fixture_fingerprint(fixture: object) -> str:
    if not isinstance(fixture, dict):
        raise ValueError("The frozen qualification fixture must be a JSON object")
    templates, keys = fixture.get("templates"), fixture.get("keys")
    if not isinstance(templates, list) or not isinstance(keys, list):
        raise ValueError("The frozen qualification fixture must contain templates and keys")
    return sha256_text(canonical({"templates": templates, "keys": keys}))


def _ascii_text(value: object, field: str, maximum: int) -> str:
    if (not isinstance(value, str) or not value or value != value.strip()
            or len(value) > maximum or PRINTABLE_ASCII.fullmatch(value) is None):
        raise ValueError(f"{field} must be non-empty printable ASCII without surrounding whitespace")
    return value


def _fixture_inventory(fixture: object) -> tuple[str, dict[str, dict[str, Any]]]:
    if not isinstance(fixture, dict):
        raise ValueError("The frozen qualification fixture must be a JSON object")
    config = fixture.get("config")
    if (not isinstance(config, dict)
            or config.get("qualification_version") != QUALIFICATION_VERSION
            or config.get("item_count") != 10
            or config.get("scored_total") != 18):
        raise ValueError("The frozen fixture must be the active ten-item, 18-scored qualification version")
    fingerprint = fixture_fingerprint(fixture)
    if config.get("fingerprint") != fingerprint:
        raise ValueError("The frozen qualification template/key fingerprint is invalid")

    templates = [row for row in fixture["templates"]
                 if isinstance(row, dict) and row.get("kind") == "qualification"]
    keys = fixture["keys"]
    if (len(templates) != 30 or len(keys) != 30
            or len({row.get("template_id") for row in templates}) != 30
            or len({row.get("template_id") for row in keys if isinstance(row, dict)}) != 30):
        raise ValueError("The frozen qualification inventory must contain 30 unique templates and keys")

    by_template = {row.get("template_id"): row for row in templates}
    keys_by_template = {row.get("template_id"): row for row in keys if isinstance(row, dict)}
    templates_by_scheme_qid: dict[tuple[int, str], dict[str, Any]] = {}
    keys_by_scheme_qid: dict[tuple[int, str], dict[str, Any]] = {}
    for template_id, template in by_template.items():
        scheme = template.get("scheme")
        coordinator = template.get("coordinator")
        if (type(scheme) is not int or scheme not in (1, 2, 3)
                or not isinstance(coordinator, dict)):
            raise ValueError("A qualification template has invalid scheme metadata")
        qid = coordinator.get("qualification_id")
        if qid not in QUALIFICATION_IDS or type(coordinator.get("review_orientation_swapped")) is not bool:
            raise ValueError("A qualification template has invalid ID or orientation metadata")
        key = keys_by_template.get(template_id)
        if (key is None or key.get("qualification_version") != QUALIFICATION_VERSION
                or key.get("qualification_id") != qid
                or key.get("template_id") != template_id):
            raise ValueError("The frozen key does not match its qualification template")
        key_suggestions = key.get("suggestions")
        if not isinstance(key_suggestions, dict) or set(key_suggestions) != set(DIMENSIONS):
            raise ValueError("A frozen qualification key does not cover all five dimensions")
        pair = (scheme, qid)
        if pair in templates_by_scheme_qid:
            raise ValueError("A qualification scheme contains a duplicate item ID")
        templates_by_scheme_qid[pair] = template
        keys_by_scheme_qid[pair] = key
    expected_pairs = {(scheme, qid) for scheme in (1, 2, 3) for qid in QUALIFICATION_IDS}
    if set(templates_by_scheme_qid) != expected_pairs or set(keys_by_scheme_qid) != expected_pairs:
        raise ValueError("Each scheme must contain Q01–Q10 exactly once")
    for scheme in (1, 2, 3):
        if [templates_by_scheme_qid[(scheme, qid)].get("position") for qid in QUALIFICATION_IDS] != list(range(1, 11)):
            raise ValueError("Qualification template positions must follow Q01–Q10 order in every scheme")
    return fingerprint, {qid: templates_by_scheme_qid[(1, qid)] for qid in QUALIFICATION_IDS}


def validate_and_expand(fixture: object, catalog: object) -> dict[str, Any]:
    fingerprint, canonical_templates = _fixture_inventory(fixture)
    if not isinstance(catalog, dict) or set(catalog) != {
        "feedback_version", "qualification_version", "language", "canonical_scheme", "items"
    }:
        raise ValueError("The private English catalog has an unexpected schema")
    if (catalog.get("feedback_version") != FEEDBACK_VERSION
            or catalog.get("qualification_version") != QUALIFICATION_VERSION
            or catalog.get("language") != LANGUAGE
            or catalog.get("canonical_scheme") != 1):
        raise ValueError("The English catalog does not target the active feedback and qualification versions")
    source_items = catalog.get("items")
    if not isinstance(source_items, list) or len(source_items) != 10:
        raise ValueError("The English catalog must contain exactly ten canonical entries")
    by_qid: dict[str, dict[str, Any]] = {}
    for item in source_items:
        if not isinstance(item, dict) or set(item) != {"qualification_id", "title_en", "rationales_en"}:
            raise ValueError("Each English catalog entry must contain only its ID, title, and rationales")
        qid = item.get("qualification_id")
        if not isinstance(qid, str) or qid not in QUALIFICATION_IDS or qid in by_qid:
            raise ValueError("The English catalog has a missing, duplicate, or unknown qualification ID")
        title = _ascii_text(item.get("title_en"), f"{qid} title", 160)
        rationales = item.get("rationales_en")
        if not isinstance(rationales, dict) or set(rationales) != set(DIMENSIONS):
            raise ValueError(f"{qid} must provide one English rationale for each of the five dimensions")
        by_qid[qid] = {
            "qualification_id": qid,
            "title_en": title,
            "rationales_en": {
                dimension: _ascii_text(rationales[dimension], f"{qid} {dimension} rationale", 500)
                for dimension in DIMENSIONS
            },
        }
    if set(by_qid) != set(QUALIFICATION_IDS):
        raise ValueError("The English catalog must cover Q01–Q10 exactly once")

    rows: list[dict[str, Any]] = []
    for scheme in (1, 2, 3):
        for qid in QUALIFICATION_IDS:
            template = canonical_templates[qid]
            coordinator = template["coordinator"]
            canonical_swapped = coordinator["review_orientation_swapped"]
            scheme_template = next(
                row for row in fixture["templates"]
                if row.get("kind") == "qualification" and row.get("scheme") == scheme
                and row.get("coordinator", {}).get("qualification_id") == qid
            )
            scheme_swapped = scheme_template["coordinator"]["review_orientation_swapped"]
            rationales = dict(by_qid[qid]["rationales_en"])
            if canonical_swapped != scheme_swapped:
                rationales = {
                    dimension: re.sub(
                        r"\b[AB]\b",
                        lambda match: "B" if match.group(0) == "A" else "A",
                        rationale,
                    )
                    for dimension, rationale in rationales.items()
                }
            rows.append({
                "template_id": scheme_template["template_id"],
                "qualification_id": qid,
                "title_en": by_qid[qid]["title_en"],
                "rationales_en": rationales,
            })
    if len(rows) != 30 or len({row["template_id"] for row in rows}) != 30:
        raise ValueError("The English overlay must map to exactly 30 unique templates")
    return {
        "feedback_version": FEEDBACK_VERSION,
        "qualification_version": QUALIFICATION_VERSION,
        "qualification_fingerprint": fingerprint,
        "language": LANGUAGE,
        "items": rows,
    }
