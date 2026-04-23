import { useCallback, useEffect, useState } from "react";

interface Note { id: number; country_tag: string; text: string; created_at: string }
interface Commander {
  id: number; country_tag: string; name: string;
  fire: number | null; shock: number | null; maneuver: number | null; siege: number | null;
  start_date: string | null; death_date: string | null; description: string | null;
}
interface EventItem {
  id: number; date: string; country_tag: string | null; province_id: number | null;
  title: string; description: string | null;
}
interface HistoricalEvent { date: string; kind: string; title: string; province_id?: number }
interface GameEvent {
  id: string; scope: string; title: string | null; desc: string | null;
  title_text?: string | null; desc_text?: string | null;
  picture: string | null; namespace: string; file: string;
}

export function CustomData(props: { tag: string; provinceId?: number | null }) {
  const { tag, provinceId } = props;
  const [tab, setTab] = useState<"history" | "game" | "notes" | "commanders" | "events">("history");

  return (
    <div>
      <div style={{ display: "flex", gap: 4, marginTop: 14, marginBottom: 8, flexWrap: "wrap" }}>
        <TabButton active={tab === "history"} onClick={() => setTab("history")}>Historical</TabButton>
        <TabButton active={tab === "game"} onClick={() => setTab("game")}>Game Events</TabButton>
        <TabButton active={tab === "notes"} onClick={() => setTab("notes")}>Notes</TabButton>
        <TabButton active={tab === "commanders"} onClick={() => setTab("commanders")}>Commanders</TabButton>
        <TabButton active={tab === "events"} onClick={() => setTab("events")}>Custom Events</TabButton>
      </div>
      {tab === "history" && <HistoryTab tag={tag} provinceId={provinceId ?? null} />}
      {tab === "game" && <GameEventsTab tag={tag} />}
      {tab === "notes" && <NotesTab tag={tag} />}
      {tab === "commanders" && <CommandersTab tag={tag} />}
      {tab === "events" && <EventsTab tag={tag} provinceId={provinceId ?? null} />}
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
            <div style={{ fontSize: 10, color: "var(--ink-soft)" }}>{e.date} · {e.kind}</div>
            <div style={{ fontSize: 12 }}>{e.title}</div>
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
      <div style={{ fontSize: 10, color: "var(--ink-soft)", marginBottom: 4 }}>
        {loading ? "loading…" : `${items.length} / ${total} events`}
      </div>
      <div style={{ maxHeight: 340, overflowY: "auto" }}>
        {items.map((e) => (
          <GameEventItem key={e.id} event={e} />
        ))}
      </div>
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

function GameEventItem({ event }: { event: GameEvent }) {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<EventDetail | null>(null);
  const [showRaw, setShowRaw] = useState(false);
  const [loading, setLoading] = useState(false);

  async function toggle() {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    if (detail !== null) return;
    setLoading(true);
    try {
      const r = await fetch(`/api/eu4/events/${encodeURIComponent(event.id)}`);
      if (r.ok) setDetail(await r.json());
    } finally {
      setLoading(false);
    }
  }

  const parsed = detail?.parsed;
  const mtth = parsed?.mean_time_to_happen;
  const mtthText = formatMtth(mtth);

  return (
    <div style={{ ...itemStyle, cursor: "pointer" }} onClick={toggle}>
      <div style={{ fontSize: 10, color: "var(--ink-soft)" }}>
        {event.namespace} · {event.scope} {open ? "▾" : "▸"}
      </div>
      <div style={{ fontFamily: "var(--font-display)", fontSize: 12 }}>
        {event.title_text ?? event.id}
      </div>
      {event.title_text && (
        <div style={{ fontSize: 10, color: "var(--ink-soft)" }}>{event.id}</div>
      )}
      {event.desc_text && (
        <div style={{ fontSize: 11, fontStyle: "italic", marginTop: 2 }}>{event.desc_text}</div>
      )}

      {open && (
        <div onClick={(e) => e.stopPropagation()} style={{ marginTop: 8 }}>
          {loading && <Empty text="loading…" />}
          {parsed && (
            <>
              {mtthText && (
                <Section title="Mean Time to Happen">
                  <span style={{ fontSize: 12 }}>{mtthText}</span>
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
                      paddingLeft: 6,
                      marginBottom: 6,
                    }}>
                      <div style={{ fontFamily: "var(--font-display)", fontSize: 12 }}>
                        {o.name_text ?? o.name_key ?? `Option ${i + 1}`}
                      </div>
                      {Object.keys(o.effects).length > 0 && (
                        <TriggerTree value={o.effects} depth={0} />
                      )}
                    </div>
                  ))}
                </Section>
              )}
              <div style={{ marginTop: 6 }}>
                <button
                  style={{ fontSize: 9, padding: "2px 6px" }}
                  onClick={() => setShowRaw((v) => !v)}
                >
                  {showRaw ? "Hide raw data" : "Show raw data"}
                </button>
                {showRaw && (
                  <pre style={{
                    marginTop: 6, padding: 6, fontSize: 10,
                    fontFamily: "ui-monospace, Menlo, monospace",
                    background: "rgba(20,14,6,0.45)", color: "var(--parchment)",
                    border: "1px solid var(--frame-dark)",
                    maxHeight: 260, overflow: "auto",
                    whiteSpace: "pre-wrap", wordBreak: "break-word",
                  }}>{detail?.body}</pre>
                )}
              </div>
            </>
          )}
        </div>
      )}
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
        fontSize: 10,
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
    return <span style={{ fontSize: 11 }}>{String(value)}</span>;
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
          <div key={k} style={{ fontSize: 11, lineHeight: "1.35em" }}>
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
        fontSize: 10,
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

