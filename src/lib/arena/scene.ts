import type { Frame } from "../audio";
import { fogTexture, grainTexture } from "./atmosphere";
import { Crowd, HORIZON } from "./crowd";
import { Director, LAMP_COUNT, type RGB } from "./director";

/** Sis duvarı ve hüzmeler yarım çözünürlükte: hem ucuz hem doğal yumuşaklık */
const LIGHT_SCALE = 0.5;
const LAMP_Y = 0.118;
const TRUSS_Y = 0.095;
const LASER_Y = HORIZON - 0.012;

type Opts = { strobe: boolean; reduced: boolean };

const frac = (n: number) => n - Math.floor(n);
const rgba = ([r, g, b]: RGB, a: number) => `rgba(${r},${g},${b},${Math.max(0, Math.min(1, a))})`;

export class ArenaScene {
  readonly director = new Director();
  private crowd = new Crowd();
  private light = document.createElement("canvas");
  private lctx: CanvasRenderingContext2D;
  private fogA: CanvasPattern;
  private fogB: CanvasPattern;
  private grainTex = grainTexture();
  private grain: CanvasPattern | null = null;
  private w = 0;
  private h = 0;
  private t = 0;

  constructor() {
    const lctx = this.light.getContext("2d");
    if (!lctx) throw new Error("Canvas 2D desteklenmiyor");
    this.lctx = lctx;
    this.fogA = lctx.createPattern(fogTexture(11, 0.45, 1, 1.8), "repeat")!;
    this.fogB = lctx.createPattern(fogTexture(23, 0.65, 1, 1.4), "repeat")!;
  }

  resize(w: number, h: number) {
    this.w = w;
    this.h = h;
    this.light.width = Math.max(1, Math.round(w * LIGHT_SCALE));
    this.light.height = Math.max(1, Math.round(h * LIGHT_SCALE));
    this.crowd.build(w, h);
  }

  render(ctx: CanvasRenderingContext2D, f: Frame, dt: number, o: Opts) {
    const { w, h } = this;
    if (!w || !h) return;
    this.t += dt;
    const d = this.director;
    d.update(f, dt, { ...o, aspect: w / h });

    this.renderLight(o.reduced);

    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = "lighter";
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(this.light, 0, 0, w, h);

    ctx.globalCompositeOperation = "source-over";
    this.drawTruss(ctx, w, h);
    this.drawLamps(ctx, w, h);
    this.drawStage(ctx, w, h);
    this.drawLasers(ctx, w, h);
    this.crowd.draw(ctx, this.t, f.phase, d.groove, d.flash, d.wash);
    this.drawSpots(ctx, w, h);
    this.drawLaserFan(ctx, w, h);
    this.drawFinish(ctx, w, h, o.reduced);
  }

  /** Sahne arkasındaki dev sis duvarı + tavan hüzmeleri, sisle kırılmış */
  private renderLight(reduced: boolean) {
    const L = this.lctx;
    const lw = this.light.width;
    const lh = this.light.height;
    const d = this.director;
    const hy = HORIZON * lh;

    L.globalCompositeOperation = "source-over";
    L.globalAlpha = 1;
    L.fillStyle = "#000";
    L.fillRect(0, 0, lw, lh);
    L.globalCompositeOperation = "lighter";

    if (d.wash > 0.003) {
      // Duvar: ufukta en parlak (yerden yukarı vuran ışık), yukarı doğru söner
      const g = L.createLinearGradient(0, 0, 0, hy);
      g.addColorStop(0, rgba(d.washColor, d.wash * 0.22));
      g.addColorStop(0.55, rgba(d.washColor, d.wash * 0.5));
      g.addColorStop(0.9, rgba(d.washColor, d.wash * 0.95));
      g.addColorStop(1, rgba(d.washColor, d.wash));
      L.fillStyle = g;
      L.fillRect(0, 0, lw, hy);
      // Ufuk çizgisindeki sıcak çekirdek
      L.save();
      L.translate(lw / 2, hy);
      L.scale(1, 0.12);
      const r = lw * 0.6;
      const c = L.createRadialGradient(0, 0, 0, 0, 0, r);
      c.addColorStop(0, rgba([255, 255, 255], d.wash * 0.8));
      c.addColorStop(1, rgba([255, 255, 255], 0));
      L.fillStyle = c;
      L.fillRect(-r, -r, r * 2, r * 2);
      L.restore();
    }

    for (const b of d.beams) if (b.inten > 0.004) drawBeam(L, b.x * lw, b.y * lh, b.angle, lh * 0.95, b.inten, d.beamColor, d.beamWidth);

    // Sis: ışığı çarparak kırar, duvarı bulut gibi gösterir
    L.globalCompositeOperation = "multiply";
    const drift = reduced ? 0.3 : 1;
    this.fogA.setTransform(new DOMMatrix().translateSelf(this.t * 6 * drift, this.t * 1.2 * drift).scaleSelf(1.7));
    L.fillStyle = this.fogA;
    L.fillRect(0, 0, lw, lh);
    this.fogB.setTransform(new DOMMatrix().translateSelf(-this.t * 3.5 * drift, -this.t * 1.8 * drift).scaleSelf(1));
    L.fillStyle = this.fogB;
    L.fillRect(0, 0, lw, lh);
  }

