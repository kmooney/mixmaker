import { useEffect, useState } from "react";
import { api, roleLabel, type Mix, type Track } from "./api";
import { Cover, Icon } from "./ui";

// Survives tab switches: show the last list immediately, refresh behind it.
let cachedMixes: Mix[] | null = null;

export function Drops({ highlight, tracks, onRemix }: { highlight?: number; tracks: Track[]; onRemix: (t: Track) => void }) {
  const [mixes, setMixes] = useState<Mix[] | null>(cachedMixes);
  const [error, setError] = useState("");
  const [open, setOpen] = useState<number | null>(highlight ?? null);

  useEffect(() => {
    api.mixes().then(
      (r) => {
        cachedMixes = r.mixes;
        setMixes(r.mixes);
      },
      (e) => cachedMixes === null && setError(e.message),
    );
  }, []);

  if (error) return <main className="drops"><div className="err">{error}</div></main>;
  if (!mixes) return <main className="drops"><div className="loading">Loading drops…</div></main>;

  const current = mixes.find((m) => m.releasePk === open) ?? null;

  return (
    <main className="drops">
      <section className="hero">
        <h1>
          Fresh <em>drops</em>
        </h1>
        <p>Every mix here is a real release in the //SCHEMA catalog, read back live — with its lineage intact.</p>
      </section>
      {mixes.length === 0 && <div className="empty-drops">No mixes yet. Head to the Studio and make the first one.</div>}

      {current && <Detail m={current} track={tracks.find((t) => t.releasePk === current.releasePk)} onRemix={onRemix} onClose={() => setOpen(null)} />}

      <div className="grid">
        {mixes.map((m) => (
          <button key={m.releasePk} className={`drop ${m.releasePk === open ? "on" : ""}`} onClick={() => setOpen(m.releasePk)}>
            <Cover url={m.coverUrl} size={220} />
            <b>{m.release?.title ?? m.title}</b>
            <small>{m.remixer} · {new Date(m.createdAt).toLocaleDateString()}</small>
            <span className="from">
              {m.sources.map((s) => s.title).join("  ×  ")}
            </span>
          </button>
        ))}
      </div>
    </main>
  );
}

function Detail({ m, track, onRemix, onClose }: { m: Mix; track?: Track; onRemix: (t: Track) => void; onClose: () => void }) {
  const r = m.release;
  const audio = r?.resources.find((x) => x.mediaKind === "AUDIO");
  const [showTrace, setShowTrace] = useState(false);
  return (
    <section className="detail">
      <button className="close" onClick={onClose} aria-label="Close">
        <Icon name="x" />
      </button>
      <div className="detail-main">
        <Cover url={m.coverUrl} size={260} />
        <div className="detail-info">
          <span className={`state ${r?.state ?? ""}`}>{r?.state ?? "unknown"}</span>
          <h2>{r?.title ?? m.title}</h2>
          <p className="sub">
            UPC <code>{m.upc}</code> · release #{m.releasePk}
          </p>
          <audio controls src={m.audioUrl} preload="none" />
          <div className="lineage small">
            {m.sources.map((s, i) => (
              <div key={i} className={`source-card ${i === 0 ? "sa" : "sb"}`}>
                <div>
                  <b>{s.title}</b>
                  <small>{s.artists.join(", ")} · {s.releaseTitle}</small>
                  <code>UPC {s.upc ?? "—"}{s.isrc ? ` · ISRC ${s.isrc}` : ""}</code>
                </div>
              </div>
            ))}
          </div>
          {track && (
            <button className="chip hot" onClick={() => onRemix(track)}>
              Remix this mix
            </button>
          )}
        </div>
      </div>

      {r && (
        <div className="prov-grid">
          <div>
            <h4>Release credits (from //SCHEMA)</h4>
            {r.contributors.map((c, i) => (
              <div className="credit" key={i}>
                <span>{c.party.name}</span>
                <small>{roleLabel(c.role)}</small>
              </div>
            ))}
          </div>
          <div>
            <h4>Track credits</h4>
            {audio?.contributors.map((c, i) => (
              <div className="credit" key={i}>
                <span>{c.party.name}</span>
                <small>{roleLabel(c.role)}</small>
              </div>
            ))}
            <h4>Track ℗</h4>
            {audio?.plines.map((l) => (
              <div className="credit line" key={l.value}>
                <span>{l.value}</span>
              </div>
            ))}
          </div>
          <div>
            <h4>Labels</h4>
            {r.labels.map((l) => (
              <div className="credit" key={l.name}>
                <span>{l.name}</span>
              </div>
            ))}
            <h4>Release ℗ / ©</h4>
            {[...r.plines, ...r.clines].map((l, i) => (
              <div className="credit line" key={i}>
                <span>{l.value}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="recipe">
        <h4>Recipe</h4>
        <pre>{JSON.stringify(m.recipe, null, 2)}</pre>
      </div>
      <button className="link" onClick={() => setShowTrace((s) => !s)}>
        {showTrace ? "hide" : "show"} the {m.trace.length} //SCHEMA operations that built this release
      </button>
      {showTrace && (
        <ol className="trace">
          {m.trace.map((s, i) => (
            <li key={i} className={s.ok ? "" : "warn"}>
              <code>{s.op}</code>
              <span>{s.detail}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
