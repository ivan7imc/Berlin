/*
 * Spike REAL — roda na SUA máquina (precisa de internet livre).
 *
 *   node spike/run-real.mjs                                  # só o Horde
 *   node spike/run-real.mjs --worker https://berlin-api.puter.work   # + worker no Puter
 *   node spike/run-real.mjs --watch-expiry                   # mede quanto tempo o resultado sobrevive
 *
 * Env:
 *   HORDE_API_KEY   (default 0000000000 = anônimo; use uma chave para sair do fim da fila)
 *
 * Este é o teste que responde ao go/no-go da seção 7 de docs/alternativa-puter.md.
 * O spike local (run-local.mjs) já validou a lógica; aqui medimos o mundo real.
 */

import { makePng } from "./harness/harness.mjs";

const args = process.argv.slice(2);
const arg = (name, dflt = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] || true : dflt;
};
const has = (name) => args.includes(`--${name}`);

const WORKER = arg("worker"); // ex.: https://berlin-api.puter.work
const WEBHOOK = arg("webhook"); // ex.: https://berlin-api.puter.work/api/hooks/horde
const TIMEOUT_MIN = Number(arg("timeout", 20));
const WATCH_EXPIRY = has("watch-expiry");

const HORDE = "https://aihorde.net/api";
const API_KEY = process.env.HORDE_API_KEY || "0000000000";
const AGENT = "Berlin-Spike:0.1:https://github.com/ivan7imc/Berlin";

