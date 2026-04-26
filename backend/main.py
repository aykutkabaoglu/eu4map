"""FastAPI backend for EU4 web map.

SQLite: data/eu4.db (read-only, produced by etl/build.py)

Run inside the dev container:
    docker compose exec dev bash -lc \
      "cd /workspace/backend && uvicorn main:app --reload --host 0.0.0.0 --port 8000"
"""

from __future__ import annotations

import json
import os
import sqlite3
import sys
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

# Reuse the ETL's PDX parser for structured event rendering.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "etl"))
from pdx_parser import Block, parse_text  # noqa: E402


DATA_DIR = Path(os.environ.get("DATA_DIR", "/workspace/data"))
EU4_DB = DATA_DIR / "eu4.db"


# ---------------------------------------------------------------------------
# DB helpers
# ---------------------------------------------------------------------------


def _connect(path: Path, read_only: bool = False) -> sqlite3.Connection:
    if read_only:
        uri = f"file:{path}?mode=ro"
        con = sqlite3.connect(uri, uri=True, check_same_thread=False)
    else:
        con = sqlite3.connect(path, check_same_thread=False)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys = ON")
    return con


@asynccontextmanager
async def lifespan(app: FastAPI):
    yield


app = FastAPI(title="eu4-web-map", version="0.1.0", lifespan=lifespan)

# Vite dev server runs on 5173; allow it to call the backend directly.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Serve the ETL artifacts (provinces_id.png, countries.json, meta.json, timeline)
# so the frontend can fetch /data/* through a single origin.
if DATA_DIR.exists():
    app.mount("/data", StaticFiles(directory=str(DATA_DIR)), name="data")


# ---------------------------------------------------------------------------
# Health
# ---------------------------------------------------------------------------


@app.get("/api/health")
def health() -> dict[str, Any]:
    return {
        "status": "ok",
        "eu4_db_exists": EU4_DB.exists(),
    }


# ---------------------------------------------------------------------------
# Read-only endpoints (eu4.db)
# ---------------------------------------------------------------------------


def _eu4() -> sqlite3.Connection:
    if not EU4_DB.exists():
        raise HTTPException(503, f"eu4.db not found at {EU4_DB} — run ETL first")
    return _connect(EU4_DB, read_only=True)


@app.get("/api/countries")
def list_countries() -> list[dict]:
    with _eu4() as con:
        rows = con.execute(
            "SELECT tag, name, color_r, color_g, color_b FROM countries ORDER BY tag"
        ).fetchall()
    return [
        {"tag": r["tag"], "name": r["name"], "color": [r["color_r"], r["color_g"], r["color_b"]]}
        for r in rows
    ]


@app.get("/api/countries/{tag}")
def get_country(tag: str) -> dict:
    tag = tag.upper()
    with _eu4() as con:
        row = con.execute("SELECT * FROM countries WHERE tag = ?", (tag,)).fetchone()
        if row is None:
            raise HTTPException(404, f"country {tag!r} not found")
        n_rulers = con.execute(
            "SELECT COUNT(*) FROM rulers WHERE tag = ?", (tag,)
        ).fetchone()[0]
        n_leaders = con.execute(
            "SELECT COUNT(*) FROM leaders WHERE tag = ?", (tag,)
        ).fetchone()[0]
        capital_name = None
        if row["capital_id"]:
            cap = con.execute(
                "SELECT name FROM provinces WHERE id = ?", (row["capital_id"],)
            ).fetchone()
            capital_name = cap["name"] if cap else None
    return {
        "tag": row["tag"],
        "name": row["name"],
        "color": [row["color_r"], row["color_g"], row["color_b"]],
        "government": row["government"],
        "religion": row["religion"],
        "primary_culture": row["primary_culture"],
        "technology_group": row["technology_group"],
        "capital_id": row["capital_id"],
        "capital_name": capital_name,
        "ruler_count": n_rulers,
        "leader_count": n_leaders,
    }


