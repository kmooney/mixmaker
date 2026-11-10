import { useEffect, useRef, useState } from "react";
import { api, type Mix, type Track } from "./api";
import { encodeWav, renderMix, type MixParams } from "./audio";
import { COVER_STYLES, drawCover, loadImage, renderCoverPng, type CoverStyle } from "./cover";
import { Icon } from "./ui";

type Phase = "edit" | "render" | "upload" | "done" | "error";

export function PublishModal(props: { a: Track; b: Track; mix: MixParams; onClose: () => void; onDone: (m: Mix) => void; stop: () => void }) {
  const { a, b } = props;
  const [title, setTitle] = useState(`${a.title} × ${b.title}`);
  const [remixer, setRemixer] = useState(() => localStorageGet("mm.remixer") ?? "");
  const [style, setStyle] = useState<CoverStyle>("split");
  const [hue, setHue] = useState(275);
  const [phase, setPhase] = useState<Phase>("edit");
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState<Mix | null>(null);
  const [error, setError] = useState("");
  const [shown, setShown] = useState(0);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [imgs, setImgs] = useState<[HTMLImageElement | null, HTMLImageElement | null]>([null, null]);

  const credit = `${[...new Set([...a.artists, ...b.artists])].join(" × ")}${remixer ? ` — ${remixer} mix` : ""}`;

  useEffect(() => {
    Promise.all([loadImage(a.coverUrl), loadImage(b.coverUrl)]).then(([x, y]) => setImgs([x, y]));
  }, [a.coverUrl, b.coverUrl]);

  useEffect(() => {
    if (canvas.current) drawCover(canvas.current, { a: imgs[0], b: imgs[1], title, credit, style, hue });
  }, [imgs, title, credit, style, hue]);

  // Reveal the trace one step at a time — it's the best part of the demo.
  useEffect(() => {
    if (!result || shown >= result.trace.length) return;
    const t = setTimeout(() => setShown((s) => s + 1), 110);
    return () => clearTimeout(t);
  }, [result, shown]);

  const publish = async () => {
    props.stop();
    localStorageSet("mm.remixer", remixer);
    try {
      setPhase("render");
      const rendered = await renderMix(props.mix, setProgress);
      const wav = encodeWav(rendered);
      const cover = await renderCoverPng({ a: imgs[0], b: imgs[1], title, credit, style, hue });
      setPhase("upload");
      const form = new FormData();
      form.append(
        "meta",
        JSON.stringify({
          title,
          remixer: remixer || "Anonymous",
          durationSeconds: Math.round(props.mix.length),
          sources: [a, b].map((t) => ({ releasePk: t.releasePk, resourcePk: t.resourcePk })),
          recipe: recipe(props.mix, style, hue),
        }),
      );
      form.append("audio", wav, "mix.wav");
      form.append("cover", cover, "cover.png");
      const m = await api.publish(form);
      setResult(m);
      setPhase("done");
    } catch (e) {
      setError((e as Error).message);
      setPhase("error");
    }
  };

  return (
    <div className="modal-bg" onClick={phase === "edit" ? props.onClose : undefined}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <button className="close" onClick={props.onClose} aria-label="Close">
          <Icon name="x" />
        </button>
        <div className="modal-grid">
          <div className="cover-preview">
            <canvas ref={canvas} width={700} height={700} />
            {phase === "edit" && (
              <>
                <div className="styles">
                  {COVER_STYLES.map((s) => (
                    <button key={s.id} className={style === s.id ? "on" : ""} onClick={() => setStyle(s.id)}>
                      {s.label}
                    </button>
                  ))}
                </div>
                <input className="hue" type="range" min={0} max={359} value={hue} onChange={(e) => setHue(+e.target.value)} />
              </>
            )}
          </div>

          <div className="form">
            {phase === "edit" && (
              <>
                <h2>Publish your mix</h2>
                <p className="sub">It goes into the //SCHEMA catalog as a new single, with both sources' credits.</p>
                <label>
                  Title
                  <input value={title} onChange={(e) => setTitle(e.target.value)} />
                </label>
                <label>
                  Your artist name
                  <input value={remixer} placeholder="DJ Whoever" onChange={(e) => setRemixer(e.target.value)} />
                </label>
                <div className="summary">
                  <div>
                    <small>Length</small>
                    {Math.round(props.mix.length)}s
                  </div>
                  <div>
                    <small>Deck A</small>
                    {props.mix.a?.buffers.length === 4 ? "4 stems" : "full mix"}
                  </div>
                  <div>
                    <small>Deck B</small>
                    {props.mix.b?.buffers.length === 4 ? "4 stems" : "full mix"}
                  </div>
                </div>
                <button className="cta" disabled={!title.trim()} onClick={publish}>
                  <Icon name="upload" /> Render & publish
                </button>
              </>
            )}

            {(phase === "render" || phase === "upload") && (
              <div className="working">
                <h2>{phase === "render" ? "Rendering your mix…" : "Publishing to //SCHEMA…"}</h2>
                <div className="bar">
                  <div style={{ width: `${phase === "render" ? progress * 100 : 100}%` }} className={phase === "upload" ? "indet" : ""} />
                </div>
                <ol className="steps">
                  <li className={phase === "render" ? "now" : "ok"}>Render audio offline (44.1 kHz)</li>
                  <li className={phase === "upload" ? "now" : ""}>Read both sources back from the catalog</li>
                  <li className={phase === "upload" ? "now" : ""}>Draft release · merge credits · ℗/© · labels</li>
                  <li className={phase === "upload" ? "now" : ""}>Upload FLAC + cover by SHA-256 · publish</li>
                </ol>
              </div>
            )}

            {phase === "done" && result && (
              <div className="done">
                <h2>
                  {result.published ? (
                    <>
                      <span className="ok-badge">
                        <Icon name="check" />
                      </span>{" "}
                      It's live.
                    </>
                  ) : (
                    "Drafted — not yet live"
                  )}
                </h2>
                <p className="sub">
                  UPC <code>{result.upc}</code> · release #{result.releasePk}
                </p>
                {result.problems.length > 0 && <div className="err">{result.problems.join("; ")}</div>}
                <ol className="trace">
                  {result.trace.slice(0, shown).map((s, i) => (
                    <li key={i} className={s.ok ? "" : "warn"}>
                      <code>{s.op}</code>
                      <span>{s.detail}</span>
                    </li>
                  ))}
                </ol>
                <button className="cta" onClick={() => props.onDone(result)}>
                  See it in Drops
                </button>
              </div>
            )}

            {phase === "error" && (
              <div className="done">
                <h2>Something broke</h2>
                <div className="err">{error}</div>
                <button className="cta" onClick={() => setPhase("edit")}>
                  Back
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function recipe(m: MixParams, style: CoverStyle, hue: number) {
  const deck = (d: MixParams["a"]) =>
    d && {
      mode: d.buffers.length > 1 ? "stems" : "full",
      stems: Object.fromEntries(d.buffers.map((x) => [x.name, d.mutes[x.name] ? 0 : +(d.gains[x.name] ?? 1).toFixed(2)])),
      volume: +d.volume.toFixed(2),
      rate: d.rate,
      startAt: d.trim,
      entersAt: d.delay,
      filter: +d.filter.toFixed(2),
      loop: d.loop ? "on" : null,
      fadeOut: d.fadeOut ? { at: d.fadeOut[0], over: d.fadeOut[1] } : null,
    };
  return { length: m.length, crossfade: m.auto ? "auto A→B" : m.crossfade, a: deck(m.a), b: deck(m.b), cover: { style, hue } };
}

function localStorageGet(k: string): string | null {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}
function localStorageSet(k: string, v: string) {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* private mode */
  }
}
