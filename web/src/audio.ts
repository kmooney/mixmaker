// One graph builder drives both live playback (AudioContext) and the final
// render (OfflineAudioContext), so what you hear is what gets published.

export const STEMS = ["vocals", "drums", "bass", "other"] as const;
export type StemName = (typeof STEMS)[number] | "full";

export interface DeckParams {
  buffers: { name: StemName; buffer: AudioBuffer }[];
  gains: Record<string, number>;
  mutes: Record<string, boolean>;
  volume: number;
  rate: number; // playback rate, 1 = original
  trim: number; // seconds into the source where the deck starts
  delay: number; // seconds into the mix where the deck enters
  filter: number; // -1 (low-pass) .. 0 (open) .. 1 (high-pass)
  /** Loop region in buffer seconds; when set, the deck plays it on repeat from its entry. */
  loop?: [number, number] | null;
  /** Fade-out as [start, length] in mix seconds; the deck is silent from start + length on. */
  fadeOut?: [number, number] | null;
}

export interface MixParams {
  a: DeckParams | null;
  b: DeckParams | null;
  crossfade: number; // 0 = all A, 1 = all B
  auto: boolean; // automate A→B across the transition window
  transition: [number, number]; // fractions of length
  length: number; // seconds
}

let shared: AudioContext | null = null;
export function ctx(): AudioContext {
  if (!shared) shared = new AudioContext({ sampleRate: 44100 });
  return shared;
}

export async function loadBuffer(url: string): Promise<AudioBuffer> {
  const res = await fetch(url);
  if (!res.ok) {
    let msg = `${res.status}`;
    try {
      msg = (await res.json()).error ?? msg;
    } catch {
      /* not json */
    }
    throw new Error(msg);
  }
  return ctx().decodeAudioData(await res.arrayBuffer());
}

export function crossfadeAt(m: MixParams, t: number): number {
  if (!m.auto) return m.crossfade;
  const [s, e] = m.transition;
  const f = t / Math.max(1, m.length);
  if (f <= s) return 0;
  if (f >= e) return 1;
  return (f - s) / (e - s);
}

const xfGains = (x: number): [number, number] => [Math.cos((x * Math.PI) / 2), Math.sin((x * Math.PI) / 2)];

function applyFilter(f: BiquadFilterNode, v: number) {
  if (v < -0.02) {
    f.type = "lowpass";
    f.frequency.value = 20000 * Math.pow(10, v * 2.3);
  } else if (v > 0.02) {
    f.type = "highpass";
    f.frequency.value = 20 * Math.pow(10, v * 2.3);
  } else {
    f.type = "lowpass";
    f.frequency.value = 22000;
  }
  f.Q.value = 0.9;
}

interface DeckNodes {
  sources: AudioBufferSourceNode[];
  stemGains: Map<string, GainNode>;
  filter: BiquadFilterNode;
  volume: GainNode;
  fade: GainNode;
  xf: GainNode;
}

/** A deck's fade-out gain at mix time `t`: equal-power, so it sounds even rather than dropping late. */
export function fadeGainAt(d: DeckParams, t: number): number {
  if (!d.fadeOut) return 1;
  const [start, len] = d.fadeOut;
  if (t <= start) return 1;
  if (t >= start + len) return 0;
  return Math.cos((((t - start) / len) * Math.PI) / 2);
}

/**
 * Schedules the fade as automation, so it is sample-accurate live and in the
 * offline render alike, and needs no per-frame updates. `when` is the context
 * time at which mix time `position` plays; starting mid-fade picks up there.
 */
function scheduleFade(g: GainNode, d: DeckParams, when: number, position: number) {
  g.gain.value = fadeGainAt(d, position);
  if (!d.fadeOut) return;
  const [start, len] = d.fadeOut;
  const from = Math.max(position, start);
  const to = start + len;
  if (to - from < 0.01) return;
  const n = 128;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) curve[i] = fadeGainAt(d, from + (i / (n - 1)) * (to - from));
  g.gain.setValueCurveAtTime(curve, when + (from - position), to - from);
}