@app.get("/api/countries/{tag}/rulers")
def get_rulers(
    tag: str,
    at: str | None = Query(None, description="YYYY-MM-DD — return the monarch active at this date"),
    kind: str | None = Query(None, description="filter by kind: monarch|heir|queen"),
) -> list[dict] | dict:
    tag = tag.upper()
    with _eu4() as con:
        if at:
            # most recent monarch on or before `at`
            k = kind or "monarch"
            row = con.execute(
                "SELECT * FROM rulers WHERE tag = ? AND kind = ? AND start_date <= ? "
                "ORDER BY start_date DESC LIMIT 1",
                (tag, k, at),
            ).fetchone()
            if row is None:
                raise HTTPException(404, f"no {k} for {tag} on or before {at}")
            return dict(row)
        q = "SELECT * FROM rulers WHERE tag = ?"
        args: list = [tag]
        if kind:
            q += " AND kind = ?"
            args.append(kind)
        q += " ORDER BY start_date, kind"
        rows = con.execute(q, args).fetchall()
    return [dict(r) for r in rows]


@app.get("/api/countries/{tag}/leaders")
def get_leaders(tag: str) -> list[dict]:
    tag = tag.upper()
    with _eu4() as con:
        rows = con.execute(
            "SELECT * FROM leaders WHERE tag = ? ORDER BY start_date", (tag,)
        ).fetchall()
    return [dict(r) for r in rows]


@app.get("/api/provinces/{pid}")
def get_province(pid: int) -> dict:
    with _eu4() as con:
        row = con.execute("SELECT * FROM provinces WHERE id = ?", (pid,)).fetchone()
        if row is None:
            raise HTTPException(404, f"province {pid} not found")
        initial_owner = con.execute(
            "SELECT owner_tag FROM province_owner_timeline WHERE province_id = ? "
            "ORDER BY date LIMIT 1",
            (pid,),
        ).fetchone()
    return {
        "id": row["id"],
        "name": row["name"],
        "def_rgb": [row["def_r"], row["def_g"], row["def_b"]],
        "is_sea": bool(row["is_sea"]),
        "is_lake": bool(row["is_lake"]),
        "is_wasteland": bool(row["is_wasteland"]),
        "initial_owner": initial_owner["owner_tag"] if initial_owner else None,
    }


@app.get("/api/provinces/{pid}/history")
def get_province_history(pid: int) -> list[dict]:
    with _eu4() as con:
        if not con.execute("SELECT 1 FROM provinces WHERE id = ?", (pid,)).fetchone():
            raise HTTPException(404, f"province {pid} not found")
        rows = con.execute(
            "SELECT date, key, value, is_block FROM province_history "
            "WHERE province_id = ? ORDER BY date, ROWID",
            (pid,),
        ).fetchall()
    out: list[dict] = []
    for r in rows:
        val = r["value"]
        if r["is_block"] and val is not None:
            try:
                val = json.loads(val)
            except json.JSONDecodeError:
                pass
        out.append({"date": r["date"] or None, "key": r["key"], "value": val})
    return out


@app.get("/api/countries/{tag}/historical-events")
def get_country_historical_events(tag: str) -> list[dict]:
    """Aggregate dated events for a country from rulers, leaders, owner timeline."""
    tag = tag.upper()
    out: list[dict] = []
    with _eu4() as con:
        rulers = con.execute(
            "SELECT kind, name, dynasty, start_date, adm, dip, mil FROM rulers "
            "WHERE tag = ? AND start_date IS NOT NULL",
            (tag,),
        ).fetchall()
        for r in rulers:
            kind_tr = {"monarch": "Monarch", "heir": "Heir", "queen": "Queen"}.get(
                r["kind"], r["kind"]
            )
            stats = f" ({r['adm']}/{r['dip']}/{r['mil']})" if r["adm"] is not None else ""
            dyn = f" — {r['dynasty']}" if r["dynasty"] else ""
            out.append({
                "date": r["start_date"],
                "kind": "ruler",
                "title": f"{kind_tr}: {r['name']}{dyn}{stats}",
            })

        leaders = con.execute(
            "SELECT name, type, start_date, fire, shock, maneuver, siege FROM leaders "
            "WHERE tag = ? AND start_date IS NOT NULL",
            (tag,),
        ).fetchall()
        for l in leaders:
            stats = f" (F{l['fire']}/S{l['shock']}/M{l['maneuver']}/Sg{l['siege']})"
            out.append({
                "date": l["start_date"],
                "kind": "leader",
                "title": f"{l['type'] or 'Komutan'}: {l['name']}{stats}",
            })

        gains = con.execute(
            "SELECT t.date, t.province_id, p.name FROM province_owner_timeline t "
            "LEFT JOIN provinces p ON p.id = t.province_id "
            "WHERE t.owner_tag = ?",
            (tag,),
        ).fetchall()
        for g in gains:
            pname = g["name"] or f"#{g['province_id']}"
            out.append({
                "date": g["date"],
                "kind": "territory",
                "title": f"Conquered: {pname}",
                "province_id": g["province_id"],
            })

    out.sort(key=lambda e: e["date"] or "")
    return out


