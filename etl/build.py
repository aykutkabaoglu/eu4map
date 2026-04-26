"""ETL: raw EU4 game files -> data/eu4.db + static JSON assets.

Inputs  (read-only): /eu4_raw/  (host: ~/eu4)
Outputs (writable):  /workspace/data/
  - eu4.db                           SQLite with countries, provinces, history, rulers, leaders, owner timeline
  - countries.json                   { tag: { name, color: [r,g,b] } }
  - province_owner_timeline.json     { id: [["YYYY-MM-DD", "TAG"], ...] }
  - meta.json                        { start, end, width, height, sea_ids, lake_ids, wasteland_ids }
  - .etl_state.json                  input file SHA hashes for idempotent re-runs

Run inside the dev container:
    docker compose exec dev bash -lc "cd /workspace/etl && python build.py"
"""

from __future__ import annotations

import csv
import hashlib
import json
import os
import re
import sqlite3
import sys
import time
from pathlib import Path
from typing import Iterable

from pdx_parser import Block, Date, parse_file


RAW = Path("/eu4_raw")
OUT = Path("/workspace/data")

# EU4 canonical campaign window.
GAME_START = Date(1444, 11, 11)
GAME_END = Date(1821, 1, 3)

# Paradox files are not strict ISO-8859-1 nor UTF-8; cp1252 is the closest.
ENCODING = "cp1252"

# Keys we keep verbatim as country-level scalars.
COUNTRY_SCALAR_KEYS = (
    "government",
    "religion",
    "primary_culture",
    "technology_group",
    "capital",
)


# ---------------------------------------------------------------------------
# Raw file loaders
# ---------------------------------------------------------------------------


def load_definition_csv(path: Path) -> dict[int, tuple[str, int, int, int]]:
    """definition.csv: province;red;green;blue;name;x (ISO-8859-1 / cp1252, `;` sep)."""
    out: dict[int, tuple[str, int, int, int]] = {}
    with open(path, "r", encoding=ENCODING, errors="replace", newline="") as f:
        reader = csv.reader(f, delimiter=";")
        header = next(reader, None)
        for row in reader:
            if not row or not row[0].strip().isdigit():
                continue
            pid = int(row[0])
            r, g, b = int(row[1]), int(row[2]), int(row[3])
            name = row[4] if len(row) > 4 else ""
            out[pid] = (name, r, g, b)
    return out


def load_default_map(path: Path) -> dict:
    block = parse_file(path, encoding=ENCODING)
    sea = [int(x) for x in (block.get("sea_starts") or Block()).bare()]
    lakes = [int(x) for x in (block.get("lakes") or Block()).bare()]
    return {
        "width": block.get("width"),
        "height": block.get("height"),
        "max_provinces": block.get("max_provinces"),
        "sea_ids": sorted(set(sea)),
        "lake_ids": sorted(set(lakes)),
    }


def load_wasteland_ids(climate_path: Path) -> list[int]:
    """climate.txt has `impassable = { ids... }` for wasteland provinces."""
    if not climate_path.exists():
        return []
    block = parse_file(climate_path, encoding=ENCODING)
    imp = block.get("impassable")
    if not isinstance(imp, Block):
        return []
    return sorted(set(int(x) for x in imp.bare()))


def load_country_tags(dir_path: Path) -> dict[str, str]:
    """common/country_tags/*.txt: TAG = "countries/Filename.txt"."""
    tags: dict[str, str] = {}
    for p in sorted(dir_path.glob("*.txt")):
        block = parse_file(p, encoding=ENCODING)
        for k, v in block.pairs():
            if isinstance(k, str) and isinstance(v, str):
                tags[k] = v
    return tags


def load_country_color(common_file: Path) -> tuple[int, int, int] | None:
    if not common_file.exists():
        return None
    block = parse_file(common_file, encoding=ENCODING)
    color = block.get("color")
    if isinstance(color, Block):
        vals = [int(x) for x in color.bare() if isinstance(x, (int, float))]
        if len(vals) >= 3:
            return vals[0], vals[1], vals[2]
    return None