// ---------- Notes ----------

function NotesTab({ tag }: { tag: string }) {
  const [items, setItems] = useState<Note[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const r = await fetch(`/api/custom/countries/${tag}/notes`);
    if (r.ok) setItems(await r.json());
  }, [tag]);
  useEffect(() => { refresh(); }, [refresh]);

  async function add() {
    if (!text.trim()) return;
    setBusy(true);
    try {
      await fetch(`/api/custom/countries/${tag}/notes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      setText("");
      await refresh();
    } finally {
      setBusy(false);
    }
  }
  async function remove(id: number) {
    await fetch(`/api/custom/countries/${tag}/notes/${id}`, { method: "DELETE" });
    await refresh();
  }

  return (
    <div>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Write a note…"
        rows={2}
        style={textareaStyle}
      />
      <div style={{ textAlign: "right", marginBottom: 6 }}>
        <button disabled={busy || !text.trim()} onClick={add}>Add</button>
      </div>
      {items.length === 0 && <Empty text="No notes." />}
      {items.map((n) => (
        <div key={n.id} style={itemStyle}>
          <div style={{ fontSize: 10, color: "var(--ink-soft)" }}>{n.created_at}</div>
          <div style={{ whiteSpace: "pre-wrap", fontSize: 12 }}>{n.text}</div>
          <button style={miniBtnStyle} onClick={() => remove(n.id)}>Delete</button>
        </div>
      ))}
    </div>
  );
}

// ---------- Commanders ----------

function CommandersTab({ tag }: { tag: string }) {
  const [items, setItems] = useState<Commander[]>([]);
  const [form, setForm] = useState({
    name: "", fire: "", shock: "", maneuver: "", siege: "",
    start_date: "", description: "",
  });

  const refresh = useCallback(async () => {
    const r = await fetch(`/api/custom/countries/${tag}/commanders`);
    if (r.ok) setItems(await r.json());
  }, [tag]);
  useEffect(() => { refresh(); }, [refresh]);

  async function add() {
    if (!form.name.trim()) return;
    const body = {
      name: form.name,
      fire: form.fire ? +form.fire : null,
      shock: form.shock ? +form.shock : null,
      maneuver: form.maneuver ? +form.maneuver : null,
      siege: form.siege ? +form.siege : null,
      start_date: form.start_date || null,
      description: form.description || null,
    };
    await fetch(`/api/custom/countries/${tag}/commanders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    setForm({ name: "", fire: "", shock: "", maneuver: "", siege: "", start_date: "", description: "" });
    await refresh();
  }
  async function remove(id: number) {
    await fetch(`/api/custom/countries/${tag}/commanders/${id}`, { method: "DELETE" });
    await refresh();
  }

  return (
    <div>
      <input
        placeholder="Name"
        value={form.name}
        onChange={(e) => setForm({ ...form, name: e.target.value })}
        style={inputStyle}
      />
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 4, marginBottom: 4 }}>
        <StatInput label="Fire" value={form.fire} onChange={(v) => setForm({ ...form, fire: v })} />
        <StatInput label="Shock" value={form.shock} onChange={(v) => setForm({ ...form, shock: v })} />
        <StatInput label="Manv." value={form.maneuver} onChange={(v) => setForm({ ...form, maneuver: v })} />
        <StatInput label="Siege" value={form.siege} onChange={(v) => setForm({ ...form, siege: v })} />
      </div>
      <input
        type="date"
        value={form.start_date}
        onChange={(e) => setForm({ ...form, start_date: e.target.value })}
        style={inputStyle}
      />
      <textarea
        placeholder="Description (optional)"
        value={form.description}
        onChange={(e) => setForm({ ...form, description: e.target.value })}
        rows={2}
        style={textareaStyle}
      />
      <div style={{ textAlign: "right", marginBottom: 6 }}>
        <button disabled={!form.name.trim()} onClick={add}>Add</button>
      </div>
      {items.length === 0 && <Empty text="No commanders." />}
      {items.map((c) => (
        <div key={c.id} style={itemStyle}>
          <div style={{ fontFamily: "var(--font-display)" }}>{c.name}</div>
          <div style={{ fontSize: 11, color: "var(--ink-soft)" }}>
            {c.start_date ?? "?"}  ·  F{c.fire ?? "-"} S{c.shock ?? "-"} M{c.maneuver ?? "-"} Sg{c.siege ?? "-"}
          </div>
          {c.description && (
            <div style={{ fontSize: 12, fontStyle: "italic" }}>{c.description}</div>
          )}
          <button style={miniBtnStyle} onClick={() => remove(c.id)}>Delete</button>
        </div>
      ))}
    </div>
  );
}

