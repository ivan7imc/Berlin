/*
 * Berlin — Puter Worker (esqueleto da v1 + alvo do spike)
 *
 * Arquivo único de propósito: o Puter publica um worker a partir de UM arquivo .js,
 * então evitamos imports entre módulos. Para rodar local (Node), o harness injeta
 * os globals `router` e `me` antes de importar este arquivo.
 *
 * Rotas:
 *   GET  /api/health
 *   GET  /api/models
 *   POST /api/edits                 -> submete job no AI Horde
 *   GET  /api/edits/:id             -> estado (usa o store; só vai ao Horde se necessário)
 *   GET  /api/edits/:id/image       -> bytes da imagem (preview/download)
 *   POST /api/hooks/horde           -> webhook do Horde (caminho primário de captura)
 *   POST /api/tick                  -> vigia (chamado por cron externo)
 *   GET  /api/results               -> medições do spike
 */

/* ------------------------------------------------------------------ *
 * Configuração
 * ------------------------------------------------------------------ */
const CONFIG = {
  HORDE_BASE: globalThis.HORDE_BASE_URL || "https://aihorde.net/api",
  API_KEY: globalThis.HORDE_API_KEY || "0000000000", // anônimo
  CLIENT_AGENT: globalThis.CLIENT_AGENT || "Berlin-Spike:0.1:https://github.com/ivan7imc/Berlin",
  DEFAULT_MODEL: globalThis.DEFAULT_MODEL || "Deliberate",
  MAILBOX_TOKEN: globalThis.MAILBOX_TOKEN || "", // protege /api/hooks/horde
  CRON_TOKEN: globalThis.CRON_TOKEN || "",       // protege /api/tick
  WEBHOOK_BASE: globalThis.WEBHOOK_BASE_URL || "", // ex.: https://berlin-api.puter.work
  RESULTS_TTL_SECONDS: Number(globalThis.RESULTS_TTL_SECONDS || 86400),
  MAX_SOURCE_BYTES: Number(globalThis.MAX_SOURCE_BYTES || 10 * 1024 * 1024),
  SPIKE_MODE: globalThis.SPIKE_MODE === "1",
};

/* ------------------------------------------------------------------ *
 * Utilidades portáveis (isolate V8 e Node 22)
 * ------------------------------------------------------------------ */
