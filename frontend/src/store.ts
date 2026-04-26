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
  key: string;     // unique render key: tag + component index
  tag: string;
  name: string;
  u: number;       // component centroid in texture coords
  v: number;
  axisLen: number; // principal axis length normalised by map width (drives font size)
  angle: number;   // principal axis angle in radians
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

/** Return true if compB is reachable from compA by crossing only sea/lake or own provinces.
 *  Used to decide whether two disconnected territories should share a label. */
function isSeaConnected(
  compA: string[],
  compB: string[],
  ownedSet: Set<string>,
  adjacency: Adjacency,
  seaLakeSet: Set<number>,
): boolean {
  const targetSet = new Set(compB);
  const visited = new Set<string>(compA);
  const queue: string[] = [...compA];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const nb of (adjacency[cur] ?? [])) {
      const nbStr = String(nb);
      if (visited.has(nbStr)) continue;
      if (targetSet.has(nbStr)) return true;
      if (seaLakeSet.has(nb) || ownedSet.has(nbStr)) {
        visited.add(nbStr);
        queue.push(nbStr);
      }
    }
  }
  return false;
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

// Components whose centroids are within this pixel distance are merged into one label.
const MERGE_DIST_PX = 200;

/** Build labels per country at the given date.
 *  Connected components closer than MERGE_DIST_PX are merged into a single label;
 *  distant territories (colonies, far islands) each get their own label. */
export function computeCountryLabels(state: LabelState, date: string): CountryLabel[] {
  const { meta, countries, timeline, centroids, capitalTimeline, adjacency } = state;
  if (!meta) return [];
  const mapW = meta.width as number;
  const mapH = meta.height as number;
  const tKey = dateKey(date);
  const seaLakeSet = new Set<number>([...meta.sea_ids, ...meta.lake_ids]);

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

    // Find connected components via BFS.
    const visited = new Set<string>();
    const rawComps: string[][] = [];
    for (const id of provinces) {
      if (!visited.has(id)) {
        const comp = bfsComponent(id, ownedSet, adjacency);
        comp.forEach((p) => visited.add(p));
        rawComps.push([...comp]);
      }
    }

    // Compute area-weighted centroid for each raw component.
    interface CompInfo { ids: string[]; area: number; cu: number; cv: number; }
    const compInfos: CompInfo[] = [];
    for (const ids of rawComps) {
      let area = 0, su = 0, sv = 0;
      for (const id of ids) {
        const c = centroids[id];
        if (!c) continue;
        area += c[2]; su += c[0] * c[2]; sv += c[1] * c[2];
      }
      if (area < 200) continue;
      compInfos.push({ ids, area, cu: su / area, cv: sv / area });
    }
    // Sort largest first so the main territory becomes the first group.
    compInfos.sort((a, b) => b.area - a.area);

    // Greedy merge: each component joins the nearest existing group within MERGE_DIST_PX.
    const groups: { ids: string[]; area: number; cu: number; cv: number }[] = [];
    for (const comp of compInfos) {
      let merged = false;
      for (const g of groups) {
        const dx = (comp.cu - g.cu) * mapW;
        const dy = (comp.cv - g.cv) * mapH;
        if (Math.sqrt(dx * dx + dy * dy) < MERGE_DIST_PX &&
            isSeaConnected(g.ids, comp.ids, ownedSet, adjacency, seaLakeSet)) {
          // Update group centroid (area-weighted) and append provinces.
          const newArea = g.area + comp.area;
          g.cu = (g.cu * g.area + comp.cu * comp.area) / newArea;
          g.cv = (g.cv * g.area + comp.cv * comp.area) / newArea;
          g.area = newArea;
          g.ids.push(...comp.ids);
          merged = true;
          break;
        }
      }
      if (!merged) {
        groups.push({ ids: [...comp.ids], area: comp.area, cu: comp.cu, cv: comp.cv });
      }
    }

    // Emit one label per group.
    for (let gi = 0; gi < groups.length; gi++) {
      const g = groups[gi];
      const angle = principalAngle(g.ids, centroids, mapW, mapH);

      // Axis extent: project province centroids onto the principal axis direction.
      const cosA = Math.cos(angle), sinA = Math.sin(angle);
      let minProj = Infinity, maxProj = -Infinity;
      for (const id of g.ids) {
        const c = centroids[id];
        if (!c) continue;
        const proj = c[0] * mapW * cosA + c[1] * mapH * sinA;
        if (proj < minProj) minProj = proj;
        if (proj > maxProj) maxProj = proj;
      }
      const axisLen = (maxProj - minProj) / mapW;

      // Recompute centroid over all provinces in the group (merging shifted g.cu/cv).
      let totalArea = 0, su = 0, sv = 0;
      for (const id of g.ids) {
        const c = centroids[id];
        if (!c) continue;
        totalArea += c[2]; su += c[0] * c[2]; sv += c[1] * c[2];
      }

      out.push({
        key: `${tag}_${gi}`,
        tag,
        name: countries[tag]?.name ?? tag,
        u: su / totalArea,
        v: sv / totalArea,
        axisLen,
        angle,
      });
    }
  }

  out.sort((p, q) => q.axisLen - p.axisLen);
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