  private drawTruss(ctx: CanvasRenderingContext2D, w: number, h: number) {
    // Işıklı duvarın önünde koyu silüet olarak okunur
    const y = TRUSS_Y * h;
    const th = Math.max(3, h * 0.008);
    ctx.fillStyle = "#030305";
    ctx.fillRect(0, y, w, th);
    ctx.fillRect(0, y + th * 2.2, w, th * 0.6);
    ctx.strokeStyle = "#030305";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 0; x < w; x += w / 14) {
      ctx.moveTo(x, 0);
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  private drawLamps(ctx: CanvasRenderingContext2D, w: number, h: number) {
    const d = this.director;
    const S = Math.min(w, h);
    const y = LAMP_Y * h;
    ctx.globalCompositeOperation = "lighter";
    for (let i = 0; i < LAMP_COUNT; i++) {
      const v = d.lamps[i];
      const x = (0.22 + (i / (LAMP_COUNT - 1)) * 0.56) * w;
      if (v < 0.02) {
        ctx.fillStyle = "rgba(120,130,160,0.08)";
        ctx.fillRect(x - 1, y - 1, 2, 2);
        continue;
      }
      const r = S * (0.012 + 0.03 * v);
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, `rgba(255,252,245,${v})`);
      g.addColorStop(0.15, `rgba(255,245,230,${v * 0.6})`);
      g.addColorStop(1, "rgba(255,240,220,0)");
      ctx.fillStyle = g;
      ctx.fillRect(x - r, y - r, r * 2, r * 2);
    }
    // Tavan hüzme fikstürlerinin lensleri
    for (const b of d.beams) {
      if (b.inten < 0.03) continue;
      const x = b.x * w;
      const yy = b.y * h;
      const r = S * 0.012 * (0.5 + b.inten);
      const g = ctx.createRadialGradient(x, yy, 0, x, yy, r);
      g.addColorStop(0, rgba(d.beamColor, b.inten));
      g.addColorStop(1, rgba(d.beamColor, 0));
      ctx.fillStyle = g;
      ctx.fillRect(x - r, yy - r, r * 2, r * 2);
    }
    ctx.globalCompositeOperation = "source-over";
  }

