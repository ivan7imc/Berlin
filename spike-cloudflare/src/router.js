import * as store from "./store.js";
import * as horde from "./horde.js";
import { buildPayload, buildBody, snap64 } from "./payload.js";
import { capture } from "./capture.js";
import { getImage, imageKey } from "./images.js";
import { tick } from "./tick.js";
import { inspectImage } from "./metadata.js";

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });

const ttlSeconds = (env) => Math.max(60, Number(env.RESULT_TTL_HOURS || 24) * 3600);

export async function router(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname;

  try {
    if (request.method === "GET" && path === "/api/health") {
      return json({ ok: true, now: Date.now(), horde: env.HORDE_BASE_URL || "https://aihorde.net/api" });
    }

    if (request.method === "GET" && path === "/api/models") return listModels(env);

    if (request.method === "POST" && path === "/api/inspect") return inspect(request);

    if (request.method === "POST" && path === "/api/edits") return createEdit(request, env, url);

    if (request.method === "GET" && path === "/api/results") {
      return json({ results: await store.listRecent(env, 20) });
    }

    if (request.method === "POST" && path === "/api/tick") {
      return json(await tick(env, { limit: 10 }));
    }

    if (request.method === "POST" && path === "/api/hooks/horde") return webhook(request, env);

    let m;
    if ((m = path.match(/^\/api\/edits\/([^/]+)\/image$/)) && request.method === "GET") {
      return serveImage(env, decodeURIComponent(m[1]));
    }
    if ((m = path.match(/^\/api\/edits\/([^/]+)$/)) && request.method === "GET") {
      return getEdit(env, decodeURIComponent(m[1]));
    }

    return json({ error: "not found", path }, 404);
  } catch (err) {
    return json({ error: String((err && err.stack) || err) }, 500);
  }
}

/* ---------- rotas ---------- */

async function listModels(env) {
  const key = "models:v1";
  const cached = await env.CACHE.get(key, { type: "json" });
  if (cached) return json({ models: cached, cached: true });

  const res = await horde.listModels(env);
  if (res.status !== 200) return json({ error: "falha ao listar modelos", horde: res.json }, 502);

  await env.CACHE.put(key, JSON.stringify(res.json), { expirationTtl: 300 }); // 5 min
  return json({ models: res.json, cached: false });
}

async function inspect(request) {
  const form = await request.formData();
  const file = form.get("image");
  if (!file) return json({ error: "campo 'image' ausente" }, 400);
  const buf = new Uint8Array(await file.arrayBuffer());
  return json(await inspectImage(buf));
}

async function createEdit(request, env, url) {
  const form = await request.formData();
  const raw = form.get("params");
  const p = raw ? JSON.parse(String(raw)) : {};

  const imagePart = form.get("image_b64"); // base64 como bytes opacos (Blob)
  if (!imagePart) return json({ error: "campo 'image_b64' ausente (base64 da imagem de entrada)" }, 400);

  const maskPart = form.get("mask_b64");
  const expectedN = Math.max(1, Number(p.n || 1));

  const id = crypto.randomUUID();
  const now = Date.now();

  // Em produção, a origem é a do próprio request. O var só existe para o spike
  // poder simular um webhook impossível de alcançar.
  const origin = env.WEBHOOK_BASE_URL || url.origin;
  const payload = buildPayload(p, { webhook: `${origin}/api/hooks/horde`, clientAgent: env.CLIENT_AGENT });

  const body = buildBody(payload, toBlob(imagePart), maskPart ? toBlob(maskPart) : null);

  // Guardamos o payload sem o base64 (não cabe nem faz sentido no D1)
  const storedPayload = { ...payload, source_image: "<bytes>", source_mask: maskPart ? "<bytes>" : undefined };
  await store.createJob(env, {
    id,
    hordeId: null,
    expectedN,
    params: JSON.stringify(storedPayload),
    now,
    nextPollAt: now + 4_000,
  });

  const res = await horde.submit(env, body);
  if (res.status !== 202) {
    await store.setError(env, id, `Horde rejeitou: HTTP ${res.status} ${JSON.stringify(res.json).slice(0, 400)}`, Date.now());
    return json({ error: "falha ao submeter ao Horde", horde: res.json, id }, 502);
  }

  await store.setHordeId(env, id, res.json.id, Date.now());
  return json({ id, horde_id: res.json.id, kudos: res.json.kudos, state: "pending" }, 202);
}

async function getEdit(env, id) {
  const job = await store.getJob(env, id);
  if (!job) return json({ error: "job não encontrado", id }, 404);
  return json({
    id: job.id,
    horde_id: job.horde_id,
    state: job.state,
    n: job.n,
    expected_n: job.expected_n,
    error: job.error,
    created_at: job.created_at,
    updated_at: job.updated_at,
    image_url: job.n > 0 ? `/api/edits/${job.id}/image` : null,
  });
}

async function serveImage(env, id) {
  const bytes = await getImage(env, imageKey(id, 0));
  if (!bytes) return json({ error: "imagem ainda não disponível" }, 404);
  return new Response(bytes, {
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": "private, max-age=3600",
      "Content-Length": String(bytes.byteLength),
    },
  });
}

/* O Horde chama aqui com timeout de 3 s e 3 tentativas. Com r2:true o corpo é
   pequeno (URLs pré-assinadas) — o trabalho é rede, não CPU. */
async function webhook(request, env) {
  const payload = await request.json();
  const hordeId = payload.request || payload.id;
  if (!hordeId) return json({ error: "payload sem id do request" }, 400);

  const job = await env.DB.prepare(`SELECT * FROM jobs WHERE horde_id = ?`).bind(hordeId).first();
  if (!job) return json({ error: "job desconhecido", horde_id: hordeId }, 404);

  const res = await capture(env, job, payload, ttlSeconds(env));
  return json({ received: true, ...res });
}

function toBlob(x) {
  if (x == null) return null;
  if (typeof x === "string") return new Blob([x]);
  return x; // File/Blob: vai direto para o corpo, sem cópia em string
}

export { snap64 };
