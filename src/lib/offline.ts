/**
 * Şarkının tamamını çalmadan önce analiz eder (ışık masasındaki "timecode" programı gibi):
 * bütün kick'ler, hi-hat'ler, seviyeler, break'ler ve drop'lar saniyesiyle önceden bulunur.
 * Çalarken ışıklar dinlemez, şarkının o anki saniyesine bakıp bu plandan okur.
 */

/** s: güç 0..1, m: eşiği ne kadar aştığı (1 = tam sınırda). Hassasiyet çalarken m'ye göre süzer */
export type Kick = { t: number; s: number; m: number };

export type Plan = {
  duration: number;
  /** Seviye zarfları, HOP saniyede bir örnek, 0..1 */
  hop: number;
  bass: Float32Array;
  mid: Float32Array;
  high: Float32Array;
  kicks: Kick[];
  hats: number[];
  /** Clap / snare (genelde 2. ve 4. vuruş) */
  claps: number[];
  /** Kick yok bölümler (break) */
  breaks: { start: number; end: number; drop: boolean }[];
  bpm: number | null;
  period: number;
};

const SR = 16000;
const HOP = 0.01;
const RANGE = 30;

/** Dosyayı 16 kHz mono'ya çözer (uzun setlerde belleği küçük tutar) */
export async function decodeMono(data: ArrayBuffer): Promise<Float32Array> {
  const ctx = new OfflineAudioContext(1, 1, SR);
  const buf = await ctx.decodeAudioData(data);
  const n = buf.length;
  const out = new Float32Array(n);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const ch = buf.getChannelData(c);
    for (let i = 0; i < n; i++) out[i] += ch[i] / buf.numberOfChannels;
  }
  return out;
}

type Biquad = { b0: number; b1: number; b2: number; a1: number; a2: number };

/** RBJ biquad katsayıları */
function biquad(type: "lowpass" | "highpass", f: number, q = 0.707): Biquad {
  const w = (2 * Math.PI * f) / SR;
  const cos = Math.cos(w);
  const alpha = Math.sin(w) / (2 * q);
  const a0 = 1 + alpha;
  const b1 = type === "lowpass" ? 1 - cos : -(1 + cos);
  const b0 = b1 * (type === "lowpass" ? 0.5 : -0.5);
  return { b0: b0 / a0, b1: b1 / a0, b2: b0 / a0, a1: (-2 * cos) / a0, a2: (1 - alpha) / a0 };
}

/** Filtreler sinyali ve HOP başına RMS'i dB olarak döner (filtreli sinyali bellekte tutmadan) */
function bandDb(x: Float32Array, chain: Biquad[]): Float32Array {
  const hop = Math.round(SR * HOP);
  const frames = Math.floor(x.length / hop);
  const out = new Float32Array(frames);
  const st = chain.map(() => [0, 0, 0, 0]);
  let acc = 0;
  for (let i = 0, f = 0; f < frames; i++) {
    let v = x[i];
    for (let k = 0; k < chain.length; k++) {
      const c = chain[k];
      const s = st[k];
      const y = c.b0 * v + c.b1 * s[0] + c.b2 * s[1] - c.a1 * s[2] - c.a2 * s[3];
      s[1] = s[0];
      s[0] = v;
      s[3] = s[2];
      s[2] = y;
      v = y;
    }
    acc += v * v;
    if ((i + 1) % hop === 0) {
      out[f++] = 10 * Math.log10(acc / hop + 1e-12);
      acc = 0;
    }
  }
  return out;
}

function percentile(a: Float32Array, p: number) {
  const s = Array.from(a).filter((v) => v > -90).sort((x, y) => x - y);
  return s.length ? s[Math.floor((s.length - 1) * p)] : -60;
}

/** dB → 0..1, parçanın kendi tepesine göre (30 dB aralık) */
function normalize(db: Float32Array) {
  const top = percentile(db, 0.97);
  return db.map((v) => Math.min(1, Math.max(0, (v - (top - RANGE)) / RANGE)));
}

/** Ani dB yükselişleri; eşik iki yönlü komşulukla (geleceği de bildiğimiz için) uyarlanır */
function onsets(db: Float32Array, minGap: number, k: number, c: number, floor: number) {
  const n = db.length;
  const rise = new Float32Array(n);
  for (let i = 2; i < n; i++) rise[i] = Math.max(0, db[i] - Math.min(db[i - 1], db[i - 2]));
  // Kayan ortalama (±1 sn)
  const W = 100;
  const pre = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + rise[i];
  const out: { i: number; r: number; m: number }[] = [];
  let last = -1e9;
  for (let i = 3; i < n - 3; i++) {
    const lo = Math.max(0, i - W);
    const hi = Math.min(n, i + W);
    const thr = ((pre[hi] - pre[lo]) / (hi - lo)) * k + c;
    if (rise[i] < thr) continue;
    if (rise[i] < rise[i - 1] || rise[i] < rise[i + 1]) continue;
    // Atak sonrası seviye parçanın tepesine yakın olmalı (break'teki gürültü kick değil)
    const after = Math.max(db[i], db[i + 1], db[i + 2], db[i + 3]);
    if (after < floor) continue;
    if (i - last < minGap) {
      // Çok yakın iki aday: güçlü olan kalsın
      if (out.length && rise[i] > out[out.length - 1].r) {
        out[out.length - 1] = { i, r: rise[i], m: rise[i] / thr };
        last = i;
      }
      continue;
    }
    out.push({ i, r: rise[i], m: rise[i] / thr });
    last = i;
  }
  return out;
}

