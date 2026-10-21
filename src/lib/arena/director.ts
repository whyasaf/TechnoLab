import type { Frame } from "../audio";
import { mulberry32 } from "./rng";

export type RGB = readonly [number, number, number];
export const ICE: RGB = [196, 222, 255];
export const VIOLET: RGB = [128, 72, 255];
export const BLUE: RGB = [60, 96, 255];
export const WHITE: RGB = [242, 245, 255];

export type Section = "idle" | "groove" | "breakdown" | "drop";

/**
 * Groove'da 8 ölçüde bir değişen "look"lar. Hepsinin ortak kuralı:
 * vuruşlar arasında karanlık, ışık sadece vuruşla gelir.
 */
type Look = "wash" | "lamps" | "beams" | "lasers" | "full";
type BeamPattern = "fan" | "parallel" | "cross" | "converge";

export const LAMP_COUNT = 18;
const BEAM_X = [0.12, 0.2, 0.28, 0.36, 0.44, 0.56, 0.64, 0.72, 0.8, 0.88];
const DOWN = Math.PI / 2;

export type Beam = { x: number; y: number; angle: number; target: number; inten: number };
/** Tepeden seyirciye inen spot: x kaynak, px/py kalabalıktaki ışık havuzu */
export type Spot = { x: number; px: number; py: number; inten: number };

const SPOT_X = [0.12, 0.27, 0.42, 0.58, 0.73, 0.88];
/** Clap'te sırayla değişen havuz düzenleri: düz, çapraz, içe, dışa */
const SPOT_PATTERNS = [
  (i: number) => 0,
  (i: number) => (i % 2 ? 0.12 : -0.12),
  (i: number) => (SPOT_X[i] < 0.5 ? 0.1 : -0.1),
  (i: number) => (SPOT_X[i] < 0.5 ? -0.08 : 0.08),
];
/** DJ masası lazer yelpazesinin kick'ten kick'e merkez yönleri */
const FAN_CENTERS = [-0.45, 0.4, -0.15, 0.2, 0, -0.3, 0.3];

type Opts = { strobe: boolean; reduced: boolean; aspect: number };

const frac = (n: number) => n - Math.floor(n);

/**
 * Işık operatörü. Her şey sesten gelen olaylara bağlıdır:
 *  - kick → o anki look'un elemanı vurur, sonra hızla söner
 *  - break → blackout; build-up'ta lamba sırası tempoya kilitli hızlanarak çakar
 *  - drop → tüm sahne aynı anda vurur, ardından birkaç ölçü "peak"
 *  - ses yok → ışık yok
 */
export class Director {
  section: Section = "idle";
  energy = 0;
  build = 0;

  // Çıktılar (sahne bunları çizer)
  wash = 0;
  washColor: RGB = ICE;
  readonly lamps = new Float32Array(LAMP_COUNT);
  readonly beams: Beam[] = BEAM_X.map((x) => ({ x, y: 0.1, angle: DOWN, target: DOWN, inten: 0 }));
  beamColor: RGB = WHITE;
  laser = 0;
  laserSpread = 0.4;
  laserTilt = -0.04;
  laserFan = 0;
  laserColor: RGB = ICE;
  led = 0;
  /** Sol / sağ lazer grubunun anlık gücü (her kick'te sıra değişir) */
  laserL = 0;
  laserR = 0;
  /** Kick'le ilerleyen LED koşu ışığının konumu (vuruş sayısı) */
  ledStep = 0;
  /** Kick gücü: yan LED kolonların doluluğu */
  ledLevel = 0;
  private laserStep = 0;
  /** LED şeridinde hangi yarı (tek/çift noktalar) bu vuruşta yanıyor */
  ledAlt = 0;
  readonly spots: Spot[] = SPOT_X.map((x) => ({ x, px: x, py: 0.82, inten: 0 }));
  /** Lazer yelpazesi: merkez yönü, vuruş içindeki süpürme yönü, hangi çizgiler yanıyor */
  fanCenter = 0;
  fanDir = 1;
  fanMask = 0;
  fanSeed = 0;
  /** Vuruş içindeki konum (yelpaze süpürmesi için) */
  phase = 0;
  /** Hi-hat zarfı ve sayacı: LED'ler titrer */
  hatHit = 0;
  hatCount = 0;
  /** Bas gücüyle tavan hüzmelerinin kalınlığı */
  beamWidth = 1;
  /** Kalabalığın kenar ışığı / genel parlama */
  flash = 0;
  /** Kalabalığın dans enerjisi */
  groove = 0;