const now = () => Date.now();

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64(bytes) {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

function snap64(n, lo = 64, hi = 3072) {
  const v = Math.round(n / 64) * 64;
  return Math.min(hi, Math.max(lo, v));
}

function joinPrompt(positive, negative) {
  const p = (positive || "").trim();
  const n = (negative || "").trim();
  return n ? `${p} ### ${n}` : p;
}

async function httpFetch(url, options) {
  // Puter expõe puter.net.fetch (CORS-free); em isolate o fetch global também existe.
  const fn =
    (globalThis.me && globalThis.me.puter && globalThis.me.puter.net && globalThis.me.puter.net.fetch) ||
    globalThis.fetch;
  return fn(url, options);
}

/* ------------------------------------------------------------------ *
 * Store: KV (índice de jobs) + FS (imagens)
 * Backends: Puter (me.puter) quando disponível; senão, shim de arquivos (Node)
 * ------------------------------------------------------------------ */
/* Backend Puter: KV na identidade do worker + FS do AppData (durável, ao contrário do disco do Render) */
function createPuterBackend() {
  const puter = globalThis.me.puter;
  const ROOT = "berlin";
  const p = (path) => `${ROOT}/${path}`;
  return {
    kind: "puter",
    async kvGet(key) {
      return (await puter.kv.get(p(key))) ?? null;
    },
    async kvSet(key, value) {
      await puter.kv.set(p(key), value);
    },
    async kvList(prefix) {
      const items = (await puter.kv.list(p(prefix) + "*")) || [];
      return items.map((it) => (typeof it === "string" ? it : it.key || it.name)).filter(Boolean);
    },
    async kvDel(key) {
      await puter.kv.del(p(key));
    },
    async putObject(path, bytes) {
      const full = p(path);
      const dir = full.split("/").slice(0, -1).join("/");
      try {
        await puter.fs.mkdir(dir, { recursive: true });
      } catch (_) {
        /* já existe */
      }
      await puter.fs.write(full, new Blob([bytes], { type: "application/octet-stream" }));
    },
    async getObject(path) {
      try {
        const blob = await puter.fs.read(p(path));
        if (!blob) return null;
        return new Uint8Array(await blob.arrayBuffer());
      } catch (_) {
        return null;
      }
    },
  };
}

function createStore() {
  const puterBackend = !!(globalThis.me && globalThis.me.puter && globalThis.me.puter.kv);
  const backend = puterBackend ? createPuterBackend() : globalThis.__fsBackend;

  if (!backend) {
    throw new Error("nenhum backend de storage disponível");
  }

  return {
    kind: backend.kind,
    async kvGet(key) {
      const raw = await backend.kvGet(key);
      return raw ? JSON.parse(raw) : null;
    },
    async kvSet(key, value) {
      await backend.kvSet(key, JSON.stringify(value));
    },
    async kvList(prefix) {
      return backend.kvList(prefix);
    },
    async kvDel(key) {
      await backend.kvDel(key);
    },
    async putObject(path, bytes) {
      await backend.putObject(path, bytes);
    },
    async getObject(path) {
      return backend.getObject(path);
    },
  };
}

let STORE = null;
const store = () => (STORE = STORE || createStore());

const keyJob = (id) => `job:${id}`;
const PREFIX_JOB = "job:";

/* ------------------------------------------------------------------ *
 * Cliente do AI Horde
 * ------------------------------------------------------------------ */
function hordeHeaders() {
  return {
    apikey: CONFIG.API_KEY,
    "Client-Agent": CONFIG.CLIENT_AGENT,
    "Content-Type": "application/json",
  };
}

async function hordeSubmit(payload) {
  const started = now();
  const res = await httpFetch(`${CONFIG.HORDE_BASE}/v2/generate/async`, {
    method: "POST",
    headers: hordeHeaders(),
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  const ms = now() - started;
  if (!res.ok && res.status !== 202) {
    return { ok: false, status: res.status, ms, body: text, error: text.slice(0, 500) };
  }
  let json = null;
  try {
    json = JSON.parse(text);
  } catch (_) {
    json = null;
  }
  return { ok: true, status: res.status, ms, json };
}

async function hordeCheck(id) {
  const res = await httpFetch(`${CONFIG.HORDE_BASE}/v2/generate/check/${id}`, {
    method: "GET",
    headers: hordeHeaders(),
  });
  if (res.status === 404) return { missing: true };
  const json = await res.json().catch(() => null);
  return { ok: res.ok, json, status: res.status };
}

async function hordeStatus(id) {
  const res = await httpFetch(`${CONFIG.HORDE_BASE}/v2/generate/status/${id}`, {
    method: "GET",
    headers: hordeHeaders(),
  });
  if (res.status === 404) return { missing: true };
  const json = await res.json().catch(() => null);
  return { ok: res.ok, json, status: res.status };
}

async function hordeModels() {
  const res = await httpFetch(`${CONFIG.HORDE_BASE}/v2/status/models?type=image&model_state=all`, {
    method: "GET",
    headers: hordeHeaders(),
  });
  const json = await res.json().catch(() => []);
  return Array.isArray(json) ? json : [];
}

/* ------------------------------------------------------------------ *
 * Montagem do payload (seção 3 do PLANO.md)
 * ------------------------------------------------------------------ */
function buildPayload(form, imageB64) {
  const width = snap64(Number(form.width || 512));
  const height = snap64(Number(form.height || 512));
  const params = {
    steps: clampInt(form.steps, 1, 500, 30),
    n: clampInt(form.n, 1, 20, 1),
    width,
    height,
    sampler_name: form.sampler_name || "k_euler",
    cfg_scale: clampNum(form.cfg_scale, 0, 100, 7.5),
    clip_skip: clampInt(form.clip_skip, 1, 12, 1),
    karras: form.karras === undefined ? true : !!form.karras,
  };

  if (form.seed) params.seed = String(form.seed);
  if (form.scheduler) params.scheduler = form.scheduler;
  if (form.denoising_strength !== undefined && form.denoising_strength !== null) {
    params.denoising_strength = clampNum(form.denoising_strength, 0.01, 1, 0.55);
  }
  if (form.hires_fix) params.hires_fix = true;
  if (form.tiling) params.tiling = true;
  if (form.post_processing && form.post_processing.length) params.post_processing = form.post_processing;

  const payload = {
    prompt: joinPrompt(form.prompt, form.negative_prompt),
    params,
    models: form.models && form.models.length ? form.models : [CONFIG.DEFAULT_MODEL],
    source_image: imageB64,
    source_processing: form.source_processing || "img2img",
    nsfw: !!form.nsfw,
    censor_nsfw: !!form.censor_nsfw,
    r2: form.r2 === undefined ? false : !!form.r2,
    shared: !!form.shared,
    replacement_filter: form.replacement_filter === undefined ? true : !!form.replacement_filter,
    slow_workers: form.slow_workers === undefined ? true : !!form.slow_workers,
    extra_slow_workers: !!form.extra_slow_workers,
    trusted_workers: !!form.trusted_workers,
  };

  if (form.source_mask) payload.source_mask = form.source_mask;
  if (CONFIG.WEBHOOK_BASE) {
    payload.webhook = `${CONFIG.WEBHOOK_BASE}/api/hooks/horde`;
  }
  return payload;
}

function clampInt(v, lo, hi, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, Math.round(n)));
}
function clampNum(v, lo, hi, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, n));
}