# ---------------------------------------------------------------------------
# History file splitters: initial (pre-date) scalars vs. dated event blocks
# ---------------------------------------------------------------------------


def split_history(block: Block) -> tuple[Block, list[tuple[Date, Block]]]:
    """Split a history file into (initial_block, [(date, event_block), ...])."""
    initial = Block()
    dated: list[tuple[Date, Block]] = []
    for k, v in block.entries:
        if isinstance(k, str) and k.count(".") == 2 and isinstance(v, Block):
            try:
                d = Date.parse(k)
            except ValueError:
                initial.entries.append((k, v))
                continue
            dated.append((d, v))
        else:
            initial.entries.append((k, v))
    dated.sort(key=lambda t: (t[0].y, t[0].m, t[0].d))
    return initial, dated


# ---------------------------------------------------------------------------
# Derivations
# ---------------------------------------------------------------------------


def owner_timeline(initial: Block, dated: list[tuple[Date, Block]]) -> list[tuple[Date, str]]:
    """Chronological list of (date, owner_tag) — start date first, then changes."""
    timeline: list[tuple[Date, str]] = []
    init_owner = initial.get("owner")
    if isinstance(init_owner, str):
        timeline.append((GAME_START, init_owner))
    for date, events in dated:
        owner = events.get("owner")
        if isinstance(owner, str):
            if not timeline or timeline[-1][1] != owner:
                timeline.append((date, owner))
    return timeline


def extract_rulers(tag: str, dated: list[tuple[Date, Block]]) -> list[dict]:
    """Extract monarch / heir / queen from dated country history events."""
    kinds = ("monarch", "heir", "queen")
    out: list[dict] = []
    for date, events in dated:
        for kind in kinds:
            for v in events.get_all(kind):
                if not isinstance(v, Block):
                    continue
                personalities = [p for p in v.get_all("add_ruler_personality") if isinstance(p, str)]
                out.append(
                    {
                        "tag": tag,
                        "kind": kind,
                        "name": _as_str(v.get("name")),
                        "dynasty": _as_str(v.get("dynasty")),
                        "birth_date": _as_iso(v.get("birth_date")),
                        "death_date": _as_iso(v.get("death_date")),
                        "start_date": date.iso(),
                        "adm": _as_int(v.get("adm")),
                        "dip": _as_int(v.get("dip")),
                        "mil": _as_int(v.get("mil")),
                        "personality": ",".join(personalities) or None,
                    }
                )
    return out


def extract_leaders(tag: str, dated: list[tuple[Date, Block]]) -> list[dict]:
    """Extract general / admiral / explorer / conquistador leaders."""
    out: list[dict] = []
    for date, events in dated:
        for v in events.get_all("leader"):
            if not isinstance(v, Block):
                continue
            out.append(
                {
                    "tag": tag,
                    "name": _as_str(v.get("name")),
                    "type": _as_str(v.get("type")),
                    "fire": _as_int(v.get("fire")),
                    "shock": _as_int(v.get("shock")),
                    # EU4 misspells "manuever" in many files
                    "maneuver": _as_int(v.get("maneuver") if v.get("maneuver") is not None else v.get("manuever")),
                    "siege": _as_int(v.get("siege")),
                    "start_date": date.iso(),
                    "death_date": _as_iso(v.get("death_date")),
                    "personality": _as_str(v.get("personality")),
                }
            )
    return out


def _as_str(v: object) -> str | None:
    if isinstance(v, str):
        return v
    if isinstance(v, (int, float, bool)):
        return str(v)
    if isinstance(v, Date):
        return v.iso()
    return None


def _as_int(v: object) -> int | None:
    if isinstance(v, int) and not isinstance(v, bool):
        return v
    if isinstance(v, float):
        return int(v)
    return None


def _as_iso(v: object) -> str | None:
    return v.iso() if isinstance(v, Date) else None


# ---------------------------------------------------------------------------
# SQLite schema
# ---------------------------------------------------------------------------


