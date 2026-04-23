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

interface AppState {
  // raw data
  meta: Meta | null;
  countries: CountryMap;
  timeline: OwnerTimeline;
  centroids: Centroids;
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
  provinceNames: {},
  loaded: false,
  error: null,

  currentDate: "1444-11-11",
  setDate: (d) => set({ currentDate: d }),

  selected: null,
  setSelected: (s) => set({ selected: s }),

  async loadAll() {
    try {
      const [metaRes, countriesRes, timelineRes, centroidsRes, namesRes] = await Promise.all([
        fetch("/data/meta.json"),
        fetch("/data/countries.json"),
        fetch("/data/province_owner_timeline.json"),
        fetch("/data/province_centroids.json"),
        fetch("/data/province_names.json"),
      ]);
      if (!metaRes.ok || !countriesRes.ok || !timelineRes.ok) {
        throw new Error("failed to load /data/* (ETL not run?)");
      }
      const meta: Meta = await metaRes.json();
      const countries: CountryMap = await countriesRes.json();
      const timeline: OwnerTimeline = await timelineRes.json();
      const centroids: Centroids = centroidsRes.ok ? await centroidsRes.json() : {};
      const provinceNames: Record<string, string> = namesRes.ok ? await namesRes.json() : {};
      set({ meta, countries, timeline, centroids, provinceNames, loaded: true, currentDate: meta.start });
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
  u: number;   // weighted centroid (tex coords)
  v: number;
  area: number;
  // Union bounding box in tex coords — used to cap label width/font.
  bx0: number; by0: number; bx1: number; by1: number;
}

/** Aggregate province centroids into one weighted label per country at the given date. */
export function computeCountryLabels(state: AppState, date: string): CountryLabel[] {
  const { meta, countries, timeline, centroids } = state;
  if (!meta) return [];
  const tKey = dateKey(date);
  interface Agg {
    sx: number; sy: number; area: number;
    bx0: number; by0: number; bx1: number; by1: number;
  }
  const agg: Record<string, Agg> = {};
  for (const idStr in timeline) {
    const c = centroids[idStr];
    if (!c) continue;
    const owner = binarySearchOwner(timeline[idStr], tKey);
    if (!owner) continue;
    const [cx, cy, area, bx0, by0, bx1, by1] = c;
    const a =
      agg[owner] ??
      (agg[owner] = {
        sx: 0, sy: 0, area: 0,
        bx0: 1, by0: 1, bx1: 0, by1: 0,
      });
    a.sx += cx * area;
    a.sy += cy * area;
    a.area += area;
    if (bx0 < a.bx0) a.bx0 = bx0;
    if (by0 < a.by0) a.by0 = by0;
    if (bx1 > a.bx1) a.bx1 = bx1;
    if (by1 > a.by1) a.by1 = by1;
  }
  const out: CountryLabel[] = [];
  for (const tag in agg) {
    const a = agg[tag];
    if (a.area < 200) continue;
    const country = countries[tag];
    out.push({
      tag,
      name: country?.name ?? tag,
      u: a.sx / a.area,
      v: a.sy / a.area,
      area: a.area,
      bx0: a.bx0, by0: a.by0, bx1: a.bx1, by1: a.by1,
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
