import { useEffect, useState } from "react";
import { useApp } from "../store";
import type { CountryApi, ProvinceApi, RulerApi } from "../types";
import { CustomData } from "./CustomData";

export function CountryPanel() {
  const selected = useApp((s) => s.selected);
  const countries = useApp((s) => s.countries);
  const currentDate = useApp((s) => s.currentDate);

  const [province, setProvince] = useState<ProvinceApi | null>(null);
  const [country, setCountry] = useState<CountryApi | null>(null);
  const [monarch, setMonarch] = useState<RulerApi | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setProvince(null);
    setCountry(null);
    setMonarch(null);
    if (!selected) return;

    setLoading(true);
    (async () => {
      try {
        const [pRes] = await Promise.all([
          fetch(`/api/provinces/${selected.id}`),
        ]);
        if (pRes.ok && !cancelled) setProvince(await pRes.json());

        if (selected.owner) {
          const [cRes, mRes] = await Promise.all([
            fetch(`/api/countries/${selected.owner}`),
            fetch(`/api/countries/${selected.owner}/rulers?at=${currentDate}`),
          ]);
          if (cRes.ok && !cancelled) setCountry(await cRes.json());
          if (mRes.ok && !cancelled) setMonarch(await mRes.json());
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selected, currentDate]);

  if (!selected) {
    return (
      <div className="eu4-panel" style={panelStyle}>
        <h2>Country Panel</h2>
        <div style={{ fontFamily: "var(--font-body)", fontSize: 13, fontStyle: "italic" }}>
          Select a province on the map.
        </div>
      </div>
    );
  }

  const ownerName = selected.owner ? countries[selected.owner]?.name ?? selected.owner : null;
  const color = selected.owner ? countries[selected.owner]?.color : null;

  return (
    <div className="eu4-panel" style={panelStyle}>
      <h1>
        {color && (
          <span
            className="color-chip"
            style={{ backgroundColor: `rgb(${color.join(",")})` }}
          />
        )}
        {ownerName ?? "Unclaimed"}
      </h1>
      {province?.name && (
        <div style={{ fontFamily: "var(--font-body)", fontStyle: "italic", fontSize: "calc(11px * var(--panel-scale, 1))", marginBottom: 8, color: "var(--ink-soft)" }}>
          {province.name}
        </div>
      )}
      {loading && <div style={{ fontSize: 12, fontStyle: "italic" }}>loading…</div>}

      {country && (
        <dl className="kv">
          <dt>Government</dt><dd>{country.government ?? "—"}</dd>
          <dt>Religion</dt><dd>{country.religion ?? "—"}</dd>
          <dt>Culture</dt><dd>{country.primary_culture ?? "—"}</dd>
          <dt>Tech Group</dt><dd>{country.technology_group ?? "—"}</dd>
          <dt>Capital</dt><dd>{country.capital_name ? `${country.capital_name} (#${country.capital_id})` : country.capital_id ?? "—"}</dd>
        </dl>
      )}

      {monarch && (
        <>
          <h2 style={{ marginTop: 14 }}>Ruler ({currentDate})</h2>
          <dl className="kv">
            <dt>Name</dt>
            <dd style={{ fontFamily: "var(--font-display)" }}>
              {monarch.name}{" "}
              {monarch.dynasty && (
                <span style={{ color: "var(--ink-soft)" }}>({monarch.dynasty})</span>
              )}
            </dd>
            <dt>Start</dt><dd>{monarch.start_date}</dd>
            <dt>ADM / DIP / MIL</dt>
            <dd>
              <b>{monarch.adm ?? "?"}</b> / <b>{monarch.dip ?? "?"}</b> / <b>{monarch.mil ?? "?"}</b>
            </dd>
          </dl>
        </>
      )}

      {selected.owner && (
        <CustomData tag={selected.owner} provinceId={selected.id} />
      )}
    </div>
  );
}

const panelStyle: React.CSSProperties = {
  width: "100%",
  height: "100%",
  overflowY: "auto",
  borderLeft: "none",
};