@app.get("/api/provinces/{pid}/historical-events")
def get_province_historical_events(pid: int) -> list[dict]:
    out: list[dict] = []
    with _eu4() as con:
        if not con.execute("SELECT 1 FROM provinces WHERE id = ?", (pid,)).fetchone():
            raise HTTPException(404, f"province {pid} not found")
        owners = con.execute(
            "SELECT date, owner_tag FROM province_owner_timeline "
            "WHERE province_id = ? ORDER BY date",
            (pid,),
        ).fetchall()
        for o in owners:
            out.append({
                "date": o["date"],
                "kind": "owner",
                "title": f"Yeni sahip: {o['owner_tag']}",
            })
        rows = con.execute(
            "SELECT date, key, value FROM province_history "
            "WHERE province_id = ? AND date != '' AND is_block = 0 "
            "AND key IN ('religion','culture','base_tax','base_production','base_manpower','add_core','remove_core','hre','trade_goods') "
            "ORDER BY date",
            (pid,),
        ).fetchall()
        for r in rows:
            out.append({
                "date": r["date"],
                "kind": r["key"],
                "title": f"{r['key']} → {r['value']}",
            })
    out.sort(key=lambda e: e["date"] or "")
    return out


@app.get("/api/provinces/{pid}/owner_timeline")
def get_province_owner_timeline(pid: int) -> list[dict]:
    with _eu4() as con:
        rows = con.execute(
            "SELECT date, owner_tag FROM province_owner_timeline "
            "WHERE province_id = ? ORDER BY date",
            (pid,),
        ).fetchall()
    return [{"date": r["date"], "owner": r["owner_tag"]} for r in rows]


@app.get("/api/eu4/events")
def list_eu4_events(
    q: str | None = None,
    scope: str | None = None,
    namespace: str | None = None,
    limit: int = Query(100, le=1000),
    offset: int = 0,
) -> dict:
    where = ["1=1"]
    args: list = []
    if scope:
        where.append("scope = ?")
        args.append(scope)
    if namespace:
        where.append("namespace = ?")
        args.append(namespace)
    if q:
        where.append(
            "(id LIKE ? OR title LIKE ? OR namespace LIKE ? "
            "OR title_text LIKE ? OR desc_text LIKE ?)"
        )
        pat = f"%{q}%"
        args.extend([pat, pat, pat, pat, pat])
    with _eu4() as con:
        if not con.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='eu4_events'"
        ).fetchone():
            raise HTTPException(503, "eu4_events table not built — run etl/build_events.py")
        total = con.execute(
            f"SELECT COUNT(*) FROM eu4_events WHERE {' AND '.join(where)}", args
        ).fetchone()[0]
        rows = con.execute(
            f"SELECT * FROM eu4_events WHERE {' AND '.join(where)} "
            f"ORDER BY namespace, id LIMIT ? OFFSET ?",
            [*args, limit, offset],
        ).fetchall()
    return {"total": total, "items": [dict(r) for r in rows]}