function StatInput(p: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", fontSize: 10 }}>
      <span style={{ color: "var(--ink-soft)" }}>{p.label}</span>
      <input
        type="number" min={0} max={6}
        value={p.value}
        onChange={(e) => p.onChange(e.target.value)}
        style={inputStyle}
      />
    </label>
  );
}

// ---------- Events ----------

function EventsTab({ tag, provinceId }: { tag: string; provinceId: number | null }) {
  const [items, setItems] = useState<EventItem[]>([]);
  const [form, setForm] = useState({ date: "", title: "", description: "" });
  const [scope, setScope] = useState<"country" | "province">("country");

  const refresh = useCallback(async () => {
    const qs = scope === "province" && provinceId != null
      ? `province_id=${provinceId}`
      : `tag=${tag}`;
    const r = await fetch(`/api/custom/events?${qs}`);
    if (r.ok) setItems(await r.json());
  }, [tag, provinceId, scope]);
  useEffect(() => { refresh(); }, [refresh]);

  async function add() {
    if (!form.date || !form.title.trim()) return;
    const body: Record<string, unknown> = {
      date: form.date,
      title: form.title,
      description: form.description || null,
    };
    if (scope === "province" && provinceId != null) body.province_id = provinceId;
    else body.country_tag = tag;
    await fetch(`/api/custom/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    setForm({ date: "", title: "", description: "" });
    await refresh();
  }
  async function remove(id: number) {
    await fetch(`/api/custom/events/${id}`, { method: "DELETE" });
    await refresh();
  }

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
      <input
        type="date"
        value={form.date}
        onChange={(e) => setForm({ ...form, date: e.target.value })}
        style={inputStyle}
      />
      <input
        placeholder="Title"
        value={form.title}
        onChange={(e) => setForm({ ...form, title: e.target.value })}
        style={inputStyle}
      />
      <textarea
        placeholder="Description"
        value={form.description}
        onChange={(e) => setForm({ ...form, description: e.target.value })}
        rows={2}
        style={textareaStyle}
      />
      <div style={{ textAlign: "right", marginBottom: 6 }}>
        <button disabled={!form.date || !form.title.trim()} onClick={add}>Add</button>
      </div>
      {items.length === 0 && <Empty text="No events." />}
      {items.map((e) => (
        <div key={e.id} style={itemStyle}>
          <div style={{ fontSize: 10, color: "var(--ink-soft)" }}>{e.date}</div>
          <div style={{ fontFamily: "var(--font-display)" }}>{e.title}</div>
          {e.description && (
            <div style={{ fontSize: 12, whiteSpace: "pre-wrap" }}>{e.description}</div>
          )}
          <button style={miniBtnStyle} onClick={() => remove(e.id)}>Delete</button>
        </div>
      ))}
    </div>
  );
}

// ---------- shared ----------

function Empty({ text }: { text: string }) {
  return (
    <div style={{ fontSize: 12, fontStyle: "italic", color: "var(--ink-soft)", padding: "4px 0" }}>
      {text}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "4px 6px",
  marginBottom: 4,
  fontFamily: "var(--font-ui)",
  fontSize: 12,
  background: "var(--parchment-dark)",
  border: "1px solid var(--frame-dark)",
  color: "var(--ink)",
};
const textareaStyle: React.CSSProperties = { ...inputStyle, resize: "vertical" };
const itemStyle: React.CSSProperties = {
  position: "relative",
  padding: "6px 28px 6px 6px",
  marginBottom: 4,
  background: "rgba(184, 134, 11, 0.08)",
  borderLeft: "3px solid var(--gold)",
};
const miniBtnStyle: React.CSSProperties = {
  position: "absolute",
  top: 2,
  right: 2,
  padding: "1px 6px",
  fontSize: 10,
};