/* ------------------------------------------------------------------ *
 * Captura: grava gerações no store
 * ------------------------------------------------------------------ */
async function captureGenerations(jobId, generations, source) {
  // Lê UMA vez e acumula: reler dentro do loop perdia as gerações já salvas.
  const job = (await store().kvGet(keyJob(jobId))) || { id: jobId, state: "pending", generations: [] };
  job.generations = job.generations || [];
  const saved = [];

  for (let i = 0; i < generations.length; i++) {
    const gen = generations[i];
    const genId = gen.id || `${jobId}-${i}`;
    if (job.generations.some((g) => g.id === genId)) continue;

    let bytes = null;
    if (gen.img && !gen.img.startsWith("http")) {
      bytes = b64ToBytes(gen.img); // r2: false
    } else if (gen.img && gen.img.startsWith("http")) {
      const r = await httpFetch(gen.img); // r2: true — URL presinada (30 min)
      bytes = new Uint8Array(await r.arrayBuffer());
    }
    if (!bytes) continue;

    const path = `results/${jobId}/${genId}.webp`;
    await store().putObject(path, bytes);
    const entry = {
      id: genId,
      path,
      bytes: bytes.length,
      seed: gen.seed,
      model: gen.model,
      worker_name: gen.worker_name,
      censored: !!gen.censored,
      captured_at: new Date().toISOString(),
      captured_via: source,
    };
    job.generations.push(entry);
    saved.push(entry);
  }

  const expected = job.expected_n || 1;
  job.id = jobId;
  job.state = job.generations.length >= expected ? "done" : "partial";
  job.updated_at = new Date().toISOString();
  await store().kvSet(keyJob(jobId), job);
  return { job, saved };
}

/* ------------------------------------------------------------------ *
 * Rotas
 * ------------------------------------------------------------------ */
router.get("/api/health", async () => ({ ok: true, store: store().kind, spike: CONFIG.SPIKE_MODE }));

router.get("/api/models", async () => {
  const models = await hordeModels();
  const active = models.filter((m) => (m.count || 0) > 0);
  return { total: models.length, active: active.length, models: active.slice(0, 20) };
});