@app.get("/api/eu4/events/namespaces")
def list_eu4_event_namespaces() -> list[dict]:
    with _eu4() as con:
        if not con.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='eu4_events'"
        ).fetchone():
            return []
        rows = con.execute(
            "SELECT namespace, COUNT(*) AS n FROM eu4_events GROUP BY namespace ORDER BY namespace"
        ).fetchall()
    return [{"namespace": r["namespace"], "count": r["n"]} for r in rows]


def _block_to_json(v: Any) -> Any:
    """Convert pdx_parser Block/Date/scalar into plain JSON-safe structures."""
    if isinstance(v, Block):
        pairs_by_key: dict[str, list] = {}
        for k, vv in v.entries:
            if k is None:
                pairs_by_key.setdefault("__bare__", []).append(_block_to_json(vv))
            else:
                pairs_by_key.setdefault(k, []).append(_block_to_json(vv))
        # Collapse single-entry keys for readability.
        out: dict[str, Any] = {}
        for k, vals in pairs_by_key.items():
            out[k] = vals[0] if len(vals) == 1 else vals
        return out
    # Date object
    if hasattr(v, "y") and hasattr(v, "m") and hasattr(v, "d"):
        return f"{v.y:04d}-{v.m:02d}-{v.d:02d}"
    return v


def _resolve_loc(con: sqlite3.Connection, key: str | None) -> str | None:
    """Look up one localisation key. We don't have a dedicated table, so we
    lean on the convention that option names share the same lookup we already
    applied to title/desc — but those are stored only for events. For
    everything else we return the key unchanged."""
    if not key:
        return None
    # Try to find another event with this same key as title/desc.
    row = con.execute(
        "SELECT title_text FROM eu4_events WHERE title = ? AND title_text IS NOT NULL LIMIT 1",
        (key,),
    ).fetchone()
    if row and row["title_text"]:
        return row["title_text"]
    return None


@app.get("/api/eu4/events/{eid}")
def get_eu4_event(eid: str) -> dict:
    with _eu4() as con:
        if not con.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='eu4_events'"
        ).fetchone():
            raise HTTPException(503, "eu4_events not built")
        row = con.execute("SELECT * FROM eu4_events WHERE id = ?", (eid,)).fetchone()
        if row is None:
            raise HTTPException(404, f"event {eid!r} not found")
        result = dict(row)

        # Parse body into a structured summary.
        body = result.get("body") or ""
        summary: dict[str, Any] = {}
        try:
            parsed: Block = parse_text("event = {\n" + body + "\n}").get("event")
            if isinstance(parsed, Block):
                # Top-level scalars we care about (title/desc/picture already in cols).
                mtth = parsed.get("mean_time_to_happen")
                if isinstance(mtth, Block):
                    mt = {}
                    for k in ("months", "years", "days"):
                        v = mtth.get(k)
                        if v is not None:
                            mt[k] = v
                    summary["mean_time_to_happen"] = mt or _block_to_json(mtth)

                trg = parsed.get("trigger")
                if isinstance(trg, Block):
                    summary["trigger"] = _block_to_json(trg)

                imm = parsed.get("immediate")
                if isinstance(imm, Block):
                    summary["immediate"] = _block_to_json(imm)

                options = []
                for v in parsed.get_all("option"):
                    if not isinstance(v, Block):
                        continue
                    name_key = v.get("name")
                    name_text = _resolve_loc(con, name_key if isinstance(name_key, str) else None)
                    effects: dict[str, Any] = {}
                    for k, vv in v.entries:
                        if k in (None, "name", "tooltip", "ai_chance", "trigger", "highlight"):
                            continue
                        effects.setdefault(k, []).append(_block_to_json(vv))
                    effects_flat = {
                        k: (vs[0] if len(vs) == 1 else vs) for k, vs in effects.items()
                    }
                    options.append({
                        "name_key": name_key,
                        "name_text": name_text,
                        "effects": effects_flat,
                    })
                if options:
                    summary["options"] = options
        except Exception as e:
            summary["_parse_error"] = str(e)

        result["parsed"] = summary
    return result


