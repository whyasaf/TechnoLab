"use client";

import { useEffect, useState } from "react";

type Item = {
  at: string;
  vote: "up" | "down" | null;
  reason: string;
  message: string;
  email?: string;
  ctx: { source: string; bpm: number | null; sensitivity: number | null; video: string; section: string; ua: string };
};

const REASON: Record<string, string> = {
  rhythm: "Işık ritme uymadı",
  "no-audio": "Ses algılanmadı",
  slow: "Görüntü kasıyor",
  other: "Başka",
};

export default function Messages() {
  const [items, setItems] = useState<Item[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    const key = new URLSearchParams(window.location.search).get("key");
    fetch("/api/feedback" + (key ? `?key=${encodeURIComponent(key)}` : ""))
      .then(async (r) => {
        if (!r.ok) throw new Error(r.status === 401 ? "Yetkisiz: anahtar gerekli." : "Okunamadı.");
        setItems(((await r.json()) as { items: Item[] }).items);
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  const up = items?.filter((i) => i.vote === "up").length ?? 0;
  const down = items?.filter((i) => i.vote === "down").length ?? 0;
  const byReason = Object.entries(REASON).map(([k, v]) => [v, items?.filter((i) => i.reason === k).length ?? 0] as const);

  return (
    <main className="msgs">
      <h1>Mesajlar</h1>
      {error && <p className="error">{error}</p>}
      {items && (
        <>
          <p className="msgs-sum">
            {items.length} kayıt · 👍 {up} · 👎 {down}
            {byReason.some(([, n]) => n) && " · " + byReason.filter(([, n]) => n).map(([l, n]) => `${l}: ${n}`).join(" · ")}
          </p>
          {items.length === 0 && <p className="note">Henüz mesaj yok.</p>}
          <ul>
            {items.map((i, n) => (
              <li key={i.at + n}>
                <div className="msgs-head">
                  <span>{i.vote === "up" ? "👍" : i.vote === "down" ? "👎" : "💬"}</span>
                  <time>{new Date(i.at).toLocaleString("tr-TR")}</time>
                  {i.reason && <em>{REASON[i.reason] ?? i.reason}</em>}
                </div>
                {i.message && <p>{i.message}</p>}
                <small>
                  {[
                    i.ctx.source && `kaynak: ${i.ctx.source}`,
                    i.ctx.bpm && `${i.ctx.bpm} BPM`,
                    i.ctx.section && i.ctx.section,
                    i.ctx.video && `video: ${i.ctx.video}`,
                    i.email && `e-posta: ${i.email}`,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </small>
              </li>
            ))}
          </ul>
        </>
      )}
    </main>
  );
}