router.post("/api/edits", async ({ request }) => {
  const form = await request.json();
  if (!form.image_base64) {
    return new Response(JSON.stringify({ error: "image_base64 obrigatório" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
  const bytes = b64ToBytes(form.image_base64);
  if (bytes.length > CONFIG.MAX_SOURCE_BYTES) {
    return new Response(JSON.stringify({ error: "imagem acima do limite" }), { status: 413 });
  }

  const payload = buildPayload(form, form.image_base64);
  const submitted = await hordeSubmit(payload);

  if (!submitted.ok) {
    return new Response(
      JSON.stringify({ error: "falha ao submeter", status: submitted.status, detail: submitted.error }),
      { status: 502, headers: { "Content-Type": "application/json" } },
    );
  }

  const id = submitted.json && submitted.json.id;
  const job = {
    id,
    created_at: new Date().toISOString(),
    expires_at: new Date(now() + (form.extra_slow_workers ? 60 : 20) * 60 * 1000).toISOString(),
    kudos: submitted.json && submitted.json.kudos,
    warnings: (submitted.json && submitted.json.warnings) || [],
    webhook: payload.webhook || null,
    state: "pending",
    generations: [],
    expected_n: payload.params.n || 1,
    submit_ms: submitted.ms,
    params: payload.params,
  };
  await store().kvSet(keyJob(id), job);

  return {
    job_id: id,
    kudos: job.kudos,
    warnings: job.warnings,
    webhook: job.webhook,
    submit_ms: submitted.ms,
    status_url: `/api/edits/${id}`,
    image_url: `/api/edits/${id}/image`,
  };
});

router.get("/api/edits/:id", async ({ params }) => {
  const id = params.id;
  const job = await store().kvGet(keyJob(id));
  if (!job) {
    const chk = await hordeCheck(id);
    if (chk.missing) return new Response(JSON.stringify({ error: "job desconhecido" }), { status: 404 });
    return { id, state: "unknown", horde: chk.json };
  }

  // Já capturado (total ou parcial)? não gasta chamada de /status no Horde.
  if (job.state === "done" || job.state === "partial") {
    return {
      id,
      state: "done",
      generations: job.generations,
      image_urls: job.generations.map((g, i) => `/api/edits/${id}/image?index=${i}`),
      from_store: true,
    };
  }

  const chk = await hordeCheck(id);
  if (chk.missing) {
    job.state = "expired";
    await store().kvSet(keyJob(id), job);
    return { id, state: "expired", message: "resultado expirou no Horde; reenvie" };
  }
  return { id, state: job.state, horde: chk.json };
});

router.get("/api/edits/:id/image", async ({ request, params }) => {
  const url = new URL(request.url);
  const index = Number(url.searchParams.get("index") || 0);
  const job = await store().kvGet(keyJob(params.id));
  if (!job || !job.generations || !job.generations[index]) {
    return new Response("não pronto", { status: 425 });
  }
  const bytes = await store().getObject(job.generations[index].path);
  if (!bytes) return new Response("expirado", { status: 404 });
  return new Response(bytes, {
    status: 200,
    headers: {
      "Content-Type": "image/webp",
      "Content-Disposition": `attachment; filename="${params.id}-${index}.webp"`,
    },
  });
});

/* Webhook do Horde: o payload já traz get_details() (com `img`) + request/id/kudos.
   O Horde espera resposta em 3 s e tenta 3 vezes — por isso esta rota é magra. */
router.post("/api/hooks/horde", async ({ request }) => {
  const t0 = now();
  const data = await request.json();
  const jobId = data.request || data.id;
  if (!jobId) return new Response("sem request id", { status: 400 });

  // Captura PRIMEIRO e só depois lê o job: gravar um objeto lido antes sobrescrevia o estado.
  let saved = [];
  if (data.img) {
    // r2:false → bytes na hora; r2:true → só a URL (o /tick baixa)
    const gens = [{ id: data.id, img: data.img, seed: data.seed, model: data.model, worker_name: data.worker_name }];
    saved = (await captureGenerations(jobId, gens, "webhook")).saved;
  }

  const job = (await store().kvGet(keyJob(jobId))) || { id: jobId, state: "pending", generations: [] };
  job.id = jobId;
  job.webhook_received_at = new Date().toISOString();
  job.webhook_payload_bytes = JSON.stringify(data).length;
  job.webhook_has_img = !!(data && data.img);
  job.webhook_captured = saved.length;
  await store().kvSet(keyJob(jobId), job);

  return { ok: true, ms: now() - t0 };
});

/* Vigia: chamado por cron externo (bater aqui não custa hora de instância). */
router.post("/api/tick", async ({ request }) => {
  if (CONFIG.CRON_TOKEN && request.headers.get("x-cron-token") !== CONFIG.CRON_TOKEN) {
    return new Response("forbidden", { status: 403 });
  }
  const t0 = now();
  const keys = await store().kvList(PREFIX_JOB);
  let pending = 0;
  let captured = 0;
  let expired = 0;

  for (const key of keys) {
    const job = await store().kvGet(key);
    if (!job || job.state === "done" || job.state === "expired") continue;
    pending++;
    const st = await hordeStatus(job.id);
    if (st.missing) {
      job.state = "expired";
      await store().kvSet(key, job);
      expired++;
      continue;
    }
    if (st.json && st.json.done) {
      const { saved } = await captureGenerations(job.id, st.json.generations || [], "tick");
      captured += saved.length;
    }
  }
  return { ms: now() - t0, pending, captured, expired };
});

/* Medições do spike */
router.get("/api/results", async () => {
  const keys = await store().kvList(PREFIX_JOB);
  const jobs = [];
  for (const key of keys) jobs.push(await store().kvGet(key));
  return { count: jobs.length, jobs };
});