  private look: Look = "wash";
  private hit = 0; // kick zarfı (her look kendi elemanına uygular)
  private clapHit = 0;
  private clapCount = 0;
  private hitStrength = 0;
  private beats = 0;
  private nextLookBeat = 32;
  private peakBeats = 0;
  private bassSlow = 0;
  private energySlow = 0;
  private longEnergy = 0;
  private silentFor = 0;
  private dipFor = 0;
  private breakFor = 0;
  private rng = mulberry32(42);
  private lookIdx = 0;
  /** Son ham kick'ten beri geçen süre: bas zarfı kick'ten 1-2 kare sonra yükselir */
  private kickAge = 9;

  update(f: Frame, dt: number, o: Opts) {
    const k = (tau: number) => 1 - Math.exp(-dt / tau);
    this.energy += (f.level - this.energy) * k(1.2);
    this.energySlow += (this.energy - this.energySlow) * k(3);
    this.bassSlow += (f.bass - this.bassSlow) * k(0.8);

    this.kickAge = f.kick ? 0 : this.kickAge + dt;
    this.updateSection(f, dt);

    if (f.beat) {
      this.beats++;
      this.hit = 1;
      this.hitStrength = f.strength;
      this.ledAlt = this.beats % 2;
      this.ledStep++;
      this.ledLevel = Math.max(this.ledLevel, f.strength);
      // Lazerler her kick'te yeni pozisyona atlar: sol, sağ, ikisi, ekrana yelpaze
      this.laserStep++;
      // Konum kick anında değişir (ışık sönerken kaymaz)
      const tilts = [-0.06, -0.3, -0.14, -0.42, -0.04, -0.22];
      this.laserTilt = tilts[this.laserStep % tilts.length];
      this.laserSpread = [0.5, 1.2, 0.8, 1.6][this.laserStep % 4];
      // Yelpaze: her kick'te yeni yön, çizgi seçimi ve kendi açıları
      this.fanCenter = FAN_CENTERS[this.laserStep % FAN_CENTERS.length];
      this.fanDir = this.laserStep % 2 ? 1 : -1;
      this.fanMask = this.laserStep % 3;
      this.fanSeed = this.laserStep;
      if (this.peakBeats > 0) this.peakBeats--;
    }
    this.hit *= Math.exp(-dt / 0.13);
    this.phase = f.phase;

    if (f.clap) {
      this.clapHit = 1;
      this.clapCount++;
      const pat = SPOT_PATTERNS[this.clapCount % SPOT_PATTERNS.length];
      this.spots.forEach((sp, i) => {
        sp.px = sp.x + pat(i);
        sp.py = 0.74 + ((i + this.clapCount) % 3) * 0.08;
      });
    }
    this.clapHit *= Math.exp(-dt / 0.14);
    if (f.hat) {
      this.hatHit = 1;
      this.hatCount++;
    }
    this.hatHit *= Math.exp(-dt / 0.07);
    this.beamWidth += (1 + f.bass * 0.9 - this.beamWidth) * k(0.08);

    if (this.section === "groove" && this.beats >= this.nextLookBeat) this.nextLook();

    // Kısık ses = kısık ışık
    const level = Math.min(1, 0.3 + this.energy * 1.4);
    const strobe = o.strobe && !o.reduced;

    let wash = 0;
    let laser = 0;
    let laserFan = 0;
    let beamI = 0;
    let led = 0;
    let spotI = 0;
    const lamps = new Float32Array(LAMP_COUNT);
    const kick = this.hit * (0.35 + 0.65 * this.hitStrength);

    if (this.section === "idle") {
      // Ses yok: karanlık
    } else if (this.section === "breakdown") {
      // Blackout + build-up: lamba sırası tempoya kilitli, giderek sıklaşarak çakar
      if (this.build > 0.1) {
        const sub = this.build < 0.4 ? 1 : this.build < 0.75 || !strobe ? 2 : 4;
        const usable = strobe || sub <= 1 ? sub : 1;
        const pos = f.beatPos ?? this.beats + f.phase;
        const on = frac(pos * usable) < 0.3 ? 1 : 0;
        lamps.fill(on * this.build * (strobe ? 1 : 0.6));
        wash = 0.12 * this.build;
        if (this.build > 0.5) spotI = on * (this.build - 0.5) * 1.4;
      }
      this.washColor = VIOLET;
    } else if (this.peakBeats > 0) {
      // Drop sonrası peak: tüm sahne. Strobe açıksa 16'lık, değilse vuruşta nabız
      const pos = f.beatPos;
      const pulse = strobe && pos !== null ? (frac(pos * 4) < 0.32 ? 1 : 0.05) : kick;
      wash = pulse * (0.7 + 0.3 * f.bass);
      lamps.fill(pulse);
      beamI = 0.5 + 0.5 * kick;
      laser = 0.15 + 0.85 * kick;
      laserFan = kick;
      led = pulse;
      spotI = Math.max(kick, this.clapHit);
    } else {
      // Groove: look'a göre tek eleman vurur, geri kalanı karanlık
      led = this.hit;
      // Lazerler her look'ta kick'le ateşlenir; 4. vuruşta kalabalığın üstüne (ekrana) açılır
      laser = this.hit;
      laserFan = this.laserStep % 2 === 1 ? this.hit : 0;
      // Clap/snare → tepeden seyirciye inen spotlar
      spotI = this.clapHit;
      switch (this.look) {
        case "wash":
          wash = kick;
          lamps.fill(0.06);
          break;
        case "lamps": {
          // Vuruşlarda yarılar dönüşümlü
          const half = this.beats % 2;
          for (let i = 0; i < LAMP_COUNT; i++) lamps[i] = (i < LAMP_COUNT / 2) === (half === 0) ? kick : 0.04;
          wash = 0.4 * kick;
          break;
        }
        case "beams":
          beamI = 0.1 + 0.9 * kick;
          wash = 0.45 * kick;
          break;
        case "lasers":
          wash = 0.3 * kick;
          break;
        case "full": {
          wash = 0.85 * kick;
          beamI = 0.6 * kick;
          // Lamba sırası 8'liklerle yürür (tempo kilitliyse)
          if (f.beatPos !== null) {
            const step = Math.floor(f.beatPos * 2) % LAMP_COUNT;
            lamps[step] = 1;
            lamps[LAMP_COUNT - 1 - step] = 1;
          }
          break;
        }
      }
      // Hi-hat: lamba sırasında küçük parıltılar
      if (f.hat) lamps[Math.floor(this.rng() * LAMP_COUNT)] = Math.max(0.35, lamps[0]);
    }

    // Uygula: hızlı atak, kısa sönüş (vuruşlar arası karanlık kalsın)
    const env = (cur: number, target: number) => cur + (target - cur) * k(target > cur ? 0.012 : 0.07);
    this.wash = env(this.wash, wash * level);
    // Lazer ve LED kısa çaktığı için yarım parlaklıkta görünmez kalıyordu: tabanı yüksek tut
    const pop = Math.max(level, 0.9);
    this.laser = env(this.laser, laser * pop);
    this.laserFan = env(this.laserFan, laserFan * pop);
    this.led = env(this.led, led * pop);
    const side = this.laserStep % 4; // 0 sol, 1 sağ, 2-3 ikisi
    this.laserL = this.laser * (side === 1 ? 0.12 : 1);
    this.laserR = this.laser * (side === 0 ? 0.12 : 1);
    this.ledLevel *= Math.exp(-dt / 0.18);
    for (const sp of this.spots) sp.inten = env(sp.inten, spotI * pop);
    for (let i = 0; i < LAMP_COUNT; i++) {
      // Hi-hat parıltısı tek karelik kalmasın diye lambalar biraz daha yavaş söner
      this.lamps[i] = Math.max(lamps[i] * level, this.lamps[i] * Math.exp(-dt / 0.09));
    }
    for (const b of this.beams) {
      b.inten = env(b.inten, beamI * level);
      b.angle += (b.target - b.angle) * k(o.reduced ? 1.5 : 0.6);
    }
    this.flash = Math.max(this.wash, this.peakBeats > 0 ? this.wash : 0);
    this.groove += ((this.section === "groove" || this.section === "drop" ? 1 : 0.15) * level - this.groove) * k(1);
  }

