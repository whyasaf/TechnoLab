"use client";

import { useEffect, useRef } from "react";
import type { AudioEngine } from "../lib/audio";

/** Motorun gerçekten ses duyup duymadığını ve tempo durumunu gösterir */
export default function Meter({ engine }: { engine: AudioEngine }) {
  const root = useRef<HTMLDivElement>(null);
  const bpmRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    let raf = 0;
    let frame = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const el = root.current;
      if (!el) return;
      const { bass, mid, high, beat, bpm, locked } = engine.last;
      const [b, m, h] = Array.from(el.querySelectorAll<HTMLElement>("i"));
      b.style.transform = `scaleX(${bass})`;
      m.style.transform = `scaleX(${mid})`;
      h.style.transform = `scaleX(${high})`;
      if (beat) {
        el.dataset.beats = String(engine.beatTotal);
        el.classList.add("beat");
        setTimeout(() => el.classList.remove("beat"), 90);
      }
      if (++frame % 15 === 0 && bpmRef.current) {
        bpmRef.current.textContent = bpm && locked ? `${Math.round(bpm)} BPM` : "BPM aranıyor";
        el.dataset.bpm = bpm && locked ? String(Math.round(bpm)) : "";
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [engine]);

  return (
    <div className="meter" ref={root} data-testid="meter" data-beats="0" data-bpm="">
      <div className="bars">
        <i /><i /><i />
      </div>
      <b />
      <span ref={bpmRef} className="bpm">—</span>
    </div>
  );
}
