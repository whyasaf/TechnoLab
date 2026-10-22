"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import DiagStrip from "../components/DiagStrip";
import Feedback from "../components/Feedback";
import Meter from "../components/Meter";
import Stage from "../components/Stage";
import YouTubePlayer, { type YouTubeClock } from "../components/YouTubePlayer";
import { AudioEngine, type SourceKind } from "../lib/audio";
import { forgetPlan, LEARN_COVERAGE, loadPlan, Recorder, savePlan } from "../lib/memory";
import { analyze, decodeMono } from "../lib/offline";

function parseYouTubeId(input: string): string | null {
  try {
    const u = new URL(input.trim());
    if (u.hostname === "youtu.be") return u.pathname.slice(1) || null;
    if (u.hostname.endsWith("youtube.com")) {
      if (u.searchParams.get("v")) return u.searchParams.get("v");
      const m = u.pathname.match(/^\/(?:embed|shorts|live)\/([\w-]{11})/);
      return m ? m[1] : null;
    }
  } catch {
    /* geçersiz URL */
  }
  return null;
}

export default function Page() {
  const [engine] = useState(() => new AudioEngine());
  const audioRef = useRef<HTMLAudioElement>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const [started, setStarted] = useState(false);
  const [kind, setKind] = useState<SourceKind>("off");
  const [sens, setSens] = useState(0.5);
  const [sync, setSync] = useState(0);
  const [bpm, setBpm] = useState(128);
  const [strobe, setStrobe] = useState(false);
  const [diag, setDiag] = useState(false);
  const [reduced, setReduced] = useState(false);
  const [url, setUrl] = useState("");
  const [videoId, setVideoId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [uiVisible, setUiVisible] = useState(true);
  const [canTab, setCanTab] = useState(false);
  // Geri bildirim: yerelde açık; yayında yalnızca mesajları saklayacak depo bağlıysa görünür
  const [feedbackOn, setFeedbackOn] = useState(process.env.NODE_ENV !== "production");
  // Örnek parça (isteğe bağlı): public/samples/demo.mp3 + demo.json varsa "Örnek" butonu çıkar
  const [sample, setSample] = useState<{ title: string; artist: string; license: string; url?: string } | null>(null);
  const [saved, setSaved] = useState(false);
  const [learnPct, setLearnPct] = useState<number | null>(null);
  const recRef = useRef<Recorder | null>(null);
  const clockRef = useRef<YouTubeClock | null>(null);

  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    fetch("/api/feedback?status=1")
      .then((r) => r.json())
      .then((d: { enabled?: boolean }) => setFeedbackOn(!!d.enabled))
      .catch(() => setFeedbackOn(false));
  }, []);

  useEffect(() => {
    fetch("/samples/demo.json")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d && typeof d.title === "string" && setSample(d))
      .catch(() => {});
  }, []);

  useEffect(() => {
    setCanTab(typeof navigator.mediaDevices?.getDisplayMedia === "function");
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const apply = () => {
      setReduced(mq.matches);
      if (mq.matches) setStrobe(false);
    };
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);

  const poke = useCallback(() => {
    setUiVisible(true);
    clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setUiVisible(false), 3500);
  }, []);

  useEffect(() => {
    if (!started) return;
    poke();
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;
      if (e.key === "f") void document.documentElement.requestFullscreen?.();
      poke();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      clearTimeout(hideTimer.current);
    };
  }, [started, poke]);

  const run = async (fn: () => Promise<void> | void) => {
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Bir şey ters gitti.");
      setStatus("");
    }
  };

  // Açılış ekranının arkasında sahne demo ritmiyle döner (ses dinlenmez, mikrofon izni istenmez)
  useEffect(() => {
    engine.useClock();
    engine.setBpm(124);
  }, [engine]);

  const start = () => {
    engine.init();
    engine.stop();
    setStarted(true);
  };

  const connectMic = () =>
    run(async () => {
      await engine.useMic();
      setKind("mic");
    });

  const connectTab = () =>
    run(async () => {
      await engine.useTab(() => setKind("off"));
      setKind("tab");
    });

  const onFile = (file?: File) => {
    const el = audioRef.current;
    if (!file || !el) return;
    engine.init();
    run(async () => {
      // Şarkının tamamı önceden analiz edilir: ışıklar çalarken tahmin etmez, plandan okur
      setStatus("Şarkı analiz ediliyor…");
      const plan = analyze(await decodeMono(await file.arrayBuffer()));
      const drops = plan.breaks.filter((b) => b.drop).length;
      setStatus(
        `${plan.kicks.length} kick · ${plan.bpm ? Math.round(plan.bpm) + " BPM" : "tempo bulunamadı"} · ${drops} drop`,
      );
      if (el.src) URL.revokeObjectURL(el.src);
      el.src = URL.createObjectURL(file);
      engine.useElement(el, plan);
      setKind("file");
      try {
        await el.play();
      } catch {
        setStatus((s) => s + " — oynatmak için ▶'ye bas");
      }
    });
  };

  const loadSample = () =>
    run(async () => {
      setStatus("Örnek parça yükleniyor…");
      const res = await fetch("/samples/demo.mp3");
      if (!res.ok) throw new Error("Örnek parça bulunamadı.");
      onFile(new File([await res.blob()], "demo.mp3", { type: "audio/mpeg" }));
    });

  const tap = () => {
    engine.tap();
    setBpm(engine.bpm);
    setKind("clock");
  };

  const submitUrl = (e: React.FormEvent) => {
    e.preventDefault();
    const id = parseYouTubeId(url);
    if (!id) return setError("Geçerli bir YouTube linki değil.");
    setError("");
    engine.learn(null, null);
    recRef.current = null;
    setLearnPct(null);
    setSaved(false);
    setVideoId(id);
    // Kayıtlı plan yoksa sesi dinlemek gerekir: "Çal" tıklaması bir kullanıcı jesti olduğu için
    // paylaşım penceresi doğrudan buradan açılır (ayrıca "Sekme"ye basmaya gerek kalmaz)
    if (!loadPlan(id)) {
      if (canTab) {
        setStatus("Açılan pencerede bu sekmeyi seç ve “Sekme sesini paylaş” kutusunu işaretle.");
        void connectTab();
      } else setStatus("Bu cihazda sekme sesi yok: Mikrofon'u seç, müzik hoparlörden çalsın.");
    }
  };

  /** Oynatıcı hazır: kayıtlı plan varsa ışıklar ondan oynar, yoksa canlı dinlerken öğrenilir */
  const onPlayerReady = (clock: YouTubeClock) => {
    clockRef.current = clock;
    if (!videoId) return;
    const plan = loadPlan(videoId);
    if (plan) {
      engine.useTimeline(clock, plan);
      setKind("youtube");
      setSaved(true);
      setStatus(`Hafızadan: ${plan.kicks.length} kick · ${plan.bpm ? Math.round(plan.bpm) + " BPM" : "tempo yok"}`);
      return;
    }
    setSaved(false);
    setStatus(
      engine.kind === "off"
        ? "Işıkların çalışması için Sekme (ya da Mikrofon) seç; dinlerken öğrenip hafızaya kaydedeceğim."
        : "Bu şarkıyı ilk kez dinliyorsun: dinlerken öğrenip hafızaya kaydedeceğim.",
    );
    const wait = setInterval(() => {
      const d = clock.duration;
      if (d > 0) {
        clearInterval(wait);
        recRef.current = new Recorder(videoId, d);
        engine.learn(clock, recRef.current);
      }
    }, 300);
  };

  // Öğrenme ilerlemesi: yeterince dinlendiyse planı kaydet
  useEffect(() => {
    if (!videoId) return;
    const t = setInterval(() => {
      const rec = recRef.current;
      if (!rec || saved) return;
      const c = rec.coverage();
      setLearnPct(Math.round(c * 100));
      if (c >= LEARN_COVERAGE) {
        if (savePlan(rec.id, rec.toPlan())) {
          setSaved(true);
          engine.learn(null, null);
          setStatus("Hafızaya kaydedildi — bu şarkıyı bir daha açınca ışıklar önceden bilir.");
        } else setStatus("Hafıza dolu, kaydedilemedi.");
      }
    }, 1000);
    return () => clearInterval(t);
  }, [videoId, saved, engine]);

  const forget = () => {
    if (!videoId) return;
    forgetPlan(videoId);
    setSaved(false);
    setStatus("Bu şarkının hafızası silindi.");
  };

  return (
    <main onPointerMove={poke} onPointerDown={poke}>
      <Stage engine={engine} strobe={strobe} reduced={reduced} />

      {!started && (
        <div className="gate">
          <div className="gate-inner">
            <p className="eyebrow">Underground techno ışık deneyimi</p>
            <h1>Technolab</h1>
            <p className="lead">Müziği dinle, ışıkların nefes almasını izle. Kick vurur, sis parlar, lazerler döner.</p>

            <ol className="steps">
              <li>
                <b>01</b>
                <span>Bir YouTube linki yapıştır ya da kendi dosyanı seç</span>
              </li>
              <li>
                <b>02</b>
                <span>Sekme sesini (telefonda mikrofonu) aç: ışıklar duyduğu her vuruşa tepki verir</span>
              </li>
              <li>
                <b>03</b>
                <span>Şarkıyı bir kez dinlediysen bir dahaki sefere önceden bilir</span>
              </li>
            </ol>

            <button className="enter" onClick={start}>
              Gir
            </button>
            <p className="fine">
              Müzik sitede saklanmaz: YouTube&apos;dan gömülü oynar ya da dosyan bilgisayarında kalır.
            </p>
            <p className="warn">
              Ani ışık patlamaları içerir. Hızlı strobe varsayılan olarak kapalı; ışığa duyarlı epilepsi riski varsa
              açma.
            </p>
            <p className="credit">
              © 2026 whyasaf · <a href="/gizlilik">Gizlilik</a> ·{" "}
              <a href="https://github.com/whyasaf/TechnoLab" target="_blank" rel="noopener noreferrer">
                GitHub
              </a>
            </p>
          </div>
        </div>
      )}

      {started && (
        <>
          <div className={`brand ${uiVisible ? "" : "hidden"}`}>Technolab</div>
          {feedbackOn && (
            <div className={`fb-wrap ${uiVisible ? "" : "hidden"}`}>
              <Feedback engine={engine} videoId={videoId} />
            </div>
          )}

          <section className={`dock ${uiVisible ? "" : "hidden"}`}>
            <div className="row">
              <button className={kind === "mic" ? "on" : ""} onClick={connectMic} title="Hoparlörden çalan müziği dinle">
                Mikrofon
              </button>
              {canTab && (
                <button className={kind === "tab" ? "on" : ""} onClick={connectTab} title="Bir sekmenin sesini yakala">
                  Sekme
                </button>
              )}
              <label className={`btn ${kind === "file" ? "on" : ""}`}>
                Dosya
                <input type="file" accept="audio/*" hidden onChange={(e) => onFile(e.target.files?.[0])} />
              </label>
              {sample && (
                <button onClick={loadSample} title="Hazır örnek parçayla dene">
                  Örnek
                </button>
              )}
              <button className={kind === "clock" ? "on" : ""} onClick={tap} title="Ritme dokun">
                Tap{kind === "clock" ? ` ${bpm}` : ""}
              </button>
            </div>

            {kind === "off" ? (
              <p className="note">Kaynak seçilmedi — ışıklar kapalı. Sekme, Mikrofon ya da Dosya seç.</p>
            ) : kind === "clock" ? (
              <p className="note">Tap ritmi — gerçek sesi dinlemiyor.</p>
            ) : (
              <Meter engine={engine} />
            )}
            {diag && kind !== "clock" && kind !== "off" && <DiagStrip engine={engine} />}
            {kind === "mic" && <p className="note">Müzik hoparlörden çalmalı.</p>}
            {status && <p className="note">{status}</p>}
            {sample && kind === "file" && (
              <p className="note">
                Örnek: {sample.title} — {sample.artist} ({sample.license})
                {sample.url && (
                  <>
                    {" · "}
                    <a href={sample.url} target="_blank" rel="noopener noreferrer">
                      kaynak
                    </a>
                  </>
                )}
              </p>
            )}
            {learnPct !== null && !saved && <p className="note">Öğreniliyor: %{learnPct}</p>}

            <div className="row">
              <span className="lbl">Hassasiyet</span>
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={sens}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  engine.sensitivity = v;
                  setSens(v);
                }}
              />
            </div>

            {kind !== "clock" && kind !== "off" && (
              <div className="row" title="Işık sesten geç geliyorsa sağa, erken geliyorsa sola çek">
                <span className="lbl">Senkron {sync > 0 ? "+" : ""}{sync} ms</span>
                <input
                  type="range"
                  min={-100}
                  max={150}
                  step={5}
                  value={sync}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    engine.syncOffset = v;
                    setSync(v);
                  }}
                />
              </div>
            )}

            <form className="row" onSubmit={submitUrl}>
              <input
                type="url"
                inputMode="url"
                placeholder="YouTube linki"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
              />
              <button type="submit">Çal</button>
            </form>

            <div className="row">
              <label className="check" title="Peak anlarında 16'lık hızlı flaş (saniyede ~8)">
                <input
                  type="checkbox"
                  checked={strobe}
                  disabled={reduced}
                  onChange={(e) => setStrobe(e.target.checked)}
                />
                Hızlı strobe
              </label>
              <label className="check">
                <input type="checkbox" checked={diag} onChange={(e) => setDiag(e.target.checked)} />
                Teşhis
              </label>
              <button onClick={() => void document.documentElement.requestFullscreen?.()}>Tam ekran</button>
              {videoId && <button onClick={() => { engine.learn(null, null); setVideoId(null); }}>Videoyu kapat</button>}
              {videoId && saved && <button onClick={forget} title="Bu şarkının kayıtlı planını sil">Hafızayı sil</button>}
            </div>

            {error && <p className="error">{error}</p>}
          </section>

          {videoId && <YouTubePlayer key={videoId} videoId={videoId} onReady={onPlayerReady} />}
        </>
      )}

      <audio ref={audioRef} controls className={`file-player ${kind === "file" && uiVisible ? "" : "hidden"}`} />
    </main>
  );
}
