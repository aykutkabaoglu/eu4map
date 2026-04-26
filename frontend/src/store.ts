import { create } from "zustand";
import type { CountryMap, Meta, OwnerTimeline, RGB } from "./types";

// ---------- date helpers ----------

/** Convert "YYYY-MM-DD" to a monotonic integer yyyy*512 + mm*32 + dd so that
 *  lexicographic / numeric compare both work. Used for timeline binary search. */
export function dateKey(iso: string): number {
  const y = +iso.slice(0, 4);
  const m = +iso.slice(5, 7);
  const d = +iso.slice(8, 10);
  return y * 512 + m * 32 + d;
}

function binarySearchOwner(
  timeline: Array<[string, string]>,
  targetKey: number,
): string | null {
  // return owner whose date is latest <= targetKey; null if all timeline dates > target
  let lo = 0;
  let hi = timeline.length - 1;
  if (hi < 0) return null;
  if (dateKey(timeline[0][0]) > targetKey) return null;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (dateKey(timeline[mid][0]) <= targetKey) lo = mid;
    else hi = mid - 1;
  }
  return timeline[lo][1];
}

// ---------- selection ----------

export interface SelectedProvince {
  id: number;
  name?: string;
  owner?: string | null;
}

// ---------- store ----------

// id -> [cx, cy, area, bx0, by0, bx1, by1]  (tex coords 0..1, area in px)
export type Centroids = Record<string, [number, number, number, number, number, number, number]>;

// tag -> [[date, province_id], ...] sorted ascending — only tags that have changes
export type CapitalTimeline = Record<string, Array<[string, number]>>;

// province_id -> [adjacent_province_id, ...]
export type Adjacency = Record<string, number[]>;

interface AppState {
  // raw data
  meta: Meta | null;
  countries: CountryMap;
  timeline: OwnerTimeline;
  centroids: Centroids;
  capitalTimeline: CapitalTimeline;
  adjacency: Adjacency;
  provinceNames: Record<string, string>;
  loaded: boolean;
  error: string | null;

  // date state
  currentDate: string; // YYYY-MM-DD
  setDate: (d: string) => void;

  // selection
  selected: SelectedProvince | null;
  setSelected: (s: SelectedProvince | null) => void;

  // bulk loader
  loadAll: () => Promise<void>;

  // compute owner Uint8Array (RGBA per province id, length = (max+1)*4)
  buildOwnerColorArray: (date: string) => Uint8Array;
  ownerAt: (provinceId: number, date: string) => string | null;
}

const UNCOLONIZED: RGB = [216, 197, 152];
const SEA: RGB = [134, 169, 201];
const WASTELAND: RGB = [90, 77, 58];