const rows = [];
const add = (name, status, detail) => {
  rows.push({ name, status, detail });
  console.log(`${status === "PASS" ? "✅" : status === "FAIL" ? "❌" : "⏭️ "} ${name}${detail ? ` — ${detail}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function horde(path, options = {}) {
  const t0 = Date.now();
  const res = await fetch(`${HORDE}${path}`, {
    ...options,
    headers: { apikey: API_KEY, "Client-Agent": AGENT, ...(options.headers || {}) },
  });
  const ms = Date.now() - t0;
  let json = null;
  try {
    json = await res.json();
  } catch (_) {
    /* vazio */
  }
  return { status: res.status, ms, json, text: json ? null : await res.text().catch(() => null) };
}

console.log(`\n=== Spike real — Berlin × AI Horde ${WORKER ? "× Puter Workers" : ""} ===`);
console.log(`apikey: ${API_KEY === "0000000000" ? "anônima (fim da fila)" : "configurada"}\n`);

/* -------- 1. alcançabilidade e modelos -------- */
const models = await horde("/v2/status/models?type=image&model_state=all");
const active = (models.json || []).filter((m) => (m.count || 0) > 0);
add("GET /v2/status/models", models.status === 200 ? "PASS" : "FAIL", `${models.status} · ${active.length} modelos ativos · ${models.ms}ms`);
const model = active.length ? active[0].name : "Deliberate";

/* -------- 2. submit real (img2img) -------- */
const png = makePng(512, 512).toString("base64");
const payload = {
  prompt: "a cyberpunk street at night, neon reflections ### blurry, watermark, text",
  params: {
    steps: 20,
    n: 1,
    width: 512,
    height: 512,
    sampler_name: "k_euler",
    cfg_scale: 7.5,
    denoising_strength: 0.55,
    clip_skip: 1,
    karras: true,
  },
  models: [model],
  source_image: png,
  source_processing: "img2img",
  nsfw: false,
  censor_nsfw: false,
  r2: false,
  shared: false,
  replacement_filter: true,
  slow_workers: true,
};
if (WEBHOOK) payload.webhook = WEBHOOK;

const submitted = await horde("/v2/generate/async", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(payload),
});
const job = submitted.json;
add(
  "POST /v2/generate/async",
  submitted.status === 202 && job && job.id ? "PASS" : "FAIL",
  `${submitted.status} · ${submitted.ms}ms · kudos=${job?.kudos}${job?.warnings?.length ? ` · avisos=${JSON.stringify(job.warnings)}` : ""}`,
);
if (!job?.id) {
  console.log("\nSem job id, abortando.", submitted.text || "");
  process.exit(1);
}
console.log(`   job: ${job.id}  (modelo: ${model})`);

/* -------- 3. fila: check a cada 10 s -------- */
let done = false;
let lastCheck = null;
const tStart = Date.now();
let checks = 0;
while ((Date.now() - tStart) / 60000 < TIMEOUT_MIN) {
  const chk = await horde(`/v2/generate/check/${job.id}`);
  checks++;
  if (chk.status === 404) {
    add("job expirou antes de ser atendido", "FAIL", `depois de ${Math.round((Date.now() - tStart) / 1000)}s — hora de tentar extra_slow_workers`);
    process.exit(1);
  }
  lastCheck = chk.json;
  if (chk.json?.done) {
    done = true;
    break;
  }
  if (checks === 1) {
    console.log(`   fila: posição ${chk.json?.queue_position} · espera estimada ${chk.json?.wait_time}s · ${chk.json?.waiting} aguardando / ${chk.json?.processing} processando`);
  }
  await sleep(10000);
}
const elapsed = Math.round((Date.now() - tStart) / 1000);
add("job concluído", done ? "PASS" : "FAIL", `${elapsed}s · ${checks} chamadas de check · restarted=${lastCheck?.restarted}`);

/* -------- 4. status: a imagem vem? -------- */
const st = await horde(`/v2/generate/status/${job.id}`);
const gen = st.json?.generations?.[0];
const imgIsUrl = !!gen?.img?.startsWith("http");
const imgBytes = gen?.img ? (imgIsUrl ? 0 : Math.round((gen.img.length * 3) / 4)) : 0;
add(
  "GET /status traz a imagem",
  st.status === 200 && !!gen?.img ? "PASS" : "FAIL",
  `${st.status} · ${st.ms}ms · ${imgIsUrl ? "URL R2 (presinada, 30 min)" : `base64 de ~${imgBytes} bytes`} · worker=${gen?.worker_name} · seed=${gen?.seed}`,
);

/* -------- 5. webhook (só se houver um worker público) -------- */
if (WEBHOOK && WORKER) {
  const res = await fetch(`${WORKER}/api/results`).then((r) => r.json()).catch(() => null);
  const j = res?.jobs?.find((x) => x.id === job.id);
  add(
    "webhook do Horde entregue ao worker",
    j?.webhook_received_at ? "PASS" : "FAIL",
    j ? `recebido=${j.webhook_received_at} · trouxe_img=${j.webhook_has_img} · capturadas=${j.webhook_captured}` : "job não encontrado no worker",
  );
  if (WORKER) {
    const img = await fetch(`${WORKER}/api/edits/${job.id}/image`).catch(() => null);
    const buf = img ? Buffer.from(await img.arrayBuffer()) : Buffer.alloc(0);
    add("GET /api/edits/:id/image serve os bytes", img?.status === 200 ? "PASS" : "FAIL", `${img?.status} · ${buf.length} bytes`);
  }
} else {
  add("webhook do Horde", "SKIP", "passe --worker e --webhook para medir");
}

/* -------- 6. quanto tempo o resultado sobrevive -------- */
if (WATCH_EXPIRY && st.status === 200) {
  console.log("\n--watch-expiry: medindo até /status devolver 404 (pode levar ~20 min)...");
  const t0 = Date.now();
  let gone = false;
  while ((Date.now() - t0) / 60000 < 90) {
    await sleep(60000);
    const r = await horde(`/v2/generate/status/${job.id}`);
    if (r.status === 404) {
      gone = true;
      add("resultado expira no Horde", "PASS", `sobreviveu ~${Math.round((Date.now() - t0) / 60000)} min — essa é a janela de captura`);
      break;
    }
  }
  if (!gone) add("resultado expira no Horde", "FAIL", "ainda disponível após 90 min");
} else {
  add("janela de expiração do resultado", "SKIP", "rode com --watch-expiry para medir");
}

/* -------- 7. latência do worker no Puter -------- */
if (WORKER) {
  const lat = [];
  for (let i = 0; i < 50; i++) {
    const t0 = Date.now();
    const r = await fetch(`${WORKER}/api/health`).catch(() => null);
    if (r) lat.push(Date.now() - t0);
    await sleep(200);
  }
  lat.sort((a, b) => a - b);
  add("50 requisições ao worker", lat.length === 50 ? "PASS" : "FAIL", `p50=${lat[Math.floor(lat.length * 0.5)]}ms p95=${lat[Math.floor(lat.length * 0.95)]}ms`);

  const tick = await fetch(`${WORKER}/api/tick`, { method: "POST" }).then((r) => r.json()).catch(() => null);
  add("POST /api/tick (vigia)", tick ? "PASS" : "FAIL", JSON.stringify(tick));
}

/* -------- relatório -------- */
const pass = rows.filter((r) => r.status === "PASS").length;
const fail = rows.filter((r) => r.status === "FAIL").length;
const skip = rows.filter((r) => r.status === "SKIP").length;
console.log(`\n=== ${pass} PASS · ${fail} FAIL · ${skip} SKIP ===`);
console.log(`
Interpretação (go/no-go de docs/alternativa-puter.md):
  · submit em < 2 s e check estável            -> Horde ok
  · webhook entregue e imagem salva no worker  -> caminho primário validado (mata o problema do cold start)
  · 50 requisições sem erro e p95 aceitável    -> limites do Puter comportam o uso
  · janela de expiração medida                 -> define de quanto tempo o /tick dispõe
`);
process.exit(fail ? 1 : 0);
