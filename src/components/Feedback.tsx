"use client";

import { useEffect, useState } from "react";
import type { AudioEngine } from "../lib/audio";

const REASONS: [string, string][] = [
  ["rhythm", "Işık ritme uymadı"],
  ["no-audio", "Ses algılanmadı"],
  ["slow", "Görüntü kasıyor"],
  ["other", "Başka"],
];

type Props = { engine: AudioEngine; videoId: string | null };

export default function Feedback({ engine, videoId }: Props) {
  const [open, setOpen] = useState(false);
  const [vote, setVote] = useState<"up" | "down" | null>(null);
  const [reason, setReason] = useState("");
  const [message, setMessage] = useState("");
  const [trap, setTrap] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "done" | "error">("idle");
  const [err, setErr] = useState("");

  const send = async () => {
    if (!vote && !message.trim()) return;
    setState("sending");
    try {
      const f = engine.last;
      const res = await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          vote, reason, message, website: trap,
          ctx: {
            source: engine.kind, bpm: f.bpm, sensitivity: engine.sensitivity, video: videoId ?? "",
            ua: navigator.userAgent,
          },
        }),
      });
      if (!res.ok) throw new Error(((await res.json()) as { error?: string }).error ?? "Gönderilemedi.");
      setState("done");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Gönderilemedi.");
      setState("error");
    }
  };

  const close = () => {
    setOpen(false);
    if (state === "done") {
      setVote(null);
      setReason("");
      setMessage("");
      setState("idle");
    }
  };

  // Gönderilince teşekkür mesajı kısa süre görünür, sonra panel kendiliğinden kapanıp sıfırlanır
  useEffect(() => {
    if (state !== "done") return;
    const t = setTimeout(() => {
      setOpen(false);
      setVote(null);
      setReason("");
      setMessage("");
      setState("idle");
    }, 2200);
    return () => clearTimeout(t);
  }, [state]);

  return (
    <div className="fb">
      <button className="fb-toggle" onClick={() => (open ? close() : setOpen(true))} aria-expanded={open}>
        Geri bildirim
      </button>
      {open && (
        <div className="fb-panel" role="dialog" aria-label="Geri bildirim">
          {state === "done" ? (
            <p className="fb-done">Teşekkürler, mesajın bana ulaştı.</p>
          ) : (
            <>
              <div className="fb-votes">
                <button className={vote === "up" ? "on" : ""} onClick={() => setVote("up")} aria-label="Beğendim">
                  👍
                </button>
                <button className={vote === "down" ? "on" : ""} onClick={() => setVote("down")} aria-label="Beğenmedim">
                  👎
                </button>
              </div>
              {vote === "down" && (
                <div className="fb-reasons">
                  {REASONS.map(([k, label]) => (
                    <button key={k} className={reason === k ? "on" : ""} onClick={() => setReason(k)}>
                      {label}
                    </button>
                  ))}
                </div>
              )}
              <textarea
                placeholder="Ne düşünüyorsun? Ne eklememi isterdin?"
                maxLength={500}
                rows={3}
                value={message}
                onChange={(e) => setMessage(e.target.value)}
              />
              {/* Bot tuzağı: insanlara görünmez */}
              <input
                className="fb-trap"
                tabIndex={-1}
                autoComplete="off"
                aria-hidden
                name="website"
                value={trap}
                onChange={(e) => setTrap(e.target.value)}
              />
              <p className="fb-fine">
                Mesaja kişisel bilgi (telefon, adres, e-posta) yazma; cevap vermiyorum. Mesajla birlikte kaynak türü,
                BPM ve tarayıcı bilgisi gönderilir.{" "}
                <a href="/gizlilik" target="_blank" rel="noopener">
                  Aydınlatma metni
                </a>
              </p>
              {state === "error" && <p className="error">{err}</p>}
              <button className="fb-send" onClick={send} disabled={state === "sending" || (!vote && !message.trim())}>
                {state === "sending" ? "Gönderiliyor…" : "Gönder"}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