  private updateSection(f: Frame, dt: number) {
    const silent = !f.active;
    this.silentFor = silent ? this.silentFor + dt : 0;
    if (this.section === "groove" || this.section === "drop") {
      const tau = this.energy > this.longEnergy ? 2 : 12;
      this.longEnergy += (this.energy - this.longEnergy) * (1 - Math.exp(-dt / tau));
    }
    // Break: kick 2 sn'den uzun kesildi (techno'da en güvenilir işaret) ya da ses belirgin kısıldı
    const dip = this.energy < this.longEnergy - 0.15;
    this.dipFor = dip ? this.dipFor + dt : 0;
    const low = this.kickAge > 2 || this.dipFor > 1.5;

    const prev = this.section;
    if (f.planned) {
      // Dosya modu: bölümler önceden biliniyor, tahmin yok
      const p = f.planned;
      if (!f.active) this.section = "idle";
      else if (p.drop) this.triggerDrop();
      else if (p.breakdown) {
        this.section = "breakdown";
        this.build = p.build;
      } else if (prev === "idle" || prev === "breakdown") {
        this.section = "groove";
        this.nextLookBeat = this.beats;
      } else if (prev === "drop" && this.peakBeats <= 0) this.section = "groove";
      this.breakFor = this.section === "breakdown" ? this.breakFor + dt : 0;
      return;
    }
    if (this.silentFor > 1.5) this.section = "idle";
    else if (prev === "breakdown" && f.kick && f.level > this.longEnergy - 0.15) {
      // Kick tam güçle geri geldi: uzun break'ten sonraysa patlama
      if (this.breakFor > 3.5) this.triggerDrop();
      else {
        this.section = "groove";
        this.nextLookBeat = this.beats;
      }
    } else if (low && prev !== "breakdown" && !silent) this.section = "breakdown";
    else if (prev === "idle" && f.kick) {
      this.section = "groove";
      this.nextLookBeat = this.beats;
    } else if (prev === "drop" && this.peakBeats <= 0) this.section = "groove";
    this.breakFor = this.section === "breakdown" ? this.breakFor + dt : 0;

    if (this.section === "breakdown") {
      const rising = this.energy > this.energySlow + 0.015 || f.high > 0.45 || f.hat;
      this.build = Math.min(1, Math.max(0, this.build + dt * (rising ? 0.12 : -0.03)));
    } else this.build *= Math.exp(-dt / 0.4);
  }

