import * as store from "./store.js";
import * as horde from "./horde.js";
import { buildPayload, LIMITS } from "./payload.js";
import { capture, safeJson } from "./capture.js";
import { getImage, imageKey } from "./images.js";
import { tick } from "./tick.js";
import { inspectImage } from "../public/shared/metadata.js";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS },
  });

const ttlSeconds = (env) => Math.max(60, Number(env.RESULT_TTL_HOURS || 24) * 3600);

export async function router(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname;

  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  try {
    if (request.method === "GET" && path === "/api/health") return health(env, url);

    if (request.method === "GET" && path === "/api/limits") {
      return json({
        source_processing: LIMITS.SOURCE_PROCESSING,
        schedulers: LIMITS.SCHEDULERS,
        post_processing: LIMITS.POST_PROCESSING,
        post_processing_order: LIMITS.POST_PROCESSING_ORDER,
        max_n: 20,
        max_dimension: 3072,
        snap: 64,
      });
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
    if ((m = path.match(/^\/api\/edits\/([^/]+)\/image$/))) {
      if (request.method !== "GET") return json({ error: "use GET" }, 405);
      const index = Math.max(0, Number(url.searchParams.get("index") || 0));
      return serveImage(env, decodeURIComponent(m[1]), index);
    }
    if ((m = path.match(/^\/api\/edits\/([^/]+)$/))) {
      const id = decodeURIComponent(m[1]);
      if (request.method === "GET") return getEdit(env, id);
      if (request.method === "DELETE") return cancelEdit(env, id);
    }

    return json({ error: "not found", path }, 404);
  } catch (err) {
    return json({ error: String((err && err.message) || err) }, err && err.status ? err.status : 500);
  }
}

/* ---------------- rotas ---------------- */

/* Diagnóstico. Nunca devolve a chave — só se existe, se tem sujeira (espaço/quebra
   de linha) e o que o Horde responde quando ela é usada. ?deep=1 chama /v2/find_user. */
async function health(env, url) {
  const raw = env.HORDE_API_KEY;
  const key = {
    present: typeof raw === "string" && raw.length > 0,
    length: typeof raw === "string" ? raw.length : 0,
    trimmed_clean: typeof raw === "string" ? raw === raw.trim() : null,
    mode: raw ? "authenticated" : "anonymous",
  };

  const out = {
    ok: true,
    now: Date.now(),
    horde: env.HORDE_BASE_URL || "https://aihorde.net/api",
    bindings: { DB: !!env.DB, IMAGES: !!env.IMAGES, CACHE: !!env.CACHE },
    key,
  };

  if (url.searchParams.get("deep") === "1") {
    try {
      const res = await horde.findUser(env);
      out.horde_auth =
        res.status === 200
          ? { valid: true, username: res.json.username, kudos: res.json.kudos }
          : { valid: false, status: res.status, message: res.json && res.json.message };
    } catch (err) {
      out.horde_auth = { valid: false, error: String((err && err.message) || err) };
    }
  }

  return json(out);
}

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
  const p = JSON.parse(String(form.get("params") || "{}"));

  const imagePart = form.get("image_b64"); // base64 como bytes opacos (Blob)
  if (!imagePart) return json({ error: "campo 'image_b64' ausente" }, 400);
  const maskPart = form.get("mask_b64");

  const origin = env.WEBHOOK_BASE_URL || url.origin;
  let payload;
  try {
    payload = buildPayload(p, {
      webhook: `${origin}/api/hooks/horde`,
      clientAgent: env.CLIENT_AGENT,
      mask: !!maskPart,
    });
  } catch (err) {
    return json({ error: String(err.message || err) }, 400); // erro de validação é 400, não 500
  }

  // Construímos o FormData para o Horde
  // O AI Horde aceita todos os parâmetros como campos individuais do FormData
  const hordeForm = new FormData();
  
  // Adicionamos todos os campos do payload como campos individuais
  // Campos que são objetos precisam ser serializados como JSON
  for (const [key, value] of Object.entries(payload)) {
    if (value === undefined || value === null) continue;
    
    if (key === 'params' || key === 'models' || key === 'workers') {
      // Campos que são arrays ou objetos
      hordeForm.append(key, JSON.stringify(value));
    } else if (typeof value === 'object') {
      hordeForm.append(key, JSON.stringify(value));
    } else {
      hordeForm.append(key, String(value));
    }
  }
  
  // Adicionamos a imagem e máscara como arquivos binários
  // O AI Horde aceita source_image e source_mask como campos de arquivo
  // O frontend envia a imagem como base64 (string) dentro de um Blob
  // Precisamos converter de volta para bytes da imagem
  const imageBlob = await base64ToBlob(imagePart);
  if (imageBlob) {
    hordeForm.append("source_image", imageBlob, "source.png");
  }
  if (maskPart) {
    const maskBlob = await base64ToBlob(maskPart);
    if (maskBlob) {
      hordeForm.append("source_mask", maskBlob, "mask.png");
    }
  }

  // dry_run não gera nada: só estima kudos (custa 0)
  if (payload.dry_run) {
    const res = await horde.submit(env, hordeForm, true);
    if (res.status !== 200) return json({ error: "dry_run recusado", horde: res.json }, 502);
    return json({ dry_run: true, kudos: res.json.kudos, warnings: res.json.warnings || [] });
  }

  const id = crypto.randomUUID();
  const now = Date.now();
  await store.createJob(env, {
    id,
    expectedN: payload.params.n,
    params: JSON.stringify({ ...payload, source_image: "<bytes>", source_mask: maskPart ? "<bytes>" : undefined }),
    now,
    nextPollAt: now + 4_000,
  });

  const res = await horde.submit(env, hordeForm, true);
  if (res.status !== 202) {
    const detail = JSON.stringify(res.json).slice(0, 400);
    await store.setError(env, id, `Horde recusou (HTTP ${res.status}): ${detail}`, Date.now());
    return json({ error: "falha ao submeter ao Horde", horde: res.json, id }, 502);
  }

  await store.setSubmitted(env, { id, hordeId: res.json.id, warnings: res.json.warnings, now: Date.now() });
  return json(
    {
      id,
      horde_id: res.json.id,
      kudos: res.json.kudos,
      warnings: res.json.warnings || [],
      state: "pending",
      status_url: `/api/edits/${id}`,
      image_url: `/api/edits/${id}/image`,
      poll_interval_ms: 4000,
    },
    202
  );
}

