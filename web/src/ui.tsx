import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import type { Graph } from "./audio";

export function Icon({ name }: { name: "play" | "pause" | "upload" | "search" | "split" | "check" | "x" | "arrow" | "stop" | "restart" | "lock" | "loop" }) {
  const p: Record<string, JSX.Element> = {
    play: <path d="M8 5v14l11-7z" fill="currentColor" />,
    pause: <path d="M7 5h4v14H7zM13 5h4v14h-4z" fill="currentColor" />,
    upload: <path d="M12 4l-5 5h3v6h4V9h3zM5 18h14v2H5z" fill="currentColor" />,
    search: <path d="M10 4a6 6 0 104.47 10.03l4.75 4.75 1.41-1.41-4.75-4.75A6 6 0 0010 4zm0 2a4 4 0 110 8 4 4 0 010-8z" fill="currentColor" />,
    split: <path d="M4 6h7v2H4zm0 5h10v2H4zm0 5h6v2H4zm11-10l5 6-5 6z" fill="currentColor" />,
    check: <path d="M9 16.2l-3.5-3.5L4 14.2l5 5 11-11-1.5-1.5z" fill="currentColor" />,
    x: <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" />,
    loop: <path d="M7 7h10v3l4-4-4-4v3H5v6h2zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2z" fill="currentColor" />,
    stop: <path d="M6 6h12v12H6z" fill="currentColor" />,
    restart: <path d="M6 6h2v12H6zm3.5 6l8.5 6V6z" fill="currentColor" />,
    lock: <path d="M12 2a5 5 0 00-5 5v3H6a1 1 0 00-1 1v10a1 1 0 001 1h12a1 1 0 001-1V11a1 1 0 00-1-1h-1V7a5 5 0 00-5-5zm-3 8V7a3 3 0 016 0v3z" fill="currentColor" />,
    arrow: <path d="M4 11h12l-4-4 1.4-1.4L20 12l-6.6 6.4L12 17l4-4H4z" fill="currentColor" />,
  };
  return (
    <svg viewBox="0 0 24 24" width="1em" height="1em" aria-hidden>
      {p[name]}
    </svg>
  );
}

export function Cover({ url, size }: { url: string | null | undefined; size: number }) {
  // One retry: a cover minted moments ago can lose a race with its upload.
  const [tries, setTries] = useState(0);
  // Ask for a thumbnail at ~2× the display size instead of the full original.
  const w = size <= 64 ? 160 : size <= 120 ? 240 : 600;
  const src = url ? `${url}?w=${w}${tries > 0 ? `&r=${tries}` : ""}` : url;
  return (
    <div className="cover" style={{ width: size, height: size }}>
      {src && tries < 3 ? (
        <img src={src} alt="" onError={() => setTimeout(() => setTries((t) => t + 1), 1200)} loading="lazy" />
      ) : (
        <div className="cover-ph" />
      )}
    </div>
  );
}

export function Slider(props: { label: string; min: number; max: number; step: number; value: number; onChange: (v: number) => void; format?: (v: number) => string }) {
  return (
    <label className="slider">
      <span>
        {props.label}
        <b>{props.format ? props.format(props.value) : props.value}</b>
      </span>
      <input type="range" min={props.min} max={props.max} step={props.step} value={props.value} onChange={(e) => props.onChange(+e.target.value)} />
    </label>
  );
}