  private triggerDrop() {
    this.breakFor = 0;
    this.section = "drop";
    this.peakBeats = 32;
    this.hit = 1;
    this.hitStrength = 1;
    this.washColor = ICE;
    this.laserColor = ICE;
    this.beamColor = WHITE;
    this.setBeams("fan");
    this.nextLookBeat = this.beats + 32;
  }

  private nextLook() {
    // Duvar ağırlıklı look'lar daha sık: referansta groove'un ana olayı duvarın vurması
    const looks: Look[] = ["wash", "full", "lamps", "wash", "beams", "full", "lasers"];
    this.lookIdx = (this.lookIdx + 1 + Math.floor(this.rng() * (looks.length - 1))) % looks.length;
    this.look = looks[this.lookIdx];
    this.nextLookBeat = this.beats + 32;
    // Renk: buz mavisi ile mor arasında; kırmızı/gökkuşağı yok
    const violet = this.rng() < 0.45;
    this.washColor = violet ? VIOLET : ICE;
    this.laserColor = this.rng() < 0.6 ? ICE : VIOLET;
    this.beamColor = this.rng() < 0.6 ? WHITE : BLUE;
    const patterns: BeamPattern[] = ["fan", "parallel", "cross", "converge"];
    this.setBeams(patterns[Math.floor(this.rng() * patterns.length)]);
  }

  /** Hüzmeler sabit durur; sadece look değişince yeni pozisyona yavaşça döner */
  private setBeams(p: BeamPattern) {
    // Açı: DOWN'dan küçük → sağa-aşağı, büyük → sola-aşağı
    const dir = this.rng() < 0.5 ? 1 : -1;
    this.beams.forEach((b, i) => {
      const side = b.x < 0.5 ? -1 : 1;
      b.target =
        p === "fan" ? DOWN - (b.x - 0.5) * 1.1 // dışa açılır
        : p === "parallel" ? DOWN + 0.35 * dir
        : p === "cross" ? DOWN + (i % 2 ? 0.45 : -0.45)
        : DOWN + side * 0.35; // merkeze toplanır
    });
  }
}
