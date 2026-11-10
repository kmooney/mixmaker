import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, fmt, type Mix, type StemStatus, type Track } from "./api";
import {
  STEMS,
  buildGraph,
  crossfadeAt,
  ctx,
  estimateBpm,
  loadBuffer,
  peaks,
  updateLive,
  type DeckParams,
  type StemName,
  type Graph,
  type MixParams,
} from "./audio";
import { Provenance } from "./Provenance";
import { stretch } from "./stretch";
import { PublishModal } from "./PublishModal";
import { Drops } from "./Drops";
import { Knob, Slider, Waveform, Visualizer, Cover, Icon } from "./ui";

export interface DeckState {
  track: Track | null;
  full: AudioBuffer | null;
  stems: Record<string, AudioBuffer> | null;
  useStems: boolean;
  stemStatus: StemStatus | null;
  loading: boolean;
  error: string | null;
  gains: Record<string, number>;
  mutes: Record<string, boolean>;
  volume: number;
  rate: number;
  trim: number;
  delay: number;
  filter: number;
  bpm: number | null;
  peaks: Float32Array | null;
  /** Tempo changes keep the original pitch (time-stretch) instead of chipmunking. */
  keylock: boolean;
  stretched: { key: string; buffers: Record<string, AudioBuffer> } | null;
  stretching: boolean;
  /** Selected region of the source, in seconds; plays on repeat while `loopOn`. */
  loop: [number, number] | null;
  loopOn: boolean;
  /** Mix time the fade-out starts, or null for no fade. */
  fadeAt: number | null;
  /** Seconds the fade-out takes to reach silence. */
  fadeLen: number;
}

const emptyDeck = (): DeckState => ({
  track: null,
  full: null,
  stems: null,
  useStems: false,
  stemStatus: null,
  loading: false,
  error: null,
  gains: { full: 1, vocals: 1, drums: 1, bass: 1, other: 1 },
  mutes: {},
  volume: 0.9,
  rate: 1,
  trim: 0,
  delay: 0,
  filter: 0,
  bpm: null,
  peaks: null,
  keylock: true,
  stretched: null,
  stretching: false,
  loop: null,
  loopOn: false,
  fadeAt: null,
  fadeLen: 8,
});

const activeLoop = (d: DeckState): [number, number] | null => (d.loopOn && d.loop ? d.loop : null);

/** Identifies the stretch a deck needs right now, or null when none is. */
function stretchKey(d: DeckState, length: number): string | null {
  if (!d.full || !d.keylock || Math.abs(d.rate - 1) < 0.001) return null;
  const mode = d.useStems && d.stems ? "stems" : "full";
  const loop = activeLoop(d);
  // A loop only needs its own section stretched, however long the mix is.
  if (loop) return `${d.track?.id}|${d.rate}|loop:${loop[0]}-${loop[1]}|${mode}`;
  return `${d.track?.id}|${d.rate}|${d.trim}|${Math.max(0, length - d.delay)}|${mode}`;
}

function sources(d: DeckState): { name: StemName; buffer: AudioBuffer }[] {
  return d.useStems && d.stems
    ? STEMS.filter((s) => d.stems![s]).map((s) => ({ name: s, buffer: d.stems![s] }))
    : [{ name: "full" as const, buffer: d.full! }];
}

