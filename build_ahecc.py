"""
Build ahecc_2022_hs8_lookup.csv from the official ABS AHECC 2022 workbooks.

Usage (run with -I so nothing is imported from the data directory):
    python -I scripts/build_ahecc.py --download   # fetch CompleteAHECC.zip into source/raw
    python -I scripts/build_ahecc.py              # parse, validate, write CSV + reports

Source: https://www.abs.gov.au/statistics/classifications/
        australian-harmonized-export-commodity-classification-ahecc/2022
"""
from __future__ import annotations

import argparse
import collections
import hashlib
import json
import random
import re
import sys
import urllib.request
import zipfile
from pathlib import Path

import openpyxl
import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
RAW_DIR = ROOT / "source" / "raw"
EXTRACT_DIR = ROOT / "source" / "extracted"
OUT_CSV = ROOT / "ahecc_2022_hs8_lookup.csv"
REPORT_DIR = ROOT / "reports"
ZIP_URL = ("https://www.abs.gov.au/statistics/classifications/"
           "australian-harmonized-export-commodity-classification-ahecc/2022/CompleteAHECC.zip")

COLUMNS = ["hs8", "hs6", "hs4", "hs2", "section_code", "section_description",
           "chapter_description", "heading_description", "subheading_description",
           "hs8_description", "full_description", "unit_of_quantity",
           "source_table", "source_sheet", "classification_year",
           # combined "code - description" labels, one per level
           "section_label", "chapter_label", "heading_label", "subheading_label", "hs8_label",
           # all five labels above joined top-down
           "hierarchy_label"]
LABEL_SEP = " - "
LEVEL_LABELS = ["section_label", "chapter_label", "heading_label", "subheading_label", "hs8_label"]
HIERARCHY_SEP = " > "


def code_label(code, desc):
    """'0101 - LIVE HORSES...'; code alone when the source has no description (never invented)."""
    return f"{code}{LABEL_SEP}{desc}" if desc else code

ROMAN = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI", "XII",
         "XIII", "XIV", "XV", "XVI", "XVII", "XVIII", "XIX", "XX", "XXI"]

FOOTNOTE_MARK = re.compile(r"(\([a-z]{1,2}\))+$")      # e.g. "01012100(a)(b)"
LEADING_DASHES = re.compile(r"^\s*(-+)\s*(?:-+\s*)*")   # also "-- -- text" (Ch29 29037500)
EMBEDDED_LEVEL = re.compile(r"\s*:?\s+-{2,}\s+")         # "Table wines: ---- White" (Ch22)
EXPECTED_HEADER = ["Chapter", "Heading", "HS Code", "Export Statistical Item", "UQ", "Description"]

# Explicit, documented corrections of evident errors in the published workbooks.
# Key: (sheet, row) -> {column: (published value, corrected value), "reason": ...}
SOURCE_CORRECTIONS = {
    ("Chapter 90", 183): {
        "hs_code": ("902781", "90278"),
        "reason": "Row '- Other instruments and apparatus' is the one-dash HS group 9027.8 (children "
                  "90278100 Mass spectrometers / 90278900 Other). HS 2022 902781 is 'Mass spectrometers', "
                  "so the published code is mislabelled; treating it as group 90278.",
    },
}


# --------------------------------------------------------------------------- helpers
def download() -> None:
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    dest = RAW_DIR / "CompleteAHECC.zip"
    req = urllib.request.Request(ZIP_URL, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req) as r:
        dest.write_bytes(r.read())
    print(f"downloaded {dest} ({dest.stat().st_size} bytes)")


def extract() -> None:
    EXTRACT_DIR.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(RAW_DIR / "CompleteAHECC.zip") as z:
        for name in z.namelist():
            if not re.fullmatch(r"\d{6}\.xlsx", name):   # only expected flat workbook names
                raise ValueError(f"unexpected archive member {name!r}")
        z.extractall(EXTRACT_DIR)


