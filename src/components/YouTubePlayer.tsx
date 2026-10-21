"use client";

import { useEffect, useRef } from "react";
import type { MediaClock } from "../lib/audio";

type YTPlayer = {
  getCurrentTime(): number;
  getDuration(): number;
  getPlayerState(): number;
  getPlaybackRate(): number;
  destroy(): void;
};
type YTNamespace = {
  Player: new (
    el: HTMLElement,
    opts: {
      videoId: string;
      host?: string;
      playerVars?: Record<string, number>;
      events?: { onReady?: () => void };
    },
  ) => YTPlayer;
};
type W = Window & { YT?: YTNamespace; onYouTubeIframeAPIReady?: () => void };

let apiPromise: Promise<YTNamespace> | null = null;
function loadApi() {
  apiPromise ??= new Promise((resolve) => {
    const w = window as W;
    if (w.YT?.Player) return resolve(w.YT);
    w.onYouTubeIframeAPIReady = () => resolve(w.YT!);
    const s = document.createElement("script");
    s.src = "https://www.youtube.com/iframe_api";
    document.head.appendChild(s);
  });
  return apiPromise;
}

/**
 * YouTube oynatıcısını saat olarak sunar. getCurrentTime() kaba aralıklarla güncellenir;
 * değer değiştiğinde çapalanır, arada duvar saatiyle ilerletilir.
 */
export class YouTubeClock implements MediaClock {
  private anchorT = 0;
  private anchorAt = 0;
  private lastRaw = -1;

  constructor(private p: YTPlayer) {}

  get duration() {
    return this.p.getDuration() || 0;
  }
  get paused() {
    // 1: oynuyor, 3: arabelleğe alıyor
    return this.p.getPlayerState() !== 1;
  }
  get ended() {
    return this.p.getPlayerState() === 0;
  }
  get playbackRate() {
    return this.p.getPlaybackRate() || 1;
  }
  get currentTime() {
    const raw = this.p.getCurrentTime() || 0;
    const now = performance.now();
    if (this.paused) {
      this.anchorT = raw;
      this.anchorAt = now;
    } else if (raw !== this.lastRaw) {
      const est = this.anchorT + ((now - this.anchorAt) / 1000) * this.playbackRate;
      // Küçük farkta yumuşak düzelt, büyük farkta (sarma) atla
      this.anchorT = Math.abs(raw - est) > 0.3 ? raw : est + (raw - est) * 0.3;
      this.anchorAt = now;
    }
    this.lastRaw = raw;
    return this.anchorT + (this.paused ? 0 : ((now - this.anchorAt) / 1000) * this.playbackRate);
  }
}

export default function YouTubePlayer({ videoId, onReady }: { videoId: string; onReady: (c: YouTubeClock) => void }) {
  const host = useRef<HTMLDivElement>(null);
  const cb = useRef(onReady);
  cb.current = onReady;

  useEffect(() => {
    let player: YTPlayer | null = null;
    let cancelled = false;
    void loadApi().then((YT) => {
      if (cancelled || !host.current) return;
      const el = document.createElement("div");
      host.current.appendChild(el);
      player = new YT.Player(el, {
        videoId,
        host: "https://www.youtube-nocookie.com",
        playerVars: { autoplay: 1, playsinline: 1, rel: 0 },
        events: { onReady: () => player && cb.current(new YouTubeClock(player)) },
      });
    });
    return () => {
      cancelled = true;
      player?.destroy();
      if (host.current) host.current.innerHTML = "";
    };
  }, [videoId]);

  return <div ref={host} className="player" />;
}
