export interface Party {
  name: string;
  partyPk: number;
}
export interface Credit {
  role: string;
  party: Party;
}
export interface Line {
  value: string;
}

export interface Track {
  id: string;
  releasePk: number;
  resourcePk: number;
  upc: string | null;
  releaseTitle: string | null;
  title: string | null;
  isrc: string | null;
  durationSeconds: number | null;
  artists: string[];
  releaseContributors: Credit[];
  trackContributors: Credit[];
  labels: { name: string; partyPk: number }[];
  plines: Line[];
  clines: Line[];
  trackPlines: Line[];
  audioUrl: string;
  coverUrl: string | null;
  isMix: boolean;
  playable: boolean;
  /** Estimated by mix-maker's API. Absent until measured; null when no tempo was found. */
  bpm?: number | null;
}

export interface StemStatus {
  status: "none" | "running" | "done" | "error";
  stems?: { name: string; url: string }[];
  message?: string;
  started?: string;
}

export interface TraceStep {
  op: string;
  detail: string;
  ok: boolean;
}

export interface Mix {
  releasePk: number;
  upc: string;
  title: string;
  remixer: string;
  createdAt: string;
  published: boolean;
  problems: string[];
  sources: {
    releasePk: number;
    upc: string | null;
    releaseTitle: string | null;
    resourcePk: number;
    title: string | null;
    isrc: string | null;
    artists: string[];
  }[];
  recipe: Record<string, unknown>;
  trace: TraceStep[];
  warnings: string[];
  audioUrl: string;
  coverUrl: string;
  release?: {
    title: string;
    state: string;
    upc: string;
    contributors: Credit[];
    labels: { name: string }[];
    plines: Line[];
    clines: Line[];
    resources: { resourcePk: number; mediaKind: string; contributors: Credit[]; plines: Line[]; title: string | null }[];
  } | null;
}

async function j<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `${res.status}`);
  return body as T;
}

export const api = {
  health: () => fetch("/api/health").then((r) => j<{ demucs: boolean; schema: { catalogPk: number } }>(r)),
  tracks: (q: string) => fetch(`/api/tracks?q=${encodeURIComponent(q)}`).then((r) => j<{ tracks: Track[] }>(r)),
  startStems: (t: Track) => fetch(`/api/stems/${t.releasePk}/${t.resourcePk}`, { method: "POST" }).then((r) => j<StemStatus>(r)),
  stemStatus: (t: Track) => fetch(`/api/stems/${t.releasePk}/${t.resourcePk}`).then((r) => j<StemStatus>(r)),
  mixes: () => fetch("/api/mixes").then((r) => j<{ mixes: Mix[] }>(r)),
  publish: (form: FormData) => fetch("/api/mixes", { method: "POST", body: form }).then((r) => j<Mix>(r)),
};

export const fmt = (s: number) => {
  const m = Math.floor(s / 60);
  const ss = Math.floor(s % 60);
  return `${m}:${ss.toString().padStart(2, "0")}`;
};

export const roleLabel = (r: string) => r.replace(/([a-z])([A-Z])/g, "$1 $2");
