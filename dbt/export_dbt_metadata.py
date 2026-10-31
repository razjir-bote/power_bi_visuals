"""Export dbt documentation metadata to CSV.

Reads the artifacts written by `dbt docs generate`:
  - target/manifest.json  (project definition: descriptions, config, tags, meta,
                           lineage, tests, documented columns, ...)
  - target/catalog.json   (what is actually in the warehouse: relation type,
                           owner, stats, every physical column with its type)

and writes two CSV files:
  - dbt_tables.csv   one row per relation produced by dbt (models, seeds,
                     snapshots; sources optional) with a fixed set of columns
                     (see TABLE_COLUMNS). `config` and `meta` are whole JSON
                     objects in one column each.
  - dbt_columns.csv  one row per column of every table, merging the documented
                     columns (manifest) with the physical columns (catalog).
                     Every column-level field dbt captures is kept: nested
                     objects are flattened into dotted names, lists are JSON
                     strings, and `meta` and `config` are one JSON column each.
                     The header is the union of all keys seen.

Usage:
    python export_dbt_metadata.py [--target-dir target] [--out-dir .]
                                  [--include-sources]

Run `dbt docs generate` first. If catalog.json is missing the export still
works, but only with manifest metadata (no physical types, no undocumented
columns).
"""

from __future__ import annotations

import argparse
import csv
import json
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any

# Resource types that materialise a relation in the warehouse.
TABLE_RESOURCE_TYPES = {"model", "seed", "snapshot"}

# Exact columns of the tables CSV, in order.
TABLE_COLUMNS = [
    "unique_id", "resource_type", "package_name", "database", "schema", "name",
    "alias", "relation_name", "materialized", "catalog.metadata.type",
    "description", "column_count", "documented_column_count",
    "undocumented_columns", "tests", "config", "meta",
]
# Columns placed first in the columns CSV (when present); everything else
# follows in order of first appearance.
COLUMN_LEADING_COLUMNS = [
    "table_unique_id", "table_resource_type", "table_database", "table_schema",
    "table_name", "table_relation_name", "name", "catalog.index",
    "catalog.type", "data_type", "description", "is_documented",
    "in_warehouse", "is_primary_key", "tests",
]


def load_json(path: Path, required: bool) -> dict | None:
    if not path.exists():
        if required:
            sys.exit(f"error: {path} not found. Run `dbt docs generate` first.")
        print(f"warning: {path} not found; exporting manifest metadata only.",
              file=sys.stderr)
        return None
    with path.open(encoding="utf-8") as f:
        return json.load(f)


def flatten(obj: Any, prefix: str = "", out: dict | None = None) -> dict:
    """Flatten nested dicts into dotted keys; lists become JSON strings."""
    if out is None:
        out = {}
    if isinstance(obj, dict):
        if not obj and prefix:
            out[prefix] = "{}"
        for key, value in obj.items():
            flatten(value, f"{prefix}.{key}" if prefix else str(key), out)
    elif isinstance(obj, (list, tuple)):
        out[prefix] = json.dumps(obj, default=str) if obj else ""
    elif obj is None:
        out[prefix] = ""
    else:
        out[prefix] = obj
    return out


def to_json(obj: Any) -> str:
    """Serialise a whole object into one CSV cell (blank when absent)."""
    return json.dumps(obj, default=str, sort_keys=True) if obj is not None else ""


def collect_tests(manifest: dict) -> tuple[dict, dict]:
    """Map tests to the tables / columns they cover.

    Returns (table_tests, column_tests):
      table_tests[node_id]                -> [test descriptor, ...]
      column_tests[(node_id, col_lower)]  -> [test descriptor, ...]
    """
    table_tests: dict[str, list[str]] = defaultdict(list)
    column_tests: dict[tuple[str, str], list[str]] = defaultdict(list)

    for node in manifest.get("nodes", {}).values():
        if node.get("resource_type") != "test":
            continue
        meta = node.get("test_metadata") or {}
        # Generic tests: "not_null", "relationships(to=ref('x'), field=id)" ...
        kind = meta.get("name") or "singular"
        if meta.get("namespace"):
            kind = f"{meta['namespace']}.{kind}"
        severity = (node.get("config") or {}).get("severity", "")
        descriptor = f"{kind}:{node['name']}" + (f" [{severity}]" if severity else "")

        attached = node.get("attached_node")
        targets = [attached] if attached else [
            n for n in (node.get("depends_on") or {}).get("nodes", [])
            if not n.startswith("test.")
        ]
        column = node.get("column_name")
        for target in targets:
            table_tests[target].append(descriptor)
            if column and attached:
                column_tests[(target, column.strip('"`[]').lower())].append(kind)

    return table_tests, column_tests


