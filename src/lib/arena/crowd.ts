import { mulberry32 } from "./rng";

/** Aynı ritimde zıplayan küçük insan grubu: tek Path2D, her kare yalnızca kaydırılır */
type Chunk = { path: Path2D; off: number; amp: number };
type Phone = { x: number; y: number; w: number; h: number; flick: number; seed: number };
type Row = { chunks: Chunk[]; phones: Phone[]; tone: string; rim: number };

const ROWS = 26;
/** Kalabalığın üst kenarı (sahne ufku) */
export const HORIZON = 0.605;

/**
 * Geniş bir arenada sahneye bakan yoğun kalabalık. Uzak sıralar küçük ve pusta,
 * yakın sıralar büyük ve simsiyah. Rastgelelik sadece kurulumda (tohumlu).
 */
export class Crowd {
  private rows: Row[] = [];

  build(w: number, h: number) {
    const rng = mulberry32(11);
    const S = Math.min(h, Math.max(w * 1.2, Math.sqrt(w * h)));
    this.rows = [];
    for (let r = 0; r < ROWS; r++) {
      const t = r / (ROWS - 1);
      const y = (HORIZON + t ** 1.7 * 0.43) * h;
      const u = S * (0.006 + t ** 1.6 * 0.072);
      const chunks: Chunk[] = [];
      const phones: Phone[] = [];
      let x = -u * 2 * rng();
      while (x < w + u * 2) {
        const path = new Path2D();
        const n = 4 + Math.floor(rng() * 6);
        for (let i = 0; i < n && x < w + u * 2; i++) {
          addPerson(path, rng, x, y + (rng() - 0.5) * u * 0.5, u, h, phones);
          x += u * (1.05 + rng() * 0.6);
        }
        chunks.push({ path, off: rng() * 0.2, amp: u * (0.12 + rng() * 0.2) });
      }
      // Uzak sıralar pus rengine yakın, ön sıralar simsiyah
      const g = Math.round(14 * (1 - t) ** 2);
      this.rows.push({ chunks, phones, tone: `rgb(${g},${g},${g + 4})`, rim: t });
    }
  }

  draw(
    ctx: CanvasRenderingContext2D, t: number, beatPhase: number, groove: number, flash: number, lights: number,
  ) {
    ctx.globalCompositeOperation = "source-over";
    const rimA = Math.min(0.5, flash * 0.45);
    for (const row of this.rows) {
      for (const c of row.chunks) {
        const ph = frac(beatPhase - c.off);
        const dy = (1 - ph) ** 3 * c.amp * groove;
        ctx.save();
        ctx.translate(0, dy);
        if (rimA > 0.02 && row.rim > 0.3) {
          // Arkadan gelen ışık: omuz/baş üst kenarında ince çizgi
          ctx.translate(0, -1.2);
          ctx.fillStyle = `rgba(205,220,255,${rimA * row.rim})`;
          ctx.fill(c.path);
          ctx.translate(0, 1.2);
        }
        ctx.fillStyle = row.tone;
        ctx.fill(c.path);
        ctx.restore();
      }
      // Havaya kaldırılmış telefon ekranları
      for (const p of row.phones) {
        const tw = 0.75 + 0.25 * Math.sin(t * p.flick + p.seed);
        ctx.fillStyle = `rgba(215,228,255,${(0.25 + 0.35 * lights) * tw})`;
        ctx.fillRect(p.x, p.y, p.w, p.h);
      }
    }
  }
}

const frac = (n: number) => n - Math.floor(n);

function addPerson(path: Path2D, rng: () => number, x: number, y: number, u: number, h: number, phones: Phone[]) {
  const head = u * (0.36 + rng() * 0.08);
  const sw = u * (0.95 + rng() * 0.3);
  // Gövde + omuzlar (ekranın altına kadar)
  path.moveTo(x - sw / 2, h + 2);
  path.lineTo(x - sw / 2, y + u * 0.35);
  path.quadraticCurveTo(x - sw / 2, y, x - sw * 0.2, y - u * 0.05);
  path.lineTo(x + sw * 0.2, y - u * 0.05);
  path.quadraticCurveTo(x + sw / 2, y, x + sw / 2, y + u * 0.35);
  path.lineTo(x + sw / 2, h + 2);
  path.closePath();
  // Baş
  path.moveTo(x + head, y - u * 0.42);
  path.ellipse(x, y - u * 0.42, head * 0.85, head, 0, 0, Math.PI * 2);

  const r = rng();
  const arm = (side: number, lift: number) => {
    // Kalkık kol: omuzdan yukarı-dışa ince dörtgen + el
    const sx = x + side * sw * 0.42;
    const ex = sx + side * u * (0.15 + rng() * 0.25);
    const ey = y - u * (1.0 + lift);
    const aw = u * 0.13;
    path.moveTo(sx - aw, y + u * 0.1);
    path.lineTo(ex - aw * 0.8, ey);
    path.lineTo(ex + aw * 0.8, ey);
    path.lineTo(sx + aw, y + u * 0.1);
    path.closePath();
    path.moveTo(ex + aw, ey);
    path.arc(ex, ey, aw, 0, Math.PI * 2);
    return { ex, ey };
  };
  if (r < 0.14) {
    arm(-1, rng() * 0.4);
    arm(1, rng() * 0.4);
  } else if (r < 0.3) {
    const hand = arm(rng() < 0.5 ? -1 : 1, rng() * 0.5);
    // Kalkık elin bir kısmında telefon
    if (rng() < 0.45 && u > 3) {
      const pw = Math.max(1.2, Math.min(9, u * 0.2));
      phones.push({ x: hand.ex - pw / 2, y: hand.ey - pw * 1.9, w: pw, h: pw * 1.7, flick: 0.5 + rng() * 2, seed: rng() * 10 });
    }
  }
}
