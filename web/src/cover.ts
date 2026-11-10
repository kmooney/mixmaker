export type CoverStyle = "split" | "blend" | "duotone" | "grid";
export const COVER_STYLES: { id: CoverStyle; label: string }[] = [
  { id: "split", label: "Split" },
  { id: "blend", label: "Blend" },
  { id: "duotone", label: "Duotone" },
  { id: "grid", label: "Mosaic" },
];

const cache = new Map<string, Promise<HTMLImageElement | null>>();
export function loadImage(url: string | null | undefined): Promise<HTMLImageElement | null> {
  if (!url) return Promise.resolve(null);
  if (!cache.has(url)) {
    cache.set(
      url,
      new Promise((resolve) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => resolve(null);
        img.src = url;
      }),
    );
  }
  return cache.get(url)!;
}

function cover(ctx: CanvasRenderingContext2D, img: HTMLImageElement | null, x: number, y: number, w: number, h: number, fallback: string) {
  if (!img) {
    ctx.fillStyle = fallback;
    ctx.fillRect(x, y, w, h);
    return;
  }
  const s = Math.max(w / img.width, h / img.height);
  const iw = img.width * s;
  const ih = img.height * s;
  ctx.drawImage(img, x + (w - iw) / 2, y + (h - ih) / 2, iw, ih);
}

export interface CoverInput {
  a: HTMLImageElement | null;
  b: HTMLImageElement | null;
  title: string;
  credit: string;
  style: CoverStyle;
  hue: number;
}

export function drawCover(canvas: HTMLCanvasElement, c: CoverInput) {
  const S = canvas.width;
  const ctx = canvas.getContext("2d")!;
  ctx.save();
  ctx.clearRect(0, 0, S, S);
  ctx.fillStyle = "#0b0b10";
  ctx.fillRect(0, 0, S, S);
  const accent = `hsl(${c.hue} 90% 60%)`;
  const accent2 = `hsl(${(c.hue + 60) % 360} 90% 55%)`;

  if (c.style === "split") {
    cover(ctx, c.a, 0, 0, S, S, accent);
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(S * 0.62, 0);
    ctx.lineTo(S, 0);
    ctx.lineTo(S, S);
    ctx.lineTo(S * 0.38, S);
    ctx.closePath();
    ctx.clip();
    cover(ctx, c.b, 0, 0, S, S, accent2);
    ctx.restore();
    ctx.strokeStyle = accent;
    ctx.lineWidth = S * 0.012;
    ctx.beginPath();
    ctx.moveTo(S * 0.62, 0);
    ctx.lineTo(S * 0.38, S);
    ctx.stroke();
  } else if (c.style === "blend") {
    cover(ctx, c.a, 0, 0, S, S, accent);
    ctx.globalCompositeOperation = "screen";
    ctx.globalAlpha = 0.85;
    ctx.save();
    ctx.translate(S, 0);
    ctx.scale(-1, 1);
    cover(ctx, c.b, 0, 0, S, S, accent2);
    ctx.restore();
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "overlay";
    const g = ctx.createLinearGradient(0, 0, S, S);
    g.addColorStop(0, accent);
    g.addColorStop(1, accent2);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, S, S);
    ctx.globalCompositeOperation = "source-over";
  } else if (c.style === "duotone") {
    ctx.filter = "grayscale(1) contrast(1.4)";
    cover(ctx, c.a, 0, 0, S / 2, S, accent);
    cover(ctx, c.b, S / 2, 0, S / 2, S, accent2);
    ctx.filter = "none";
    ctx.globalCompositeOperation = "multiply";
    ctx.fillStyle = accent;
    ctx.fillRect(0, 0, S / 2, S);
    ctx.fillStyle = accent2;
    ctx.fillRect(S / 2, 0, S / 2, S);
    ctx.globalCompositeOperation = "source-over";
  } else {
    const n = 4;
    const cell = S / n;
    for (let i = 0; i < n; i++)
      for (let j = 0; j < n; j++) {
        const pick = (i + j) % 2 === 0 ? c.a : c.b;
        ctx.save();
        ctx.beginPath();
        ctx.rect(i * cell, j * cell, cell, cell);
        ctx.clip();
        cover(ctx, pick, (i % 2) * -cell, (j % 2) * -cell, cell * 2, cell * 2, (i + j) % 2 ? accent : accent2);
        ctx.restore();
      }
    ctx.globalCompositeOperation = "color";
    ctx.fillStyle = accent;
    ctx.globalAlpha = 0.35;
    ctx.fillRect(0, 0, S, S);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
  }

  // Legibility gradient + type.
  const g = ctx.createLinearGradient(0, S * 0.55, 0, S);
  g.addColorStop(0, "rgba(0,0,0,0)");
  g.addColorStop(1, "rgba(0,0,0,0.85)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);

  const pad = S * 0.06;
  ctx.fillStyle = "#fff";
  ctx.textBaseline = "alphabetic";
  // Title: up to two lines, shrinking until it fits.
  const title = c.title.toUpperCase() || "UNTITLED MIX";
  let size = S * 0.095;
  let lines: string[] = [];
  for (;;) {
    ctx.font = `800 ${size}px Inter, system-ui, sans-serif`;
    lines = [];
    let cur = "";
    for (const w of title.split(/\s+/)) {
      const next = cur ? `${cur} ${w}` : w;
      if (ctx.measureText(next).width > S - pad * 2 && cur) {
        lines.push(cur);
        cur = w;
      } else cur = next;
    }
    lines.push(cur);
    const widest = Math.max(...lines.map((l) => ctx.measureText(l).width));
    if ((lines.length <= 2 && widest <= S - pad * 2) || size < S * 0.035) break;
    size *= 0.92;
  }
  const baseY = S - pad - S * 0.055;
  lines.slice(0, 2).forEach((l, i, arr) => ctx.fillText(l, pad, baseY - (arr.length - 1 - i) * size * 1.02));
  ctx.font = `500 ${S * 0.035}px Inter, system-ui, sans-serif`;
  ctx.fillStyle = "rgba(255,255,255,0.8)";
  ctx.fillText(c.credit, pad, S - pad);

  // Corner badge.
  ctx.font = `700 ${S * 0.028}px "JetBrains Mono", monospace`;
  const badge = "MIX-MAKER";
  const bw = ctx.measureText(badge).width + S * 0.03;
  ctx.fillStyle = accent;
  ctx.fillRect(pad, pad, bw, S * 0.05);
  ctx.fillStyle = "#000";
  ctx.fillText(badge, pad + S * 0.015, pad + S * 0.036);
  ctx.restore();
}

export async function renderCoverPng(c: CoverInput, size = 1400): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  drawCover(canvas, c);
  return new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error("toBlob failed"))), "image/png"));
}
