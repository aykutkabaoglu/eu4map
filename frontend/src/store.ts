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

interface AppState {
  // raw data
  meta: Meta | null;
  countries: CountryMap;
  timeline: OwnerTimeline;
  centroids: Centroids;
  capitalTimeline: CapitalTimeline;
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
  provinceNames: {},
  loaded: false,
  error: null,

  currentDate: "1444-11-11",
  setDate: (d) => set({ currentDate: d }),

  selected: null,
  setSelected: (s) => set({ selected: s }),

  async loadAll() {
    try {
      const [metaRes, countriesRes, timelineRes, centroidsRes, capitalTimelineRes, namesRes] = await Promise.all([
        fetch("/data/meta.json"),
        fetch("/data/countries.json"),
        fetch("/data/province_owner_timeline.json"),
        fetch("/data/province_centroids.json"),
        fetch("/data/country_capital_timeline.json"),
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
      const provinceNames: Record<string, string> = namesRes.ok ? await namesRes.json() : {};
      set({ meta, countries, timeline, centroids, capitalTimeline, provinceNames, loaded: true, currentDate: meta.start });
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
  u: number;   // label position: capital province centroid (tex coords)
  v: number;
  area: number; // total owned province area (texture pixels) — drives font size + visibility
}

/** Minimal state slice needed by computeCountryLabels — avoids the `as never` hack. */
export interface LabelState {
  meta: Meta | null;
  countries: CountryMap;
  timeline: OwnerTimeline;
  centroids: Centroids;
  capitalTimeline: CapitalTimeline;
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

/** Build one label per country at the given date, anchored to the current capital province.
 *  If the capital has been conquered, falls back to the area-weighted centroid of owned provinces. */
export function computeCountryLabels(state: LabelState, date: string): CountryLabel[] {
  const { meta, countries, timeline, centroids, capitalTimeline } = state;
  if (!meta) return [];
  const tKey = dateKey(date);

  interface Agg { sx: number; sy: number; area: number; }
  const agg: Record<string, Agg> = {};

  for (const idStr in timeline) {
    const c = centroids[idStr];
    if (!c) continue;
    const owner = binarySearchOwner(timeline[idStr], tKey);
    if (!owner) continue;
    const [cx, cy, area] = c;
    const a = agg[owner] ?? (agg[owner] = { sx: 0, sy: 0, area: 0 });
    a.sx += cx * area;
    a.sy += cy * area;
    a.area += area;
  }

  const out: CountryLabel[] = [];
  for (const tag in agg) {
    const a = agg[tag];
    if (a.area < 200) continue;

    // Prefer the current capital; fall back to owned-province centroid if conquered.
    const capId = capitalAt(capitalTimeline, countries, tag, tKey);
    const capOwned = capId != null && binarySearchOwner(timeline[String(capId)] ?? [], tKey) === tag;
    const cap = capOwned ? centroids[String(capId)] : null;

    out.push({
      tag,
      name: countries[tag]?.name ?? tag,
      u: cap ? cap[0] : a.sx / a.area,
      v: cap ? cap[1] : a.sy / a.area,
      area: a.area,
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
