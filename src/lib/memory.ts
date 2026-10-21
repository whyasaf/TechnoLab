import type { Frame } from "./audio";
import { structure, type Kick, type Plan } from "./offline";

/**
 * YouTube hafızası: bir videoyu ilk dinleyişte canlı analizden gelen olaylar
 * videonun saniyesiyle kaydedilir; sonraki açılışlarda bu plan dosya modu gibi oynar.
 * Sesin kendisi değil, sadece zaman bilgisi (kick/clap/hat anları, seviye zarfı) saklanır.
 */

const SLOT = 0.01;
/** Saklanan seviye zarfının çözünürlüğü */
const LEVEL_HOP = 0.05;
/** Bu kadarı dinlendiyse plan kaydedilir */
export const LEARN_COVERAGE = 0.85;
const KEY = "technolab.memory.v1:";

export class Recorder {
  readonly n: number;
  private kick: Float32Array;
  private hat: Uint8Array;
  private clap: Uint8Array;
  private bass: Uint8Array;
  private mid: Uint8Array;
  private high: Uint8Array;
  private covered: Uint8Array;
  private coveredCount = 0;
  private lastI = -1;

  constructor(readonly id: string, readonly duration: number) {
    this.n = Math.ceil(duration / SLOT) + 1;
    this.kick = new Float32Array(this.n);
    this.hat = new Uint8Array(this.n);
    this.clap = new Uint8Array(this.n);
    this.bass = new Uint8Array(this.n);
    this.mid = new Uint8Array(this.n);
    this.high = new Uint8Array(this.n);
    this.covered = new Uint8Array(this.n);
  }

  /** t: olayın videodaki saniyesi (gecikmesi düşülmüş) */
  record(t: number, f: Frame) {
    const i = Math.round(t / SLOT);
    if (i < 0 || i >= this.n) return;
    // Kesintisiz çalmada iki kare arasındaki slotları da dinlenmiş say; atlamada sayma
    const from = this.lastI >= 0 && i > this.lastI && i - this.lastI < 20 ? this.lastI + 1 : i;
    for (let j = from; j <= i; j++) {
      if (!this.covered[j]) {
        this.covered[j] = 1;
        this.coveredCount++;
      }
      // Bu aralık yeniden dinleniyorsa eski olayları temizle
      this.kick[j] = 0;
      this.hat[j] = 0;
      this.clap[j] = 0;
      this.bass[j] = Math.round(f.bass * 255);
      this.mid[j] = Math.round(f.mid * 255);
      this.high[j] = Math.round(f.high * 255);
    }
    if (f.beat) this.kick[i] = Math.max(0.05, f.strength);
    if (f.hat) this.hat[i] = 1;
    if (f.clap) this.clap[i] = 1;
    this.lastI = i;
  }

  coverage() {
    return this.coveredCount / this.n;
  }

  toPlan(): Plan {
    const per = Math.round(LEVEL_HOP / SLOT);
    const m = Math.ceil(this.n / per);
    const down = (a: Uint8Array) => {
      const out = new Float32Array(m);
      for (let k = 0; k < m; k++) {
        let s = 0;
        let c = 0;
        for (let j = k * per; j < Math.min(this.n, (k + 1) * per); j++, c++) s += a[j];
        out[k] = c ? s / c / 255 : 0;
      }
      return out;
    };
    const kicks: Kick[] = [];
    const hats: number[] = [];
    const claps: number[] = [];
    for (let i = 0; i < this.n; i++) {
      // Canlı kayıtta kick'ler zaten hassasiyet eşiğinden geçti: hepsi çalarken yanar
      if (this.kick[i] > 0) kicks.push({ t: i * SLOT, s: this.kick[i], m: 9 });
      if (this.hat[i]) hats.push(i * SLOT);
      if (this.clap[i]) claps.push(i * SLOT);
    }
    const bass = down(this.bass);
    const covered = this.covered;
    const isCovered = (a: number, b: number) => {
      const i0 = Math.max(0, Math.round(a / SLOT));
      const i1 = Math.min(this.n, Math.round(b / SLOT));
      let c = 0;
      for (let i = i0; i < i1; i++) c += covered[i];
      return i1 > i0 && c / (i1 - i0) > 0.9;
    };
    const { bpm, period, breaks } = structure(kicks, bass, LEVEL_HOP, this.duration, isCovered);
    return {
      duration: this.duration, hop: LEVEL_HOP, bass, mid: down(this.mid), high: down(this.high),
      kicks, hats, claps, breaks, bpm, period,
    };
  }
}

const toB64 = (a: Float32Array) => {
  // Parça parça: uzun setlerde tek seferde yayma (spread) argüman sınırını aşar
  let bin = "";
  for (let i = 0; i < a.length; i += 8192) {
    bin += String.fromCharCode(...Array.from(a.subarray(i, i + 8192), (v) => Math.round(v * 255)));
  }
  return btoa(bin);
};
const fromB64 = (s: string) => Float32Array.from(atob(s), (c) => c.charCodeAt(0) / 255);
const r2 = (v: number) => Math.round(v * 100);

export function savePlan(id: string, plan: Plan) {
  try {
    localStorage.setItem(
      KEY + id,
      JSON.stringify({
        duration: plan.duration, hop: plan.hop, bpm: plan.bpm, period: plan.period, breaks: plan.breaks,
        bass: toB64(plan.bass), mid: toB64(plan.mid), high: toB64(plan.high),
        kicks: plan.kicks.map((k) => [r2(k.t), r2(k.s)]),
        hats: plan.hats.map(r2),
        claps: plan.claps.map(r2),
      }),
    );
    return true;
  } catch {
    return false;
  }
}

export function loadPlan(id: string): Plan | null {
  try {
    const raw = localStorage.getItem(KEY + id);
    if (!raw) return null;
    const d = JSON.parse(raw);
    return {
      duration: d.duration, hop: d.hop, bpm: d.bpm, period: d.period, breaks: d.breaks,
      bass: fromB64(d.bass), mid: fromB64(d.mid), high: fromB64(d.high),
      kicks: d.kicks.map(([t, s]: [number, number]) => ({ t: t / 100, s: s / 100, m: 9 })),
      hats: d.hats.map((t: number) => t / 100),
      claps: d.claps.map((t: number) => t / 100),
    };
  } catch {
    return null;
  }
}

export function forgetPlan(id: string) {
  try {
    localStorage.removeItem(KEY + id);
  } catch {
    /* depolama yok */
  }
}
