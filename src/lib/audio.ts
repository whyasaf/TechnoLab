import type { Recorder } from "./memory";
import type { Plan } from "./offline";
import { TempoTracker } from "./tempo";

/** off: kaynak seçilmedi → ışık yok. clock: sadece kullanıcı Tap'e basınca */
export type SourceKind = "off" | "clock" | "mic" | "tab" | "file" | "youtube";

/** Plan modunda zamanı veren oynatıcı: <audio> ya da YouTube oynatıcı uyarlayıcısı */
export type MediaClock = { currentTime: number; paused: boolean; ended: boolean; playbackRate: number };

export type Frame = {
  /** 0..1 mutlak seviyeler (ses kısılınca düşer), attack/release zarflı */
  bass: number;
  mid: number;
  high: number;
  level: number;
  /** Vuruş: duyulan kick, anında */
  beat: boolean;
  /** Vuruş gücü 0..1 — sesin yüksekliğine de bağlı */
  strength: number;
  /** Hi-hat / tiz transient */
  hat: boolean;
  /** Clap / snare */
  clap: boolean;
  bpm: number | null;
  locked: boolean;
  /** 0..1, vuruş içindeki konum */
  phase: number;
  /** Gürültü tabanının üstünde herhangi bir ses var mı */
  active: boolean;
  /** Tempo kilitliyken sürekli vuruş sayacı (hareketleri ritme bağlamak için) */
  beatPos: number | null;
  /** Ham kick onset'i (ızgaradan bağımsız, anında) — drop tespiti için */
  kick: boolean;
  /** Önceden analiz edilmiş dosyada bölüm bilgisi plandan gelir (tahmin yok) */
  planned: { breakdown: boolean; build: number; drop: boolean } | null;
};

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
/** Bunun altındaki her şey sessizlik / oda gürültüsü sayılır (dBFS, bant ortalaması) */
const ABS_FLOOR = -90;

const emptyFrame = (): Frame => ({
  bass: 0, mid: 0, high: 0, level: 0, beat: false, strength: 0, hat: false, clap: false, bpm: null, locked: false, phase: 0, active: false, beatPos: null, kick: false, planned: null,
});

export class AudioEngine {
  kind: SourceKind = "off";
  bpm = 128;
  /** 0..1 — referans seviyesini kaydırır (mikrofon kısıksa artır) */
  sensitivity = 0.5;
  /** Kullanıcı senkron düzeltmesi (ms). Pozitif = ışık daha erken */
  syncOffset = 0;

  last: Frame = emptyFrame();
  beatTotal = 0;
  readonly tempo = new TempoTracker();

  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private source: AudioNode | null = null;
  private stream: MediaStream | null = null;
  private el: HTMLAudioElement | null = null;
  private clock: MediaClock | null = null;
  private learner: { clock: MediaClock; rec: Recorder } | null = null;
  private elSource: MediaElementAudioSourceNode | null = null;
  /** Dosya modunda önceden çıkarılmış ışık planı */
  plan: Plan | null = null;
  private planT = -1;
  private clockT = 0;
  private clockAt = 0;
  private kickIdx = 0;
  private hatIdx = 0;
  private clapIdx = 0;

  private db = new Float32Array(0);
  private prev = new Float32Array(0);
  private top = { bass: -60, mid: -60, high: -60, clap: -60 };
  private beatGap = 470;
  private env = { bass: 0, mid: 0, high: 0 };
  private peak = { kick: 3, clap: 3 };
  private kickHist: number[] = [];
  private hatHist: number[] = [];
  private clapHist: number[] = [];
  private lastClap = 0;
  private lastOnset = 0;
  private lastHat = 0;
  private lastBeatT = 0;
  private lastNow = 0;
  /** Ortalama kare süresi (ms): vuruşu en yakın kareye oturtmak ve ekran gecikmesini telafi için */
  private frameMs = 16.7;

  private clockStart = 0;
  private lastClockBeat = -1;
  private lastClockHalf = -1;
  private taps: number[] = [];

  /** Kullanıcı jestiyle çağrılmalı (iOS/Safari AudioContext kuralı) */
  init() {
    if (!this.ctx) {
      const AC =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new AC();
      this.analyser = this.ctx.createAnalyser();
      // Küçük pencere + yumuşatma yok: transient'ler ~25 ms daha erken yakalanır
      this.analyser.fftSize = 1024;
      this.analyser.smoothingTimeConstant = 0;
      this.db = new Float32Array(this.analyser.frequencyBinCount);
      this.prev = new Float32Array(this.analyser.frequencyBinCount);
      this.clockStart = performance.now();
    }
    void this.ctx.resume();
  }