export const useApp = create<AppState>((set, get) => ({
  meta: null,
  countries: {},
  timeline: {},
  centroids: {},
  capitalTimeline: {},
  adjacency: {},
  provinceNames: {},
  loaded: false,
  error: null,

  currentDate: "1444-11-11",
  setDate: (d) => set({ currentDate: d }),

  selected: null,
  setSelected: (s) => set({ selected: s }),

  async loadAll() {
    try {
      const [metaRes, countriesRes, timelineRes, centroidsRes, capitalTimelineRes, adjacencyRes, namesRes] = await Promise.all([
        fetch("/data/meta.json"),
        fetch("/data/countries.json"),
        fetch("/data/province_owner_timeline.json"),
        fetch("/data/province_centroids.json"),
        fetch("/data/country_capital_timeline.json"),
        fetch("/data/province_adjacency.json"),
        fetch("/data/province_names.json"),
      ]);
      if (!metaRes.ok || !countriesRes.ok || !timelineRes.ok) {
        throw new Error("failed to load /data/* (ETL not run?)");
      }
      const meta: Meta = await metaRes.json();
      const countries: CountryMap = await countriesRes.json();
      const timeline: OwnerTimeline = await timelineRes.json();
      const centroids: Centroids = centroidsRes.ok ? await centroidsRes.json() : {};
      const capitalTimeline: CapitalTimeline = capitalTimelineRes.ok ? await capitalTimelineRes.json() : {};
      const adjacency: Adjacency = adjacencyRes.ok ? await adjacencyRes.json() : {};
      const provinceNames: Record<string, string> = namesRes.ok ? await namesRes.json() : {};
      set({ meta, countries, timeline, centroids, capitalTimeline, adjacency, provinceNames, loaded: true, currentDate: meta.start });
    } catch (e) {
      set({ error: (e as Error).message });
    }
  },

  buildOwnerColorArray(date) {
    const { meta, countries, timeline } = get();
    if (!meta) return new Uint8Array(0);
    const max = meta.max_provinces;
    const out = new Uint8Array((max + 1) * 4);
    const tKey = dateKey(date);
    const seaSet = new Set(meta.sea_ids);
    const lakeSet = new Set(meta.lake_ids);
    const wasteSet = new Set(meta.wasteland_ids);

    for (let id = 1; id <= max; id++) {
      let r: number, g: number, b: number;
      if (seaSet.has(id) || lakeSet.has(id)) {
        [r, g, b] = SEA;
      } else if (wasteSet.has(id)) {
        [r, g, b] = WASTELAND;
      } else {
        const tl = timeline[String(id)];
        const owner = tl ? binarySearchOwner(tl, tKey) : null;
        const c = owner ? countries[owner]?.color : undefined;
        if (c) {
          [r, g, b] = c;
        } else {
          [r, g, b] = UNCOLONIZED;
        }
      }
      const i = id * 4;
      out[i] = r;
      out[i + 1] = g;
      out[i + 2] = b;
      out[i + 3] = 255;
    }
    // id=0 → transparent/background
    return out;
  },

  ownerAt(provinceId, date) {
    const { timeline } = get();
    const tl = timeline[String(provinceId)];
    return tl ? binarySearchOwner(tl, dateKey(date)) : null;
  },
}));

export interface CountryLabel {
  tag: string;
  name: string;
  u: number;    // label position in texture coords (main landmass centroid)
  v: number;
  area: number; // total owned province area (texture pixels) — drives font size + visibility
  angle: number; // principal axis rotation in radians
}

/** Minimal state slice needed by computeCountryLabels — avoids the `as never` hack. */
export interface LabelState {
  meta: Meta | null;
  countries: CountryMap;
  timeline: OwnerTimeline;
  centroids: Centroids;
  capitalTimeline: CapitalTimeline;
  adjacency: Adjacency;
}

/** Return the capital province id active at the given date for the given tag. */
export function capitalAt(capitalTimeline: CapitalTimeline, countries: CountryMap, tag: string, tKey: number): number | null {
  const changes = capitalTimeline[tag];
  if (changes && changes.length > 0) {
    // Walk forward; take the last entry whose date <= tKey.
    let result: number | null = null;
    for (const [iso, capId] of changes) {
      if (dateKey(iso) <= tKey) result = capId;
      else break;
    }
    if (result !== null) return result;
  }
  // Fallback to static capital from countries.json
  return countries[tag]?.capital ?? null;
}

/** BFS connected component. Returns the province ids in this component. */
function bfsComponent(start: string, owned: Set<string>, adjacency: Adjacency): Set<string> {
  const comp = new Set<string>();
  const queue: string[] = [start];
  comp.add(start);
  while (queue.length > 0) {
    const cur = queue.pop()!;
    for (const nb of (adjacency[cur] ?? [])) {
      const nbStr = String(nb);
      if (owned.has(nbStr) && !comp.has(nbStr)) {
        comp.add(nbStr);
        queue.push(nbStr);
      }
    }
  }
  return comp;
}

/** PCA on area-weighted province positions → principal axis angle in radians.
 *  mapW/mapH convert normalized tex coords to pixel space so aspect ratio
 *  doesn't bias the axis (5632×2048 map: X coords are 2.75× wider than Y). */
