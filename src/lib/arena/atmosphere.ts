import { mulberry32 } from "./rng";

const smooth = (t: number) => t * t * (3 - 2 * t);

function canvas(w: number, h: number) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

/** Döşenebilir fBm değer gürültüsü, kabaca 0..1 */
function tileNoise(size: number, seed: number) {
  const rng = mulberry32(seed);
  const out = new Float32Array(size * size);
  const octaves = [
    [3, 0.5],
    [6, 0.27],
    [12, 0.15],
    [24, 0.08],
  ] as const;
  for (const [cells, amp] of octaves) {
    const g = Float32Array.from({ length: cells * cells }, () => rng());
    for (let y = 0; y < size; y++) {
      const fy = (y / size) * cells;
      const y0 = Math.floor(fy);
      const ty = smooth(fy - y0);
      const y1 = (y0 + 1) % cells;
      for (let x = 0; x < size; x++) {
        const fx = (x / size) * cells;
        const x0 = Math.floor(fx);
        const tx = smooth(fx - x0);
        const x1 = (x0 + 1) % cells;
        const top = g[y0 * cells + x0] + (g[y0 * cells + x1] - g[y0 * cells + x0]) * tx;
        const bot = g[y1 * cells + x0] + (g[y1 * cells + x1] - g[y1 * cells + x0]) * tx;
        out[y * size + x] += (top + (bot - top) * ty) * amp;
      }
    }
  }
  return out;
}

/** Işık tamponunu çarpmak için gri sis dokusu: lo..hi aralığında */
export function fogTexture(seed: number, lo: number, hi: number, contrast: number) {
  const size = 256;
  const n = tileNoise(size, seed);
  const c = canvas(size, size);
  const ctx = c.getContext("2d")!;
  const img = ctx.createImageData(size, size);
  for (let i = 0; i < n.length; i++) {
    const v = Math.min(1, Math.max(0, (n[i] - 0.5) * contrast + 0.5));
    const g = (lo + (hi - lo) * v) * 255;
    img.data[i * 4] = g;
    img.data[i * 4 + 1] = g;
    img.data[i * 4 + 2] = g;
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

export function grainTexture() {
  const size = 128;
  const rng = mulberry32(5);
  const c = canvas(size, size);
  const ctx = c.getContext("2d")!;
  const img = ctx.createImageData(size, size);
  for (let i = 0; i < size * size; i++) {
    const g = rng() * 255;
    img.data[i * 4] = g;
    img.data[i * 4 + 1] = g;
    img.data[i * 4 + 2] = g;
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}