export function analyze(x: Float32Array): Plan {
  const duration = x.length / SR;
  const bassDb = bandDb(x, [biquad("lowpass", 150), biquad("lowpass", 150)]);
  const midDb = bandDb(x, [biquad("highpass", 150), biquad("lowpass", 2000)]);
  const highDb = bandDb(x, [biquad("highpass", 5000), biquad("highpass", 5000)]);

  const bassTop = percentile(bassDb, 0.97);
  // En hassas eşikle bütün adaylar bulunur; hangilerinin ışık yakacağına çalarken
  // Hassasiyet sürgüsü karar verir (canlı değiştirilebilir)
  const raw = onsets(bassDb, 18, 1.25, 1.2, bassTop - 18);
  const maxR = Math.max(1e-6, ...raw.map((o) => o.r));
  const kicks: Kick[] = raw.map((o) => ({ t: o.i * HOP, s: Math.min(1, 0.4 + (0.6 * o.r) / maxR), m: o.m }));

  const highTop = percentile(highDb, 0.97);
  const hats = onsets(highDb, 8, 1.6, 2, highTop - 22).map((o) => o.i * HOP);

  // Clap/snare: 1.5–5 kHz gürültü patlaması
  const clapDb = bandDb(x, [biquad("highpass", 1500), biquad("highpass", 1500), biquad("lowpass", 5000)]);
  const clapTop = percentile(clapDb, 0.97);
  // Sadece parçanın en güçlü orta-tiz patlamaları: hi-hat'ler burada daha zayıf kalır
  const claps = onsets(clapDb, 20, 2, 4, clapTop - 5).map((o) => o.i * HOP);

  const bass = normalize(bassDb);
  const { bpm, period, breaks } = structure(kicks, bass, HOP, duration);
  return { duration, hop: HOP, bass, mid: normalize(midDb), high: normalize(highDb), kicks, hats, claps, breaks, bpm, period };
}

/**
 * Kick listesinden tempo ve break/drop yapısını çıkarır. Hem dosya analizi hem
 * YouTube hafızası (canlı dinlenerek öğrenilen plan) bunu kullanır.
 */
export function structure(
  kicks: Kick[], bass: Float32Array, hop: number, duration: number,
  isCovered: (a: number, b: number) => boolean = () => true,
) {
  // Tempo: kick aralıklarının en sık değeri (0.3–0.75 sn = 80–200 BPM)
  const hist = new Map<number, number>();
  for (let i = 1; i < kicks.length; i++) {
    const g = Math.round((kicks[i].t - kicks[i - 1].t) * 100);
    if (g >= 30 && g <= 75) hist.set(g, (hist.get(g) ?? 0) + 1);
  }
  let best = 0;
  let bestN = 0;
  for (const [g, n] of hist) {
    const score = n + (hist.get(g - 1) ?? 0) * 0.5 + (hist.get(g + 1) ?? 0) * 0.5;
    if (score > bestN) {
      bestN = score;
      best = g;
    }
  }
  // Tepe etrafındaki aralıkların ortalamasıyla hassaslaştır
  let sum = 0;
  let cnt = 0;
  for (let i = 1; i < kicks.length; i++) {
    const g = kicks[i].t - kicks[i - 1].t;
    if (Math.abs(g * 100 - best) <= 1.5) {
      sum += g;
      cnt++;
    }
  }
  const period = cnt ? sum / cnt : 0.47;
  const bpm = cnt > 8 ? 60 / period : null;

  // Break: kick'siz 2 sn'den uzun boşluk. Sonu 3.5 sn'den uzun ve sonraki kick güçlüyse drop.
  const breaks: Plan["breaks"] = [];
  const lvlAt = (t: number) => bass[Math.min(bass.length - 1, Math.max(0, Math.round(t / hop + 0.03 / hop)))] ?? 0;
  const pushBreak = (start: number, end: number, next: number | null) => {
    if (end - start < 2) return;
    breaks.push({ start, end, drop: next !== null && end - start >= 3.5 && lvlAt(next) > 0.55 });
  };
  if (kicks.length) {
    if (isCovered(0, kicks[0].t)) pushBreak(0, kicks[0].t, kicks[0].t);
    for (let i = 1; i < kicks.length; i++) {
      const gap = kicks[i].t - kicks[i - 1].t;
      // Kaydı olmayan (dinlenmemiş) aralık break sayılmaz
    if (gap > 2 && isCovered(kicks[i - 1].t, kicks[i].t)) pushBreak(kicks[i - 1].t + period, kicks[i].t, kicks[i].t);
    }
    const tail = kicks[kicks.length - 1].t + period;
    if (duration - tail > 2 && isCovered(tail, duration)) breaks.push({ start: tail, end: duration, drop: false });
  }

  return { bpm, period, breaks };
}
