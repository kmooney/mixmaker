// Tempo change without pitch change (SoundTouch's WSOLA), done ahead of time
// into a plain AudioBuffer. Live playback and the offline render both play the
// stretched buffer at rate 1, so what you hear is what gets published.
import { SimpleFilter, SoundTouch } from "soundtouchjs";
import { ctx } from "./audio";

/** Reads stereo frames out of an AudioBuffer, zero-filling past the end. */
class Source {
  constructor(private buf: AudioBuffer) {}
  extract(target: Float32Array, numFrames: number, position: number): number {
    const l = this.buf.getChannelData(0);
    const r = this.buf.numberOfChannels > 1 ? this.buf.getChannelData(1) : l;
    const avail = Math.max(0, Math.min(numFrames, l.length - position));
    for (let i = 0; i < numFrames; i++) {
      const p = position + i;
      target[i * 2] = i < avail ? l[p] : 0;
      target[i * 2 + 1] = i < avail ? r[p] : 0;
    }
    return avail;
  }
}

export interface Cancel {
  cancelled: boolean;
}

/**
 * Returns `outSec` seconds of `buf`, starting at `startSec` in the source,
 * played `tempo`× faster at the original pitch.
 */
export async function stretch(buf: AudioBuffer, tempo: number, startSec: number, outSec: number, cancel: Cancel): Promise<AudioBuffer | null> {
  const sr = buf.sampleRate;
  const st = new SoundTouch();
  st.tempo = tempo;
  const filter = new SimpleFilter(new Source(buf), st);
  filter.sourcePosition = Math.floor(startSec * sr);

  const maxOut = Math.ceil(Math.min(outSec, (buf.duration - startSec) / tempo + 0.5) * sr);
  const out = ctx().createBuffer(2, Math.max(1, maxOut), sr);
  const L = out.getChannelData(0);
  const R = out.getChannelData(1);
  const chunk = 16384;
  const tmp = new Float32Array(chunk * 2);
  let written = 0;
  let sinceYield = 0;
  while (written < maxOut) {
    const n = filter.extract(tmp, Math.min(chunk, maxOut - written));
    if (n <= 0) break;
    for (let i = 0; i < n; i++) {
      L[written + i] = tmp[i * 2];
      R[written + i] = tmp[i * 2 + 1];
    }
    written += n;
    // Keep the UI responsive: yield to the event loop every ~1.5s of audio.
    if (++sinceYield >= 4) {
      sinceYield = 0;
      await new Promise((r) => setTimeout(r, 0));
      if (cancel.cancelled) return null;
    }
  }
  return out;
}