/** Drag up/down (or scroll) to turn; double-click to reset to center. */
export function Knob(props: { label: string; min: number; max: number; value: number; onChange: (v: number) => void; format: (v: number) => string; center?: number }) {
  const { min, max, value, onChange } = props;
  const f = (value - min) / (max - min);
  const angle = -135 + f * 270;
  const drag = useRef<{ y: number; v: number } | null>(null);
  const clamp = (v: number) => Math.max(min, Math.min(max, v));

  return (
    <div
      className="knob"
      onPointerDown={(e) => {
        (e.target as Element).setPointerCapture(e.pointerId);
        drag.current = { y: e.clientY, v: value };
      }}
      onPointerMove={(e) => {
        if (!drag.current) return;
        const dv = ((drag.current.y - e.clientY) / 150) * (max - min);
        onChange(clamp(drag.current.v + dv));
      }}
      onPointerUp={() => (drag.current = null)}
      onDoubleClick={() => onChange(props.center ?? min + (max - min) / 2)}
      onWheel={(e) => onChange(clamp(value - Math.sign(e.deltaY) * (max - min) * 0.02))}
    >
      <svg viewBox="0 0 48 48">
        <circle cx="24" cy="24" r="19" className="track" />
        <circle
          cx="24"
          cy="24"
          r="19"
          className="arc"
          strokeDasharray={`${f * 0.75 * 119.4} 200`}
          transform="rotate(135 24 24)"
        />
        <line x1="24" y1="24" x2="24" y2="10" transform={`rotate(${angle} 24 24)`} />
      </svg>
      <b>{props.format(value)}</b>
      <span>{props.label}</span>
    </div>
  );
}

/** Max |sample| per pixel column over [t0, t1] seconds, read straight from the audio. */
function windowPeaks(buf: AudioBuffer, t0: number, t1: number, n: number): Float32Array {
  const out = new Float32Array(n);
  const sr = buf.sampleRate;
  const ch = [buf.getChannelData(0), buf.getChannelData(buf.numberOfChannels > 1 ? 1 : 0)];
  const s0 = Math.floor(t0 * sr);
  const per = Math.max(1, ((t1 - t0) * sr) / n);
  // Zoomed out, a column spans tens of thousands of samples: sampling is plenty.
  const stride = Math.max(1, Math.floor(per / 1024));
  for (let i = 0; i < n; i++) {
    const a = s0 + Math.floor(i * per);
    const b = Math.min(ch[0].length, s0 + Math.floor((i + 1) * per));
    let m = 0;
    for (let j = a; j < b; j += stride) {
      const v = Math.max(Math.abs(ch[0][j]), Math.abs(ch[1][j]));
      if (v > m) m = v;
    }
    out[i] = m;
  }
  return out;
}

const MAX_ZOOM = 64;

/**
 * Click sets the deck's start point; drag selects a loop region.
 * Zoom: −/+/fit, pinch or ctrl/⌘+scroll at the cursor; pan: horizontal or shift+scroll, or the minimap.
 */
