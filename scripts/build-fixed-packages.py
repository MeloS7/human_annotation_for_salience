#!/usr/bin/env python3
"""Build nine private, frozen qualification + study packages.

This generator is coordinator-side only. It reads the frozen local fixtures,
validates the complete allocation before writing anything, and publishes the
private output directory atomically without replacing an existing directory.
No material or answer key is written into the public deployment repository.
"""

from __future__ import annotations

import argparse
from collections import Counter, defaultdict
from functools import lru_cache
import hashlib
import importlib.util
import json
import math
from pathlib import Path
import random
import sys
from typing import Any


PUBLIC_ROOT = Path(__file__).resolve().parents[1]
ASSIGNMENT_VERSION = "fixed-packages-20261101-v1"
POLICY_VERSION = "qualification-required-20261101-v1"
QUALIFICATION_VERSION = "qualification-pilot-20261020-v1"
PASS_COUNT = 14
SCORED_TOTAL = 18
SCHEMES = (1, 2, 3)
PARTICIPANTS = tuple(range(9))
DIMENSIONS = (
    "source_coverage", "reference_coverage", "readability", "faithfulness", "content_focus",
)
STRATA = ("improved", "near", "declined")
LENGTHS = ("short", "normal", "long")
GUM_GENRES = (
    "academic", "bio", "conversation", "fiction", "interview", "news",
    "speech", "textbook", "vlog", "voyage", "whow",
)