  private drawStage(ctx: CanvasRenderingContext2D, w: number, h: number) {
    const d = this.director;
    const hy = HORIZON * h;
    const S = Math.min(w, h);

    // DJ kabini: ince aydınlatılmış çerçeve, içinde silüet
    const bw = Math.max(40, w * 0.075);
    const bh = Math.max(10, h * 0.028);
    const bx = w / 2 - bw / 2;
    const by = hy - bh - h * 0.004;
    ctx.fillStyle = "#000";
    ctx.beginPath();
    ctx.arc(w / 2, by - bh * 0.35, bh * 0.28, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillRect(w / 2 - bh * 0.45, by - bh * 0.1, bh * 0.9, bh * 0.5);
    ctx.fillRect(bx, by, bw, bh);
    ctx.strokeStyle = `rgba(230,240,255,${0.18 + 0.7 * d.led})`;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(bx, by, bw, bh);

    // Sahne önü LED şerit: her kick'te tek/çift noktalar dönüşümlü yanar
    ctx.globalCompositeOperation = "lighter";
    const step = Math.max(12, w * 0.02);
    const r = Math.max(3, S * 0.008);
    const ly = hy - Math.max(4, h * 0.012);
    const count = Math.ceil((w * 0.72) / step);
    // Her kick'te 3 nokta ilerleyen, ortadan iki yana açılan koşu ışığı
    const head = (d.ledStep * 3) % Math.ceil(count / 2);
    let n = 0;
    for (let x = w * 0.14; x < w * 0.86; x += step, n++) {
      const fromCenter = Math.abs(n - (count - 1) / 2);
      const dist = Math.abs(fromCenter - head);
      const chase = dist < 3 ? 1 - dist / 3 : 0;
      const twinkle = frac(Math.sin(n * 91.7 + d.hatCount * 13.1) * 4375.5) > 0.72 ? d.hatHit * 0.75 : 0;
      const on = Math.max(n % 2 === d.ledAlt ? d.led * 0.55 : d.led * 0.15, chase * d.led, twinkle);
      const g = ctx.createRadialGradient(x, ly, 0, x, ly, r * 3);
      g.addColorStop(0, `rgba(200,220,255,${0.08 + 0.92 * on})`);
      g.addColorStop(0.35, `rgba(90,140,255,${0.04 + 0.6 * on})`);
      g.addColorStop(1, "rgba(90,140,255,0)");
      ctx.fillStyle = g;
      ctx.fillRect(x - r * 3, ly - r * 3, r * 6, r * 6);
    }
    // Sahnenin iki yanında dikey LED kolonlar: kick gücü kadar aşağıdan yukarı dolar
    const segs = 14;
    const colH = h * 0.45;
    const segH = colH / segs;
    for (const cx of [w * 0.1, w * 0.9]) {
      for (let i = 0; i < segs; i++) {
        const lit = i / segs < d.ledLevel ? 1 : 0;
        const a = 0.05 + 0.85 * lit * (0.5 + 0.5 * d.led);
        ctx.fillStyle = `rgba(${lit ? "180,205,255" : "90,140,255"},${a})`;
        ctx.fillRect(cx - S * 0.016, hy - (i + 1) * segH + 2, S * 0.032, segH - 4);
      }
    }
    if (d.led > 0.05) {
      const g = ctx.createLinearGradient(0, hy - S * 0.05, 0, hy + 2);
      g.addColorStop(0, "rgba(90,140,255,0)");
      g.addColorStop(1, `rgba(90,140,255,${0.22 * d.led})`);
      ctx.fillStyle = g;
      ctx.fillRect(w * 0.12, hy - S * 0.05, w * 0.76, S * 0.05 + 2);
    }
    ctx.globalCompositeOperation = "source-over";
  }

  /** Sahne kenarlarından seyirci hizasında yatay, keskin lazerler */
  private drawLasers(ctx: CanvasRenderingContext2D, w: number, h: number) {
    const d = this.director;
    if (d.laserL < 0.01 && d.laserR < 0.01) return;
    const y = LASER_Y * h;
    ctx.globalCompositeOperation = "lighter";
    ctx.lineCap = "round";
    for (const [ex, dir, v] of [
      [0.3, -1, d.laserL],
      [0.7, 1, d.laserR],
    ] as const) {
      if (v < 0.01) continue;
      const x = ex * w;
      for (let k = -3; k <= 3; k++) {
        const a = d.laserTilt + k * d.laserSpread * 0.07;
        const ang = dir > 0 ? a : Math.PI - a;
        const x2 = x + Math.cos(ang) * w;
        const y2 = y + Math.sin(ang) * w;
        laserLine(ctx, x, y, x2, y2, d.laserColor, v);
      }
      flare(ctx, x, y, Math.min(w, h) * 0.07 * v, d.laserColor, v);
    }
    ctx.globalCompositeOperation = "source-over";
  }

  /**
   * Tepeden (kameranın üstündeki truss'tan) seyirciye inen spotlar: sisli koni +
   * kalabalığın başlarında ışık havuzu. Kalabalıktan sonra çizilir.
   */
  private drawSpots(ctx: CanvasRenderingContext2D, w: number, h: number) {
    const d = this.director;
    ctx.globalCompositeOperation = "lighter";
    for (const sp of d.spots) {
      const v = sp.inten;
      if (v < 0.01) continue;
      const x0 = sp.x * w;
      const y0 = -h * 0.02;
      const px = sp.px * w;
      const py = sp.py * h;
      const rx = w * 0.07;
      const ry = h * 0.035;
      // Koni
      const g = ctx.createLinearGradient(x0, y0, px, py);
      g.addColorStop(0, `rgba(235,242,255,${0.35 * v})`);
      g.addColorStop(0.5, `rgba(220,232,255,${0.1 * v})`);
      g.addColorStop(1, `rgba(220,232,255,${0.16 * v})`);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(x0 - w * 0.006, y0);
      ctx.lineTo(px - rx, py);
      ctx.lineTo(px + rx, py);
      ctx.lineTo(x0 + w * 0.006, y0);
      ctx.closePath();
      ctx.fill();
      // Kalabalıktaki ışık havuzu
      ctx.save();
      ctx.translate(px, py);
      ctx.scale(1, ry / rx);
      const pool = ctx.createRadialGradient(0, 0, 0, 0, 0, rx);
      pool.addColorStop(0, `rgba(235,242,255,${0.45 * v})`);
      pool.addColorStop(0.6, `rgba(220,232,255,${0.15 * v})`);
      pool.addColorStop(1, "rgba(220,232,255,0)");
      ctx.fillStyle = pool;
      ctx.fillRect(-rx, -rx, rx * 2, rx * 2);
      ctx.restore();
    }
    ctx.globalCompositeOperation = "source-over";
  }

  /** Peak'te sahne ortasından kalabalığın üzerine açılan lazer yelpazesi */
  private drawLaserFan(ctx: CanvasRenderingContext2D, w: number, h: number) {
    const d = this.director;
    if (d.laserFan < 0.01) return;
    const x = w / 2;
    const y = (HORIZON - 0.02) * h;
    ctx.globalCompositeOperation = "lighter";
    // Kick'te yeni yön; vuruş boyunca o yöne doğru süpürür, sonraki kick'te sıfırlanır
    const sweep = d.fanDir * d.phase * 0.35;
    for (let k = -4; k <= 4; k++) {
      // Çizgi seçimi kick'ten kick'e değişir: hepsi / tekler / çiftler
      if (d.fanMask === 1 && k % 2 === 0) continue;
      if (d.fanMask === 2 && k % 2 !== 0) continue;
      // Her çizginin kendi sapması (kick başına sabit, kare kare değil)
      const own = Math.sin(k * 1.7 + d.fanSeed * 2.3) * 0.09;
      const ang = Math.PI / 2 + d.fanCenter + sweep + (k / 4) * (0.3 + d.laserSpread * 0.6) + own;
      laserLine(ctx, x, y, x + Math.cos(ang) * h * 1.2, y + Math.sin(ang) * h * 1.2, d.laserColor, d.laserFan);
    }
    ctx.globalCompositeOperation = "source-over";
  }

  private drawFinish(ctx: CanvasRenderingContext2D, w: number, h: number, reduced: boolean) {
    const m = Math.max(w, h);
    const v = ctx.createRadialGradient(w / 2, h * 0.45, m * 0.3, w / 2, h * 0.45, m * 0.85);
    v.addColorStop(0, "rgba(0,0,0,0)");
    v.addColorStop(1, "rgba(0,0,0,0.6)");
    ctx.fillStyle = v;
    ctx.fillRect(0, 0, w, h);

    this.grain ??= ctx.createPattern(this.grainTex, "repeat");
    if (this.grain) {
      const ox = reduced ? 0 : Math.floor(Math.random() * 128);
      const oy = reduced ? 0 : Math.floor(Math.random() * 128);
      this.grain.setTransform(new DOMMatrix().translateSelf(ox, oy));
      ctx.globalAlpha = 0.03;
      ctx.fillStyle = this.grain;
      ctx.fillRect(0, 0, w, h);
      ctx.globalAlpha = 1;
    }
  }
}

function drawBeam(
  L: CanvasRenderingContext2D, x: number, y: number, angle: number, len: number, inten: number, color: RGB, widthScale = 1,
) {
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  const ex = x + dx * len;
  const ey = y + dy * len;
  const px = -dy;
  const py = dx;
  const grad = L.createLinearGradient(x, y, ex, ey);
  grad.addColorStop(0, rgba(color, 1));
  grad.addColorStop(0.15, rgba(color, 0.5));
  grad.addColorStop(0.6, rgba(color, 0.15));
  grad.addColorStop(1, rgba(color, 0));
  L.fillStyle = grad;
  for (const [spread, a] of [
    [0.09, 0.25],
    [0.04, 0.6],
    [0.012, 1],
  ] as const) {
    const s = Math.tan(spread * widthScale) * len;
    L.globalAlpha = Math.min(1, inten * a);
    L.beginPath();
    L.moveTo(x + px, y + py);
    L.lineTo(ex + px * s, ey + py * s);
    L.lineTo(ex - px * s, ey - py * s);
    L.lineTo(x - px, y - py);
    L.closePath();
    L.fill();
  }
  L.globalAlpha = 1;
}

function laserLine(ctx: CanvasRenderingContext2D, x: number, y: number, x2: number, y2: number, c: RGB, v: number) {
  const g = ctx.createLinearGradient(x, y, x2, y2);
  g.addColorStop(0, rgba(c, v));
  g.addColorStop(1, rgba(c, v * 0.25));
  ctx.strokeStyle = g;
  ctx.globalAlpha = 0.22;
  ctx.lineWidth = 12;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x2, y2);
  ctx.stroke();
  ctx.globalAlpha = 0.5;
  ctx.lineWidth = 5;
  ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.lineWidth = 2.2;
  ctx.stroke();
}

function flare(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, c: RGB, v: number) {
  if (r < 1) return;
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, rgba([255, 255, 255], v));
  g.addColorStop(0.2, rgba(c, v * 0.6));
  g.addColorStop(1, rgba(c, 0));
  ctx.fillStyle = g;
  ctx.fillRect(x - r, y - r, r * 2, r * 2);
}
