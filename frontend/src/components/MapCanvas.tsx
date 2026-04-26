import { useEffect, useMemo, useRef, useState } from "react";
import { useApp, computeCountryLabels, type LabelState } from "../store";
import { createRenderer, type MapRenderer } from "../renderer";

export function MapCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<MapRenderer | null>(null);

  const meta = useApp((s) => s.meta);
  const loaded = useApp((s) => s.loaded);
  const error = useApp((s) => s.error);
  const currentDate = useApp((s) => s.currentDate);
  const countries = useApp((s) => s.countries);
  const provinceNames = useApp((s) => s.provinceNames);
  const setSelected = useApp((s) => s.setSelected);
  const buildOwnerColorArray = useApp((s) => s.buildOwnerColorArray);
  const ownerAt = useApp((s) => s.ownerAt);

  const [rendererReady, setRendererReady] = useState(false);
  const [hover, setHover] = useState<{
    x: number;
    y: number;
    provinceId: number;
    owner: string | null;
  } | null>(null);

  // create renderer once data is loaded
  useEffect(() => {
    if (!loaded || !meta || !canvasRef.current) return;
    let cancelled = false;
    createRenderer({
      canvas: canvasRef.current,
      provincesUrl: "/data/provinces_id.png",
      maxProvinces: meta.max_provinces,
    })
      .then((r) => {
        if (cancelled) {
          r.destroy();
          return;
        }
        rendererRef.current = r;
        r.setOwnerColors(buildOwnerColorArray(currentDate));
        setRendererReady(true);
      })
      .catch((e) => {
        console.error("renderer init failed", e);
      });
    return () => {
      cancelled = true;
      rendererRef.current?.destroy();
      rendererRef.current = null;
      setRendererReady(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, meta]);

  // push new owner colors whenever the date changes
  useEffect(() => {
    if (!rendererRef.current) return;
    rendererRef.current.setOwnerColors(buildOwnerColorArray(currentDate));
    // also refresh hover tag if present
    if (hover) {
      setHover({
        ...hover,
        owner: ownerAt(hover.provinceId, currentDate),
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentDate, loaded]);

  // hover / click
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onMove = (e: MouseEvent) => {
      const r = rendererRef.current;
      if (!r) return;
      const pid = r.provinceIdAtClient(e.clientX, e.clientY);
      if (pid === 0) {
        setHover(null);
        return;
      }
      setHover({
        x: e.clientX,
        y: e.clientY,
        provinceId: pid,
        owner: ownerAt(pid, currentDate),
      });
    };
    const onLeave = () => setHover(null);
    const onClick = (e: MouseEvent) => {
      const r = rendererRef.current;
      if (!r) return;
      const pid = r.provinceIdAtClient(e.clientX, e.clientY);
      if (pid === 0) {
        setSelected(null);
        return;
      }
      setSelected({
        id: pid,
        owner: ownerAt(pid, currentDate),
      });
    };
    canvas.addEventListener("mousemove", onMove);
    canvas.addEventListener("mouseleave", onLeave);
    canvas.addEventListener("click", onClick);
    return () => {
      canvas.removeEventListener("mousemove", onMove);
      canvas.removeEventListener("mouseleave", onLeave);
      canvas.removeEventListener("click", onClick);
    };
  }, [currentDate, ownerAt, setSelected]);

  if (error) {
    return (
      <div className="eu4-panel" style={{ margin: 24 }}>
        <h2>Failed to load data</h2>
        <div>{error}</div>
        <div style={{ marginTop: 8, fontSize: 12 }}>
          Fix: <code>docker compose exec dev bash -lc "cd /workspace/etl &amp;&amp; python build.py"</code>
        </div>
      </div>
    );
  }

  return (
    <div style={{ position: "relative", width: "100%", height: "100%" }}>
      <canvas
        ref={canvasRef}
        style={{
          width: "100%",
          height: "100%",
          display: "block",
          cursor: "grab",
        }}
      />
      {!loaded && (
        <div style={{
          position: "absolute", inset: 0, display: "flex",
          alignItems: "center", justifyContent: "center",
          color: "var(--parchment)", fontFamily: "var(--font-display)",
          letterSpacing: "0.2em",
        }}>
          Loading map…
        </div>
      )}
      {hover && (
        <HoverTip
          x={hover.x}
          y={hover.y}
          provinceId={hover.provinceId}
          provinceName={provinceNames[String(hover.provinceId)] ?? null}
          ownerTag={hover.owner}
          ownerName={hover.owner ? countries[hover.owner]?.name ?? hover.owner : null}
        />
      )}
      {rendererReady && <CountryLabels rendererRef={rendererRef} />}
    </div>
  );
}

function CountryLabels({ rendererRef }: { rendererRef: React.RefObject<MapRenderer | null> }) {
  const currentDate = useApp((s) => s.currentDate);
  const loaded = useApp((s) => s.loaded);
  const meta = useApp((s) => s.meta);
  const countries = useApp((s) => s.countries);
  const timeline = useApp((s) => s.timeline);
  const centroids = useApp((s) => s.centroids);
  const capitalTimeline = useApp((s) => s.capitalTimeline);
  const adjacency = useApp((s) => s.adjacency);
  const [version, setVersion] = useState(0);

  // Re-render whenever the renderer view changes (pan/zoom).
  useEffect(() => {
    const r = rendererRef.current;
    if (!r) return;
    // Kick one render after mount so the container ref is populated.
    setVersion((v) => (v + 1) % 1_000_000);
    return r.onViewChange(() => setVersion((v) => (v + 1) % 1_000_000));
  }, [rendererRef, loaded]);

  const labels = useMemo(() => {
    if (!loaded || !meta) return [];
    const labelState: LabelState = { meta, countries, timeline, centroids, capitalTimeline, adjacency };
    return computeCountryLabels(labelState, currentDate);
  }, [loaded, meta, countries, timeline, centroids, capitalTimeline, adjacency, currentDate]);

  const visible = useMemo(() => {
    const r = rendererRef.current;
    if (!r) return { items: [], zoom: 1 };
    const zoom = r.getZoom();
    // Keep only labels whose font size would reach the 9px threshold.
    const minAxisLen = 9 / (zoom * 180);
    const items = labels
      .filter((l) => l.axisLen >= minAxisLen)
      .map((l) => {
        const c = r.texToClient(l.u, l.v);
        return { ...l, x: c.x, y: c.y };
      });
    return { items, zoom };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [labels, version]);

  const containerRef = useRef<HTMLDivElement>(null);
  const rect = containerRef.current?.getBoundingClientRect();
  const ox = rect?.left ?? 0;
  const oy = rect?.top ?? 0;

  return (
    <div
      ref={containerRef}
      style={{
        position: "absolute",
        inset: 0,
        pointerEvents: "none",
        overflow: "hidden",
      }}
    >
      {visible.items.map((l) => {
        const { zoom } = visible;
        // Font size proportional to the component's principal axis length in screen space.
        const fontSize = Math.min(28, l.axisLen * zoom * 180);
        if (fontSize < 9) return null;
        const RAD_TO_DEG = 180 / Math.PI;
        const deg = l.angle * RAD_TO_DEG;
        return (
          <div
            key={l.key}
            style={{
              position: "absolute",
              left: l.x - ox,
              top: l.y - oy,
              transform: `translate(-50%, -50%) rotate(${deg.toFixed(1)}deg)`,
              fontFamily: "var(--font-display)",
              fontSize,
              color: "rgba(30,20,10,0.95)",
              letterSpacing: "0.12em",
              textShadow:
                "0 0 3px rgba(255,240,210,0.9), 0 0 6px rgba(255,240,210,0.7)",
              whiteSpace: "nowrap",
              userSelect: "none",
            }}
          >
            {l.name.toUpperCase()}
          </div>
        );
      })}
    </div>
  );
}

function HoverTip(props: {
  x: number;
  y: number;
  provinceId: number;
  provinceName: string | null;
  ownerTag: string | null;
  ownerName: string | null;
}) {
  return (
    <div
      className="eu4-panel"
      style={{
        position: "fixed",
        left: props.x + 12,
        top: props.y + 12,
        padding: "6px 10px",
        fontFamily: "var(--font-ui)",
        fontSize: 12,
        pointerEvents: "none",
        zIndex: 10,
      }}
    >
      <div style={{ fontFamily: "var(--font-display)", fontSize: 13 }}>
        {props.provinceName ?? `Province #${props.provinceId}`}
      </div>
      <div style={{ fontSize: 10, color: "var(--ink-soft)" }}>
        #{props.provinceId}
      </div>
      <div>
        {props.ownerName ? `${props.ownerName} (${props.ownerTag})` : "—"}
      </div>
    </div>
  );
}
