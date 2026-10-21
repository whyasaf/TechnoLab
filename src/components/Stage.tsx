"use client";

import { useEffect, useRef } from "react";
import type { AudioEngine } from "../lib/audio";
import { ArenaScene } from "../lib/arena/scene";

type Props = {
  engine: AudioEngine;
  /** Hızlı (16'lık) strobe — kullanıcı açıkça açmadıkça kapalı */
  strobe: boolean;
  /** prefers-reduced-motion */
  reduced: boolean;
};

export default function Stage({ engine, strobe, reduced }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const opts = useRef({ strobe, reduced });

  useEffect(() => {
    opts.current = { strobe, reduced };
  }, [strobe, reduced]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d", { alpha: false });
    if (!canvas || !ctx) return;

    const scene = new ArenaScene();

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      scene.resize(w, h);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    let last = performance.now();
    let raf = 0;
    let frame = 0;
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      scene.render(ctx, engine.read(now), dt, opts.current);
      // Test / hata ayıklama için sahne durumu
      if (++frame % 20 === 0) {
        canvas.dataset.section = scene.director.section;
        canvas.dataset.energy = scene.director.energy.toFixed(2);
        canvas.dataset.wash = scene.director.wash.toFixed(2);
      }
    };
    raf = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [engine]);

  return <canvas ref={canvasRef} className="stage" aria-hidden />;
}