def clean_code(v) -> tuple[str | None, str]:
    """Return (digits, footnote_markers). Codes are always text in the source."""
    if v is None:
        return None, ""
    if not isinstance(v, str):
        raise TypeError(f"non-text code cell {v!r}")
    s = v.strip().replace(" ", "")
    if not s:
        return None, ""
    m = FOOTNOTE_MARK.search(s)
    marks = m.group(0) if m else ""
    digits = s[: m.start()] if m else s
    digits = digits.strip()
    if not digits.isdigit():
        raise ValueError(f"unparseable code cell {v!r}")
    return digits, marks


def clean_desc(v) -> tuple[str, int]:
    """Strip indentation dashes and whitespace; return (text, dash_depth)."""
    if v is None:
        return "", 0
    s = str(v).replace(" ", " ").strip()
    m = LEADING_DASHES.match(s)
    depth = len(m.group(1)) if m else 0
    if m:
        s = s[m.end():]
    s = re.sub(r"\s+", " ", s).strip()
    return s, depth


def label(s: str) -> str:
    """Description as used in hierarchy columns: trailing ':' removed (it only signals children)."""
    s = EMBEDDED_LEVEL.sub(" > ", s)
    return re.sub(r"\s*:\s*$", "", s).strip()


def norm(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", s.lower()).strip()


# --------------------------------------------------------------------------- summary (Table 22)
def read_summary(path: Path):
    wb = openpyxl.load_workbook(path, read_only=True)
    ws = wb["Summary"]
    sections, chapters, chap_to_sec = {}, {}, {}
    current = None
    for r in ws.iter_rows(min_row=7, values_only=True):
        a, b, c = (list(r) + [None] * 3)[:3]
        if isinstance(a, str) and a.strip().startswith("Section"):
            num = int(re.search(r"\d+", a).group())
            current = num
            sections[num] = str(b).strip()
        elif a is None and b is not None and c is not None and current:
            ch = f"{int(b):02d}"
            chapters[ch] = str(c).strip()
            chap_to_sec[ch] = current
    return sections, chapters, chap_to_sec


# --------------------------------------------------------------------------- key of changes (Table 23)
def read_key_of_changes(path: Path):
    wb = openpyxl.load_workbook(path, read_only=True)
    out = {}
    for ws in wb.worksheets:
        if not ws.title.startswith("AHECC items"):
            continue
        codes = []
        for r in ws.iter_rows(min_row=8, values_only=True):
            v = r[0] if r else None
            if isinstance(v, str) and re.fullmatch(r"\d{8}", v.strip()):
                codes.append(v.strip())
        out[ws.title.strip()] = codes
    return out


# --------------------------------------------------------------------------- chapter parser
class Issues:
    def __init__(self):
        self.items = []

    def add(self, kind, sheet, row, detail):
        self.items.append({"kind": kind, "sheet": sheet, "row": row, "detail": detail})


def parse_chapter(ws, table_no: int, issues: Issues):
    """Parse one 'Chapter NN' worksheet. Returns (chapter_code, chapter_title, records, nodes)."""
    sheet = ws.title
    rows = list(ws.iter_rows(values_only=True))
    hdr = [(str(c).strip() if c is not None else None) for c in rows[5][:6]]
    if hdr != EXPECTED_HEADER:
        raise ValueError(f"{sheet}: unexpected header {hdr}")
    title_cell = str(rows[3][0])
    m = re.search(r"Table\s+(\d+)\.", title_cell)
    if not m or int(m.group(1)) != table_no:
        issues.add("table_title_mismatch", sheet, 4, title_cell)

    chapter_code = chapter_title = None
    heading = None            # (code, text)
    stack: list[dict] = []    # hierarchy nodes below the heading, each {level, code, text, kind}
    nodes = {}                # code -> text for HS4/5/6/7 nodes
    records = []
    in_footnotes = False

    for i, raw in enumerate(rows[6:], start=7):
        r = (list(raw) + [None] * 6)[:6]
        extra = [x for x in raw[6:] if x not in (None, "")]
        if extra:
            issues.add("extra_columns", sheet, i, extra)
        a, b, c, d, uq, desc_raw = r
        if all(x in (None, "") for x in r):
            continue

        # Column A: chapter code, or footnote/copyright text (end of the classification body)
        if a is not None:
            a_s = str(a).strip()
            if re.fullmatch(r"\d{2}", a_s):
                if chapter_code is not None:
                    issues.add("second_chapter_row", sheet, i, a_s)
                chapter_code = a_s
                chapter_title = label(clean_desc(desc_raw)[0])
                heading, stack = None, []          # reset at chapter boundary
                continue
            in_footnotes = True
            if any(x not in (None, "") for x in (b, c, d, uq)):
                issues.add("footnote_row_with_codes", sheet, i, r)
            continue
        if in_footnotes:
            issues.add("content_after_footnotes", sheet, i, r)

        hb, mb = clean_code(b)
        hc, mc = clean_code(c)
        hd, md = clean_code(d)
        fix = SOURCE_CORRECTIONS.get((sheet, i))
        if fix and "hs_code" in fix:
            published, corrected = fix["hs_code"]
            if hc != published:
                raise ValueError(f"{sheet} R{i}: correction expects {published}, found {hc}")
            hc = corrected
            issues.add("source_correction_applied", sheet, i, f"HS code {published} -> {corrected}: {fix['reason']}")
        text, dashes = clean_desc(desc_raw)
        uq = str(uq).strip() if uq not in (None, "") else None

        if hb is None and hc is None and hd is None:
            # descriptive banner rows such as "SUB-CHAPTER I - ..." in Chapter 72
            if text.upper().startswith("SUB-CHAPTER"):
                heading, stack = None, []
                continue
            issues.add("text_only_row", sheet, i, text)
            continue
        if not text:
            issues.add("code_without_description", sheet, i, r)

        # validate code shapes / chapter prefix
        for code, length in ((hb, (4,)), (hc, (5, 6)), (hd, (7, 8))):
            if code is not None:
                if len(code) not in length:
                    issues.add("bad_code_length", sheet, i, code)
                if chapter_code and not code.startswith(chapter_code):
                    issues.add("code_outside_chapter", sheet, i, code)

        # Effective depth: heading rows are level 0; otherwise dash count; un-dashed rows
        # (Chapters 98/99) fall back to the leftmost populated code column.
        if hb is not None:
            level = 0
        elif dashes > 0:
            level = dashes
        elif hc is not None:
            level = 1
            issues.add("undashed_row_level_inferred", sheet, i, f"{hc} -> level 1 (HS subheading column)")
        elif stack and not stack[-1]["is_item"]:
            level = stack[-1]["level"] + 1   # first undashed row under a group: its child
            issues.add("undashed_row_level_inferred", sheet, i, f"{hd} -> child of row {stack[-1]['row']}")
        elif stack:
            level = stack[-1]["level"]       # follows an item: its sibling
            issues.add("undashed_row_level_inferred", sheet, i, f"{hd} -> sibling of row {stack[-1]['row']}")
        else:
            level = 1
            issues.add("undashed_row_level_inferred", sheet, i, f"{hd} -> level 1 (directly under heading)")

        if hb is not None:
            if heading is not None and hb == heading[0]:
                issues.add("duplicate_heading_row", sheet, i, hb)
            heading = (hb, label(text))
            nodes[hb] = label(text)
            stack = []
        else:
            if heading is None:
                issues.add("row_before_heading", sheet, i, r)
            while stack and stack[-1]["level"] >= level:
                stack.pop()
            # HS (5/6-digit) ancestors must be code prefixes; a mis-indented row must not be
            # nested under a sibling HS subheading (e.g. Ch38 38085901, Ch55 55143095).
            # statistical items are leaves; nothing nests under an item
            while stack and stack[-1]["is_item"]:
                issues.add("indent_corrected_item_is_leaf", sheet, i,
                           f"{hd or hc} deeper than preceding item row {stack[-1]['row']}")
                stack.pop()
            own = hd or hc
            while stack and any(len(cd) in (5, 6) and not own.startswith(cd) for cd in stack[-1]["codes"]):
                issues.add("indent_corrected_by_hs_prefix", sheet, i,
                           f"{own} not nested under {stack[-1]['codes']} (row {stack[-1]['row']})")
                stack.pop()

        # node codes defined on this row (HS4 handled above)
        row_node_codes = [x for x in (hc, hd if hd and len(hd) == 7 else None) if x]
        for code in row_node_codes:
            if code in nodes and nodes[code] != label(text):
                issues.add("node_redefined", sheet, i, f"{code}: {nodes[code]!r} vs {label(text)!r}")
            nodes[code] = label(text)
        if hb is None:
            stack.append({"level": level, "codes": row_node_codes, "text": label(text), "row": i,
                          "is_item": bool(hd and len(hd) == 8)})

        if hd is not None and len(hd) == 8:
            if uq is None:
                issues.add("hs8_without_uq", sheet, i, hd)
            ancestors = stack[:-1] if hb is None else []
            # integrity: every coded ancestor must be a prefix of the item code
            for anc in ancestors:
                for code in anc["codes"]:
                    if not hd.startswith(code):
                        # 7-digit AHECC group codes are labels only; children need not share them.
                        kind = ("info_ahecc_group_code_not_prefix" if len(code) == 7
                                else "ERROR_hs_ancestor_not_prefix")
                        issues.add(kind, sheet, i, f"{hd} under {code} (row {anc['row']})")
            if any(a_["is_item"] for a_ in ancestors):
                issues.add("ERROR_item_nested_under_item", sheet, i, hd)
            if heading is None or not hd.startswith(heading[0]):
                issues.add("heading_not_prefix", sheet, i, f"{hd} under {heading}")
            if hc is not None and not hd.startswith(hc):
                issues.add("same_row_hs_code_not_prefix", sheet, i, f"{hd} vs {hc}")
            records.append({
                "hs8": hd,
                "row": i,
                "uq": uq,
                "item_text": text,          # leading dashes removed, original wording kept
                "heading_code": heading[0] if heading else None,
                "heading_text": heading[1] if heading else None,
                "path": [a_["text"] for a_ in ancestors],
                "same_row_is_heading": hb is not None,
                "footnotes": "".join([mb, mc, md]),
            })
        elif hd is None and uq is not None:
            issues.add("uq_without_item", sheet, i, r)
    if chapter_code is None:
        raise ValueError(f"{sheet}: no chapter row found")
    return chapter_code, chapter_title, records, nodes


def check_merged_cells(path: Path, issues: Issues):
    wb = openpyxl.load_workbook(path)  # full mode exposes merged ranges
    for ws in wb.worksheets:
        if re.fullmatch(r"Chapter \d\d", ws.title):
            for rng in ws.merged_cells.ranges:
                if rng.min_row > 6 and rng.min_col <= 6:
                    issues.add("merged_cell_in_body", ws.title, rng.min_row, str(rng))


def independent_scan(path: Path) -> dict[str, list[str]]:
    """Regex sweep of every cell of every chapter sheet, independent of the hierarchy parser."""
    found = collections.defaultdict(list)
    wb = openpyxl.load_workbook(path, read_only=True)
    pat = re.compile(r"^\s*(\d{8})\s*(\([a-z]{1,2}\))*\s*$")
    for ws in wb.worksheets:
        if not re.fullmatch(r"Chapter \d\d", ws.title):
            continue
        for i, row in enumerate(ws.iter_rows(values_only=True), 1):
            for j, v in enumerate(row):
                if v is None:
                    continue
                s = str(int(v)) if isinstance(v, (int, float)) and not isinstance(v, bool) else str(v)
                m = pat.match(s)
                if m:
                    found[m.group(1)].append(f"{path.name}:{ws.title}!R{i}C{j+1}")
    return found


# --------------------------------------------------------------------------- build
def build():
    issues = Issues()
    sections, sum_chapters, chap_to_sec = read_summary(EXTRACT_DIR / "123322.xlsx")
    key_changes = read_key_of_changes(EXTRACT_DIR / "123323.xlsx")
    if sorted(sections) != list(range(1, 22)):
        raise ValueError(f"summary sections {sorted(sections)}")

    all_records, chapter_titles, all_nodes = [], {}, {}
    workbooks, sheets_done, releases = [], [], {}
    scan = collections.defaultdict(list)
    for t in range(1, 22):
        path = EXTRACT_DIR / f"1233{t:02d}.xlsx"
        workbooks.append(path.name)
        check_merged_cells(path, issues)
        for code, locs in independent_scan(path).items():
            scan[code].extend(locs)
        wb = openpyxl.load_workbook(path, read_only=True)
        contents = list(wb["Contents"].iter_rows(max_row=3, values_only=True))
        releases[path.name] = contents[2][0]
        chapter_sheets = [ws for ws in wb.worksheets if re.fullmatch(r"Chapter \d\d", ws.title)]
        for ws in chapter_sheets:
            ch, title, recs, nodes = parse_chapter(ws, t, issues)
            if ws.title != f"Chapter {ch}":
                issues.add("sheet_chapter_mismatch", ws.title, 7, ch)
            if chap_to_sec.get(ch) != t:
                issues.add("section_mismatch", ws.title, 7, f"summary section {chap_to_sec.get(ch)} vs table {t}")
            if norm(title) != norm(sum_chapters.get(ch, "")):
                issues.add("chapter_title_differs_from_summary", ws.title, 7,
                           f"sheet={title!r} | summary={sum_chapters.get(ch)!r}")
            chapter_titles[ch] = title
            all_nodes.update(nodes)
            for rcd in recs:
                rcd.update(table=t, sheet=ws.title, chapter=ch)
            all_records.extend(recs)
            sheets_done.append(f"{path.name}:{ws.title}")

    missing_chapters = sorted(set(sum_chapters) - set(chapter_titles))
    extra_chapters = sorted(set(chapter_titles) - set(sum_chapters))

    # ---- duplicates: report, never silently choose
    by_code = collections.defaultdict(list)
    for rcd in all_records:
        by_code[rcd["hs8"]].append(rcd)
    duplicates = {k: v for k, v in by_code.items() if len(v) > 1}
    for k, v in duplicates.items():
        texts = {(x["item_text"], x["uq"]) for x in v}
        issues.add("duplicate_hs8" + ("_conflicting" if len(texts) > 1 else "_identical"),
                   v[0]["sheet"], v[0]["row"], f"{k}: " + "; ".join(f"{x['sheet']} R{x['row']} {x['item_text']!r} {x['uq']}" for x in v))

    # ---- assemble output rows
    out = []
    for code, recs in sorted(by_code.items()):
        rcd = recs[0]
        if len(recs) > 1 and len({(x["item_text"], x["uq"]) for x in recs}) > 1:
            raise SystemExit(f"conflicting duplicate {code}; resolve before export")
        ch, hs4, hs6 = code[:2], code[:4], code[:6]
        sec = chap_to_sec[ch]
        chapter_desc = sum_chapters.get(ch) or chapter_titles.get(ch)
        heading_desc = all_nodes.get(hs4)
        if heading_desc is None:
            issues.add("unresolved_heading", rcd["sheet"], rcd["row"], code)
        sub_desc = all_nodes.get(hs6)
        if sub_desc is None:
            issues.add("unresolved_subheading", rcd["sheet"], rcd["row"], code)
        if rcd["heading_code"] != hs4:
            issues.add("heading_context_mismatch", rcd["sheet"], rcd["row"], f"{code} parsed under {rcd['heading_code']}")

        item = rcd["item_text"]
        parts = [chapter_desc, rcd["heading_text"]] + rcd["path"] + [label(item)]
        dedup = []
        for p in parts:
            if p and (not dedup or norm(p) != norm(dedup[-1])):
                dedup.append(p)
        out.append({
            "hs8": code, "hs6": hs6, "hs4": hs4, "hs2": ch,
            "section_code": ROMAN[sec - 1],
            "section_description": sections[sec],
            "chapter_description": chapter_desc,
            "heading_description": heading_desc,
            "subheading_description": sub_desc,
            "hs8_description": item,
            "full_description": " > ".join(dedup),
            "unit_of_quantity": rcd["uq"],
            "source_table": str(rcd["table"]),
            "source_sheet": rcd["sheet"],
            "classification_year": "2022",
            "section_label": code_label(ROMAN[sec - 1], sections[sec]),
            "chapter_label": code_label(ch, chapter_desc),
            "heading_label": code_label(hs4, heading_desc),
            "subheading_label": code_label(hs6, sub_desc),
            "hs8_label": code_label(code, item),
        })
    for row in out:
        row["hierarchy_label"] = HIERARCHY_SEP.join(row[c] for c in LEVEL_LABELS)
    df = pd.DataFrame(out, columns=COLUMNS).astype("string")

    # ---- validation before export
    errors = validate(df, scan, key_changes)
    if errors:
        print("VALIDATION FAILED:\n  " + "\n  ".join(errors))
        sys.exit(1)

    df.to_csv(OUT_CSV, index=False, encoding="utf-8-sig", na_rep="")

    # ---- reload & re-validate the saved file
    re_df = pd.read_csv(OUT_CSV, dtype=str, keep_default_na=False, encoding="utf-8-sig")
    re_df = re_df.replace("", pd.NA)
    errors = validate(re_df, scan, key_changes)
    if errors:
        print("POST-EXPORT VALIDATION FAILED:\n  " + "\n  ".join(errors))
        sys.exit(1)

    write_reports(re_df, issues, workbooks, sheets_done, releases, scan, key_changes,
                  duplicates, missing_chapters, extra_chapters)


def validate(df: pd.DataFrame, scan, key_changes) -> list[str]:
    e = []
    if list(df.columns) != COLUMNS:
        e.append(f"columns {list(df.columns)}")
    if df["hs8"].isna().any():
        e.append("null hs8")
    bad = df[~df["hs8"].fillna("").str.fullmatch(r"[0-9]{8}")]
    if len(bad):
        e.append(f"{len(bad)} invalid hs8 codes")
    for col, n in (("hs6", 6), ("hs4", 4), ("hs2", 2)):
        if (df[col] != df["hs8"].str[:n]).any():
            e.append(f"{col} != hs8[:{n}]")
    if df["hs8"].duplicated().any():
        e.append(f"{df['hs8'].duplicated().sum()} duplicate hs8")
    if not df["hs8"].is_monotonic_increasing:
        e.append("not sorted by hs8")
    for col in ("section_code", "section_description", "chapter_description", "hs8_description",
                "full_description", "source_table", "source_sheet"):
        if df[col].isna().any():
            e.append(f"{df[col].isna().sum()} missing {col}")
    if (df["classification_year"] != "2022").any():
        e.append("classification_year")
    # label columns must be exactly code [+ " - " + description] for the same row
    for lab, code_col, desc_col in (("section_label", "section_code", "section_description"),
                                    ("chapter_label", "hs2", "chapter_description"),
                                    ("heading_label", "hs4", "heading_description"),
                                    ("subheading_label", "hs6", "subheading_description"),
                                    ("hs8_label", "hs8", "hs8_description")):
        expected = [code_label(c, d if isinstance(d, str) else None)
                    for c, d in zip(df[code_col], df[desc_col])]
        if list(df[lab]) != expected:
            e.append(f"{lab} inconsistent with {code_col}/{desc_col}")
    joined = df[LEVEL_LABELS].astype(str).agg(HIERARCHY_SEP.join, axis=1)
    if (df["hierarchy_label"] != joined).any():
        e.append("hierarchy_label is not the concatenation of the level labels")
    if df["hierarchy_label"].duplicated().any():
        e.append("duplicate hierarchy_label")
    # reconciliation with the independent regex sweep
    src = set(scan)
    got = set(df["hs8"])
    if src - got:
        e.append(f"in source but not extracted: {sorted(src - got)[:20]}")
    if got - src:
        e.append(f"extracted but not in source sweep: {sorted(got - src)[:20]}")
    # sheet/chapter consistency
    if (df["source_sheet"] != "Chapter " + df["hs2"]).any():
        e.append("source_sheet does not match hs2")
    # items commencing per Key of Changes must exist, unless closed by a later amendment
    # (e.g. 30024900 commenced 1-1-22, ended 30-04-22, removed from Table 6 on 18-04-2023)
    later_ended = set(key_changes.get("AHECC items ending 30-04-22", []))
    for title, codes in key_changes.items():
        if "commencing" in title:
            expected = set(codes) - (later_ended if title.endswith("1-1-22") else set())
            miss = sorted(expected - got)
            if miss:
                e.append(f"Key of Changes '{title}' items missing: {miss}")
    # every closed item must be absent from the current classification
    for title, codes in key_changes.items():
        if "ending" in title:
            still = sorted(set(codes) & got)
            if still:
                e.append(f"Key of Changes '{title}' closed items still present: {still}")
    return e


def write_reports(df, issues, workbooks, sheets_done, releases, scan, key_changes,
                  duplicates, missing_chapters, extra_chapters):
    REPORT_DIR.mkdir(exist_ok=True)
    got = set(df["hs8"])
    ended = {}
    for title, codes in key_changes.items():
        if "ending" in title:
            ended[title] = sorted(set(codes) & got)
    kinds = collections.Counter(x["kind"] for x in issues.items)
    zip_path = RAW_DIR / "CompleteAHECC.zip"
    summary = {
        "source_url": ZIP_URL,
        "zip_sha256": hashlib.sha256(zip_path.read_bytes()).hexdigest(),
        "zip_bytes": zip_path.stat().st_size,
        "workbook_release_lines": releases,
        "workbooks_processed": len(workbooks),
        "chapter_sheets_processed": len(sheets_done),
        "rows": len(df),
        "distinct_hs8": int(df["hs8"].nunique()),
        "sections": int(df["section_code"].nunique()),
        "chapters": int(df["hs2"].nunique()),
        "headings": int(df["hs4"].nunique()),
        "subheadings": int(df["hs6"].nunique()),
        "leading_zero_codes": int(df["hs8"].str.startswith("0").sum()),
        "source_sweep_distinct_codes": len(scan),
        "source_sweep_codes_seen_more_than_once": {k: v for k, v in scan.items() if len(v) > 1},
        "duplicate_hs8_in_source": {k: [f"{x['sheet']} R{x['row']}" for x in v] for k, v in duplicates.items()},
        "missing_chapters_vs_summary": missing_chapters,
        "extra_chapters_vs_summary": extra_chapters,
        "missing": {c: int(df[c].isna().sum()) for c in df.columns},
        "uq_values": df["unit_of_quantity"].value_counts(dropna=False).to_dict(),
        "key_of_changes_ended_items_still_present": ended,
        "issue_counts": dict(kinds),
    }
    (REPORT_DIR / "build_summary.json").write_text(json.dumps(summary, indent=2, default=str), encoding="utf-8")
    pd.DataFrame(issues.items).to_csv(REPORT_DIR / "parse_issues.csv", index=False, encoding="utf-8-sig")
    print(json.dumps({k: v for k, v in summary.items() if k not in
                      ("workbook_release_lines", "source_sweep_codes_seen_more_than_once")}, indent=2, default=str))


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--download", action="store_true", help="download and extract the ABS archive first")
    args = ap.parse_args()
    if args.download:
        download()
        extract()
    random.seed(0)
    build()
