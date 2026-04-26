import * as Slider from "@radix-ui/react-slider";
import { useEffect, useRef, useState } from "react";
import { addDays, daysBetween, useApp } from "../store";

// Days/second presets: 1 day/s, 7 days/s, 30 days/s, 90 days/s, 365 days/s
const SPEEDS = [1, 7, 30, 90, 365] as const;
const SPEED_LABELS = ["Day", "Week", "Month", "3 Mo", "Year"] as const;
const DEFAULT_SPEED_IDX = 2; // 30 d/s (month)

export function DateSlider() {
  const meta = useApp((s) => s.meta);
  const currentDate = useApp((s) => s.currentDate);
  const setDate = useApp((s) => s.setDate);
  const [playing, setPlaying] = useState(false);
  const [speedIdx, setSpeedIdx] = useState(DEFAULT_SPEED_IDX);
  const rafRef = useRef<number | null>(null);
  const speedRef = useRef(SPEEDS[DEFAULT_SPEED_IDX]);
  // keep a ref to currentDate so the RAF loop doesn't need it as a dependency
  const currentDateRef = useRef(currentDate);
  useEffect(() => { currentDateRef.current = currentDate; }, [currentDate]);

  const totalDays = meta ? daysBetween(meta.start, meta.end) : 0;
  const currentDays = meta ? daysBetween(meta.start, currentDate) : 0;

  const slower = () => {
    const i = Math.max(0, speedIdx - 1);
    setSpeedIdx(i);
    speedRef.current = SPEEDS[i];
  };
  const faster = () => {
    const i = Math.min(SPEEDS.length - 1, speedIdx + 1);
    setSpeedIdx(i);
    speedRef.current = SPEEDS[i];
  };

  useEffect(() => {
    if (!meta || !playing) return;
    let lastTs = 0;
    let accum = 0; // fractional days carried over between frames
    const step = (ts: number) => {
      if (!lastTs) lastTs = ts;
      const dt = (ts - lastTs) / 1000;
      lastTs = ts;
      accum += dt * speedRef.current;
      const delta = Math.floor(accum);
      if (delta >= 1) {
        accum -= delta;
        const d = addDays(currentDateRef.current, delta);
        if (daysBetween(meta.start, d) >= totalDays) {
          setDate(meta.end);
          setPlaying(false);
          return;
        }
        setDate(d);
      }
      rafRef.current = requestAnimationFrame(step);
    };
    rafRef.current = requestAnimationFrame(step);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, [playing, meta, setDate, totalDays]);

  // keyboard: arrow keys = +/- day, shift = month, alt = year
  useEffect(() => {
    if (!meta) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName?.toLowerCase() === "input") return;
      let step = 0;
      if (e.key === "ArrowRight") step = 1;
      else if (e.key === "ArrowLeft") step = -1;
      else return;
      if (e.shiftKey) step *= 30;
      if (e.altKey) step *= 365;
      e.preventDefault();
      const d = addDays(currentDate, step);
      const within = Math.max(0, Math.min(totalDays, daysBetween(meta.start, d)));
      setDate(addDays(meta.start, within));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [currentDate, meta, totalDays, setDate]);

  if (!meta) return null;

  return (
    <div
      className="eu4-panel"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "5px 18px",
      }}
    >
      <button onClick={() => setPlaying(!playing)} style={{ minWidth: 72 }}>
        {playing ? "❚❚ Pause" : "▶ Play"}
      </button>
      {/* Speed control */}
      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
        <button
          onClick={slower}
          disabled={speedIdx === 0}
          style={{ minWidth: 24, padding: "2px 6px", fontSize: 12 }}
          title="Slower"
        >
          ‹
        </button>
        <span
          style={{
            fontFamily: "var(--font-ui)",
            fontSize: 11,
            color: "var(--ink-soft)",
            minWidth: 28,
            textAlign: "center",
          }}
        >
          {SPEED_LABELS[speedIdx]}
        </span>
        <button
          onClick={faster}
          disabled={speedIdx === SPEEDS.length - 1}
          style={{ minWidth: 24, padding: "2px 6px", fontSize: 12 }}
          title="Faster"
        >
          ›
        </button>
      </div>
      <div
        style={{
          fontFamily: "var(--font-display)",
          fontSize: 13,
          letterSpacing: "0.15em",
          color: "var(--ink)",
          minWidth: 110,
          textAlign: "center",
        }}
      >
        {currentDate}
      </div>
      <Slider.Root
        className="SliderRoot"
        value={[currentDays]}
        min={0}
        max={totalDays}
        step={1}
        onValueChange={(v) => setDate(addDays(meta.start, v[0]))}
        style={{
          position: "relative",
          display: "flex",
          alignItems: "center",
          flex: 1,
          height: 22,
          userSelect: "none",
          touchAction: "none",
        }}
      >
        <Slider.Track
          style={{
            backgroundColor: "var(--frame-dark)",
            position: "relative",
            flexGrow: 1,
            height: 6,
            borderRadius: 4,
            boxShadow: "inset 0 2px 3px rgba(0,0,0,0.6)",
          }}
        >
          <Slider.Range
            style={{
              position: "absolute",
              backgroundColor: "var(--gold-light)",
              borderRadius: 4,
              height: "100%",
            }}
          />
        </Slider.Track>
        <Slider.Thumb
          aria-label="Date"
          style={{
            display: "block",
            width: 18,
            height: 18,
            background: "linear-gradient(180deg, var(--gold-light), var(--gold))",
            border: "1px solid var(--frame-dark)",
            borderRadius: 3,
            boxShadow: "0 2px 4px rgba(0,0,0,0.6), inset 0 1px 0 rgba(255,230,180,0.6)",
            cursor: "grab",
          }}
        />
      </Slider.Root>
      <div
        style={{
          fontFamily: "var(--font-ui)",
          fontSize: 10,
          color: "var(--ink-soft)",
          minWidth: 120,
          textAlign: "right",
        }}
      >
        {meta.start} — {meta.end}
      </div>
    </div>
  );
}
