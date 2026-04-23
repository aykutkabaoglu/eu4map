import { useEffect, useRef, useState } from "react";
import { useApp } from "./store";
import { MapCanvas } from "./components/MapCanvas";
import { DateSlider } from "./components/DateSlider";
import { CountryPanel } from "./components/CountryPanel";

const PANEL_MIN = 260;
const PANEL_MAX = 720;
const PANEL_KEY = "eu4.panelWidth";

export default function App() {
  const loadAll = useApp((s) => s.loadAll);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  const [panelWidth, setPanelWidth] = useState(() => {
    const raw = typeof window !== "undefined" ? localStorage.getItem(PANEL_KEY) : null;
    const n = raw ? +raw : 340;
    return Math.min(PANEL_MAX, Math.max(PANEL_MIN, Number.isFinite(n) ? n : 340));
  });
  useEffect(() => {
    try { localStorage.setItem(PANEL_KEY, String(panelWidth)); } catch {}
  }, [panelWidth]);

  // Scale fonts/spacing inside the panel proportionally to width.
  const panelScale = Math.min(1.7, Math.max(0.9, panelWidth / 340));

  const draggingRef = useRef(false);
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!draggingRef.current) return;
      const w = window.innerWidth - e.clientX - 6;
      setPanelWidth(Math.min(PANEL_MAX, Math.max(PANEL_MIN, w)));
    };
    const onUp = () => {
      draggingRef.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);

  return (
    <div
      style={{
        display: "grid",
        gridTemplateRows: "48px 1fr auto",
        gridTemplateColumns: `1fr ${panelWidth}px`,
        height: "100vh",
        width: "100vw",
        background: "var(--frame-darker)",
        gap: 6,
        padding: 6,
        ["--panel-scale" as string]: panelScale,
      } as React.CSSProperties}
    >
      <header
        className="eu4-panel"
        style={{
          gridColumn: "1 / 3",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "6px 18px",
        }}
      >
        <h1
          style={{
            margin: 0,
            fontFamily: "var(--font-display)",
            fontSize: 20,
            letterSpacing: "0.2em",
            borderBottom: "none",
            paddingBottom: 0,
          }}
        >
          EUROPA UNIVERSALIS — Web Map
        </h1>
        <span style={{ fontFamily: "var(--font-body)", fontStyle: "italic", fontSize: 13 }}>
          1444 – 1821
        </span>
      </header>

      <div
        style={{
          gridColumn: "1",
          gridRow: "2",
          border: "3px solid var(--frame-dark)",
          boxShadow: "inset 0 0 0 1px var(--gold)",
          background: "#1a1208",
          overflow: "hidden",
        }}
      >
        <MapCanvas />
      </div>

      <div style={{ gridColumn: "2", gridRow: "2", position: "relative" }}>
        <div
          onMouseDown={() => {
            draggingRef.current = true;
            document.body.style.cursor = "ew-resize";
            document.body.style.userSelect = "none";
          }}
          title="Resize panel"
          style={{
            position: "absolute",
            left: -8,
            top: 0,
            bottom: 0,
            width: 12,
            cursor: "ew-resize",
            zIndex: 20,
            background:
              "linear-gradient(to right, transparent 40%, var(--gold) 50%, transparent 60%)",
            opacity: 0.15,
            transition: "opacity 0.2s",
          }}
          onMouseEnter={(e) => (e.currentTarget.style.opacity = "0.6")}
          onMouseLeave={(e) => (e.currentTarget.style.opacity = "0.15")}
        />
        <CountryPanel />
      </div>

      <div style={{ gridColumn: "1 / 3", gridRow: "3" }}>
        <DateSlider />
      </div>
    </div>
  );
}
