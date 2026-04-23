export type RGB = [number, number, number];

export interface Meta {
  start: string;
  end: string;
  width: number;
  height: number;
  max_provinces: number;
  sea_ids: number[];
  lake_ids: number[];
  wasteland_ids: number[];
}

export interface Country {
  name: string;
  color: RGB;
  government: string | null;
  religion: string | null;
  primary_culture: string | null;
  technology_group: string | null;
  capital: number | null;
}

export type CountryMap = Record<string, Country>;

// province_owner_timeline.json is { [provinceId]: [["YYYY-MM-DD", "TAG"], ...] }
export type OwnerTimeline = Record<string, Array<[string, string]>>;

export interface RulerApi {
  tag: string;
  kind: string;
  name: string | null;
  dynasty: string | null;
  birth_date: string | null;
  death_date: string | null;
  start_date: string;
  adm: number | null;
  dip: number | null;
  mil: number | null;
  personality: string | null;
}

export interface CountryApi {
  tag: string;
  name: string;
  color: RGB;
  government: string | null;
  religion: string | null;
  primary_culture: string | null;
  technology_group: string | null;
  capital_id: number | null;
  capital_name: string | null;
  ruler_count: number;
  leader_count: number;
}

export interface ProvinceApi {
  id: number;
  name: string;
  def_rgb: RGB;
  is_sea: boolean;
  is_lake: boolean;
  is_wasteland: boolean;
  initial_owner: string | null;
}
