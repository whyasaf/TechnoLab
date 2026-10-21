/**
 * Onset zarfı üzerinden otokorelasyonla tempo tahmini + faz kilidi.
 * Ham bas genliğinden BPM uydurmak yerine, vuruşların periyodikliğini ölçer.
 */
const RATE = 100; // Hz, onset zarfının örnekleme hızı
const SIZE = RATE * 8; // 8 sn pencere
const LAG_MIN = Math.round((60 / 180) * RATE);
const LAG_MAX = Math.round((60 / 78) * RATE);
const MIN_CONFIDENCE = 0.2;

export class TempoTracker {
  locked = false;
  bpm: number | null = null;
  confidence = 0;

  private buf = new Float32Array(SIZE);
  private written = 0;
  private nextT = 0;
  private acc = 0;
  private lastAnalyze = 0;
  private period = 0; // ms
  private anchor = 0; // bir vuruşun zamanı (ms)
  private anchorIndex = 0; // anchor'daki vuruşun sıra numarası (yeniden çapalamada süreklilik için)
  private estPeriod = 0; // otokorelasyon tahmini; PLL bunun ±%8'i içinde kalır
  private candidate = 0;
  private candidateHits = 0;
  private misses = 0;
  private halfVotes = 0;
  private driftVotes = 0;
  /** Son güçlü kick zamanları: ızgara sadece gerçek kick varken yeniden oturtulur */
  private strong: number[] = [];

  reset() {
    this.buf.fill(0);
    this.written = 0;
    this.nextT = 0;
    this.locked = false;
    this.bpm = null;
    this.confidence = 0;
    this.candidateHits = 0;
    this.misses = 0;
  }

  push(now: number, onset: number) {
    if (!this.nextT || now - this.nextT > 500) this.nextT = now;
    this.acc = Math.max(this.acc, onset);
    while (now >= this.nextT) {
      this.buf[this.written % SIZE] = this.acc;
      this.acc = 0;
      this.written++;
      this.nextT += 1000 / RATE;
    }
    if (now - this.lastAnalyze > 400 && this.written > RATE * 3) {
      this.lastAnalyze = now;
      this.analyze();
    }
  }

  /** Sürekli vuruş konumu (vuruş cinsinden) */
  posAt(now: number) {
    return this.anchorIndex + (now - this.anchor) / this.period;
  }

  phaseAt(now: number) {
    const p = this.posAt(now);
    return p - Math.floor(p);
  }

  indexAt(now: number) {
    return Math.floor(this.posAt(now));
  }

  /**
   * PLL: algılanan her kick'i en yakın tahmini vuruşla karşılaştırır, fazı hatanın bir
   * kısmı kadar kaydırır, periyodu da hatanın integraliyle düzeltir. Izgara böylece
   * gerçek vuruşlara yapışık kalır, tek tük kaçan/yanlış onset'te de savrulmaz.
   */
  onset(t: number, strength: number) {
    if (!this.locked) return;
    const pos = this.posAt(t);
    const n = Math.round(pos);
    const err = (pos - n) * this.period; // ms; + ise vuruş tahminden geç geldi
    if (Math.abs(err) > this.period * 0.22) {
      // Güçlü kick'ler ısrarla ızgaranın ortasına düşüyorsa offbeat'e kilitlenmişiz: yarım vuruş çevir
      if (strength > 0.4 && Math.abs(Math.abs(pos - n) - 0.5) < 0.15 && ++this.halfVotes >= 4) {
        this.anchor += this.period / 2;
        this.halfVotes = 0;
      }
      return;
    }
    // Zayıf onset'ler (riser gürültüsü, hi-hat sızıntısı) ızgarayı oynatmasın
    if (strength < 0.25) return;
    this.strong = [...this.strong.filter((s) => t - s < 4000), t];
    if (strength > 0.4) this.halfVotes = Math.max(0, this.halfVotes - 1);
    const g = Math.min(1, 0.3 + strength);
    this.anchorIndex = n;
    this.anchor = t - err + err * 0.35 * g;
    this.period = Math.min(this.estPeriod * 1.08, Math.max(this.estPeriod * 0.92, this.period + err * 0.06 * g));
    this.bpm = 60000 / this.period;
  }

  periodMs() {
    return this.period;
  }

  private analyze() {
    const n = Math.min(this.written, SIZE);
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) x[i] = this.buf[(this.written - n + i) % SIZE];

