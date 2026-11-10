import { roleLabel, type Credit, type Track } from "./api";
import { Cover, Icon } from "./ui";

type Tagged<T> = T & { from: ("A" | "B")[] };

function merge<T>(a: T[], b: T[], key: (x: T) => string): Tagged<T>[] {
  const out = new Map<string, Tagged<T>>();
  for (const [side, list] of [["A", a], ["B", b]] as const) {
    for (const x of list) {
      const k = key(x);
      const e = out.get(k);
      if (e) {
        if (!e.from.includes(side)) e.from.push(side);
      } else out.set(k, { ...x, from: [side] });
    }
  }
  return [...out.values()];
}

export function mergedCredits(a: Track | null, b: Track | null) {
  const ck = (c: Credit) => `${c.party.partyPk}:${c.role}`;
  return {
    release: merge(a?.releaseContributors ?? [], b?.releaseContributors ?? [], ck),
    track: merge(a?.trackContributors ?? [], b?.trackContributors ?? [], ck),
    labels: merge(a?.labels ?? [], b?.labels ?? [], (l) => `${l.partyPk}`),
    plines: merge(a?.plines ?? [], b?.plines ?? [], (l) => l.value),
    clines: merge(a?.clines ?? [], b?.clines ?? [], (l) => l.value),
  };
}

const Src = ({ from }: { from: ("A" | "B")[] }) => (
  <span className="src">
    {from.map((f) => (
      <i key={f} className={f === "A" ? "sa" : "sb"}>
        {f}
      </i>
    ))}
  </span>
);

export function Provenance({ a, b }: { a: Track | null; b: Track | null }) {
  const m = mergedCredits(a, b);
  return (
    <section className="prov">
      <div className="prov-head">
        <h3>Provenance</h3>
        <p>Everything below is read from //SCHEMA and carried into the new release — nobody loses a credit in the remix.</p>
      </div>
      <div className="lineage">
        <SourceCard t={a} side="A" />
        <div className="plus">+</div>
        <SourceCard t={b} side="B" />
        <div className="arrow">
          <Icon name="arrow" />
        </div>
        <div className="new-card">
          <div className="new-cover">NEW</div>
          <div>
            <b>Your mix</b>
            <small>Single · new UPC · FLAC master</small>
          </div>
        </div>
      </div>
      <div className="prov-grid">
        <div>
          <h4>Release credits</h4>
          {m.release.map((c) => (
            <div className="credit" key={`${c.party.partyPk}${c.role}`}>
              <span>{c.party.name}</span>
              <small>{roleLabel(c.role)}</small>
              <Src from={c.from} />
            </div>
          ))}
          <div className="credit you">
            <span>You</span>
            <small>Remixer</small>
            <span className="src"><i className="sy">+</i></span>
          </div>
        </div>
        <div>
          <h4>Track credits</h4>
          {m.track.map((c) => (
            <div className="credit" key={`${c.party.partyPk}${c.role}`}>
              <span>{c.party.name}</span>
              <small>{roleLabel(c.role)}</small>
              <Src from={c.from} />
            </div>
          ))}
          {m.track.length === 0 && <p className="none">none on the source recordings</p>}
        </div>
        <div>
          <h4>Labels</h4>
          {m.labels.map((l) => (
            <div className="credit" key={l.partyPk}>
              <span>{l.name}</span>
              <Src from={l.from} />
            </div>
          ))}
          <h4>℗ / © lines</h4>
          {[...m.plines.map((l) => ({ ...l, k: `p${l.value}` })), ...m.clines.map((l) => ({ ...l, k: `c${l.value}` }))].map((l) => (
            <div className="credit line" key={l.k}>
              <span>{l.value}</span>
              <Src from={l.from} />
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function SourceCard({ t, side }: { t: Track | null; side: "A" | "B" }) {
  return (
    <div className={`source-card ${side === "A" ? "sa" : "sb"}`}>
      <Cover url={t?.coverUrl} size={48} />
      <div>
        <b>{t?.title ?? "—"}</b>
        <small>{t ? t.artists.join(", ") : `pick a track for deck ${side}`}</small>
        {t && (
          <code>
            UPC {t.upc ?? "—"} {t.isrc && `· ISRC ${t.isrc}`}
          </code>
        )}
      </div>
    </div>
  );
}