export interface Graph {
  decks: { a: DeckNodes | null; b: DeckNodes | null };
  master: GainNode;
  analyser: AnalyserNode | null;
  stop(): void;
}

function stemGain(d: DeckParams, name: string): number {
  return d.mutes[name] ? 0 : (d.gains[name] ?? 1);
}

/** Builds the graph and starts every source so that mix time `position` plays at `when`. */
export function buildGraph(c: BaseAudioContext, m: MixParams, when: number, position: number, live: boolean): Graph {
  const master = c.createGain();
  master.gain.value = 0.9;
  const comp = c.createDynamicsCompressor();
  comp.threshold.value = -10;
  comp.ratio.value = 6;
  comp.attack.value = 0.003;
  comp.release.value = 0.2;
  master.connect(comp);
  let analyser: AnalyserNode | null = null;
  if (live) {
    analyser = c.createAnalyser();
    analyser.fftSize = 2048;
    comp.connect(analyser);
    analyser.connect(c.destination);
  } else {
    comp.connect(c.destination);
  }

  const build = (d: DeckParams | null, side: 0 | 1): DeckNodes | null => {
    if (!d || d.buffers.length === 0) return null;
    const xf = c.createGain();
    const volume = c.createGain();
    const fade = c.createGain();
    const filter = c.createBiquadFilter();
    applyFilter(filter, d.filter);
    volume.gain.value = d.volume;
    scheduleFade(fade, d, when, position);
    filter.connect(volume).connect(fade).connect(xf).connect(master);

    if (live) {
      xf.gain.value = xfGains(crossfadeAt(m, position))[side];
    } else {
      // Offline: bake the crossfade (static or automated) into a curve.
      const n = 256;
      const curve = new Float32Array(n);
      for (let i = 0; i < n; i++) curve[i] = xfGains(crossfadeAt(m, (i / (n - 1)) * m.length))[side];
      xf.gain.setValueCurveAtTime(curve, 0, m.length);
    }

    const stemGains = new Map<string, GainNode>();
    const sources: AudioBufferSourceNode[] = [];
    // Where in the source buffer mix time `position` lands.
    const elapsed = position - d.delay;
    for (const { name, buffer } of d.buffers) {
      const g = c.createGain();
      g.gain.value = stemGain(d, name);
      g.connect(filter);
      stemGains.set(name, g);
      const src = c.createBufferSource();
      src.buffer = buffer;
      src.playbackRate.value = d.rate;
      src.connect(g);
      if (d.loop) {
        const [ls, le] = d.loop;
        src.loop = true;
        src.loopStart = ls;
        src.loopEnd = le;
        const len = Math.max(0.01, le - ls);
        if (elapsed >= 0) src.start(when, ls + ((elapsed * d.rate) % len));
        else src.start(when - elapsed, ls);
      } else if (elapsed >= 0) {
        const offset = d.trim + elapsed * d.rate;
        if (offset < buffer.duration) src.start(when, offset);
      } else {
        src.start(when - elapsed, d.trim);
      }
      sources.push(src);
    }
    return { sources, stemGains, filter, volume, fade, xf };
  };

  const decks = { a: build(m.a, 0), b: build(m.b, 1) };
  return {
    decks,
    master,
    analyser,
    stop() {
      for (const d of [decks.a, decks.b]) {
        d?.sources.forEach((s) => {
          try {
            s.stop();
          } catch {
            /* never started */
          }
          s.disconnect();
        });
      }
      master.disconnect();
      comp.disconnect();
      analyser?.disconnect();
    },
  };
}

/** Live-updates the cheap params without restarting sources. */
export function updateLive(g: Graph, m: MixParams, position: number) {
  const x = xfGains(crossfadeAt(m, position));
  (["a", "b"] as const).forEach((k, i) => {
    const nodes = g.decks[k];
    const d = m[k];
    if (!nodes || !d) return;
    nodes.xf.gain.setTargetAtTime(x[i], ctx().currentTime, 0.02);
    nodes.volume.gain.setTargetAtTime(d.volume, ctx().currentTime, 0.02);
    applyFilter(nodes.filter, d.filter);
    for (const [name, gn] of nodes.stemGains) gn.gain.setTargetAtTime(stemGain(d, name), ctx().currentTime, 0.02);
  });
}