async function getEdit(env, id) {
  const job = await store.getJob(env, id);
  if (!job) return json({ error: "job não encontrado", id }, 404);

  const out = {
    id: job.id,
    horde_id: job.horde_id,
    state: job.state,
    n: job.n,
    expected_n: job.expected_n,
    error: job.error,
    created_at: job.created_at,
    updated_at: job.updated_at,
    generations: safeJson(job.generations, []),
    warnings: safeJson(job.warnings, []),
    image_urls: Array.from({ length: job.n }, (_, i) => `/api/edits/${job.id}/image?index=${i}`),
  };

  // Enquanto não terminou, /check dá a posição na fila (é barato: 10/s)
  if (job.horde_id && (job.state === "pending" || job.state === "partial")) {
    const chk = await horde.check(env, job.horde_id);
    if (chk.status === 200) {
      out.queue = {
        waiting: chk.json.waiting,
        processing: chk.json.processing,
        finished: chk.json.finished,
        restarted: chk.json.restarted,
        queue_position: chk.json.queue_position,
        wait_time: chk.json.wait_time,
        is_possible: chk.json.is_possible,
        kudos: chk.json.kudos,
      };
    } else if (chk.status === 404) {
      out.queue = { gone: true };
    }
  }

  return json(out);
}

async function serveImage(env, id, index) {
  const job = await store.getJob(env, id);
  if (!job) return json({ error: "job não encontrado", id }, 404);
  if (index >= job.n) return json({ error: `só há ${job.n} imagem(ns) pronta(s)` }, 425);

  const bytes = await getImage(env, imageKey(id, index));
  if (!bytes) return json({ error: "imagem ainda não disponível" }, 425);

  const gens = safeJson(job.generations, []);
  const gen = gens[index] || {};
  return new Response(bytes, {
    headers: {
      "Content-Type": "image/png",
      "Content-Length": String(bytes.byteLength),
      "Cache-Control": "private, max-age=3600",
      "X-Seed": String(gen.seed ?? ""),
      "X-Worker-Name": String(gen.worker_name ?? ""),
      "X-Model": String(gen.model ?? ""),
      ...CORS,
    },
  });
}

async function cancelEdit(env, id) {
  const job = await store.getJob(env, id);
  if (!job) return json({ error: "job não encontrado", id }, 404);
  if (job.horde_id) await horde.cancel(env, job.horde_id);
  await store.setError(env, id, "cancelado pelo usuário", Date.now());
  return json({ id, state: "error", error: "cancelado pelo usuário" });
}

/* O Horde chama aqui com timeout de 3 s e 3 tentativas. Com r2:true o corpo é
   pequeno, então o trabalho é rede, não CPU — e respondemos em dezenas de ms. */
async function webhook(request, env) {
  const payload = await request.json();
  const hordeId = payload.request || payload.id;
  if (!hordeId) return json({ error: "payload sem id do request" }, 400);

  const job = await store.getJobByHordeId(env, hordeId);
  if (!job) return json({ error: "job desconhecido", horde_id: hordeId }, 404);

  const res = await capture(env, job, payload, ttlSeconds(env));
  return json({ received: true, ...res });
}

function toBlob(x) {
  if (x == null) return null;
  if (typeof x === "string") return new Blob([x]);
  return x; // File/Blob: vai direto para o corpo, sem virar string
}

// Converte um Blob contendo string base64 de volta para Blob com bytes da imagem
async function base64ToBlob(blobOrFile) {
  if (!blobOrFile) return null;
  
  // Obtém a string base64 do Blob
  const base64String = await blobOrFile.text();
  
  // Decodifica o base64 para bytes
  // Usamos atob que está disponível em Cloudflare Workers
  const binaryString = atob(base64String);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  
  return new Blob([bytes], { type: 'application/octet-stream' });
}