def build_tables(manifest: dict, catalog: dict | None, include_sources: bool,
                 table_tests: dict) -> list[tuple[dict, dict]]:
    """Return [(manifest_node, row), ...] for every table."""
    nodes = [n for n in manifest.get("nodes", {}).values()
             if n.get("resource_type") in TABLE_RESOURCE_TYPES]
    if include_sources:
        nodes += list(manifest.get("sources", {}).values())

    catalog_entries = {}
    if catalog:
        catalog_entries.update(catalog.get("nodes", {}))
        catalog_entries.update(catalog.get("sources", {}))

    results = []
    for node in sorted(nodes, key=lambda n: n["unique_id"]):
        uid = node["unique_id"]
        config = node.get("config") or {}
        cat = catalog_entries.get(uid)
        row = {
            "unique_id": uid,
            "resource_type": node.get("resource_type"),
            "package_name": node.get("package_name"),
            "database": node.get("database"),
            "schema": node.get("schema"),
            "name": node.get("name"),
            # Sources have `identifier` instead of `alias`.
            "alias": node.get("alias") or node.get("identifier"),
            "relation_name": node.get("relation_name"),
            "materialized": config.get("materialized", ""),
            "catalog.metadata.type": ((cat or {}).get("metadata") or {}).get("type", ""),
            "description": node.get("description"),
        }

        documented = node.get("columns") or {}
        physical = (cat or {}).get("columns") or {}
        # "Documented" = has a description in YAML (columns may be listed only
        # to attach tests).
        documented_lower = {n.lower() for n, c in documented.items()
                            if c.get("description")}

        row["column_count"] = len(physical) if cat else len(documented)
        row["documented_column_count"] = sum(
            1 for c in documented.values() if c.get("description"))
        row["undocumented_columns"] = json.dumps(
            [c for c in physical if c.lower() not in documented_lower]
        ) if cat else ""
        row["tests"] = json.dumps(sorted(table_tests.get(uid, [])))
        row["config"] = to_json(config)
        row["meta"] = to_json(node.get("meta") or {})

        results.append((node, row))
    return results


def build_columns(tables: list[tuple[dict, dict]], catalog: dict | None,
                  column_tests: dict) -> list[dict]:
    catalog_entries = {}
    if catalog:
        catalog_entries.update(catalog.get("nodes", {}))
        catalog_entries.update(catalog.get("sources", {}))

    rows = []
    for node, _ in tables:
        uid = node["unique_id"]
        documented = node.get("columns") or {}
        physical = (catalog_entries.get(uid) or {}).get("columns") or {}
        doc_by_lower = {k.lower(): v for k, v in documented.items()}
        primary_key = {c.lower() for c in node.get("primary_key") or []}

        # Physical columns in warehouse order, then documented-only columns
        # (documented in YAML but not present in the warehouse).
        ordered = sorted(physical.values(), key=lambda c: c.get("index") or 0)
        names = [c["name"] for c in ordered]
        seen = {n.lower() for n in names}
        names += [n for n in documented if n.lower() not in seen]

        for col_name in names:
            key = col_name.lower()
            doc = doc_by_lower.get(key, {})
            cat_col = next((c for n, c in physical.items() if n.lower() == key), None)

            row = {
                "table_unique_id": uid,
                "table_resource_type": node.get("resource_type"),
                "table_database": node.get("database"),
                "table_schema": node.get("schema"),
                "table_name": node.get("alias") or node.get("identifier") or node.get("name"),
                "table_relation_name": node.get("relation_name"),
            }
            row.update(flatten({k: v for k, v in doc.items()
                                if k not in ("name", "config", "meta")}))
            row["name"] = col_name
            row["meta"] = to_json(doc.get("meta") or {})
            row["config"] = to_json(doc.get("config"))
            row["is_documented"] = bool(doc.get("description"))
            row["in_warehouse"] = cat_col is not None if catalog else ""
            row["is_primary_key"] = key in primary_key
            row["tests"] = json.dumps(sorted(column_tests.get((uid, key), [])))
            if cat_col:
                row.update(flatten({k: v for k, v in cat_col.items() if k != "name"},
                                   "catalog"))
            rows.append(row)
    return rows


def write_csv(path: Path, rows: list[dict], leading: list[str],
              fixed: bool = False) -> None:
    """Write rows to CSV.

    fixed=True: the header is exactly `leading`.
    fixed=False: `leading` columns first (when present), then any other keys
    in order of first appearance.
    """
    if fixed:
        header = list(leading)
    else:
        header = [c for c in leading if any(c in r for r in rows)]
        seen = set(header)
        for row in rows:
            for col in row:
                if col not in seen:
                    header.append(col)
                    seen.add(col)

    path.parent.mkdir(parents=True, exist_ok=True)
    # utf-8-sig so Excel detects the encoding.
    with path.open("w", newline="", encoding="utf-8-sig") as f:
        writer = csv.DictWriter(f, fieldnames=header, restval="")
        writer.writeheader()
        writer.writerows(rows)
    print(f"wrote {len(rows):>5} rows x {len(header):>3} columns -> {path}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--target-dir", default="target", type=Path,
                        help="dbt target directory holding manifest.json and catalog.json")
    parser.add_argument("--out-dir", default=".", type=Path,
                        help="directory to write the CSV files to")
    parser.add_argument("--tables-file", default="dbt_tables.csv")
    parser.add_argument("--columns-file", default="dbt_columns.csv")
    parser.add_argument("--include-sources", action="store_true",
                        help="also export sources (tables dbt reads but does not build)")
    args = parser.parse_args()

    manifest = load_json(args.target_dir / "manifest.json", required=True)
    catalog = load_json(args.target_dir / "catalog.json", required=False)

    table_tests, column_tests = collect_tests(manifest)
    tables = build_tables(manifest, catalog, args.include_sources, table_tests)
    columns = build_columns(tables, catalog, column_tests)

    write_csv(args.out_dir / args.tables_file, [r for _, r in tables],
              TABLE_COLUMNS, fixed=True)
    write_csv(args.out_dir / args.columns_file, columns, COLUMN_LEADING_COLUMNS)


if __name__ == "__main__":
    main()
