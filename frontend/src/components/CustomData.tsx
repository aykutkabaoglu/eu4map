import { useCallback, useEffect, useState } from "react";

interface HistoricalEvent { date: string; kind: string; title: string; province_id?: number }
interface GameEvent {
  id: string; scope: string; title: string | null; desc: string | null;
  title_text?: string | null; desc_text?: string | null;
  picture: string | null; namespace: string; file: string;
}

export function CustomData(props: { tag: string; provinceId?: number | null }) {
  const { tag, provinceId } = props;
  const [tab, setTab] = useState<"history" | "game">("history");

  return (
    <div>
      <div style={{ display: "flex", gap: 4, marginTop: 14, marginBottom: 8, flexWrap: "wrap" }}>
        <TabButton active={tab === "history"} onClick={() => setTab("history")}>Historical</TabButton>
        <TabButton active={tab === "game"} onClick={() => setTab("game")}>Game Events</TabButton>
      </div>
      {tab === "history" && <HistoryTab tag={tag} provinceId={provinceId ?? null} />}
      {tab === "game" && <GameEventsTab tag={tag} />}
    </div>
  );
}

function HistoryTab({ tag, provinceId }: { tag: string; provinceId: number | null }) {
  const [items, setItems] = useState<HistoricalEvent[]>([]);
  const [scope, setScope] = useState<"country" | "province">("country");
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const url = scope === "province" && provinceId != null
        ? `/api/provinces/${provinceId}/historical-events`
        : `/api/countries/${tag}/historical-events`;
      const r = await fetch(url);
      if (r.ok) setItems(await r.json());
      else setItems([]);
    } finally {
      setLoading(false);
    }
  }, [tag, provinceId, scope]);
  useEffect(() => { refresh(); }, [refresh]);

  return (
    <div>
      <div style={{ display: "flex", gap: 4, marginBottom: 6 }}>
        <TabButton active={scope === "country"} onClick={() => setScope("country")}>Country</TabButton>
        <TabButton
          active={scope === "province"}
          onClick={() => provinceId != null && setScope("province")}
        >
          Province{provinceId != null ? ` #${provinceId}` : ""}
        </TabButton>
      </div>
      {loading && <Empty text="loading…" />}
      {!loading && items.length === 0 && <Empty text="No historical records." />}
      <div style={{ maxHeight: 360, overflowY: "auto" }}>
        {items.map((e, i) => (
          <div key={i} style={itemStyle}>
            <div style={{ fontSize: 14, color: "var(--ink-soft)" }}>{e.date} · {e.kind}</div>
            <div style={{ fontSize: 17 }}>{e.title}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function GameEventsTab({ tag }: { tag: string }) {
  const [items, setItems] = useState<GameEvent[]>([]);
  const [total, setTotal] = useState(0);
  const [q, setQ] = useState(tag.toLowerCase());
  const [scope, setScope] = useState<"" | "country" | "province" | "news">("");
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<GameEvent | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const p = new URLSearchParams();
      if (q.trim()) p.set("q", q.trim());
      if (scope) p.set("scope", scope);
      p.set("limit", "50");
      const r = await fetch(`/api/eu4/events?${p.toString()}`);
      if (r.ok) {
        const d = await r.json();
        setItems(d.items);
        setTotal(d.total);
      }
    } finally {
      setLoading(false);
    }
  }, [q, scope]);
  useEffect(() => { refresh(); }, [refresh]);

  return (
    <div>
      <input
        placeholder="search (id, title, namespace)"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        style={inputStyle}
      />
      <div style={{ display: "flex", gap: 4, marginBottom: 6, flexWrap: "wrap" }}>
        <TabButton active={scope === ""} onClick={() => setScope("")}>All</TabButton>
        <TabButton active={scope === "country"} onClick={() => setScope("country")}>Country</TabButton>
        <TabButton active={scope === "province"} onClick={() => setScope("province")}>Province</TabButton>
        <TabButton active={scope === "news"} onClick={() => setScope("news")}>News</TabButton>
      </div>
      <div style={{ fontSize: 14, color: "var(--ink-soft)", marginBottom: 4 }}>
        {loading ? "loading…" : `${items.length} / ${total} events`}
      </div>
      <div style={{ maxHeight: 340, overflowY: "auto" }}>
        {items.map((e) => (
          <GameEventItem key={e.id} event={e} onSelect={setSelected} />
        ))}
      </div>
      {selected && <EventDetailModal event={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}

interface EventOption { name_key: string | null; name_text: string | null; effects: Record<string, unknown> }
interface EventDetail {
  id: string;
  body?: string;
  parsed?: {
    mean_time_to_happen?: Record<string, unknown>;
    trigger?: unknown;
    immediate?: unknown;
    options?: EventOption[];
  };
}

function GameEventItem({ event, onSelect }: { event: GameEvent; onSelect: (e: GameEvent) => void }) {
  return (
    <div style={{ ...itemStyle, cursor: "pointer" }} onClick={() => onSelect(event)}>
      <div style={{ fontSize: 14, color: "var(--ink-soft)" }}>
        {event.namespace} · {event.scope} ▸
      </div>
      <div style={{ fontFamily: "var(--font-display)", fontSize: 17 }}>
        {event.title_text ?? event.id}
      </div>
      {event.title_text && (
        <div style={{ fontSize: 13, color: "var(--ink-soft)" }}>{event.id}</div>
      )}
      {event.desc_text && (
        <div style={{ fontSize: 16, fontStyle: "italic", marginTop: 2 }}>{event.desc_text}</div>
      )}
    </div>
  );
}

function EventDetailModal({ event, onClose }: { event: GameEvent; onClose: () => void }) {
  const [detail, setDetail] = useState<EventDetail | null>(null);
  const [showRaw, setShowRaw] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setDetail(null);
    setLoading(true);
    fetch(`/api/eu4/events/${encodeURIComponent(event.id)}`)
      .then((r) => r.ok ? r.json() : null)
      .then((d) => { setDetail(d); setLoading(false); });
  }, [event.id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const parsed = detail?.parsed;
  const mtthText = formatMtth(parsed?.mean_time_to_happen);

  return (
    <div
      style={{
        position: "fixed", inset: 0, zIndex: 1000,
        background: "rgba(20,14,6,0.72)",
        display: "flex", alignItems: "center", justifyContent: "center",
      }}
      onClick={onClose}
    >
      <div
        className="eu4-panel"
        style={{
          width: "min(680px, 92vw)",
          maxHeight: "82vh",
          overflowY: "auto",
          padding: "20px 24px",
          position: "relative",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <button
          style={{ position: "absolute", top: 8, right: 10, fontSize: 14, padding: "3px 10px" }}
          onClick={onClose}
        >
          ✕ Close
        </button>

        <div style={{ fontSize: 14, color: "var(--ink-soft)", marginBottom: 4 }}>
          {event.namespace} · {event.scope} · {event.id}
        </div>
        <h2 style={{ marginTop: 0 }}>{event.title_text ?? event.id}</h2>
        {event.desc_text && (
          <p style={{ fontStyle: "italic", fontSize: 18, marginTop: 0, marginBottom: 12 }}>
            {event.desc_text}
          </p>
        )}

        {loading && <Empty text="loading…" />}

        {parsed && (
          <>
            {mtthText && (
              <Section title="Mean Time to Happen">
                <span style={{ fontSize: 18 }}>{mtthText}</span>
              </Section>
            )}
            {parsed.trigger != null && (
              <Section title="Conditions">
                <TriggerTree value={parsed.trigger} depth={0} />
              </Section>
            )}
            {parsed.immediate != null && (
              <Section title="Immediate Effects">
                <TriggerTree value={parsed.immediate} depth={0} />
              </Section>
            )}
            {parsed.options && parsed.options.length > 0 && (
              <Section title="Options">
                {parsed.options.map((o, i) => (
                  <div key={i} style={{
                    borderLeft: "2px solid var(--gold)",
                    paddingLeft: 8,
                    marginBottom: 8,
                  }}>
                    <div style={{ fontFamily: "var(--font-display)", fontSize: 18, marginBottom: 2 }}>
                      {o.name_text ?? o.name_key ?? `Option ${i + 1}`}
                    </div>
                    {Object.keys(o.effects).length > 0 && (
                      <TriggerTree value={o.effects} depth={0} />
                    )}
                  </div>
                ))}
              </Section>
            )}
            <div style={{ marginTop: 10 }}>
              <button
                style={{ fontSize: 14, padding: "3px 8px" }}
                onClick={() => setShowRaw((v) => !v)}
              >
                {showRaw ? "Hide raw data" : "Show raw data"}
              </button>
              {showRaw && (
                <pre style={{
                  marginTop: 6, padding: 8, fontSize: 14,
                  fontFamily: "ui-monospace, Menlo, monospace",
                  background: "rgba(20,14,6,0.45)", color: "var(--parchment)",
                  border: "1px solid var(--frame-dark)",
                  maxHeight: 300, overflow: "auto",
                  whiteSpace: "pre-wrap", wordBreak: "break-word",
                }}>{detail?.body}</pre>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function formatMtth(m: Record<string, unknown> | undefined): string | null {
  if (!m) return null;
  if (typeof m.years === "number") return `~${m.years} yr`;
  if (typeof m.months === "number") {
    const months = m.months as number;
    if (months >= 24) return `~${Math.round(months / 12)} yr`;
    return `~${months} mo`;
  }
  if (typeof m.days === "number") return `~${m.days} d`;
  return null;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginTop: 6 }}>
      <div style={{
        fontFamily: "var(--font-display)",
        fontSize: 14,
        letterSpacing: "0.08em",
        textTransform: "uppercase",
        color: "var(--ink-soft)",
        borderBottom: "1px solid var(--gold)",
        paddingBottom: 2,
        marginBottom: 4,
      }}>{title}</div>
      {children}
    </div>
  );
}

function TriggerTree({ value, depth }: { value: unknown; depth: number }) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object") {
    return <span style={{ fontSize: 16 }}>{String(value)}</span>;
  }
  if (Array.isArray(value)) {
    return (
      <div>
        {value.map((v, i) => (
          <div key={i}><TriggerTree value={v} depth={depth} /></div>
        ))}
      </div>
    );
  }
  const entries = Object.entries(value as Record<string, unknown>);
  return (
    <div style={{ paddingLeft: depth > 0 ? 10 : 0, borderLeft: depth > 0 ? "1px dotted rgba(74,46,26,0.4)" : undefined }}>
      {entries.map(([k, v]) => {
        const isLeaf = v === null || typeof v !== "object";
        return (
          <div key={k} style={{ fontSize: 16, lineHeight: "1.4em" }}>
            <span style={{
              fontFamily: "var(--font-ui)",
              color: "var(--ink-soft)",
              fontWeight: 500,
            }}>{prettyKey(k)}</span>
            {isLeaf ? (
              <>: <span>{String(v)}</span></>
            ) : (
              <TriggerTree value={v} depth={depth + 1} />
            )}
          </div>
        );
      })}
    </div>
  );
}

function prettyKey(k: string): string {
  // Replace underscores, capitalize for common operators.
  if (k === "__bare__") return "•";
  if (k === "NOT") return "NOT";
  if (k === "OR") return "OR";
  if (k === "AND") return "AND";
  return k.replace(/_/g, " ");
}

function TabButton(p: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={p.onClick}
      style={{
        fontSize: 13,
        padding: "4px 10px",
        opacity: p.active ? 1 : 0.6,
        boxShadow: p.active
          ? "inset 0 0 8px var(--gold-light), 0 1px 2px rgba(0,0,0,0.4)"
          : undefined,
      }}
    >
      {p.children}
    </button>
  );
}

// ---------- shared ----------

function Empty({ text }: { text: string }) {
  return (
    <div style={{ fontSize: 16, fontStyle: "italic", color: "var(--ink-soft)", padding: "4px 0" }}>
      {text}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "4px 6px",
  marginBottom: 4,
  fontFamily: "var(--font-ui)",
  fontSize: 16,
  background: "var(--parchment-dark)",
  border: "1px solid var(--frame-dark)",
  color: "var(--ink)",
};
const itemStyle: React.CSSProperties = {
  position: "relative",
  padding: "6px 6px",
  marginBottom: 4,
  background: "rgba(184, 134, 11, 0.08)",
  borderLeft: "3px solid var(--gold)",
};