SCHEMA = """
DROP TABLE IF EXISTS countries;
DROP TABLE IF EXISTS provinces;
DROP TABLE IF EXISTS province_history;
DROP TABLE IF EXISTS province_owner_timeline;
DROP TABLE IF EXISTS rulers;
DROP TABLE IF EXISTS leaders;

CREATE TABLE countries (
    tag TEXT PRIMARY KEY,
    name TEXT,
    color_r INTEGER, color_g INTEGER, color_b INTEGER,
    government TEXT,
    religion TEXT,
    primary_culture TEXT,
    technology_group TEXT,
    capital_id INTEGER
);

CREATE TABLE provinces (
    id INTEGER PRIMARY KEY,
    name TEXT,
    def_r INTEGER, def_g INTEGER, def_b INTEGER,
    is_sea INTEGER NOT NULL DEFAULT 0,
    is_lake INTEGER NOT NULL DEFAULT 0,
    is_wasteland INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE province_history (
    province_id INTEGER NOT NULL,
    date TEXT NOT NULL,         -- 'YYYY-MM-DD' or '' for initial
    key TEXT NOT NULL,
    value TEXT,                 -- scalar as text, or JSON for block values
    is_block INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_province_history ON province_history(province_id, date);

CREATE TABLE province_owner_timeline (
    province_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    owner_tag TEXT NOT NULL
);
CREATE INDEX idx_owner_timeline ON province_owner_timeline(province_id, date);

CREATE TABLE rulers (
    tag TEXT NOT NULL,
    kind TEXT NOT NULL,
    name TEXT,
    dynasty TEXT,
    birth_date TEXT,
    death_date TEXT,
    start_date TEXT,
    adm INTEGER, dip INTEGER, mil INTEGER,
    personality TEXT
);
CREATE INDEX idx_rulers_tag_date ON rulers(tag, start_date);

CREATE TABLE leaders (
    tag TEXT NOT NULL,
    name TEXT,
    type TEXT,
    fire INTEGER, shock INTEGER, maneuver INTEGER, siege INTEGER,
    start_date TEXT,
    death_date TEXT,
    personality TEXT
);
CREATE INDEX idx_leaders_tag_date ON leaders(tag, start_date);
"""


# ---------------------------------------------------------------------------
# Block -> text serialization for province_history
# ---------------------------------------------------------------------------


def value_to_text(v: object) -> tuple[str | None, bool]:
    """Returns (text, is_block). Scalars -> str, blocks -> JSON."""
    if isinstance(v, Block):
        return json.dumps(_block_to_jsonable(v), ensure_ascii=False), True
    if isinstance(v, Date):
        return v.iso(), False
    if isinstance(v, bool):
        return "yes" if v else "no", False
    if v is None:
        return None, False
    return str(v), False


def _block_to_jsonable(b: Block) -> object:
    pairs = [(k, v) for k, v in b.entries if k is not None]
    bare = [v for k, v in b.entries if k is None]
    if bare and not pairs:
        return [_scalar_to_jsonable(v) for v in bare]
    result: dict[str, object] = {}
    for k, v in pairs:
        jv = _block_to_jsonable(v) if isinstance(v, Block) else _scalar_to_jsonable(v)
        if k in result:
            # dup key -> promote to list
            if not isinstance(result[k], list):
                result[k] = [result[k]]
            result[k].append(jv)
        else:
            result[k] = jv
    return result