export function Waveform(props: {
  buffer: AudioBuffer;
  playhead: number;
  playing: boolean;
  trim: number;
  side: "A" | "B";
  loop: [number, number] | null;
  loopOn: boolean;
  onTrim: (s: number) => void;
  onLoop: (l: [number, number]) => void;
}) {
  const dur = props.buffer.duration || 1;
  const ref = useRef<HTMLCanvasElement>(null);
  // new: drawing a fresh selection · move: sliding the loop · start/end: resizing an edge
  const drag = useRef<{ x0: number; moved: boolean; mode: "new" | "move" | "start" | "end"; orig: [number, number] | null } | null>(null);
  const [preview, setPreview] = useState<[number, number] | null>(null);
  const [draft, setDraft] = useState<[number, number] | null>(null);
  const [hover, setHover] = useState<"move" | "edge" | null>(null);
  const [view, setView] = useState<[number, number]>([0, dur]);
  const [width, setWidth] = useState(0);
  const viewRef = useRef(view);
  viewRef.current = view;

  // A new track resets the view.
  useEffect(() => setView([0, props.buffer.duration || 1]), [props.buffer]);

  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const ro = new ResizeObserver(() => setWidth(c.clientWidth));
    ro.observe(c);
    return () => ro.disconnect();
  }, []);

  const clampView = useCallback(
    (a: number, b: number): [number, number] => {
      const len = Math.min(dur, Math.max(dur / MAX_ZOOM, b - a));
      const start = Math.max(0, Math.min(dur - len, a));
      return [start, start + len];
    },
    [dur],
  );

  const zoomAt = useCallback(
    (factor: number, at?: number) => {
      const [a, b] = viewRef.current;
      const center = at ?? (a + b) / 2;
      const len = (b - a) / factor;
      const f = (center - a) / (b - a);
      setView(clampView(center - f * len, center - f * len + len));
    },
    [clampView],
  );

  // Pinch / ctrl+wheel zooms; horizontal or shift+wheel pans. Plain vertical
  // wheel is left alone so the page still scrolls.
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const onWheel = (e: WheelEvent) => {
      const [a, b] = viewRef.current;
      const r = c.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const at = a + ((e.clientX - r.left) / r.width) * (b - a);
        zoomAt(Math.exp(-e.deltaY * 0.01), at);
      } else if (Math.abs(e.deltaX) > Math.abs(e.deltaY) || e.shiftKey) {
        e.preventDefault();
        const d = (e.shiftKey ? e.deltaY : e.deltaX) / r.width;
        setView(clampView(a + d * (b - a), b + d * (b - a)));
      }
    };
    c.addEventListener("wheel", onWheel, { passive: false });
    return () => c.removeEventListener("wheel", onWheel);
  }, [zoomAt, clampView]);

  // While playing, page the view along with the playhead.
  useEffect(() => {
    if (!props.playing) return;
    const [a, b] = view;
    if (b - a >= dur - 0.01) return;
    if (props.playhead < a || props.playhead > b) {
      const len = b - a;
      setView(clampView(props.playhead - len * 0.1, props.playhead + len * 0.9));
    }
  }, [props.playhead, props.playing, view, dur, clampView]);

  const peaks = useMemo(
    () => (width ? windowPeaks(props.buffer, view[0], view[1], Math.floor(width)) : null),
    [props.buffer, view, width],
  );
  const overview = useMemo(() => windowPeaks(props.buffer, 0, dur, 300), [props.buffer, dur]);
  const fullMax = useMemo(() => Math.max(...overview, 0.01), [overview]);

  useEffect(() => {
    const c = ref.current;
    if (!c || !peaks) return;
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth;
    const h = c.clientHeight;
    c.width = w * dpr;
    c.height = h * dpr;
    const g = c.getContext("2d")!;
    g.scale(dpr, dpr);
    g.clearRect(0, 0, w, h);
    const [v0, v1] = view;
    const X = (t: number) => ((t - v0) / (v1 - v0)) * w;
    const T = (x: number) => v0 + (x / w) * (v1 - v0);
    const color = props.side === "A" ? "#b26bff" : "#1ed1a2";
    const loop = draft ?? props.loop;
    const region = preview ?? loop;
    const looping = !preview && loop && (props.loopOn || !!draft);

    if (region) {
      g.fillStyle = looping ? (props.side === "A" ? "rgba(178,107,255,0.22)" : "rgba(30,209,162,0.22)") : "rgba(255,255,255,0.08)";
      g.fillRect(X(region[0]), 0, X(region[1]) - X(region[0]), h);
    }
    // Normalize to the whole track, so zooming in doesn't inflate quiet parts.
    for (let i = 0; i < peaks.length; i++) {
      const t = T(i + 0.5);
      const v = Math.min(1, peaks[i] / fullMax) * (h / 2 - 2);
      const inLoop = looping && t >= loop![0] && t <= loop![1];
      g.fillStyle = looping
        ? inLoop
          ? t < props.playhead ? color : "rgba(255,255,255,0.75)"
          : "rgba(255,255,255,0.14)"
        : t < props.trim ? "rgba(255,255,255,0.12)" : t < props.playhead ? color : "rgba(255,255,255,0.38)";
      g.fillRect(i, h / 2 - v, 1, Math.max(1, v * 2));
    }
    if (region) {
      g.fillStyle = looping ? color : "rgba(255,255,255,0.6)";
      for (const t of region) g.fillRect(X(t) - 1, 0, 2, h);
    }
    g.fillStyle = "#fff";
    g.fillRect(X(props.playhead) - 1, 0, 2, h);
    if (!looping) {
      const tx = X(props.trim);
      g.fillStyle = color;
      g.fillRect(tx - 1, 0, 2, h);
      g.beginPath();
      g.moveTo(tx - 6, 0);
      g.lineTo(tx + 6, 0);
      g.lineTo(tx, 8);
      g.fill();
    }
    // Time labels when zoomed in.
    if (v1 - v0 < dur - 0.01) {
      g.font = "10px 'JetBrains Mono', monospace";
      g.fillStyle = "rgba(255,255,255,0.55)";
      g.fillText(fmtT(v0), 4, h - 4);
      const end = fmtT(v1);
      g.fillText(end, w - g.measureText(end).width - 4, h - 4);
    }
  }, [peaks, fullMax, view, props.playhead, props.trim, props.side, props.loop, props.loopOn, preview, draft, dur]);

  /** What a pointer at clientX would grab: an edge of the loop, its body, or nothing. */
  const hitTest = (clientX: number, el: HTMLElement): "start" | "end" | "move" | null => {
    if (!props.loop) return null;
    const r = el.getBoundingClientRect();
    const [a, b] = viewRef.current;
    const x = (t: number) => r.left + ((t - a) / (b - a)) * r.width;
    const [ls, le] = props.loop;
    if (Math.abs(clientX - x(ls)) <= 6) return "start";
    if (Math.abs(clientX - x(le)) <= 6) return "end";
    if (clientX > x(ls) && clientX < x(le)) return "move";
    return null;
  };

  const at = (e: React.PointerEvent<HTMLElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const [a, b] = viewRef.current;
    return a + Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * (b - a);
  };

  const zoom = dur / (view[1] - view[0]);
  const zoomed = zoom > 1.01;

  return (
    <div className="wavewrap">
      <canvas
        ref={ref}
        className="wave"
        title="Click to set the start · drag to loop · drag a loop to move it, or its edges to resize · pinch or ⌘/ctrl+scroll to zoom"
        style={{ cursor: hover === "edge" ? "ew-resize" : hover === "move" ? (drag.current ? "grabbing" : "grab") : "crosshair" }}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          const hit = hitTest(e.clientX, e.currentTarget);
          drag.current = { x0: e.clientX, moved: false, mode: hit ?? "new", orig: props.loop };
          setPreview(null);
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d) {
            const hit = hitTest(e.clientX, e.currentTarget);
            setHover(hit === "start" || hit === "end" ? "edge" : hit === "move" ? "move" : null);
            return;
          }
          if (Math.abs(e.clientX - d.x0) > 4) d.moved = true;
          if (!d.moved) return;
          const r = e.currentTarget.getBoundingClientRect();
          const [a, b] = viewRef.current;
          const t0 = a + ((d.x0 - r.left) / r.width) * (b - a);
          const t1 = at(e);
          if (d.mode === "new") {
            setPreview([Math.min(t0, t1), Math.max(t0, t1)]);
          } else if (d.mode === "move" && d.orig) {
            // Slide, keeping the length, without running off either end.
            const len = d.orig[1] - d.orig[0];
            const start = Math.max(0, Math.min(dur - len, d.orig[0] + (t1 - t0)));
            setDraft([start, start + len]);
          } else if (d.orig) {
            const min = 0.05;
            setDraft(
              d.mode === "start"
                ? [Math.max(0, Math.min(t1, d.orig[1] - min)), d.orig[1]]
                : [d.orig[0], Math.min(dur, Math.max(t1, d.orig[0] + min))],
            );
          }
        }}
        onPointerUp={(e) => {
          const d = drag.current;
          drag.current = null;
          const round = (l: [number, number]): [number, number] => [Math.round(l[0] * 1000) / 1000, Math.round(l[1] * 1000) / 1000];
          if (d?.moved && d.mode === "new" && preview) {
            if (preview[1] - preview[0] >= 0.05) props.onLoop(round(preview));
          } else if (d?.moved && draft) {
            props.onLoop(round(draft));
          } else if (!d?.moved) {
            props.onTrim(at(e));
          }
          setPreview(null);
          setDraft(null);
        }}
        onPointerLeave={() => !drag.current && setHover(null)}
      />
      <div className="zoombar">
        <button onClick={() => zoomAt(1 / 2)} disabled={!zoomed} aria-label="Zoom out">−</button>
        <span>{zoom < 10 ? zoom.toFixed(1) : Math.round(zoom)}×</span>
        <button onClick={() => zoomAt(2, props.loop && props.loopOn ? (props.loop[0] + props.loop[1]) / 2 : props.playhead)} disabled={zoom >= MAX_ZOOM - 0.01} aria-label="Zoom in">+</button>
        {props.loop && (
          <button className="fit" onClick={() => {
            const pad = (props.loop![1] - props.loop![0]) * 0.15;
            setView(clampView(props.loop![0] - pad, props.loop![1] + pad));
          }}>loop</button>
        )}
        <button className="fit" onClick={() => setView([0, dur])} disabled={!zoomed}>fit</button>
      </div>
      {zoomed && (
        <div
          className="minimap"
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            const r = e.currentTarget.getBoundingClientRect();
            const len = view[1] - view[0];
            const t = ((e.clientX - r.left) / r.width) * dur;
            setView(clampView(t - len / 2, t + len / 2));
          }}
          onPointerMove={(e) => {
            if (!e.buttons) return;
            const r = e.currentTarget.getBoundingClientRect();
            const [a, b] = viewRef.current;
            const t = ((e.clientX - r.left) / r.width) * dur;
            setView(clampView(t - (b - a) / 2, t + (b - a) / 2));
          }}
        >
          <svg viewBox={`0 0 ${overview.length} 20`} preserveAspectRatio="none">
            {Array.from(overview, (v, i) => {
              const hh = Math.max(0.5, (v / fullMax) * 9);
              return <rect key={i} x={i} y={10 - hh} width={0.8} height={hh * 2} />;
            })}
          </svg>
          <div className="win" style={{ left: `${(view[0] / dur) * 100}%`, width: `${((view[1] - view[0]) / dur) * 100}%` }} />
          <div className="ph" style={{ left: `${(props.playhead / dur) * 100}%` }} />
        </div>
      )}
    </div>
  );
}

