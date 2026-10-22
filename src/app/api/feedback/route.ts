import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

export const dynamic = "force-dynamic";

const FILE = path.join(process.cwd(), "data", "feedback.jsonl");
const REASONS = ["rhythm", "no-audio", "slow", "other"];
const MAX_MSG = 500;

const clip = (v: unknown, n: number) => (typeof v === "string" ? v.trim().slice(0, n) : "");

/**
 * Kalıcı depo: Vercel'de Upstash Redis (REST) bağlıysa onu kullanır; yerelde dosya.
 * Env adları Vercel'in Upstash entegrasyonunun eklediklerine göre (KV_*) ve Upstash'in kendi adları desteklenir.
 */
const redisUrl = () => process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
const redisToken = () => process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
const useRedis = () => !!(redisUrl() && redisToken());
/** Yerelde dosya yazılabilir; yayında yalnızca Redis bağlıysa saklanabilir */
const storageReady = () => process.env.NODE_ENV !== "production" || useRedis();
const KEY = "technolab:feedback";
const RETENTION_SECONDS = 180 * 24 * 60 * 60;

async function redis(cmd: (string | number)[]) {
  const r = await fetch(redisUrl()!, {
    method: "POST",
    headers: { Authorization: `Bearer ${redisToken()}`, "Content-Type": "application/json" },
    body: JSON.stringify(cmd),
    cache: "no-store",
  });
  if (!r.ok) throw new Error("redis " + r.status);
  return ((await r.json()) as { result: unknown }).result;
}

/** Basit IP başına sınır: dakikada en fazla 5 gönderim (bellekte, sunucu yeniden başlayınca sıfırlanır) */
const hits = new Map<string, number[]>();
function limited(ip: string) {
  const now = Date.now();
  const list = (hits.get(ip) ?? []).filter((t) => now - t < 60_000);
  list.push(now);
  hits.set(ip, list);
  return list.length > 5;
}

/** Yerelde (dev) herkes okuyabilir; yayında ADMIN_KEY ayarlı ve eşleşmeden okunamaz */
function canRead(req: Request) {
  if (process.env.NODE_ENV !== "production") return true;
  const key = process.env.ADMIN_KEY;
  return !!key && new URL(req.url).searchParams.get("key") === key;
}

export async function POST(req: Request) {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? "local";
  if (limited(ip)) return Response.json({ error: "Çok hızlı gönderiyorsun, biraz bekle." }, { status: 429 });

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Geçersiz istek." }, { status: 400 });
  }
  // Gizli alan: botlar doldurur, insanlar görmez
  if (clip(body.website, 50)) return Response.json({ ok: true });

  const vote = body.vote === "up" || body.vote === "down" ? body.vote : null;
  const reason = REASONS.includes(body.reason as string) ? (body.reason as string) : "";
  const message = clip(body.message, MAX_MSG);
  if (!vote && !message) return Response.json({ error: "Boş mesaj." }, { status: 400 });

  const ctx = (body.ctx ?? {}) as Record<string, unknown>;
  const entry = {
    at: new Date().toISOString(),
    vote,
    reason,
    message,
    ctx: {
      source: clip(ctx.source, 20),
      bpm: typeof ctx.bpm === "number" ? Math.round(ctx.bpm) : null,
      sensitivity: typeof ctx.sensitivity === "number" ? Math.round(ctx.sensitivity * 100) / 100 : null,
      video: clip(ctx.video, 20),
      section: clip(ctx.section, 20),
      ua: clip(ctx.ua, 160),
    },
  };

  if (!storageReady()) return Response.json({ error: "Şu an kaydedilemedi." }, { status: 503 });
  try {
    if (useRedis()) {
      await redis(["LPUSH", KEY, JSON.stringify(entry)]);
      await redis(["LTRIM", KEY, 0, 999]); // en yeni 1000 kayıt
      await redis(["EXPIRE", KEY, RETENTION_SECONDS]); // son yazmadan 180 gün sonra tümü silinir
    } else {
      await mkdir(path.dirname(FILE), { recursive: true });
      await appendFile(FILE, JSON.stringify(entry) + "\n");
    }
  } catch {
    return Response.json({ error: "Şu an kaydedilemedi." }, { status: 503 });
  }
  return Response.json({ ok: true });
}

export async function GET(req: Request) {
  // Form gösterilsin mi? Saklayacak depo hazırsa evet. Veri döndürmez, anahtar gerekmez.
  if (new URL(req.url).searchParams.has("status")) return Response.json({ enabled: storageReady() });
  if (!canRead(req)) return Response.json({ error: "Yetkisiz." }, { status: 401 });
  try {
    if (useRedis()) {
      const rows = (await redis(["LRANGE", KEY, 0, 499])) as string[];
      return Response.json({ items: rows.map((r) => JSON.parse(r)) });
    }
    const raw = await readFile(FILE, "utf8");
    const items = raw
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .reverse();
    return Response.json({ items });
  } catch {
    return Response.json({ items: [] });
  }
}