function principalAngle(ids: string[], centroids: Centroids, mapW: number, mapH: number): number {
  let totalArea = 0, sx = 0, sy = 0;
  for (const id of ids) {
    const c = centroids[id];
    if (!c) continue;
    const [cx, cy, area] = c;
    totalArea += area;
    sx += cx * mapW * area;
    sy += cy * mapH * area;
  }
  if (totalArea === 0) return 0;
  const mx = sx / totalArea, my = sy / totalArea;
  let vxx = 0, vyy = 0, vxy = 0;
  for (const id of ids) {
    const c = centroids[id];
    if (!c) continue;
    const [cx, cy, area] = c;
    const dx = cx * mapW - mx, dy = cy * mapH - my;
    vxx += area * dx * dx;
    vyy += area * dy * dy;
    vxy += area * dx * dy;
  }
  return 0.5 * Math.atan2(2 * vxy, vxx - vyy);
}

/** Build one label per country at the given date.
 *  Label is placed on the largest connected landmass containing the capital (or
 *  the largest component if the capital is lost). Rotation follows the principal axis. */
export function computeCountryLabels(state: LabelState, date: string): CountryLabel[] {
  const { meta, countries, timeline, centroids, capitalTimeline, adjacency } = state;
  if (!meta) return [];
  const mapW = meta.width as number;
  const mapH = meta.height as number;
  const tKey = dateKey(date);

  // Collect owned provinces per country.
  const owned: Record<string, string[]> = {};
  for (const idStr in timeline) {
    const owner = binarySearchOwner(timeline[idStr], tKey);
    if (!owner) continue;
    (owned[owner] ??= []).push(idStr);
  }

  const out: CountryLabel[] = [];
  for (const tag in owned) {
    const provinces = owned[tag];
    const ownedSet = new Set(provinces);

    // Find all connected components.
    const visited = new Set<string>();
    const components: Set<string>[] = [];
    for (const id of provinces) {
      if (!visited.has(id)) {
        const comp = bfsComponent(id, ownedSet, adjacency);
        comp.forEach((p) => visited.add(p));
        components.push(comp);
      }
    }

    // Prefer the component containing the current capital; fall back to largest by area.
    const capId = capitalAt(capitalTimeline, countries, tag, tKey);
    const capStr = capId != null ? String(capId) : null;
    const capOwned = capStr != null && ownedSet.has(capStr) &&
      binarySearchOwner(timeline[capStr] ?? [], tKey) === tag;

    let mainComp: Set<string>;
    if (capOwned && capStr) {
      mainComp = components.find((c) => c.has(capStr)) ?? components[0];
    } else {
      // Largest component by total province area.
      mainComp = components.reduce((best, c) => {
        const area = (id: string) => centroids[id]?.[2] ?? 0;
        const areaOf = (comp: Set<string>) => { let s = 0; comp.forEach((p) => s += area(p)); return s; };
        return areaOf(c) > areaOf(best) ? c : best;
      }, components[0]);
    }

    // Area-weighted centroid of the main component.
    const compIds = [...mainComp];
    let totalArea = 0, su = 0, sv = 0;
    for (const id of compIds) {
      const c = centroids[id];
      if (!c) continue;
      totalArea += c[2]; su += c[0] * c[2]; sv += c[1] * c[2];
    }
    if (totalArea < 200) continue;

    // Total owned area (drives font size — whole country, not just main component).
    let fullArea = 0;
    for (const id of provinces) fullArea += centroids[id]?.[2] ?? 0;

    out.push({
      tag,
      name: countries[tag]?.name ?? tag,
      u: su / totalArea,
      v: sv / totalArea,
      area: fullArea,
      angle: principalAngle(compIds, centroids, mapW, mapH),
    });
  }
  out.sort((p, q) => q.area - p.area);
  return out;
}

// ---------- date arithmetic for slider ----------

export function addDays(iso: string, days: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(a: string, b: string): number {
  const da = new Date(a + "T00:00:00Z").getTime();
  const db = new Date(b + "T00:00:00Z").getTime();
  return Math.round((db - da) / 86400000);
}