  private detach() {
    this.el?.pause();
    this.source?.disconnect();
    this.analyser?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.source = null;
    this.plan = null;
    this.clock = null;
    this.kickHist = [];
    this.hatHist = [];
    this.clapHist = [];
    this.peak = { kick: 3, clap: 3 };
    this.top = { bass: -60, mid: -60, high: -60, clap: -60 };
    this.prev.fill(-120);
    this.tempo.reset();
  }

  private attachStream(stream: MediaStream, kind: SourceKind) {
    if (!this.ctx || !this.analyser) return;
    this.stream = stream;
    this.source = this.ctx.createMediaStreamSource(new MediaStream(stream.getAudioTracks()));
    this.source.connect(this.analyser);
    this.kind = kind;
  }

  async useMic() {
    this.init();
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    this.detach();
    this.attachStream(stream, "mic");
  }

  async useTab(onEnded?: () => void) {
    this.init();
    // preferCurrentTab: Chrome paylaşım penceresinde bu sekmeyi hazır seçili getirir
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: true,
      preferCurrentTab: true,
    } as DisplayMediaStreamOptions);
    const track = stream.getAudioTracks()[0];
    if (!track) {
      stream.getTracks().forEach((t) => t.stop());
      throw new Error("Ses paylaşılmadı. Paylaşım penceresinde 'Sekme sesini paylaş' kutusunu işaretle.");
    }
    this.detach();
    this.attachStream(stream, "tab");
    track.addEventListener("ended", () => {
      if (this.kind === "tab") {
        this.stop();
        onEnded?.();
      }
    });
  }

  useElement(el: HTMLAudioElement, plan: Plan | null = null) {
    this.init();
    if (!this.ctx || !this.analyser) return;
    this.detach();
    this.plan = plan;
    this.planT = -1;
    this.el = el;
    this.elSource ??= this.ctx.createMediaElementSource(el);
    this.source = this.elSource;
    this.elSource.connect(this.analyser);
    this.analyser.connect(this.ctx.destination);
    this.kind = "file";
  }

  stop() {
    this.detach();
    this.kind = "off";
  }

  /** YouTube hafızası: plan var, ses analizi yok; zaman oynatıcıdan gelir */
  useTimeline(clock: MediaClock, plan: Plan) {
    this.init();
    this.detach();
    this.clock = clock;
    this.plan = plan;
    this.planT = -1;
    this.kind = "youtube";
  }

  /** Canlı analiz sırasında olayları videonun saniyesiyle kaydet (null: kaydı durdur) */
  learn(clock: MediaClock | null, rec: Recorder | null) {
    this.learner = clock && rec ? { clock, rec } : null;
  }

  /** Canlı algılamanın gecikmesi (ms): FFT penceresi + kare + ölçülmüş sabit */
  private detectMs() {
    if (!this.analyser || !this.ctx) return 0;
    return (this.analyser.fftSize / this.ctx.sampleRate) * 500 + this.frameMs / 2 + 23;
  }

  useClock() {
    this.detach();
    this.kind = "clock";
    this.clockStart = performance.now();
    this.lastClockBeat = -1;
  }

  setBpm(bpm: number) {
    this.bpm = Math.min(200, Math.max(60, bpm));
  }

  tap() {
    const now = performance.now();
    if (this.taps.length && now - this.taps[this.taps.length - 1] > 2000) this.taps = [];
    this.taps = [...this.taps, now].slice(-8);
    if (this.taps.length >= 2) {
      const gaps = this.taps.slice(1).map((t, i) => t - this.taps[i]);
      const avg = gaps.reduce((a, b) => a + b, 0) / gaps.length;
      this.setBpm(Math.round(60000 / avg));
    }
    if (this.kind !== "clock") this.detach();
    this.kind = "clock";
    this.clockStart = now;
    this.lastClockBeat = -1;
  }

  /**
   * Algılanan vuruş, duyulan vuruştan geç kalır (FFT penceresi, onset karşılaştırması,
   * mikrofon girişi, ekran karesi). Kilitli ızgarayı bu kadar ileri alıp ışığı zamanında yakalarız.
   */
  leadMs() {
    if (this.kind === "clock" || this.kind === "off" || !this.analyser || !this.ctx) return 0;
    // Algılama: FFT penceresinin yarısı + onset'in görüldüğü karenin ortalama yarısı
    // + ölçümle bulunan sabit (dosya testinde ızgara ses saatine göre medyan +23 ms kalıyordu)
    const detect = this.detectMs();
    // Ekran: çizilen kare bir sonraki yenilemede görünür
    const display = this.frameMs;
    // Mikrofon girişi gecikmesi; dosyada ise ses analizden sonra hoparlöre gider
    const path = this.kind === "mic" ? 15 : this.kind === "file" ? -(this.ctx.outputLatency || 0.02) * 1000 : 0;
    return detect + display + path + this.syncOffset;
  }

  read(now: number): Frame {
    const f =
      this.kind === "off" ? emptyFrame()
      : this.kind === "clock" ? this.readClock(now)
      : this.kind === "file" && this.plan && this.el ? this.readPlanned(now, this.el, this.plan)
      : this.kind === "youtube" && this.plan && this.clock ? this.readPlanned(now, this.clock, this.plan)
      : this.readAnalyser(now);
    const L = this.learner;
    if (L && (this.kind === "tab" || this.kind === "mic" || (this.kind === "file" && !this.plan)) && !L.clock.paused) {
      // Olay, algılandığı andan detectMs önce videoda çaldı
      L.rec.record(L.clock.currentTime - this.detectMs() / 1000, f);
    }
    if (f.beat) this.beatTotal++;
    this.last = f;
    return f;
  }

  private readClock(now: number): Frame {
    const beats = ((now - this.clockStart) / 60000) * this.bpm;
    const idx = Math.floor(beats);
    const phase = beats - idx;
    const half = Math.floor(beats * 2);
    const beat = idx !== this.lastClockBeat;
    const hat = !beat && half !== this.lastClockHalf;
    this.lastClockBeat = idx;
    this.lastClockHalf = half;

    const bass = 0.7 * Math.exp(-phase * 6);
    const high = 0.5 * Math.exp(-Math.abs(phase - 0.5) * 20);
    return {
      bass, mid: 0.45, high, level: 0.55, beat, strength: beat ? 0.85 : 0, hat, clap: beat && idx % 2 === 1,
      bpm: this.bpm, locked: true, phase, active: true, beatPos: beats, kick: beat, planned: null,
    };
  }

  /**
   * Plan modu: ışık, şarkının çalınan saniyesine göre önceden çıkarılmış listeden okunur.
   * currentTime kaba adımlarla güncellendiği için duvar saatiyle pürüzsüzleştirilir.
   */
  private readPlanned(now: number, el: MediaClock, plan: Plan): Frame {
    const dt = Math.min(0.1, (now - (this.lastNow || now)) / 1000);
    this.lastNow = now;
    if (dt > 0) this.frameMs += (Math.min(100, dt * 1000) - this.frameMs) * 0.05;

    const ct = el.currentTime;
    if (el.paused) {
      this.clockT = ct;
    } else {
      const est = this.clockT + ((now - this.clockAt) / 1000) * el.playbackRate;
      this.clockT = Math.abs(ct - est) > 0.25 ? ct : est + (ct - est) * 0.03;
    }
    this.clockAt = now;
    // Duyulan an = çözücü konumu − çıkış gecikmesi; kare bir sonraki yenilemede görünür
    const out = (this.ctx?.outputLatency || 0.02) + (this.ctx?.baseLatency || 0);
    const t = this.clockT - out + this.frameMs / 1000 + this.syncOffset / 1000;

    // Geri sarma / ileri atlama: indeksleri yeniden bul, aradaki olayları ateşleme
    if (this.planT < 0 || t < this.planT || t - this.planT > 0.5) {
      this.kickIdx = plan.kicks.findIndex((k) => k.t > t);
      if (this.kickIdx < 0) this.kickIdx = plan.kicks.length;
      this.hatIdx = plan.hats.findIndex((h) => h > t);
      if (this.hatIdx < 0) this.hatIdx = plan.hats.length;
      this.clapIdx = plan.claps.findIndex((c) => c > t);
      if (this.clapIdx < 0) this.clapIdx = plan.claps.length;
      this.planT = t;
    }
    const playing = !el.paused && !el.ended;

    // Hassasiyet: eşiği ne kadar aşan aday kick'lerin ışık yakacağı (0 → sadece net kick'ler, 1 → hepsi)
    const minMargin = 1 + (1 - this.sensitivity) * 0.5;
    let beat = false;
    let strength = 0;
    while (this.kickIdx < plan.kicks.length && plan.kicks[this.kickIdx].t <= t) {
      const k = plan.kicks[this.kickIdx];
      if (k.m >= minMargin) {
        beat = true;
        strength = Math.max(strength, k.s);
      }
      this.kickIdx++;
    }
    let clap = false;
    while (this.clapIdx < plan.claps.length && plan.claps[this.clapIdx] <= t) {
      clap = true;
      this.clapIdx++;
    }
    let hat = false;
    while (this.hatIdx < plan.hats.length && plan.hats[this.hatIdx] <= t) {
      hat = true;
      this.hatIdx++;
    }
    let drop = false;
    let breakdown = false;
    let build = 0;
    for (const b of plan.breaks) {
      if (b.drop && b.end > this.planT && b.end <= t) drop = true;
      if (t >= b.start && t < b.end) {
        breakdown = true;
        // Drop'u önceden bildiğimiz için build-up son 8 sn'de zamanında yükselir
        if (b.drop) build = Math.max(0, 1 - (b.end - t) / Math.min(8, b.end - b.start));
      }
    }
    this.planT = t;
    if (!playing) beat = hat = clap = drop = false;

    const i = Math.max(0, Math.min(plan.bass.length - 1, Math.round(t / plan.hop)));
    const env = (a: Float32Array, cur: number) => {
      const target = playing ? a[i] : 0;
      return cur + (target - cur) * (1 - Math.exp(-dt / (target > cur ? 0.015 : 0.2)));
    };
    this.env.bass = env(plan.bass, this.env.bass);
    this.env.mid = env(plan.mid, this.env.mid);
    this.env.high = env(plan.high, this.env.high);

    const prev = plan.kicks[this.kickIdx - 1];
    const phase = prev ? Math.min(1, (t - prev.t) / plan.period) : 0;
    // Izgara: son kick'ten tempo periyoduyla (break'te de akar)
    const beatPos = prev ? this.kickIdx - 1 + (t - prev.t) / plan.period : null;
    if (beat) this.lastBeatT = now;

    const { bass, mid, high } = this.env;
    return {
      bass, mid, high, level: (bass * 1.2 + mid + high * 0.6) / 2.8,
      beat, strength, hat, clap, bpm: plan.bpm, locked: plan.bpm !== null, phase,
      active: playing, beatPos, kick: beat,
      planned: { breakdown, build, drop },
    };
  }

  private readAnalyser(now: number): Frame {
    if (!this.ctx || !this.analyser) return emptyFrame();
    const dt = Math.min(0.1, (now - (this.lastNow || now)) / 1000);
    this.lastNow = now;
    if (dt > 0) this.frameMs += (Math.min(100, dt * 1000) - this.frameMs) * 0.05;

    // Ham dB (float): bayt verisi gibi tavana vurup doymaz. Yüksek sekme sesinde
    // bas bandı sürekli 255'te kalınca değişim (kick) görünmez hale geliyordu.
    this.analyser.getFloatFrequencyData(this.db);
    const binHz = this.ctx.sampleRate / this.analyser.fftSize;
    const bin = (hz: number) => Math.max(1, Math.floor(hz / binHz));
    const dbAt = (i: number) => {
      const v = this.db[i];
      return Number.isFinite(v) ? Math.max(-120, v) : -120;
    };
    /** Bandın güç ortalaması, dB */
    const band = (lo: number, hi: number) => {
      const a = bin(lo);
      const b = Math.max(a + 1, bin(hi));
      let p = 0;
      for (let i = a; i < b; i++) p += 10 ** (dbAt(i) / 10);
      return 10 * Math.log10(p / (b - a) + 1e-12);
    };
    /** Banttaki pozitif dB artışlarının ortalaması (onset gücü) */
    const flux = (lo: number, hi: number) => {
      const a = bin(lo);
      const b = Math.max(a + 1, bin(hi));
      let sum = 0;
      for (let i = a; i < b; i++) {
        const d = dbAt(i) - this.prev[i];
        if (d > 0) sum += d;
      }
      return sum / (b - a);
    };

    const bassDb = band(40, 150);
    const midDb = band(150, 2000);
    const highDb = band(2000, 10000);
    const kickF = flux(40, 150);
    const hatF = flux(6000, 14000);
    const clapF = flux(1500, 5000);
    const clapDb = band(1500, 5000);
    for (let i = 0; i < this.db.length; i++) this.prev[i] = dbAt(i);

    // Seviye: parçanın son zamanlardaki en yüksek seviyesine göre (30 dB aralık).
    // Tepe yavaş iner (~1 dB/sn): kısık bölüm kısık görünür, ama farklı ses düzeylerine uyum sağlar.
    const range = 30 - this.sensitivity * 10;
    const level = (key: "bass" | "mid" | "high", d: number) => {
      this.top[key] = Math.max(d, this.top[key] - 1 * dt, ABS_FLOOR + range);
      return clamp01((d - (this.top[key] - range)) / range);
    };
    const bassA = level("bass", bassDb);
    const midA = level("mid", midDb);
    const highA = level("high", highDb);

    const follow = (cur: number, target: number) =>
      cur + (target - cur) * (1 - Math.exp(-dt / (target > cur ? 0.015 : 0.2)));
    this.env.bass = follow(this.env.bass, bassA);
    this.env.mid = follow(this.env.mid, midA);
    this.env.high = follow(this.env.high, highA);

    const active = Math.max(bassDb, midDb, highDb) > ABS_FLOOR;
    this.top.clap = Math.max(clapDb, this.top.clap - 1 * dt, ABS_FLOOR + 10);

    // Kick: bas bandında ani dB sıçraması. Eşik, yakın geçmişin ortalamasına göre uyarlanır.
    this.kickHist.push(kickF);
    if (this.kickHist.length > 40) this.kickHist.shift();
    const kMean = this.kickHist.reduce((a, b) => a + b, 0) / this.kickHist.length;
    this.peak.kick = Math.max(kickF, this.peak.kick * 0.999, 3);
    const thr = kMean * (1.8 - this.sensitivity * 0.5) + 2;
    const onset =
      active &&
      kickF > thr &&
      // Bas, parçanın bas tepesinin çok altındaysa (break'teki gürültü) kick değildir
      bassDb > this.top.bass - 18 &&
      now - this.lastOnset > 180;
    if (onset) this.lastOnset = now;
    const onsetStrength = onset ? clamp01(0.35 + (0.65 * (kickF - kMean)) / (this.peak.kick - kMean + 1e-6)) * clamp01(0.3 + bassA) : 0;

    this.hatHist.push(hatF);
    if (this.hatHist.length > 30) this.hatHist.shift();
    const hMean = this.hatHist.reduce((a, b) => a + b, 0) / this.hatHist.length;
    const hat = active && hatF > hMean * 1.8 + 1.5 && now - this.lastHat > 80;
    if (hat) this.lastHat = now;

    this.clapHist.push(clapF);
    if (this.clapHist.length > 40) this.clapHist.shift();
    const cMean = this.clapHist.reduce((a, b) => a + b, 0) / this.clapHist.length;
    // Parçanın en güçlü orta-tiz patlamaları: hi-hat'ler ve gürültü tepeye yakın değildir
    this.peak.clap = Math.max(clapF, this.peak.clap * 0.9995, 3);
    const clap =
      active &&
      clapF > this.peak.clap * (0.6 - this.sensitivity * 0.2) &&
      // Seviye ölçütü: clap bandı kendi tepesine yakın olmalı (hi-hat ondan belirgin kısıktır)
      clapDb > this.top.clap - 7 &&
      clapF > cMean * 2 + 3 &&
      now - this.lastClap > 200;
    if (clap) this.lastClap = now;

    // Tempo sadece BPM göstergesi, hızlı strobe ve build-up ruloları için; ışık vuruşu değil
    this.tempo.push(now, active ? kickF / this.peak.kick : 0);
    if (onset) this.tempo.onset(now, onsetStrength);
    const t = this.tempo;
    const beatPos = t.locked ? t.posAt(now + this.leadMs()) : null;

    // Işık vuruşu = duyulan kick, anında. Izgaraya göre değil.
    if (onset) {
      if (this.lastBeatT) this.beatGap += (Math.min(1000, now - this.lastBeatT) - this.beatGap) * 0.3;
      this.lastBeatT = now;
    }
    const phase = clamp01((now - this.lastBeatT) / Math.max(250, this.beatGap));

    const { bass, mid, high } = this.env;
    return {
      bass, mid, high, level: (bass * 1.2 + mid + high * 0.6) / 2.8,
      beat: onset, strength: onsetStrength, hat, clap, bpm: t.bpm, locked: t.locked, phase,
      active, beatPos, kick: onset, planned: null,
    };
  }
}