def _scalar_to_jsonable(v: object) -> object:
    if isinstance(v, Date):
        return v.iso()
    return v


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def preprocess_map(
    bmp_path: Path,
    defs: dict[int, tuple[str, int, int, int]],
    out_path: Path,
) -> None:
    """provinces.bmp (RGB) -> provinces_id.png. R channel = id>>8, G = id&0xFF, B = 0.

    Shader decodes: id = R*256 + G. id=0 means unknown/background.
    """
    import numpy as np
    from PIL import Image

    print(f"[etl] preprocessing map {bmp_path} -> {out_path}", flush=True)
    im = np.asarray(Image.open(bmp_path).convert("RGB"))
    h, w, _ = im.shape

    # Pack RGB to a single uint32 key, then unique+inverse to build an id LUT.
    packed = (
        (im[:, :, 0].astype(np.uint32) << 16)
        | (im[:, :, 1].astype(np.uint32) << 8)
        | im[:, :, 2].astype(np.uint32)
    )
    uniques, inverse = np.unique(packed, return_inverse=True)

    rgb_to_id: dict[int, int] = {}
    for pid, (_, r, g, b) in defs.items():
        rgb_to_id[(r << 16) | (g << 8) | b] = pid

    id_for_unique = np.zeros(len(uniques), dtype=np.uint16)
    missing = 0
    for idx, key in enumerate(uniques.tolist()):
        pid = rgb_to_id.get(int(key))
        if pid is None:
            missing += 1
        else:
            id_for_unique[idx] = pid
    if missing:
        print(f"[etl]   WARN: {missing} RGB values in bitmap not in definition.csv (mapped to id=0)")

    ids = id_for_unique[inverse].reshape(h, w)
    hi = (ids >> 8).astype(np.uint8)
    lo = (ids & 0xFF).astype(np.uint8)
    rgb_out = np.stack([hi, lo, np.zeros_like(hi)], axis=-1)

    Image.fromarray(rgb_out, mode="RGB").save(out_path, format="PNG", optimize=True)
    print(
        f"[etl]   wrote {out_path.stat().st_size/1024:.0f} KiB "
        f"({w}x{h}, {len(uniques)} unique colors, {len(rgb_to_id)} defined ids)"
    )


