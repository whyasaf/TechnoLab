"use client";

import { useEffect, useRef } from "react";
import type { AudioEngine } from "../lib/audio";

const SECONDS = 3;

/**
 * Motorun ne duyduğunu canlı gösterir: mavi çizgi bas seviyesi, kırmızı çentik
 * algılanan ham kick, beyaz çentik ışığa giden vuruş. Kırmızı ile beyaz üst üste
 * değilse ritim kaymış demektir.
 */
export default function DiagStrip({ engine }: { engine: AudioEngine }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const c = ref.current;
    const ctx = c?.getContext("2d");
    if (!c || !ctx) return;
    const samples: { t: number; bass: number; kick: boolean; beat: boolean }[] = [];
    let raf = 0;
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      const f = engine.last;
      samples.push({ t: now, bass: f.bass, kick: f.kick, beat: f.beat });
      while (samples.length && now - samples[0].t > SECONDS * 1000) samples.shift();

      const w = c.width;
      const h = c.height;
      ctx.clearRect(0, 0, w, h);
      const x = (t: number) => w - ((now - t) / (SECONDS * 1000)) * w;
      ctx.strokeStyle = "rgba(90,140,255,0.9)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      samples.forEach((s, i) => (i ? ctx.lineTo(x(s.t), h - s.bass * (h - 4)) : ctx.moveTo(x(s.t), h)));
      ctx.stroke();
      for (const s of samples) {
        if (s.kick) {
          ctx.fillStyle = "#ff4d5e";
          ctx.fillRect(x(s.t) - 1, 0, 2, h / 2);
        }
        if (s.beat) {
          ctx.fillStyle = "#fff";
          ctx.fillRect(x(s.t) - 1, h / 2, 2, h / 2);
        }
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [engine]);

  return <canvas ref={ref} className="diag" width={300} height={36} title="Kırmızı: duyulan kick · Beyaz: ışık vuruşu · Mavi: bas" />;
}
