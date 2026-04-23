"""Catalog EU4 game events from /eu4_raw/events/*.txt into eu4.db.

Game events are conditional (trigger + mean_time_to_happen), not dated, so we
only extract enough metadata to let the UI browse them: id, scope
(country/province), title key, desc key, picture, and the namespace/file they
came from.

Run (inside dev container):
    python etl/build_events.py
"""

from __future__ import annotations

import re
import sqlite3
import sys
from pathlib import Path


RAW_EVENTS = Path("/eu4_raw/events")
DB = Path("/workspace/data/eu4.db")
ENCODING = "cp1252"

EVENT_BLOCK = re.compile(r"\b(country_event|province_event|news_event)\s*=\s*\{")
SCALAR = re.compile(r'^\s*(id|title|desc|picture)\s*=\s*("?)([^"\n{]+?)\2\s*$', re.M)
NAMESPACE = re.compile(r"^\s*namespace\s*=\s*(\S+)", re.M)


def _strip_comments(s: str) -> str:
    # EU4 uses '#' comments until end-of-line; keep inside quoted strings.
    out: list[str] = []
    in_str = False
    for line in s.splitlines(keepends=True):
        buf: list[str] = []
        in_str = False
        for ch in line:
            if ch == '"':
                in_str = not in_str
                buf.append(ch)
            elif ch == "#" and not in_str:
                break
            else:
                buf.append(ch)
        out.append("".join(buf))
    return "".join(out)


def _find_block_end(s: str, open_idx: int) -> int:
    """Given index of the '{' that opens a block, return index just past matching '}'."""
    depth = 0
    in_str = False
    i = open_idx
    while i < len(s):
        ch = s[i]
        if ch == '"':
            in_str = not in_str
        elif not in_str:
            if ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    return i + 1
        i += 1
    return len(s)


def parse_events_file(path: Path) -> list[dict]:
    raw = path.read_text(encoding=ENCODING, errors="replace")
    raw = _strip_comments(raw)
    ns_match = NAMESPACE.search(raw)
    namespace = ns_match.group(1).strip() if ns_match else path.stem

    out: list[dict] = []
    for m in EVENT_BLOCK.finditer(raw):
        scope_kw = m.group(1)  # country_event | province_event | news_event
        brace = raw.find("{", m.end() - 1)
        end = _find_block_end(raw, brace)
        block = raw[brace + 1 : end - 1]

        # Top-level scalars only (nested `option = { name = ... }` ignored).
        # Use a depth counter when walking lines.
        depth = 0
        top_lines: list[str] = []
        in_str = False
        buf: list[str] = []
        for ch in block:
            if ch == '"':
                in_str = not in_str
                buf.append(ch)
                continue
            if not in_str:
                if ch == "{":
                    depth += 1
                elif ch == "}":
                    depth -= 1
                    continue
            if depth == 0:
                buf.append(ch)
        top = "".join(buf)

        fields: dict[str, str] = {}
        for sm in SCALAR.finditer(top):
            fields[sm.group(1)] = sm.group(3).strip()

        if "id" not in fields:
            continue
        scope = {
            "country_event": "country",
            "province_event": "province",
            "news_event": "news",
        }[scope_kw]
        out.append({
            "id": fields["id"],
            "scope": scope,
            "title": fields.get("title"),
            "desc": fields.get("desc"),
            "picture": fields.get("picture"),
            "namespace": namespace,
            "file": path.name,
            "body": block.strip(),
        })
    return out


SCHEMA = """
CREATE TABLE IF NOT EXISTS eu4_events (
    id         TEXT PRIMARY KEY,
    scope      TEXT NOT NULL,    -- country | province | news
    title      TEXT,              -- localisation key
    desc       TEXT,
    picture    TEXT,
    namespace  TEXT,
    file       TEXT,
    body       TEXT
);
CREATE INDEX IF NOT EXISTS idx_eu4_events_scope ON eu4_events(scope);
CREATE INDEX IF NOT EXISTS idx_eu4_events_ns ON eu4_events(namespace);
"""


def main() -> None:
    if not RAW_EVENTS.exists():
        print(f"no events dir: {RAW_EVENTS}", file=sys.stderr)
        sys.exit(1)
    if not DB.exists():
        print(f"run etl/build.py first — missing {DB}", file=sys.stderr)
        sys.exit(1)

    all_events: list[dict] = []
    files = sorted(RAW_EVENTS.glob("*.txt"))
    for p in files:
        try:
            all_events.extend(parse_events_file(p))
        except Exception as e:
            print(f"skip {p.name}: {e}", file=sys.stderr)

    con = sqlite3.connect(DB)
    try:
        con.executescript(SCHEMA)
        con.execute("DELETE FROM eu4_events")
        con.executemany(
            "INSERT OR REPLACE INTO eu4_events "
            "(id, scope, title, desc, picture, namespace, file, body) "
            "VALUES (:id,:scope,:title,:desc,:picture,:namespace,:file,:body)",
            all_events,
        )
        con.commit()
        n = con.execute("SELECT COUNT(*) FROM eu4_events").fetchone()[0]
        by_scope = con.execute(
            "SELECT scope, COUNT(*) FROM eu4_events GROUP BY scope"
        ).fetchall()
    finally:
        con.close()

    print(f"indexed {n} events from {len(files)} files")
    for scope, c in by_scope:
        print(f"  {scope}: {c}")


if __name__ == "__main__":
    main()