def file_sha(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def _name_from_history_filename(filename: str, tag: str) -> str:
    """'TUR - Ottoman Empire.txt' -> 'Ottoman Empire'."""
    stem = filename[:-4] if filename.lower().endswith(".txt") else filename
    m = re.match(rf"{re.escape(tag)}\s*[-–]\s*(.+)", stem)
    return m.group(1).strip() if m else stem.strip()


LOC_LINE = re.compile(r'^\s*([A-Za-z0-9_.\-]+)\s*:\s*\d+\s*"(.*)"\s*$')
LOC_STRIP = re.compile(r"§[A-Za-z!]|£[^£\n]*£|\\n|\$[^$\n]+\$")


def load_localisation(raw: Path) -> dict[str, str]:
    """Load all *_l_english.yml files and return key->text mapping."""
    loc_dir = raw / "localisation"
    out: dict[str, str] = {}
    for path in sorted(loc_dir.glob("*_l_english.yml")):
        try:
            for line in path.read_text(encoding="utf-8-sig", errors="replace").splitlines():
                m = LOC_LINE.match(line)
                if not m:
                    continue
                key, txt = m.group(1), m.group(2)
                txt = LOC_STRIP.sub("", txt).strip()
                if txt:
                    out[key] = txt
        except Exception:
            pass
    return out


def run() -> int:
    t0 = time.time()
    if not RAW.exists():
        print(f"ERROR: raw data not mounted at {RAW}", file=sys.stderr)
        return 1
    OUT.mkdir(parents=True, exist_ok=True)

    # --- 0. localisation (country + province display names)
    print("[etl] loading localisation ...", flush=True)
    loc = load_localisation(RAW)
    print(f"[etl]   {len(loc)} localisation keys")

    # --- 1. provinces (from definition.csv) + sea/lake/wasteland flags
    print("[etl] loading definition.csv ...", flush=True)
    defs = load_definition_csv(RAW / "map" / "definition.csv")
    print(f"[etl]   {len(defs)} provinces in definition")

    print("[etl] loading default.map ...", flush=True)
    dmap = load_default_map(RAW / "map" / "default.map")
    sea_set = set(dmap["sea_ids"])
    lake_set = set(dmap["lake_ids"])
    wasteland = load_wasteland_ids(RAW / "map" / "climate.txt")
    wasteland_set = set(wasteland)
    print(f"[etl]   sea={len(sea_set)} lake={len(lake_set)} wasteland={len(wasteland_set)}")

    # --- 2. country tags -> common file path, then map color
    print("[etl] loading country_tags ...", flush=True)
    tags = load_country_tags(RAW / "common" / "country_tags")
    print(f"[etl]   {len(tags)} tags")

    # Index history/countries by tag
    hist_countries_dir = RAW / "history" / "countries"
    hist_country_files: dict[str, Path] = {}
    for p in hist_countries_dir.glob("*.txt"):
        m = re.match(r"^([A-Z0-9_]{3})\s*[-–]\s*", p.name)
        if m:
            hist_country_files[m.group(1)] = p

    # Index history/provinces by id
    hist_provinces_dir = RAW / "history" / "provinces"
    hist_province_files: dict[int, Path] = {}
    for p in hist_provinces_dir.glob("*.txt"):
        m = re.match(r"^(\d+)\s*[-–]\s*", p.name)
        if m:
            hist_province_files[int(m.group(1))] = p

    # --- 3. walk countries
    countries_rows: list[tuple] = []
    countries_json: dict[str, dict] = {}
    rulers_rows: list[dict] = []
    leaders_rows: list[dict] = []

    print(f"[etl] parsing {len(tags)} country history + common files ...", flush=True)
    capital_timeline_json: dict[str, list[list]] = {}
    for tag, rel in sorted(tags.items()):
        common_file = RAW / "common" / rel
        color = load_country_color(common_file)
        if color is None:
            color = (128, 128, 128)

        hist_file = hist_country_files.get(tag)
        # Prefer in-game localisation name; fall back to history filename, then tag.
        name = loc.get(tag) or (
            _name_from_history_filename(hist_file.name, tag) if hist_file is not None else tag
        )
        initial = Block()
        dated: list[tuple[Date, Block]] = []
        if hist_file is not None:
            try:
                root = parse_file(hist_file, encoding=ENCODING)
            except Exception as e:
                print(f"[etl]   WARN: {hist_file.name}: {e}", file=sys.stderr)
                root = Block()
            initial, dated = split_history(root)

        government = _as_str(initial.get("government"))
        religion = _as_str(initial.get("religion"))
        primary_culture = _as_str(initial.get("primary_culture"))
        tech_group = _as_str(initial.get("technology_group"))
        capital_id = _as_int(initial.get("capital"))

        countries_rows.append(
            (tag, name, color[0], color[1], color[2], government, religion, primary_culture, tech_group, capital_id)
        )
        countries_json[tag] = {
            "name": name,
            "color": list(color),
            "government": government,
            "religion": religion,
            "primary_culture": primary_culture,
            "technology_group": tech_group,
            "capital": capital_id,
        }
        rulers_rows.extend(extract_rulers(tag, dated))
        leaders_rows.extend(extract_leaders(tag, dated))

        # Collect in-game dated capital changes. The static initial capital in
        # countries.json already serves as the pre-change fallback, so we only
        # record explicit dated moves here (no artificial game-start entry).
        cap_changes: list[list] = []
        game_start_iso = f"{GAME_START.y:04d}-{GAME_START.m:02d}-{GAME_START.d:02d}"
        game_end_iso   = f"{GAME_END.y:04d}-{GAME_END.m:02d}-{GAME_END.d:02d}"
        for date, block in dated:
            cap = block.get("capital")
            if cap is None or isinstance(cap, Block):
                continue
            try:
                cid = int(str(cap).strip())
            except (ValueError, TypeError):
                continue
            iso = f"{date.y:04d}-{date.m:02d}-{date.d:02d}"
            if iso < game_start_iso or iso > game_end_iso:
                continue
            cap_changes.append([iso, cid])
        if cap_changes:
            capital_timeline_json[tag] = cap_changes

    # --- 4. walk provinces
    print(f"[etl] parsing {len(hist_province_files)} province history files ...", flush=True)
    province_rows: list[tuple] = []
    history_rows: list[tuple] = []
    timeline_rows: list[tuple] = []
    timeline_json: dict[int, list[list[str]]] = {}

    for pid, (pname, r, g, b) in sorted(defs.items()):
        # Prefer in-game localisation name (PROV{id}); fall back to definition.csv name.
        display_name = loc.get(f"PROV{pid}") or pname
        province_rows.append(
            (pid, display_name, r, g, b, int(pid in sea_set), int(pid in lake_set), int(pid in wasteland_set))
        )

        hp = hist_province_files.get(pid)
        if hp is None:
            continue
        try:
            root = parse_file(hp, encoding=ENCODING)
        except Exception as e:
            print(f"[etl]   WARN: {hp.name}: {e}", file=sys.stderr)
            continue
        initial, dated = split_history(root)

        # dump full history rows (for /api/provinces/{id}/history)
        for k, v in initial.entries:
            if k is None:
                continue
            text, is_block = value_to_text(v)
            history_rows.append((pid, "", k, text, int(is_block)))
        for date, events in dated:
            for k, v in events.entries:
                if k is None:
                    continue
                text, is_block = value_to_text(v)
                history_rows.append((pid, date.iso(), k, text, int(is_block)))

        # owner timeline
        tl = owner_timeline(initial, dated)
        if tl:
            timeline_json[pid] = [[d.iso(), tag] for d, tag in tl]
            for d, tag in tl:
                timeline_rows.append((pid, d.iso(), tag))

    # --- 5. write SQLite
    db_path = OUT / "eu4.db"
    if db_path.exists():
        db_path.unlink()
    print(f"[etl] writing {db_path} ...", flush=True)
    con = sqlite3.connect(db_path)
    try:
        con.executescript(SCHEMA)
        con.executemany(
            "INSERT INTO countries VALUES (?,?,?,?,?,?,?,?,?,?)", countries_rows
        )
        con.executemany(
            "INSERT INTO provinces VALUES (?,?,?,?,?,?,?,?)", province_rows
        )
        con.executemany(
            "INSERT INTO province_history VALUES (?,?,?,?,?)", history_rows
        )
        con.executemany(
            "INSERT INTO province_owner_timeline VALUES (?,?,?)", timeline_rows
        )
        con.executemany(
            "INSERT INTO rulers (tag,kind,name,dynasty,birth_date,death_date,start_date,adm,dip,mil,personality) "
            "VALUES (:tag,:kind,:name,:dynasty,:birth_date,:death_date,:start_date,:adm,:dip,:mil,:personality)",
            rulers_rows,
        )
        con.executemany(
            "INSERT INTO leaders (tag,name,type,fire,shock,maneuver,siege,start_date,death_date,personality) "
            "VALUES (:tag,:name,:type,:fire,:shock,:maneuver,:siege,:start_date,:death_date,:personality)",
            leaders_rows,
        )
        con.commit()
    finally:
        con.close()

    # --- 5b. provinces.bmp -> provinces_id.png (RG8 ID encoding)
    preprocess_map(RAW / "map" / "provinces.bmp", defs, OUT / "provinces_id.png")

    # --- 6. write JSON outputs
    print("[etl] writing JSON outputs ...", flush=True)
    (OUT / "countries.json").write_text(json.dumps(countries_json, ensure_ascii=False), encoding="utf-8")
    (OUT / "country_capital_timeline.json").write_text(
        json.dumps(capital_timeline_json, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    (OUT / "province_owner_timeline.json").write_text(
        json.dumps(timeline_json, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    meta = {
        "start": GAME_START.iso(),
        "end": GAME_END.iso(),
        "width": dmap["width"],
        "height": dmap["height"],
        "max_provinces": dmap["max_provinces"],
        "sea_ids": dmap["sea_ids"],
        "lake_ids": dmap["lake_ids"],
        "wasteland_ids": sorted(wasteland_set),
    }
    (OUT / "meta.json").write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")

    # --- 7. summary
    dt = time.time() - t0
    print(
        f"[etl] done in {dt:.1f}s — countries={len(countries_rows)} "
        f"provinces={len(province_rows)} rulers={len(rulers_rows)} "
        f"leaders={len(leaders_rows)} history_rows={len(history_rows)} "
        f"timeline_rows={len(timeline_rows)}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(run())