def canonical(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def json_bytes(value: Any) -> bytes:
    return (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def _private_helpers():
    path = PUBLIC_ROOT / "scripts" / "build-private-setup.py"
    spec = importlib.util.spec_from_file_location("_fixed_package_private_helpers", path)
    if spec is None or spec.loader is None:
        raise RuntimeError("Could not load the private-output helper")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def affine_lines() -> tuple[tuple[int, ...], ...]:
    """The twelve 3-point lines of the affine plane over F_3."""
    result: list[tuple[int, ...]] = []
    for direction in range(4):
        for intercept in range(3):
            if direction == 3:
                line = tuple(3 * intercept + x for x in range(3))
            else:
                line = tuple(3 * x + ((direction * x + intercept) % 3) for x in range(3))
            result.append(tuple(sorted(line)))
    return tuple(result)


def affine_classes() -> tuple[tuple[tuple[int, ...], ...], ...]:
    lines = affine_lines()
    return tuple(tuple(lines[3 * direction:3 * direction + 3]) for direction in range(4))


def gum_class_pairs() -> tuple[tuple[int, int], ...]:
    """Choose six class-pair schedules so every worker pair overlaps 5 or 6 GUM items."""
    return ((0, 1), (0, 1), (0, 1), (0, 2), (0, 2), (0, 3),
            (1, 2), (1, 3), (1, 3), (2, 3), (2, 3))


def _check_canonical_pool(items: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    by_id: dict[str, dict[str, Any]] = {}
    for item in items:
        coordinator = item.get("coordinator")
        if not isinstance(coordinator, dict):
            raise ValueError("A formal study template is missing its private allocation metadata")
        item_id = coordinator.get("pair_id")
        if not isinstance(item_id, str) or not item_id:
            raise ValueError("A formal study template has no stable pair ID")
        if item_id in by_id:
            prior = by_id[item_id]
            if any(prior.get(key) != coordinator.get(key) for key in (
                "dataset", "genre", "macsum_length", "stratum",
            )):
                raise ValueError("The frozen schemes disagree on a pair's allocation metadata")
        else:
            by_id[item_id] = coordinator
    if len(by_id) != 126:
        raise ValueError(f"Expected exactly 126 distinct formal pairs; found {len(by_id)}")
    datasets = Counter(meta.get("dataset") for meta in by_id.values())
    if datasets != Counter({"macsum": 60, "gumsum": 66}):
        raise ValueError("The frozen pool must contain 60 MACSum and 66 GUMSum pairs")
    genres = Counter(meta.get("genre") for meta in by_id.values() if meta.get("dataset") == "gumsum")
    if genres != Counter({genre: 6 for genre in GUM_GENRES}):
        raise ValueError("GUMSum must contain six pairs from each of the 11 frozen genres")
    mac = [meta for meta in by_id.values() if meta.get("dataset") == "macsum"]
    if Counter(meta.get("stratum") for meta in mac) != Counter({"improved": 21, "near": 18, "declined": 21}):
        raise ValueError("MACSum ROUGE strata differ from the frozen 21/18/21 inventory")
    if Counter(meta.get("macsum_length") for meta in mac) != Counter({"short": 20, "normal": 20, "long": 20}):
        raise ValueError("MACSum length groups differ from the frozen 20/20/20 inventory")
    gum = [meta for meta in by_id.values() if meta.get("dataset") == "gumsum"]
    if Counter(meta.get("stratum") for meta in gum) != Counter({"improved": 22, "near": 22, "declined": 22}):
        raise ValueError("GUMSum ROUGE strata differ from the frozen 22/22/22 inventory")
    return by_id


def _make_mac_line_cells(mac_items: list[dict[str, Any]], lines: tuple[tuple[int, ...], ...]) -> dict[tuple[int, ...], list[dict[str, Any]]]:
    """Allocate 60 MACSum items to five copies of each line with exact margins.

    Each worker receives 7 improved, 6 near, 7 declined items and 6 short,
    7 normal, 7 long items. The 3x3 stratum/length cell inventory is preserved.
    """
    class_extra = {
        "improved": {0, 1, 2},
        "near": {2, 3},
        "declined": {0, 1, 3},
    }
    # Baseline one per line plus these extras yields 5 slots at every line.
    length_extra = {
        "short": (2, 2, 2, 1, 1, 0, 0, 0, 0, 0, 0, 0),
        "normal": (0, 0, 0, 1, 0, 1, 2, 2, 2, 0, 0, 0),
        "long": (0, 0, 0, 0, 1, 1, 0, 0, 0, 2, 2, 2),
    }
    row_margins: list[tuple[int, int, int]] = []
    col_margins: list[tuple[int, int, int]] = []
    for line_index in range(12):
        direction = line_index // 3
        row_margins.append(tuple(1 + int(direction in class_extra[stratum]) for stratum in STRATA))
        col_margins.append(tuple(1 + length_extra[length][line_index] for length in LENGTHS))
    if any(sum(row) != 5 for row in row_margins) or any(sum(row) != 5 for row in col_margins):
        raise ValueError("Internal MACSum line margins are invalid")

    global_counts = Counter((m["coordinator"]["stratum"], m["coordinator"]["macsum_length"]) for m in mac_items)
    target = tuple(global_counts[(s, length)] for s in STRATA for length in LENGTHS)
    if len(target) != 9 or sum(target) != 60 or any(count not in (6, 7) for count in target):
        raise ValueError("Unexpected MACSum joint stratum/length inventory")

    def options_for(rows: tuple[int, ...], cols: tuple[int, ...]) -> list[tuple[int, ...]]:
        found: list[tuple[int, ...]] = []
        for a0 in range(min(rows[0], cols[0]) + 1):
            for a1 in range(min(rows[0] - a0, cols[1]) + 1):
                a2 = rows[0] - a0 - a1
                if a2 < 0 or a2 > cols[2]:
                    continue
                left = [cols[0] - a0, cols[1] - a1, cols[2] - a2]
                for b0 in range(min(rows[1], left[0]) + 1):
                    for b1 in range(min(rows[1] - b0, left[1]) + 1):
                        b2 = rows[1] - b0 - b1
                        if b2 < 0 or b2 > left[2]:
                            continue
                        c0, c1, c2 = left[0] - b0, left[1] - b1, left[2] - b2
                        if c0 + c1 + c2 != rows[2]:
                            continue
                        found.append((a0, a1, a2, b0, b1, b2, c0, c1, c2))
        return found

    all_options = [options_for(row_margins[i], col_margins[i]) for i in range(12)]
    if any(not choices for choices in all_options):
        raise ValueError("No MACSum joint cell allocation satisfies a line's margins")
    # Search constrained lines first; options are deterministic and bounded.
    order = sorted(range(12), key=lambda i: (len(all_options[i]), -max(row_margins[i]), i))
    suffix_max: list[tuple[int, ...]] = [(0,) * 9 for _ in range(13)]
    for offset in range(11, -1, -1):
        index = order[offset]
        suffix_max[offset] = tuple(
            suffix_max[offset + 1][j] + max(option[j] for option in all_options[index])
            for j in range(9)
        )

    @lru_cache(maxsize=None)
    def solve(offset: int, remaining: tuple[int, ...]) -> tuple[tuple[int, ...], ...] | None:
        if offset == len(order):
            return () if not any(remaining) else None
        if any(value < 0 or value > suffix_max[offset][j] for j, value in enumerate(remaining)):
            return None
        index = order[offset]
        choices = sorted(all_options[index], key=lambda opt: sum((remaining[j] - opt[j]) ** 2 for j in range(9)))
        for option in choices:
            next_remaining = tuple(remaining[j] - option[j] for j in range(9))
            if min(next_remaining) < 0:
                continue
            tail = solve(offset + 1, next_remaining)
            if tail is not None:
                return ((index, option),) + tail
        return None

    solution = solve(0, target)
    if solution is None:
        raise ValueError("Could not satisfy the exact MACSum per-worker stratum/length margins")
    matrices: dict[int, tuple[int, ...]] = dict(solution)
    pools: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
    for item in mac_items:
        meta = item["coordinator"]
        pools[(meta["stratum"], meta["macsum_length"])].append(item)
    rng = random.Random(2601101)
    for pool in pools.values():
        rng.shuffle(pool)
    result: dict[tuple[int, ...], list[dict[str, Any]]] = {line: [] for line in lines}
    for line_index, line in enumerate(lines):
        matrix = matrices[line_index]
        for row_index, stratum in enumerate(STRATA):
            for column_index, length in enumerate(LENGTHS):
                count = matrix[row_index * 3 + column_index]
                result[line].extend(pools[(stratum, length)][:count])
                del pools[(stratum, length)][:count]
    if any(pools.values()) or any(len(result[line]) != 5 for line in lines):
        raise ValueError("MACSum line assignment did not consume its inventory exactly")
    return result


def _gum_stratum_target(high_groups: tuple[tuple[int, ...], ...] = ((0, 1, 2), (3, 4, 5), (6, 7, 8))) -> list[list[int]]:
    target = [[7, 7, 7] for _ in PARTICIPANTS]
    for category, high in enumerate(high_groups):
        for person in high:
            target[person][category] += 1
    return target


def _balance_gum_genres(
    genre_items: dict[str, list[dict[str, Any]]],
    genre_lines: dict[str, list[tuple[int, ...]]],
    seed: int = 2601101,
) -> dict[str, list[dict[str, Any]]]:
    """Find per-genre permutations giving each worker 7/7/8 GUMSum strata."""
    rng = random.Random(seed)
    categories = {value: i for i, value in enumerate(STRATA)}
    targets = [
        _gum_stratum_target(((shift, (shift + 3) % 9, (shift + 6) % 9),
                             ((shift + 1) % 9, (shift + 4) % 9, (shift + 7) % 9),
                             ((shift + 2) % 9, (shift + 5) % 9, (shift + 8) % 9)))
        for shift in range(9)
    ]
    genres = list(GUM_GENRES)
    if set(genre_items) != set(genres) or any(len(genre_items[g]) != 6 or len(genre_lines[g]) != 6 for g in genres):
        raise ValueError("Each GUMSum genre must map six frozen items to six worker triples")

    # Small deterministic simulated-annealing search over within-genre swaps.
    # Each swap preserves exactly two assignments per worker in that genre.
    best_score = math.inf
    best_plan: dict[str, list[dict[str, Any]]] | None = None
    restarts = 16
    steps = 160_000
    for target in targets:
        for _restart in range(restarts):
            assignment: dict[str, list[dict[str, Any]]] = {}
            counts = [[0, 0, 0] for _ in PARTICIPANTS]
            for genre in genres:
                values = list(genre_items[genre])
                rng.shuffle(values)
                assignment[genre] = values
                for line, item in zip(genre_lines[genre], values):
                    category = categories[item["coordinator"]["stratum"]]
                    for person in line:
                        counts[person][category] += 1
            score = sum((counts[p][c] - target[p][c]) ** 2 for p in PARTICIPANTS for c in range(3))
            if score < best_score:
                best_score, best_plan = score, {g: list(v) for g, v in assignment.items()}
            if score == 0:
                return {genre: list(assignment[genre]) for genre in genres}
            for step in range(steps):
                genre = genres[rng.randrange(len(genres))]
                i, j = rng.sample(range(6), 2)
                first, second = assignment[genre][i], assignment[genre][j]
                first_cat = categories[first["coordinator"]["stratum"]]
                second_cat = categories[second["coordinator"]["stratum"]]
                if first_cat == second_cat:
                    continue
                line_a, line_b = genre_lines[genre][i], genre_lines[genre][j]
                affected = set(line_a) | set(line_b)
                before = sum((counts[p][c] - target[p][c]) ** 2 for p in affected for c in (first_cat, second_cat))
                for person in line_a:
                    counts[person][first_cat] -= 1
                    counts[person][second_cat] += 1
                for person in line_b:
                    counts[person][second_cat] -= 1
                    counts[person][first_cat] += 1
                after = sum((counts[p][c] - target[p][c]) ** 2 for p in affected for c in (first_cat, second_cat))
                delta = after - before
                temperature = 2.0 * (0.025 ** (step / steps))
                if delta <= 0 or rng.random() < math.exp(-delta / temperature):
                    assignment[genre][i], assignment[genre][j] = second, first
                    score += delta
                    if score < best_score:
                        best_score, best_plan = score, {g: list(v) for g, v in assignment.items()}
                    if score == 0:
                        return {g: list(assignment[g]) for g in genres}
                else:
                    for person in line_a:
                        counts[person][first_cat] += 1
                        counts[person][second_cat] -= 1
                    for person in line_b:
                        counts[person][second_cat] += 1
                        counts[person][first_cat] -= 1
            if best_score == 0 and best_plan is not None:
                return {g: list(best_plan[g]) for g in genres}
    # A best-effort plan is not acceptable here: the requested exact balance
    # must be demonstrated, or the coordinator should review the constraints.
    raise ValueError(f"Could not satisfy exact GUMSum per-worker stratum balance (best squared error {best_score:g})")


class _FlowEdge:
    __slots__ = ("to", "capacity", "reverse", "initial")

    def __init__(self, to: int, capacity: int, reverse: int):
        self.to = to
        self.capacity = capacity
        self.reverse = reverse
        self.initial = capacity


class _Dinic:
    def __init__(self, size: int):
        self.graph: list[list[_FlowEdge]] = [[] for _ in range(size)]

    def add(self, start: int, end: int, capacity: int) -> _FlowEdge:
        forward = _FlowEdge(end, capacity, len(self.graph[end]))
        backward = _FlowEdge(start, 0, len(self.graph[start]))
        self.graph[start].append(forward)
        self.graph[end].append(backward)
        return forward

    def max_flow(self, source: int, sink: int) -> int:
        total = 0
        size = len(self.graph)
        while True:
            level = [-1] * size
            queue = [source]
            level[source] = 0
            for node in queue:
                for edge in self.graph[node]:
                    if edge.capacity > 0 and level[edge.to] < 0:
                        level[edge.to] = level[node] + 1
                        queue.append(edge.to)
            if level[sink] < 0:
                return total
            cursor = [0] * size

            def send(node: int, flow: int) -> int:
                if node == sink:
                    return flow
                while cursor[node] < len(self.graph[node]):
                    edge = self.graph[node][cursor[node]]
                    if edge.capacity > 0 and level[edge.to] == level[node] + 1:
                        pushed = send(edge.to, min(flow, edge.capacity))
                        if pushed:
                            edge.capacity -= pushed
                            self.graph[edge.to][edge.reverse].capacity += pushed
                            return pushed
                    cursor[node] += 1
                return 0

            while pushed := send(source, 10**9):
                total += pushed


def _select_orientations(assignments: dict[str, tuple[int, ...]], seed: int = 2601101) -> dict[str, set[int]]:
    """Pick 1–2 A-oriented reviewers per item and exactly 21 per worker."""
    item_ids = sorted(assignments)
    n_items = len(item_ids)

    def network(target_item_flow: int, worker_capacity: int, already: dict[str, set[int]] | None = None):
        source = 0
        item_base = 1
        worker_base = item_base + n_items
        sink = worker_base + 9
        flow = _Dinic(sink + 1)
        item_worker_edges: dict[tuple[str, int], _FlowEdge] = {}
        rng = random.Random(seed + target_item_flow + worker_capacity)
        shuffled_ids = list(item_ids)
        rng.shuffle(shuffled_ids)
        for offset, item_id in enumerate(shuffled_ids):
            item_node = item_base + offset
            flow.add(source, item_node, 1)
            workers = list(assignments[item_id])
            rng.shuffle(workers)
            for worker in workers:
                if already and worker in already[item_id]:
                    continue
                item_worker_edges[(item_id, worker)] = flow.add(item_node, worker_base + worker, 1)
        for worker in PARTICIPANTS:
            flow.add(worker_base + worker, sink, worker_capacity)
        value = flow.max_flow(source, sink)
        if value != target_item_flow:
            return None
        selected: dict[str, set[int]] = defaultdict(set)
        for (item_id, worker), edge in item_worker_edges.items():
            if edge.initial - edge.capacity == 1:
                selected[item_id].add(worker)
        return selected

    # First assign one A per item, exactly 14 per worker.
    first = network(n_items, 14)
    if first is None:
        raise ValueError("Could not balance one A-oriented presentation per item")
    # Then assign a second A on exactly half the items, seven more per worker.
    second = network(n_items // 2, 7, first)
    if n_items % 2 or second is None:
        raise ValueError("Could not balance the second A-oriented presentation per item")
    result = {item_id: set(first[item_id]) | set(second.get(item_id, set())) for item_id in item_ids}
    counts = Counter(person for workers in result.values() for person in workers)
    if counts != Counter({person: 21 for person in PARTICIPANTS}) or any(len(workers) not in (1, 2) for workers in result.values()):
        raise ValueError("The A/B orientation flow returned an invalid balance")
    return result


def make_assignment(
    study_templates: list[dict[str, Any]], seed: int = 2601101,
) -> tuple[dict[int, list[dict[str, Any]]], dict[str, set[int]], dict[str, dict[str, Any]]]:
    by_id = _check_canonical_pool(study_templates)
    classes = affine_classes()
    lines = affine_lines()
    item_by_id = {row["coordinator"]["pair_id"]: row for row in study_templates if row["scheme"] == 1}
    if len(item_by_id) != 126:
        raise ValueError("The canonical scheme-1 study template inventory is incomplete")
    rng = random.Random(seed)

    # Give every GUMSum genre six line slots from two complete parallel classes.
    gum_by_genre: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for item_id, metadata in by_id.items():
        if metadata["dataset"] == "gumsum":
            gum_by_genre[metadata["genre"]].append(item_by_id[item_id])
    pairs = gum_class_pairs()
    if len(pairs) != len(GUM_GENRES):
        raise ValueError("The GUMSum class-pair schedule is incomplete")
    genre_lines: dict[str, list[tuple[int, ...]]] = {}
    for genre, (first, second) in zip(GUM_GENRES, pairs):
        genre_lines[genre] = list(classes[first]) + list(classes[second])
        rng.shuffle(gum_by_genre[genre])

    balanced_gum = _balance_gum_genres(gum_by_genre, genre_lines, seed)
    by_line: dict[tuple[int, ...], list[dict[str, Any]]] = {line: [] for line in lines}
    for genre, documents in balanced_gum.items():
        for line, item in zip(genre_lines[genre], documents):
            by_line[line].append(item)

    mac_items = [item_by_id[item_id] for item_id, meta in by_id.items() if meta["dataset"] == "macsum"]
    mac_lines = _make_mac_line_cells(mac_items, lines)
    for line, documents in mac_lines.items():
        by_line[line].extend(documents)

    participants_for_item: dict[str, tuple[int, ...]] = {}
    per_person: dict[int, list[dict[str, Any]]] = {person: [] for person in PARTICIPANTS}
    for line, documents in by_line.items():
        for item in documents:
            item_id = item["coordinator"]["pair_id"]
            if item_id in participants_for_item:
                raise ValueError("A formal item was allocated to more than one worker triple")
            participants_for_item[item_id] = line
            for person in line:
                per_person[person].append(item)
    if set(participants_for_item) != set(by_id):
        raise ValueError("The crossed allocation omitted a frozen formal item")
    if any(len(items) != 42 for items in per_person.values()):
        raise ValueError("Each worker must receive exactly 42 formal items")
    orientations = _select_orientations(participants_for_item, seed)
    return per_person, orientations, by_id


def _validate_template_variants(templates: list[dict[str, Any]], by_id: dict[str, dict[str, Any]]) -> dict[str, dict[str, dict[str, Any]]]:
    variants: dict[str, dict[str, dict[str, Any]]] = defaultdict(dict)
    for row in templates:
        if row.get("kind") != "study":
            continue
        metadata = row.get("coordinator")
        item_id = metadata.get("pair_id") if isinstance(metadata, dict) else None
        if item_id not in by_id or row["scheme"] not in SCHEMES:
            raise ValueError("A scheme template does not map to the frozen pair inventory")
        if row["scheme"] in variants[item_id]:
            raise ValueError("Duplicate template scheme for a frozen pair")
        if metadata.get("ours_side") not in {"A", "B"}:
            raise ValueError("An existing study scheme has no candidate orientation")
        variants[item_id][row["scheme"]] = row
    if any(set(variants[item_id]) != set(SCHEMES) for item_id in by_id):
        raise ValueError("Every study item must have exactly one existing template in each scheme")
    for item_id, by_scheme in variants.items():
        sides = {row["coordinator"]["ours_side"] for row in by_scheme.values()}
        if sides != {"A", "B"}:
            raise ValueError(f"Existing orientations do not cover both sides for item {item_id}")
        canonical_row = by_scheme[1]
        canonical_source = canonical_row["payload"]["source"]
        canonical_reference = canonical_row["payload"]["reference"]
        candidate_set = sorted((canonical_row["payload"]["summary_a"], canonical_row["payload"]["summary_b"]))
        for row in by_scheme.values():
            expected_hashes = {
                "request": "request_sha256", "source": "source_sha256",
                "summary_a": "summary_a_sha256", "summary_b": "summary_b_sha256",
                "reference": "reference_sha256",
            }
            if any(row.get("hashes", {}).get(hash_name) != sha256_text(row["payload"].get(payload_name, ""))
                   for payload_name, hash_name in expected_hashes.items()):
                raise ValueError("A frozen study payload does not match its content hashes")
            if row["payload"]["source"] != canonical_source or row["payload"]["reference"] != canonical_reference:
                raise ValueError("The existing schemes changed a source document or reference")
            if sorted((row["payload"]["summary_a"], row["payload"]["summary_b"])) != candidate_set:
                raise ValueError("The existing schemes changed the summary pair")
            coordinator = row["coordinator"]
            expected_methods = ("ours", "standard") if coordinator["ours_side"] == "A" else ("standard", "ours")
            if ((coordinator.get("summary_a_method"), coordinator.get("summary_b_method")) != expected_methods or
                    not coordinator.get("summary_a_id") or not coordinator.get("summary_b_id") or
                    coordinator["summary_a_id"] == coordinator["summary_b_id"]):
                raise ValueError("A scheme's candidate IDs/methods do not match its A/B orientation")
            for key in ("dataset", "genre", "macsum_length", "stratum"):
                if row["coordinator"].get(key) != by_id[item_id].get(key):
                    raise ValueError("Scheme metadata differs for a frozen study pair")
    return variants


def _qualification_templates(q_expected: dict[str, Any], qualification_key: dict[str, Any]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    if q_expected.get("config", {}).get("qualification_version") != QUALIFICATION_VERSION:
        raise ValueError("The qualification materials do not match the active frozen version")
    if q_expected.get("config", {}).get("item_count") != 10 or q_expected.get("config", {}).get("scored_total") != SCORED_TOTAL:
        raise ValueError("The qualification fixture does not contain ten items and 18 scored labels")
    frozen_fingerprint = sha256_text(canonical({"templates": q_expected.get("templates"), "keys": q_expected.get("keys")}))
    if frozen_fingerprint != q_expected.get("config", {}).get("fingerprint"):
        raise ValueError("The qualification template/key fingerprint does not match its frozen inventory")
    policy = qualification_key.get("policy")
    if (qualification_key.get("policy_version") != POLICY_VERSION or
            qualification_key.get("qualification_version") != QUALIFICATION_VERSION or
            qualification_key.get("pass_count") != PASS_COUNT or not isinstance(policy, dict) or
            policy.get("pass_count") != PASS_COUNT or policy.get("scored_total") != SCORED_TOTAL or
            policy.get("confirmed_scored_count") != SCORED_TOTAL or policy.get("key_status") != "human_confirmed_scored"):
        raise ValueError("The human-confirmed qualification policy is incomplete")

    all_templates = [row for row in q_expected.get("templates", []) if row.get("kind") == "qualification"]
    all_keys = q_expected.get("keys", [])
    if (len(all_templates) != 30 or len({row.get("template_id") for row in all_templates}) != 30 or
            len(all_keys) != 30 or len({row.get("template_id") for row in all_keys}) != 30):
        raise ValueError("The frozen qualification inventory must contain 30 unique schemes/templates and keys")
    by_scheme_qid = {
        scheme: {
            row.get("coordinator", {}).get("qualification_id"): row
            for row in all_templates if row.get("scheme") == scheme
        }
        for scheme in SCHEMES
    }
    qids = {f"Q{i:02d}" for i in range(1, 11)}
    if any(set(rows) != qids or len(rows) != 10 for rows in by_scheme_qid.values()):
        raise ValueError("Each qualification scheme must contain exactly Q01–Q10")
    templates = [by_scheme_qid[1][f"Q{i:02d}"] for i in range(1, 11)]
    by_qid = {row.get("coordinator", {}).get("qualification_id"): row for row in templates}
    if set(by_qid) != qids or len(templates) != 10:
        raise ValueError("Canonical scheme 1 must contain exactly Q01–Q10")
    all_keys_by_template = {row.get("template_id"): row for row in all_keys}
    key_by_scheme_qid = {
        scheme: {
            qid: all_keys_by_template.get(template["template_id"])
            for qid, template in by_scheme_qid[scheme].items()
        }
        for scheme in SCHEMES
    }
    if any(any(not isinstance(key, dict) for key in rows.values()) for rows in key_by_scheme_qid.values()):
        raise ValueError("Canonical qualification answer suggestions are incomplete")
    human_scored = qualification_key.get("scored_labels")
    reviewed: dict[tuple[str, str], str] = {}
    for label in human_scored if isinstance(human_scored, list) else []:
        key = (label.get("qualification_id"), label.get("dimension"))
        if key in reviewed or label.get("final_label") not in {"A", "B", "Tie"}:
            raise ValueError("The human-confirmed scored key contains duplicate/invalid entries")
        reviewed[key] = label["final_label"]
    key_by_id = key_by_scheme_qid[1]
    expected_scored = {
        (qid, dim)
        for qid, key in key_by_id.items()
        for dim, suggestion in key["suggestions"].items()
        if suggestion.get("scored") is True
    }
    if len(expected_scored) != SCORED_TOTAL or set(reviewed) != expected_scored:
        raise ValueError("The answer key is not exactly the 18 human-confirmed scored labels")

    matching_schemes = []
    for scheme in SCHEMES:
        keys = key_by_scheme_qid[scheme]
        if all(reviewed[(qid, dim)] == keys[qid]["suggestions"][dim]["label"] for qid, dim in expected_scored):
            matching_schemes.append(scheme)
    if len(matching_schemes) != 1:
        raise ValueError("Could not uniquely identify the reviewed qualification presentation orientation")
    reviewed_scheme = matching_schemes[0]
    for qid, dim in expected_scored:
        canonical_label = key_by_id[qid]["suggestions"][dim]["label"]
        canonical_swapped = bool(by_qid[qid]["coordinator"].get("review_orientation_swapped"))
        reviewed_swapped = bool(by_scheme_qid[reviewed_scheme][qid]["coordinator"].get("review_orientation_swapped"))
        transformed = canonical_label
        if canonical_swapped != reviewed_swapped and canonical_label != "Tie":
            transformed = "B" if canonical_label == "A" else "A"
        if reviewed[(qid, dim)] != transformed:
            raise ValueError("The reviewed scored key does not map consistently to canonical scheme 1")

    qualification: list[dict[str, Any]] = []
    private_keys: list[dict[str, Any]] = []
    for position in range(1, 11):
        qid = f"Q{position:02d}"
        template = by_qid[qid]
        if template.get("position") != position:
            raise ValueError("Canonical qualification ordering differs from Q01–Q10")
        qualification.append({
            "item_id": qid,
            "kind": "qualification",
            "position": position,
            "template_id": template["template_id"],
            "payload": template["payload"],
            "hashes": template["hashes"],
        })
        key = key_by_id[qid]
        if set(key.get("suggestions", {})) != set(DIMENSIONS):
            raise ValueError("Qualification scoring suggestions do not cover all five dimensions")
        judgments: dict[str, Any] = {}
        for dim in DIMENSIONS:
            suggestion = key["suggestions"][dim]
            if suggestion.get("label") not in {"A", "B", "Tie"}:
                raise ValueError("Qualification key contains an invalid choice")
            scored = suggestion.get("scored") is True
            # The review export is in the one identified reviewed scheme; the
            # shared task pack uses canonical scheme 1, so its answer label is
            # the scheme-1 suggestion after the orientation transform above.
            label = suggestion["label"]
            judgments[dim] = {
                "label": label,
                "scored": scored,
                "label_status": "human_confirmed" if scored else "ai_provisional_exploratory",
                "rationale_zh": suggestion.get("rationale_zh"),
            }
        private_keys.append({
            "qualification_id": qid,
            "dataset": key["dataset"],
            "title_zh": key.get("title_zh"),
            "template_id": key["template_id"],
            "judgments": judgments,
        })
    if Counter(row["dataset"] for row in private_keys) != Counter({"cnndm": 5, "gumsum": 5}):
        raise ValueError("Qualification must contain five CNN/DM and five GUMSum items")
    return qualification, private_keys


def build_outputs(
    expected: dict[str, Any], q_expected: dict[str, Any], confirmed_key: dict[str, Any],
) -> list[tuple[str, str]]:
    templates = expected.get("templates")
    settings = expected.get("settings")
    if not isinstance(templates, list) or not isinstance(settings, dict):
        raise ValueError("The frozen private study fixture is incomplete")
    study_templates = [row for row in templates if row.get("kind") == "study"]
    by_id = _check_canonical_pool(study_templates)
    variants = _validate_template_variants(study_templates, by_id)
    if not isinstance(settings.get("rubric"), dict) or not isinstance(settings.get("guide_md"), str):
        raise ValueError("The frozen rubric or annotation guide is missing")
    policy = confirmed_key.get("policy")
    if not isinstance(policy, dict) or not isinstance(policy.get("workflow_guide_md"), str):
        raise ValueError("The human-confirmed qualification approval has no frozen workflow guide")
    if policy.get("fingerprint") != q_expected.get("config", {}).get("fingerprint"):
        raise ValueError("Qualification materials differ from the human-confirmed approval fingerprint")
    if policy.get("workflow_guide_sha256") != sha256_text(policy["workflow_guide_md"]):
        raise ValueError("The qualification workflow guide hash is invalid")
    qualification, private_keys = _qualification_templates(q_expected, confirmed_key)

    per_person, orientations, by_id = make_assignment(study_templates)
    # Map frozen pair and desired A/B orientation to an existing scheme template.
    records_by_person: dict[int, list[dict[str, Any]]] = {person: [] for person in PARTICIPANTS}
    for person, items in per_person.items():
        for canonical_item in items:
            meta = canonical_item["coordinator"]
            pair_id = meta["pair_id"]
            desired = "A" if person in orientations[pair_id] else "B"
            matching = [row for row in variants[pair_id].values() if row["coordinator"]["ours_side"] == desired]
            if not matching:
                raise ValueError("No existing presentation scheme has the requested A/B orientation")
            chosen = min(matching, key=lambda row: row["scheme"])
            records_by_person[person].append({
                "item_id": pair_id,
                "kind": "study",
                "position": 0,
                "template_id": chosen["template_id"],
                "payload": chosen["payload"],
                "hashes": chosen["hashes"],
                # Candidate IDs/methods are presentation-order dependent; use
                # the selected template's mapping, not canonical scheme 1.
                "_coordinator": chosen["coordinator"],
                "_ours_side": desired,
            })

    rng = random.Random(2601101)
    package_files: list[tuple[str, str]] = []
    manifest_packages: list[dict[str, Any]] = []
    plan_packages: list[dict[str, Any]] = []
    mapping_items: list[dict[str, Any]] = []
    for person in PARTICIPANTS:
        study = records_by_person[person]
        if len(study) != 42:
            raise ValueError("A generated worker package does not have exactly 42 study items")
        rng.shuffle(study)
        mac = [item for item in study if item["_coordinator"]["dataset"] == "macsum"]
        gum = [item for item in study if item["_coordinator"]["dataset"] == "gumsum"]
        if len(mac) != 20 or len(gum) != 22:
            raise ValueError("A worker package must contain 20 MACSum and 22 GUMSum items")
        for position, item in enumerate(study, start=1):
            item["position"] = position

        package_id = f"package_{person + 1:02d}"
        # Do not place the private analysis mapping in the worker-facing package.
        package = {
            "schema_version": "annotation-package-v1",
            "assignment_version": ASSIGNMENT_VERSION,
            "package_id": package_id,
            "rubric_version": settings["rubric_version"],
            "study_fingerprint": settings["study_fingerprint"],
            "instruction_fingerprint": settings["instruction_fingerprint"],
            "qualification_version": QUALIFICATION_VERSION,
            "policy_version": POLICY_VERSION,
            "pass_count": PASS_COUNT,
            "scored_total": SCORED_TOTAL,
            "rubric": settings["rubric"],
            "guide_md": policy["workflow_guide_md"],
            "qualification": qualification,
            "study": [{key: value for key, value in item.items() if not key.startswith("_")} for item in study],
        }
        package_name = f"{package_id}.json"
        package_text = json_bytes(package).decode("utf-8")
        package_files.append((package_name, package_text))
        mac_strata = Counter(item["_coordinator"]["stratum"] for item in mac)
        mac_lengths = Counter(item["_coordinator"]["macsum_length"] for item in mac)
        gum_strata = Counter(item["_coordinator"]["stratum"] for item in gum)
        gum_genres = Counter(item["_coordinator"]["genre"] for item in gum)
        a_count = sum(item["_ours_side"] == "A" for item in study)
        if (mac_strata != Counter({"improved": 7, "near": 6, "declined": 7}) or
                sorted(mac_lengths.values()) != [6, 7, 7] or
                sorted(gum_strata.values()) != [7, 7, 8] or
                Counter(gum_genres) != Counter({genre: 2 for genre in GUM_GENRES}) or
                a_count != 21):
            raise ValueError("A generated worker package failed its orientation or GUMSum genre balance")
        manifest_packages.append({
            "package_id": package_id,
            "file": package_name,
            "sha256": sha256_text(package_text),
            "qualification_sha256": sha256_text(canonical(qualification)),
            "study_count": len(study),
            "macsum_count": len(mac),
            "gumsum_count": len(gum),
            "macsum_strata": {s: mac_strata[s] for s in STRATA},
            "macsum_lengths": {length: mac_lengths[length] for length in LENGTHS},
            "gumsum_strata": {s: gum_strata[s] for s in STRATA},
            "gumsum_genres": {genre: gum_genres[genre] for genre in GUM_GENRES},
            "ours_on_a": a_count,
            "ours_on_b": 42 - a_count,
        })
        plan_packages.append({
            "package_id": package_id,
            "ordinal": person + 1,
            "items": [{"position": row["position"], "item_id": row["item_id"], "template_id": row["template_id"]} for row in study],
        })
        for item in study:
            meta = item["_coordinator"]
            mapping_items.append({
                "package_id": package_id,
                "position": item["position"],
                "item_id": item["item_id"],
                "template_id": item["template_id"],
                "dataset": meta["dataset"],
                "genre": meta["genre"],
                "macsum_length": meta["macsum_length"],
                "stratum": meta["stratum"],
                "ours_side": item["_ours_side"],
                "summary_a_id": meta["summary_a_id"],
                "summary_b_id": meta["summary_b_id"],
                "summary_a_method": meta["summary_a_method"],
                "summary_b_method": meta["summary_b_method"],
            })

    # Validate exact item coverage and both orientations across the assigned raters.
    assigned = Counter(row["item_id"] for pack in plan_packages for row in pack["items"])
    if set(assigned) != set(by_id) or any(assigned[item_id] != 3 for item_id in by_id):
        raise ValueError("Every formal pair must be assigned to exactly three different packages")
    orientations_by_item: dict[str, set[str]] = defaultdict(set)
    for row in mapping_items:
        orientations_by_item[row["item_id"]].add(row["ours_side"])
    if any(sides != {"A", "B"} for sides in orientations_by_item.values()):
        raise ValueError("Each formal item must be shown with Ours on both A and B across raters")
    overlap: dict[str, dict[str, int]] = {}
    for left in range(9):
        left_items = {row["item_id"] for row in plan_packages[left]["items"]}
        for right in range(left + 1, 9):
            right_items = {row["item_id"] for row in plan_packages[right]["items"]}
            shared = len(left_items & right_items)
            if shared not in (10, 11):
                raise ValueError("The crossed design must give each pair of workers 10 or 11 shared items")
            overlap[f"package_{left + 1:02d}|package_{right + 1:02d}"] = shared

    plan_body = {"version": ASSIGNMENT_VERSION, "packages": plan_packages}
    plan = plan_body | {"fingerprint": sha256_text(canonical(plan_body))}
    manifest = {
        "schema_version": "annotation-package-manifest-v1",
        "assignment_version": ASSIGNMENT_VERSION,
        "study_fingerprint": settings["study_fingerprint"],
        "instruction_fingerprint": settings["instruction_fingerprint"],
        "rubric_version": settings["rubric_version"],
        "qualification_version": QUALIFICATION_VERSION,
        "policy_version": POLICY_VERSION,
        "pass_count": PASS_COUNT,
        "scored_total": SCORED_TOTAL,
        "packages": manifest_packages,
    }
    qualification_private = {
        "schema_version": "qualification-key-private-v1",
        "assignment_version": ASSIGNMENT_VERSION,
        "qualification_version": QUALIFICATION_VERSION,
        "policy_version": POLICY_VERSION,
        "key_status": "human_confirmed_scored",
        "pass_count": PASS_COUNT,
        "scored_total": SCORED_TOTAL,
        "confirmed_scored_count": SCORED_TOTAL,
        "exploratory_count": 32,
        "items": private_keys,
    }
    analysis_mapping = {
        "schema_version": "analysis-mapping-private-v1",
        "assignment_version": ASSIGNMENT_VERSION,
        "items": mapping_items,
    }
    report = {
        "schema_version": "fixed-package-validation-v1",
        "assignment_version": ASSIGNMENT_VERSION,
        "valid": True,
        "counts": {
            "packages": 9,
            "qualification_per_package": 10,
            "study_per_package": 42,
            "macsum_per_package": 20,
            "gumsum_per_package": 22,
            "formal_items": 126,
            "ratings": 378,
            "ratings_per_item": 3,
            "qualification_scored": SCORED_TOTAL,
            "qualification_pass_count": PASS_COUNT,
        },
        "requirements": {
            "qualification_shared_identically": True,
            "qualification_datasets_per_package": {"cnndm": 5, "gumsum": 5},
            "all_qualification_templates_canonical_scheme_1": True,
            "macsum_per_package": {
                "strata": {"improved": 7, "near": 6, "declined": 7},
                "lengths": "6/7/7 per package; the length group with six items rotates",
            },
            "gumsum_per_package": {
                "genres": {genre: 2 for genre in GUM_GENRES},
                "strata": "7/7/8 (the stratum with eight items rotates across packages)",
            },
            "ours_a_b_per_package": {"A": 21, "B": 21},
            "all_items_have_three_distinct_packages": True,
            "every_item_uses_both_ours_orientations": True,
            "pairwise_package_overlap_range": [min(overlap.values()), max(overlap.values())],
        },
        "pairwise_package_overlap": overlap,
        "package_summaries": manifest_packages,
    }
    files = list(package_files)
    files.extend([
        ("manifest.private.json", json_bytes(manifest).decode("utf-8")),
        ("assignment_plan.private.json", json_bytes(plan).decode("utf-8")),
        ("qualification_key.private.json", json_bytes(qualification_private).decode("utf-8")),
        ("analysis_mapping.private.json", json_bytes(analysis_mapping).decode("utf-8")),
        ("validation_report.json", json_bytes(report).decode("utf-8")),
    ])
    hashes = {name: sha256_text(text) for name, text in files}
    for filename, text in files:
        if filename == "manifest.private.json":
            value = json.loads(text)
            value["private_file_sha256"] = {name: hashes[name] for name in sorted(hashes) if name != filename}
            manifest_text = json_bytes(value).decode("utf-8")
            files[files.index((filename, text))] = (filename, manifest_text)
            break
    return files


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--research-root", type=Path, required=True, help="Private research checkout containing the frozen source fixtures")
    parser.add_argument("--output-dir", type=Path, required=True, help="New private directory outside the public deploy repository")
    args = parser.parse_args(argv)
    research_root = args.research_root.resolve()
    destination = args.output_dir.resolve()
    helpers = _private_helpers()
    helpers._assert_private_destination(destination, PUBLIC_ROOT.resolve(), "fixed annotation package output")
    if destination.exists():
        raise FileExistsError(f"Refusing to overwrite an existing private package directory: {destination}")
    setup = research_root / "data/summary_generation/human_preference_annotation_v1/online_setup"
    review_path = research_root / "data/summary_generation/human_qualification_review_v1/qualification_scored_gold_human_confirmed_v1.json"
    source_path = setup / "expected-private.json"
    qualification_path = setup / "qualification-pilot-expected-private.json"
    for path in (source_path, qualification_path, review_path):
        if not path.is_file():
            raise FileNotFoundError(f"Required frozen private input is missing: {path}")
    expected = json.loads(source_path.read_text(encoding="utf-8"))
    q_expected = json.loads(qualification_path.read_text(encoding="utf-8"))
    confirmed_key = json.loads(review_path.read_text(encoding="utf-8"))
    files = build_outputs(expected, q_expected, confirmed_key)
    helpers.write_output_directory(destination, files)
    print(f"Created {len(files)} private files at {destination}")
    print("Validated 9 packages × (10 shared qualification + 42 assigned study); 126 study pairs × 3 packages.")
    print("Qualification: 14/18 threshold; references and answer keys remain in private files.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