export async function renderMix(m: MixParams, onProgress?: (f: number) => void): Promise<AudioBuffer> {
  const sr = 44100;
  const off = new OfflineAudioContext(2, Math.ceil(m.length * sr), sr);
  buildGraph(off, m, 0, 0, false);
  // Fade the tail so the mix doesn't end on a cliff.
  let timer: number | undefined;
  if (onProgress) {
    timer = window.setInterval(() => onProgress(Math.min(0.99, off.currentTime / m.length)), 100);
  }
  const out = await off.startRendering();
  if (timer) window.clearInterval(timer);
  const fade = Math.min(3, m.length / 4) * sr;
  for (let ch = 0; ch < out.numberOfChannels; ch++) {
    const data = out.getChannelData(ch);
    for (let i = 0; i < fade; i++) data[data.length - 1 - i] *= i / fade;
    for (let i = 0; i < Math.min(sr * 0.05, data.length); i++) data[i] *= i / (sr * 0.05);
  }
  onProgress?.(1);
  return out;
}

export function encodeWav(buf: AudioBuffer): Blob {
  const ch = buf.numberOfChannels;
  const len = buf.length;
  const bytes = 44 + len * ch * 2;
  const view = new DataView(new ArrayBuffer(bytes));
  const w = (o: number, s: string) => [...s].forEach((c, i) => view.setUint8(o + i, c.charCodeAt(0)));
  w(0, "RIFF");
  view.setUint32(4, bytes - 8, true);
  w(8, "WAVE");
  w(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, ch, true);
  view.setUint32(24, buf.sampleRate, true);
  view.setUint32(28, buf.sampleRate * ch * 2, true);
  view.setUint16(32, ch * 2, true);
  view.setUint16(34, 16, true);
  w(36, "data");
  view.setUint32(40, len * ch * 2, true);
  const chans = Array.from({ length: ch }, (_, i) => buf.getChannelData(i));
  let o = 44;
  for (let i = 0; i < len; i++) {
    for (let c = 0; c < ch; c++) {
      const s = Math.max(-1, Math.min(1, chans[c][i]));
      view.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      o += 2;
    }
  }
  return new Blob([view.buffer], { type: "audio/wav" });
}

export function peaks(buf: AudioBuffer, n: number): Float32Array {
  const out = new Float32Array(n);
  const data = buf.getChannelData(0);
  const step = Math.max(1, Math.floor(data.length / n));
  for (let i = 0; i < n; i++) {
    let max = 0;
    const start = i * step;
    for (let j = 0; j < step; j += 16) {
      const v = Math.abs(data[start + j] ?? 0);
      if (v > max) max = v;
    }
    out[i] = max;
  }
  return out;
}

/** Rough tempo estimate from onset autocorrelation — good enough to suggest a match. */
export function estimateBpm(buf: AudioBuffer): number | null {
  const sr = buf.sampleRate;
  const data = buf.getChannelData(0);
  const hop = 512;
  const start = Math.floor(Math.min(30, buf.duration / 4) * sr);
  const end = Math.min(data.length, start + 30 * sr);
  const env: number[] = [];
  let prev = 0;
  for (let i = start; i + hop < end; i += hop) {
    let e = 0;
    for (let j = 0; j < hop; j++) e += data[i + j] * data[i + j];
    env.push(Math.max(0, e - prev));
    prev = e;
  }
  if (env.length < 100) return null;
  const fps = sr / hop;
  let best = 0;
  let bestLag = 0;
  for (let bpm = 70; bpm <= 180; bpm += 0.5) {
    const lag = (60 / bpm) * fps;
    let s = 0;
    for (let i = 0; i + lag < env.length; i++) s += env[i] * env[Math.floor(i + lag)];
    if (s > best) {
      best = s;
      bestLag = lag;
    }
  }
  return bestLag ? Math.round((60 * fps) / bestLag) : null;
}