/** Keeps `d.stretched` in step with the deck's tempo, trim and mix length. */
function useStretch(d: DeckState, set: React.Dispatch<React.SetStateAction<DeckState>>, length: number) {
  const key = stretchKey(d, length);
  useEffect(() => {
    if (!key) {
      if (d.stretching) set((s) => ({ ...s, stretching: false }));
      return;
    }
    if (d.stretched?.key === key) return;
    const cancel = { cancelled: false };
    set((s) => ({ ...s, stretching: true }));
    // Debounced: dragging the tempo knob shouldn't stretch every step.
    const timer = setTimeout(async () => {
      const out: Record<string, AudioBuffer> = {};
      const loop = activeLoop(d);
      const from = loop ? loop[0] : d.trim;
      const need = loop ? (loop[1] - loop[0]) / d.rate : Math.max(1, length - d.delay) + 2;
      for (const { name, buffer } of sources(d)) {
        const r = await stretch(buffer, d.rate, from, need, cancel);
        if (!r) return;
        out[name] = r;
      }
      if (!cancel.cancelled) set((s) => ({ ...s, stretched: { key, buffers: out }, stretching: false }));
    }, 300);
    return () => {
      cancel.cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
}

function deckParams(d: DeckState, length: number): DeckParams | null {
  if (!d.full) return null;
  const fadeOut: [number, number] | null = d.fadeAt === null ? null : [d.fadeAt, d.fadeLen];
  const base = { gains: d.gains, mutes: d.mutes, volume: d.volume, delay: d.delay, filter: d.filter, fadeOut };
  const key = stretchKey(d, length);
  if (key && d.stretched?.key === key) {
    // Pre-stretched from `trim` onward: play it straight, at rate 1.
    const buffers = sources(d).map((s) => ({ name: s.name, buffer: d.stretched!.buffers[s.name] }));
    // A stretched loop is exactly the loop section: repeat the whole buffer.
    const loop: [number, number] | null = activeLoop(d) ? [0, buffers[0].buffer.duration] : null;
    return { ...base, buffers, rate: 1, trim: 0, loop };
  }
  // No stretch needed — or not ready yet, in which case the rate change
  // briefly shifts pitch until it is.
  return { ...base, buffers: sources(d), rate: d.rate, trim: d.trim, loop: activeLoop(d) };
}

type Tab = "studio" | "drops";

export default function App() {
  const [tab, setTab] = useState<Tab>("studio");
  const [health, setHealth] = useState<{ demucs: boolean; ok: boolean } | null>(null);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [a, setA] = useState<DeckState>(emptyDeck);
  const [b, setB] = useState<DeckState>(emptyDeck);
  const [crossfade, setCrossfade] = useState(0.5);
  const [auto, setAuto] = useState(true);
  const [length, setLength] = useState(90);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [publishing, setPublishing] = useState(false);
  const [lastMix, setLastMix] = useState<Mix | null>(null);

  useStretch(a, setA, length);
  useStretch(b, setB, length);

  const graph = useRef<Graph | null>(null);
  const clock = useRef({ ctxStart: 0, posStart: 0 });

  useEffect(() => {
    api.health().then(
      (h) => setHealth({ demucs: h.demucs, ok: true }),
      () => setHealth({ demucs: false, ok: false }),
    );
  }, []);

  const refreshTracks = useCallback(() => api.tracks("").then((r) => setTracks(r.tracks)).catch(() => {}), []);
  useEffect(() => {
    void refreshTracks();
    // Tracks become playable as //SCHEMA's encoder catches up.
    const t = setInterval(refreshTracks, 30000);
    return () => clearInterval(t);
  }, [refreshTracks]);

  const mix: MixParams = useMemo(
    () => ({ a: deckParams(a, length), b: deckParams(b, length), crossfade, auto, transition: [0.35, 0.65], length }),
    [a, b, crossfade, auto, length],
  );

  // ------------------------------------------------------------ transport
  const stop = useCallback(() => {
    graph.current?.stop();
    graph.current = null;
  }, []);

  const startAt = useCallback(
    (pos: number) => {
      stop();
      const c = ctx();
      void c.resume();
      const when = c.currentTime + 0.05;
      graph.current = buildGraph(c, mix, when, pos, true);
      clock.current = { ctxStart: when, posStart: pos };
    },
    [mix, stop],
  );

  const toggle = () => {
    if (playing) {
      stop();
      setPlaying(false);
    } else {
      startAt(position >= length ? 0 : position);
      setPlaying(true);
    }
  };

  const seek = (p: number) => {
    setPosition(p);
    if (playing) startAt(p);
  };

  const restart = () => {
    setPosition(0);
    startAt(0);
    setPlaying(true);
  };

  const stopAll = () => {
    stop();
    setPlaying(false);
    setPosition(0);
  };

  // Space bar plays/pauses (unless you're typing in a field).
  const toggleRef = useRef(toggle);
  toggleRef.current = toggle;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (e.code !== "Space" || el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "BUTTON") return;
      e.preventDefault();
      toggleRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Restart when anything structural changes; live-update the rest.
  const structure = [
    a.full, b.full, a.useStems, b.useStems, a.stems, b.stems, a.rate, b.rate, a.trim, b.trim, a.delay, b.delay, length,
    a.stretched, b.stretched, a.keylock, b.keylock, a.loop, b.loop, a.loopOn, b.loopOn,
    // Fades are scheduled automation, so changing one reschedules the graph.
    a.fadeAt, b.fadeAt, a.fadeLen, b.fadeLen,
  ];
  useEffect(() => {
    if (playing) startAt(position);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, structure);

  useEffect(() => {
    if (graph.current) updateLive(graph.current, mix, position);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mix]);

  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const tick = () => {
      const p = clock.current.posStart + (ctx().currentTime - clock.current.ctxStart);
      if (p >= length) {
        stop();
        setPlaying(false);
        setPosition(0);
        return;
      }
      setPosition(Math.max(0, p));
      if (graph.current && auto) updateLive(graph.current, mix, p);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, length, auto, mix, stop]);

  useEffect(() => {
    if (tab !== "studio" && playing) {
      stop();
      setPlaying(false);
    }
  }, [tab, playing, stop]);

  // ------------------------------------------------------------ decks
  const loadTrack = async (set: React.Dispatch<React.SetStateAction<DeckState>>, t: Track) => {
    set({ ...emptyDeck(), track: t, loading: true });
    try {
      const full = await loadBuffer(t.audioUrl);
      // The API's measurement when it has one, so the deck shows the same
      // tempo the picker searched by; the browser's estimate otherwise.
      const bpm = t.bpm ?? estimateBpm(full);
      const trim = Math.min(30, Math.max(0, full.duration * 0.15));
      set((d) => (d.track?.id === t.id ? { ...d, full, bpm, trim: Math.round(trim), peaks: peaks(full, 800), loading: false } : d));
      // Stems may already exist; if not, start splitting right away so
      // they're likely ready by the time you reach for them.
      api.stemStatus(t).then((s) => {
        if (s.status === "done") void loadStems(set, t, s);
        else if (health?.demucs) void splitStems(t, set);
      });
    } catch (e) {
      set((d) => ({ ...d, loading: false, error: (e as Error).message }));
    }
  };

  const loadStems = async (set: React.Dispatch<React.SetStateAction<DeckState>>, t: Track, s: StemStatus) => {
    set((d) => (d.track?.id === t.id ? { ...d, stemStatus: { status: "running", message: "Loading stems…" } } : d));
    const entries = await Promise.all((s.stems ?? []).map(async (st) => [st.name, await loadBuffer(st.url)] as const));
    set((d) => (d.track?.id === t.id ? { ...d, stems: Object.fromEntries(entries), useStems: true, stemStatus: s } : d));
  };

  const splitStems = async (t: Track | null, set: React.Dispatch<React.SetStateAction<DeckState>>) => {
    if (!t) return;
    set((d) => (d.track?.id === t.id ? { ...d, stemStatus: { status: "running" } } : d));
    let s = await api.startStems(t);
    while (s.status === "running") {
      const cur = s;
      set((d) => (d.track?.id === t.id ? { ...d, stemStatus: cur } : d));
      await new Promise((r) => setTimeout(r, 2000));
      s = await api.stemStatus(t);
    }
    if (s.status === "done") await loadStems(set, t, s);
    else set((d) => (d.track?.id === t.id ? { ...d, stemStatus: s } : d));
  };

  const matchTempo = () => {
    if (!a.bpm || !b.bpm) return;
    const target = a.bpm * a.rate;
    let r = target / b.bpm;
    // Prefer half/double time over a huge stretch.
    if (r > 1.4) r /= 2;
    if (r < 0.7) r *= 2;
    setB((d) => ({ ...d, rate: Math.max(0.7, Math.min(1.4, Math.round(r * 1000) / 1000)) }));
  };

  const ready = !!(a.full && b.full) && !a.stretching && !b.stretching;
  const x = crossfadeAt(mix, position);

  return (
    <div className="app">
      <header className="top">
        <div className="brand" onClick={() => setTab("studio")}>
          <div className="logo">
            <span />
            <span />
          </div>
          <b>mix</b>
          <i>·</i>
          <b>maker</b>
        </div>
        <nav>
          <button className={tab === "studio" ? "on" : ""} onClick={() => setTab("studio")}>
            Studio
          </button>
          <button className={tab === "drops" ? "on" : ""} onClick={() => setTab("drops")}>
            Drops
          </button>
        </nav>
        <div className="powered">
          <span className={`dot ${health?.ok ? "ok" : health ? "bad" : ""}`} />
          catalog by <b>//SCHEMA</b>
        </div>
      </header>

      {tab === "studio" ? (
        <main className="studio">
          <section className="hero">
            <h1>
              Two tracks in. <em>One new drop out.</em>
            </h1>
            <p>Pick a track for each deck, pull the stems apart, blend — then publish it back with every credit carried over.</p>
          </section>

          <div className="decks">
            <Deck
              side="A"
              deck={a}
              set={setA}
              tracks={tracks}
              onPick={(t) => loadTrack(setA, t)}
              onSplit={() => splitStems(a.track, setA)}
              demucs={!!health?.demucs}
              position={position}
              playing={playing}
              level={Math.cos((x * Math.PI) / 2)}
              onSeek={seek}
              other={b.track}
              otherBpm={b.bpm ? b.bpm * b.rate : null}
              mixLength={length}
            />

            <section className="mixer">
              <Visualizer graph={graph} playing={playing} />
              <div className="transport">
                <button className="tbtn" disabled={!a.full && !b.full} onClick={restart} aria-label="Restart" title="Play from the top">
                  <Icon name="restart" />
                </button>
                <button className="play" disabled={!a.full && !b.full} onClick={toggle} aria-label={playing ? "Pause" : "Play"} title="Play / pause (space)">
                  <Icon name={playing ? "pause" : "play"} />
                </button>
                <button className="tbtn" disabled={!playing && position === 0} onClick={stopAll} aria-label="Stop" title="Stop and go back to the start">
                  <Icon name="stop" />
                </button>
              </div>
              <div className="clock">
                {fmt(position)} <span>/ {fmt(length)}</span>
              </div>
              <div className="timeline" onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                seek(((e.clientX - r.left) / r.width) * length);
              }}>
                <div className="fill" style={{ width: `${(position / length) * 100}%` }} />
                {auto && <div className="window" style={{ left: "35%", width: "30%" }} title="A → B transition" />}
                {([["A", a], ["B", b]] as const).map(([side, d]) =>
                  d.full && d.fadeAt !== null && d.fadeAt < length ? (
                    <div
                      key={side}
                      className={`fade-mark fade-${side.toLowerCase()}`}
                      style={{
                        left: `${(d.fadeAt / length) * 100}%`,
                        width: `${(Math.min(d.fadeLen, length - d.fadeAt) / length) * 100}%`,
                      }}
                      title={`Deck ${side} fades out ${fmt(d.fadeAt)}–${fmt(d.fadeAt + d.fadeLen)}`}
                    />
                  ) : null,
                )}
              </div>

              <div className="xfader">
                <span className="a">A</span>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={auto ? x : crossfade}
                  disabled={auto}
                  onChange={(e) => setCrossfade(+e.target.value)}
                />
                <span className="b">B</span>
              </div>
              <label className="toggle">
                <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
                <span />
                Auto-transition A → B
              </label>

              <Slider label="Mix length" min={20} max={300} step={5} value={length} onChange={setLength} format={fmt} />

              <div className="bpm">
                <div>
                  <small>A</small>
                  {a.bpm ? Math.round(a.bpm * a.rate) : "—"}
                </div>
                <button disabled={!a.bpm || !b.bpm} onClick={matchTempo} title="Stretch B to A's tempo">
                  Sync B → A
                </button>
                <div>
                  <small>B</small>
                  {b.bpm ? Math.round(b.bpm * b.rate) : "—"}
                </div>
              </div>

              <button className="cta" disabled={!ready} onClick={() => setPublishing(true)}>
                <Icon name="upload" /> Publish mix
              </button>
              {!ready && <p className="hint">Load a track on both decks to publish.</p>}
            </section>

            <Deck
              side="B"
              deck={b}
              set={setB}
              tracks={tracks}
              onPick={(t) => loadTrack(setB, t)}
              onSplit={() => splitStems(b.track, setB)}
              demucs={!!health?.demucs}
              position={position}
              playing={playing}
              level={Math.sin((x * Math.PI) / 2)}
              onSeek={seek}
              other={a.track}
              otherBpm={a.bpm ? a.bpm * a.rate : null}
              mixLength={length}
            />
          </div>

          {(a.track || b.track) && <Provenance a={a.track} b={b.track} />}
        </main>
      ) : (
        <Drops highlight={lastMix?.releasePk} tracks={tracks} onRemix={(t) => {
          setTab("studio");
          void loadTrack(setA, t);
        }} />
      )}

      {publishing && a.track && b.track && (
        <PublishModal
          a={a.track}
          b={b.track}
          mix={mix}
          onClose={() => setPublishing(false)}
          onDone={(m) => {
            setLastMix(m);
            setPublishing(false);
            setTab("drops");
            void refreshTracks();
          }}
          stop={() => {
            stop();
            setPlaying(false);
          }}
        />
      )}
    </div>
  );
}

// ------------------------------------------------------------------ Deck

function Deck(props: {
  side: "A" | "B";
  deck: DeckState;
  set: React.Dispatch<React.SetStateAction<DeckState>>;
  tracks: Track[];
  onPick: (t: Track) => void;
  onSplit: () => void;
  demucs: boolean;
  position: number;
  playing: boolean;
  level: number;
  onSeek: (p: number) => void;
  other: Track | null;
  otherBpm: number | null;
  mixLength: number;
}) {
  const { side, deck: d, set } = props;
  const [picking, setPicking] = useState(false);
  const patch = (p: Partial<DeckState>) => set((s) => ({ ...s, ...p }));
  const cls = side === "A" ? "deck deck-a" : "deck deck-b";

  if (!d.track || picking) {
    return (
      <section className={cls}>
        <div className="deck-label">
          Deck {side} {d.track && <button className="link" onClick={() => setPicking(false)}>cancel</button>}
        </div>
        <Picker
          tracks={props.tracks}
          exclude={props.other?.id}
          otherBpm={props.otherBpm}
          otherSide={side === "A" ? "B" : "A"}
          onPick={(t) => {
            setPicking(false);
            props.onPick(t);
          }}
        />
      </section>
    );
  }

  const t = d.track;
  // Where the shared playhead sits inside this deck's source.
  const into = Math.max(0, props.position - d.delay) * d.rate;
  const loop = activeLoop(d);
  const local = loop ? loop[0] + (into % Math.max(0.01, loop[1] - loop[0])) : d.trim + into;
  const stemsOn = d.useStems && d.stems;
  const channels = stemsOn ? [...STEMS] : ["full"];

  return (
    <section className={cls} style={{ ["--level" as string]: props.level.toFixed(3) }}>
      <div className="deck-label">
        Deck {side}
        <button className="link" onClick={() => setPicking(true)}>change</button>
      </div>
      <div className="deck-head">
        <Cover url={t.coverUrl} size={96} />
        <div className="meta">
          <h2 title={t.title ?? ""}>{t.title}</h2>
          <p>{t.artists.join(", ") || "Unknown artist"}</p>
          <small>
            {t.labels[0]?.name ?? "—"} {t.isrc && <>· {t.isrc}</>}
          </small>
        </div>
        <div className="meter"><div /></div>
      </div>

      {d.loading && <div className="loading">Pulling audio from //SCHEMA…</div>}
      {d.error && <div className="err">Couldn't load audio: {d.error}</div>}

      {d.full && (
        <Waveform
          buffer={d.full!}
          playhead={local}
          playing={props.playing}
          trim={d.trim}
          side={side}
          loop={d.loop}
          loopOn={d.loopOn}
          onTrim={(s) => patch({ trim: Math.round(s * 100) / 100 })}
          onLoop={(l) => patch({ loop: l, loopOn: true })}
        />
      )}
      {d.peaks && (
        <div className="loopbar">
          {d.loop ? (
            <>
              <button className={`chip ${d.loopOn ? "loop-on" : ""}`} onClick={() => patch({ loopOn: !d.loopOn })}>
                <Icon name="loop" /> {d.loopOn ? "looping" : "loop off"} {fmt(d.loop[0])}–{fmt(d.loop[1])}
                <small>{(d.loop[1] - d.loop[0]).toFixed(1)}s</small>
              </button>
              {d.bpm && (
                <span className="beats">
                  {[1, 2, 4, 8].map((bars) => (
                    <button key={bars} className="chip" title={`Loop ${bars} bar${bars > 1 ? "s" : ""} (4 beats each at ~${d.bpm} bpm)`}
                      onClick={() => {
                        const len = (bars * 4 * 60) / d.bpm!;
                        const start = d.loop![0];
                        patch({ loop: [start, Math.min(d.full!.duration, start + len)], loopOn: true });
                      }}>
                      {bars}
                    </button>
                  ))}
                  <small>bars</small>
                </span>
              )}
              <button className="link" onClick={() => patch({ loop: null, loopOn: false })}>clear</button>
            </>
          ) : (
            <span className="hint-inline">drag on the waveform to loop a section · click to set the start</span>
          )}
        </div>
      )}

      {d.full && (
        <>
          <div className="stems-head">
            <span>{stemsOn ? "Stems" : "Channel"}</span>
            {stemsOn ? (
              <button className="chip" onClick={() => patch({ useStems: false })}>
                use full track
              </button>
            ) : d.stems ? (
              <button className="chip hot" onClick={() => patch({ useStems: true })}>
                use stems
              </button>
            ) : d.stemStatus?.status === "running" ? (
              <span className="chip busy">
                <i className="spinner" />{" "}
                {d.stemStatus.message ??
                  `separating with demucs${d.stemStatus.started ? ` · ${fmt((Date.now() - Date.parse(d.stemStatus.started)) / 1000)}` : "…"}`}
              </span>
            ) : (
              <button className="chip hot" disabled={!props.demucs} onClick={props.onSplit} title={props.demucs ? "" : "demucs not installed on the API host"}>
                <Icon name="split" /> Split stems
              </button>
            )}
          </div>
          {d.stemStatus?.status === "error" && <div className="err small">{d.stemStatus.message?.slice(-200)}</div>}
          <div className="channels">
            {channels.map((name) => (
              <div key={name} className={`channel ${d.mutes[name] ? "muted" : ""}`}>
                <input
                  type="range"
                  className="vfader"
                  min={0}
                  max={1.5}
                  step={0.01}
                  value={d.gains[name] ?? 1}
                  onChange={(e) => patch({ gains: { ...d.gains, [name]: +e.target.value } })}
                />
                <button
                  className="mute"
                  onClick={() => patch({ mutes: { ...d.mutes, [name]: !d.mutes[name] } })}
                >
                  {name}
                </button>
              </div>
            ))}
          </div>

          <div className="knobs">
            <Knob label="Volume" min={0} max={1.2} value={d.volume} onChange={(v) => patch({ volume: v })} format={(v) => `${Math.round(v * 100)}`} />
            <Knob label="Tempo" min={0.7} max={1.4} value={d.rate} onChange={(v) => patch({ rate: Math.round(v * 1000) / 1000 })} format={(v) => `${v >= 1 ? "+" : ""}${Math.round((v - 1) * 100)}%`} center={1} />
            <Knob label="Filter" min={-1} max={1} value={d.filter} onChange={(v) => patch({ filter: v })} format={(v) => (Math.abs(v) < 0.03 ? "open" : v < 0 ? "LP" : "HP")} center={0} />
            <Knob label="Enter at" min={0} max={120} value={d.delay} onChange={(v) => patch({ delay: Math.round(v) })} format={(v) => fmt(v)} />
          </div>
          <div className="fadebar">
            <button
              className={`chip ${d.fadeAt !== null ? "loop-on" : ""}`}
              onClick={() =>
                patch(
                  d.fadeAt !== null
                    ? { fadeAt: null }
                    : // Default: finish exactly at the end of the mix, never before the deck enters.
                      { fadeAt: Math.max(d.delay, Math.round(props.mixLength - d.fadeLen)) },
                )
              }
              title="Fade this deck to silence over a stretch of the mix"
            >
              {d.fadeAt !== null ? (
                <>
                  fading out <small>{fmt(d.fadeAt)}–{fmt(Math.min(props.mixLength, d.fadeAt + d.fadeLen))}</small>
                </>
              ) : (
                "fade out"
              )}
            </button>
            {d.fadeAt !== null && (
              <>
                <Knob
                  label="Fade at"
                  min={0}
                  max={props.mixLength}
                  value={Math.min(d.fadeAt, props.mixLength)}
                  onChange={(v) => patch({ fadeAt: Math.round(v) })}
                  format={(v) => fmt(v)}
                />
                <Knob
                  label="Over"
                  min={1}
                  max={30}
                  value={d.fadeLen}
                  onChange={(v) => patch({ fadeLen: Math.round(v) })}
                  format={(v) => `${Math.round(v)}s`}
                />
              </>
            )}
          </div>
          <div className="deck-foot">
            <span>start {fmt(d.trim)}</span>
            {d.bpm && <span>~{Math.round(d.bpm * d.rate)} bpm</span>}
            <button
              className={`lock ${d.keylock ? "on" : ""}`}
              onClick={() => patch({ keylock: !d.keylock })}
              title={d.keylock ? "Key lock on: tempo changes keep the original pitch" : "Key lock off: tempo changes shift pitch, like vinyl"}
            >
              {d.stretching ? <i className="spinner" /> : <Icon name="lock" />} key lock
            </button>
            <button className="link" onClick={() => patch({ rate: 1, filter: 0, volume: 0.9, delay: 0, mutes: {}, gains: emptyDeck().gains, keylock: true, fadeAt: null, fadeLen: 8 })}>
              reset
            </button>
          </div>
        </>
      )}
    </section>
  );
}

/** How far a track's tempo may sit from the target and still match, in BPM. */
const BPM_RANGES = [3, 5, 10, 15, 20];
const DEFAULT_BPM_RANGE = 10;

/**
 * The nearest of `bpm`, half it and double it to `target`, when that is within
 * `range`. Half and double count because a 90 BPM track and a 180 BPM one share
 * a beat grid, and the estimator can land on either for the same song.
 */
function bpmMatch(bpm: number | null | undefined, target: number, range: number): { bpm: number; distance: number } | null {
  if (!bpm) return null;
  const best = [bpm, bpm * 2, bpm / 2]
    .map((b) => ({ bpm: b, distance: Math.abs(b - target) }))
    .reduce((x, y) => (y.distance < x.distance ? y : x));
  return best.distance <= range ? best : null;
}

/** The tempo change that brings `bpm` to `target`, as the Tempo knob shows it. */
function tempoNudge(bpm: number, target: number): string {
  const pct = Math.round((target / bpm - 1) * 100);
  return pct === 0 ? "±0%" : `${pct > 0 ? "+" : ""}${pct}%`;
}

function Picker(props: {
  tracks: Track[];
  onPick: (t: Track) => void;
  exclude?: string;
  /** The other deck's tempo as it is playing (bpm × rate), to offer as a target. */
  otherBpm?: number | null;
  otherSide?: string;
}) {
  const [q, setQ] = useState("");
  const [bpmText, setBpmText] = useState("");
  const [range, setRange] = useState(DEFAULT_BPM_RANGE);
  const needle = q.trim().toLowerCase();
  const target = Number(bpmText) > 0 ? Number(bpmText) : null;
  const measuring = props.tracks.filter((t) => t.playable && t.bpm === undefined).length;
  const match = (t: Track) => (target === null ? null : bpmMatch(t.bpm, target, range));
  const list = props.tracks
    .filter((t) => !needle || [t.title, t.releaseTitle, ...t.artists].some((s) => s?.toLowerCase().includes(needle)))
    .filter((t) => target === null || match(t) !== null)
    .sort(
      (x, y) =>
        Number(y.playable) - Number(x.playable) ||
        (target === null ? 0 : match(x)!.distance - match(y)!.distance),
    );
  const other = props.otherBpm ? Math.round(props.otherBpm) : null;
  return (
    <div className="picker">
      <div className="picker-bar">
        <div className="search">
          <Icon name="search" />
          <input placeholder="Search the catalog" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <label className="search bpm-search" title={`Within ±${range} BPM, counting half and double time`}>
          <input
            inputMode="numeric"
            placeholder="BPM"
            value={bpmText}
            onChange={(e) => setBpmText(e.target.value.replace(/[^0-9.]/g, ""))}
          />
          <select value={range} onChange={(e) => setRange(Number(e.target.value))} aria-label="BPM range">
            {BPM_RANGES.map((r) => (
              <option key={r} value={r}>
                ±{r}
              </option>
            ))}
          </select>
          {bpmText && (
            <button className="link" onClick={() => setBpmText("")} aria-label="Clear BPM">
              ×
            </button>
          )}
        </label>
      </div>
      {(other || measuring > 0) && (
        <div className="picker-hints">
          {other && String(other) !== bpmText && (
            <button className="chip" onClick={() => setBpmText(String(other))}>
              match Deck {props.otherSide} · {other} bpm
            </button>
          )}
          {measuring > 0 && <span className="muted">measuring tempo · {measuring} to go</span>}
        </div>
      )}
      <ul>
        {list.map((t) => (
          <li key={t.id}>
            <button disabled={!t.playable || t.id === props.exclude} onClick={() => props.onPick(t)}>
              <Cover url={t.coverUrl} size={44} />
              <span className="ti" title={[t.title, t.artists.join(", ")].filter(Boolean).join(" — ")}>
                <b>{t.title}</b>
                <small>
                  {t.artists.join(", ")}
                  {t.isMix && <em className="tag">mix</em>}
                </small>
              </span>
              {t.bpm ? (
                <span className="dur" title={target !== null ? `Set Tempo to ${tempoNudge(match(t)!.bpm, target)} to hit ${target} BPM` : undefined}>
                  {t.bpm} bpm
                  {target !== null && <em className="nudge"> {tempoNudge(match(t)!.bpm, target)}</em>}
                </span>
              ) : null}
              <span className="dur">{t.playable ? fmt(t.durationSeconds ?? 0) : "encoding…"}</span>
            </button>
          </li>
        ))}
        {list.length === 0 && (
          <li className="empty">
            {!props.tracks.length
              ? "Loading the catalog…"
              : target !== null && measuring > 0
                ? "No tracks match yet — still measuring tempos."
                : "No tracks match."}
          </li>
        )}
      </ul>
    </div>
  );
}