    // Yumuşat: periyot tam sayı örnek değil, darbeler bir örnek kayabiliyor
    const s = new Float32Array(n);
    let mean = 0;
    for (let i = 0; i < n; i++) {
      const v =
        (x[i - 2] ?? 0) * 0.1 + (x[i - 1] ?? 0) * 0.2 + x[i] * 0.4 + (x[i + 1] ?? 0) * 0.2 + (x[i + 2] ?? 0) * 0.1;
      s[i] = v;
      mean += v;
    }
    mean /= n;
    let r0 = 0;
    for (let i = 0; i < n; i++) {
      s[i] -= mean;
      r0 += s[i] * s[i];
    }
    r0 /= n;
    if (r0 < 1e-6) return this.miss();

    const score = new Float32Array(LAG_MAX + 2);
    const norm = new Float32Array(LAG_MAX + 2);
    let bestL = 0;
    for (let L = LAG_MIN - 1; L <= LAG_MAX + 1; L++) {
      let r = 0;
      for (let i = 0; i + L < n; i++) r += s[i] * s[i + L];
      r /= (n - L) * r0;
      // Techno için 128 civarını tercih et (oktav hatalarını bastırır)
      const w = Math.exp(-0.5 * (Math.log2((60 * RATE) / L / 128) / 0.7) ** 2);
      norm[L] = r;
      score[L] = r * w;
      if (L >= LAG_MIN && L <= LAG_MAX && (!bestL || score[L] > score[bestL])) bestL = L;
    }

    this.confidence = norm[bestL];
    if (this.confidence < MIN_CONFIDENCE) return this.miss();
    this.misses = 0;

    const a = score[bestL - 1];
    const b = score[bestL];
    const c = score[bestL + 1];
    const den = a - 2 * b + c;
    const lag = bestL + (den ? (0.5 * (a - c)) / den : 0);
    const bpm = (60 * RATE) / lag;
    const periodMs = (1000 * lag) / RATE;

    // Kilitliyken ince ayar PLL'in işi; analiz yalnızca belirgin tempo değişimini yakalar
    if (this.locked && this.bpm && Math.abs(bpm - this.bpm) / this.bpm < 0.04) {
      this.estPeriod = periodMs;
      this.candidateHits = 0;
      // Emniyet: ızgara gerçek kick'lerden belirgin kaydıysa (PLL penceresi dışına) yeniden oturt
      const kicking = this.strong.filter((s) => this.nextT - s < 4000).length >= 4;
      if (!kicking) {
        this.driftVotes = 0;
        return;
      }
      const beatT = this.combPhase(x.subarray(Math.max(0, x.length - RATE * 4)), this.period);
      const pos = this.posAt(beatT);
      const off = pos - Math.round(pos);
      if (Math.abs(off) > 0.15 && ++this.driftVotes >= 2) {
        this.anchorIndex = Math.round(pos);
        this.anchor = beatT;
        this.driftVotes = 0;
      } else if (Math.abs(off) <= 0.15) this.driftVotes = 0;
      return;
    }

    // Yeni tempo: art arda 3 kez tutarlı çıkarsa kilitlen
    if (Math.abs(bpm - this.candidate) / bpm < 0.03) this.candidateHits++;
    else {
      this.candidate = bpm;
      this.candidateHits = 1;
    }
    if (this.candidateHits >= 3) {
      this.period = periodMs;
      this.estPeriod = periodMs;
      this.bpm = bpm;
      this.locked = true;
      this.alignPhase(x);
    }
  }

  /** Taraklama: periyot ızgarasını onset'lerle en iyi örtüşen faza oturt */
  private alignPhase(x: Float32Array) {
    this.anchor = this.combPhase(x, this.period);
    this.anchorIndex = 0;
    this.halfVotes = 0;
    this.driftVotes = 0;
  }

  /** Verilen periyotla onset'lerle en iyi örtüşen son vuruşun zamanı (ms) */
  private combPhase(x: Float32Array, periodMs: number) {
    const n = x.length;
    const P = periodMs / (1000 / RATE);
    let bestPh = 0;
    let bestSum = -1;
    for (let ph = 0; ph < P; ph++) {
      let sum = 0;
      for (let k = 0; ; k++) {
        const i = Math.round(n - 1 - ph - k * P);
        if (i < 1) break;
        // Kare: güçlü kick'ler, offbeat bas/hi-hat gibi zayıf onset'leri ezer
        const v = x[i] + 0.5 * (x[i - 1] + (x[i + 1] ?? 0));
        sum += v * v;
      }
      if (sum > bestSum) {
        bestSum = sum;
        bestPh = ph;
      }
    }
    const lastSampleT = this.nextT - 1000 / RATE;
    return lastSampleT - bestPh * (1000 / RATE);
  }

  private miss() {
    // Break'te kick yokken de ızgara serbest akmaya devam eder (DJ setinde tempo değişmez);
    // kilit ancak ~10 sn boyunca ritim bulunamazsa düşer
    if (++this.misses > 25) {
      this.locked = false;
      this.bpm = null;
      this.candidateHits = 0;
    }
  }
}