function fmtT(s: number) {
  const m = Math.floor(s / 60);
  const ss = s - m * 60;
  return `${m}:${ss.toFixed(2).padStart(5, "0")}`;
}

export function Visualizer({ graph, playing }: { graph: MutableRefObject<Graph | null>; playing: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = c.clientWidth * dpr;
    c.height = c.clientHeight * dpr;
    const g = c.getContext("2d")!;
    const bins = new Uint8Array(1024);
    let raf = 0;
    let t = 0;
    const draw = () => {
      const w = c.width;
      const h = c.height;
      g.clearRect(0, 0, w, h);
      const an = graph.current?.analyser;
      if (an && playing) an.getByteFrequencyData(bins);
      else bins.fill(0);
      const bars = 48;
      const bw = w / bars;
      t += 0.02;
      for (let i = 0; i < bars; i++) {
        const idx = Math.floor(Math.pow(i / bars, 1.8) * 400) + 2;
        const idle = playing ? 0 : (Math.sin(t + i * 0.35) * 0.5 + 0.5) * 0.08;
        const v = Math.max(bins[idx] / 255, idle);
        const bh = Math.max(2 * dpr, v * h * 0.95);
        const grad = g.createLinearGradient(0, h, 0, h - bh);
        grad.addColorStop(0, "#b26bff");
        grad.addColorStop(1, "#1ed1a2");
        g.fillStyle = grad;
        const x = i * bw + bw * 0.18;
        g.beginPath();
        g.roundRect(x, h - bh, bw * 0.64, bh, bw * 0.3);
        g.fill();
      }
      raf = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, [graph, playing]);
  return <canvas ref={ref} className="viz" />;
}
