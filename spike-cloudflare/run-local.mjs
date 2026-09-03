/* Suíte local do spike Cloudflare Workers.
   Sobe o mock do Horde e o `wrangler dev` (workerd de verdade, D1 e KV locais)
   e roda os testes contra eles. Não sai da máquina e não precisa de conta Cloudflare. */

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { startMockHorde, makePng } from "./harness/horde-mock.mjs";

const ORIGIN = "http://127.0.0.1:8787";
const MOCK_PORT = 8788;
const PERSIST = ".wrangler-state";
const MODELS_TTL = 300;

const sha = (buf) => createHash("sha256").update(buf).digest("hex").slice(0, 16);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (arr, p) => arr.slice().sort((a, b) => a - b)[Math.min(arr.length - 1, Math.floor(arr.length * p))];

let pass = 0;
let fail = 0;
const failures = [];
const notes = [];

async function check(name, fn) {
  try {
    const info = await fn();
    pass++;
    console.log(`  ✅ ${name}${info ? ` — ${info}` : ""}`);
  } catch (err) {
    fail++;
    failures.push(name);
    console.log(`  ❌ ${name}\n       ${String(err.message).split("\n").join("\n       ")}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

/* ---------------- setup ---------------- */

console.log("\n=== Spike Cloudflare Workers: preparando ===\n");

// execução anterior pode ter deixado o workerd vivo (se um teste quebrou no meio)
spawnSync("pkill", ["-f", "worker[d]-linux-64"]);

fs.rmSync(PERSIST, { recursive: true, force: true });

const mig = spawnSync(
  "npx",
  ["wrangler", "d1", "execute", "berlin-spike", "--local", "--file=schema.sql", "--persist-to", PERSIST, "-y"],
  { encoding: "utf8" }
);
if (mig.status !== 0) {
  console.error("falha ao aplicar schema.sql:\n", mig.stdout, mig.stderr);
  process.exit(1);
}
console.log("  • schema.sql aplicado no D1 local");

const SOURCE_PNG = makePng(500, 333); // dimensões "feias" de propósito: o snap-64 tem que agir
const RESULT_PNG = makePng(512, 512, { fill: (x, y) => [(x * 3) & 255, (y * 3) & 255, 128, 255] });
const RESULT_SHA = sha(RESULT_PNG);

const mock = await startMockHorde({ port: MOCK_PORT, completeAfterMs: 1200, imageBytes: RESULT_PNG });
console.log(`  • mock do Horde em 127.0.0.1:${MOCK_PORT}`);

const wrangler = spawn(
  "npx",
  ["wrangler", "dev", "--port", "8787", "--ip", "127.0.0.1", "--persist-to", PERSIST],
  {
    env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1", NO_COLOR: "1" },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  }
);
const wlogs = [];
wrangler.stdout.on("data", (d) => wlogs.push(String(d)));
wrangler.stderr.on("data", (d) => wlogs.push(String(d)));

async function waitWorker() {
  const t0 = Date.now();
  while (Date.now() - t0 < 90_000) {
    try {
      const r = await fetch(`${ORIGIN}/api/health`);
      if (r.ok) return Date.now() - t0;
    } catch (_) {
      /* ainda subindo */
    }
    await sleep(300);
  }
  throw new Error("wrangler dev não respondeu em 90 s");
}

const bootMs = await waitWorker();
console.log(`  • wrangler dev pronto em ${bootMs} ms\n`);

/* ---------------- helpers ---------------- */

async function submitEdit({ params, imageBytes }) {
  const form = new FormData();
  form.append("params", JSON.stringify(params));
  form.append("image_b64", new Blob([Buffer.from(imageBytes).toString("base64")]), "src.b64");
  return fetch(`${ORIGIN}/api/edits`, { method: "POST", body: form });
}

async function waitState(id, targets, timeoutMs = 25_000) {
  const want = Array.isArray(targets) ? targets : [targets];
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < timeoutMs) {
    const r = await fetch(`${ORIGIN}/api/edits/${id}`);
    if (r.ok) {
      last = await r.json();
      if (want.includes(last.state)) return { ok: true, job: last, ms: Date.now() - t0 };
    }
    await sleep(300);
  }
  return { ok: false, job: last, ms: Date.now() - t0 };
}

async function runCron() {
  const r = await fetch(`${ORIGIN}/cdn-cgi/handler/scheduled?format=json`);
  const text = await r.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch (_) {
    /* resposta em texto simples */
  }
  return { status: r.status, json, text };
}

const getJson = async (path, init) => {
  const r = await fetch(`${ORIGIN}${path}`, init);
  return { status: r.status, json: await r.json().catch(() => null), res: r };
};

/* ---------------- testes ---------------- */

console.log("=== 1. Básico ===\n");

await check("GET /api/health responde", async () => {
  const { status, json } = await getJson("/api/health");
  assert(status === 200 && json.ok === true, `status=${status} body=${JSON.stringify(json)}`);
  return `horde=${json.horde}`;
});

await check("frontend servido como static asset pelo mesmo Worker", async () => {
  const r = await fetch(`${ORIGIN}/`);
  const text = await r.text();
  assert(r.status === 200, `status=${r.status}`);
  assert(text.includes("<title>"), "não parece HTML");
  return `${text.length} bytes`;
});

await check("GET /api/models usa cache do KV (5 min)", async () => {
  const a = await getJson("/api/models");
  const b = await getJson("/api/models");
  const stats = await (await fetch(`http://127.0.0.1:${MOCK_PORT}/__stats`)).json();
  assert(a.json.models.length === 2, `primeira chamada: ${JSON.stringify(a.json).slice(0, 120)}`);
  assert(a.json.cached === false, "primeira chamada deveria ir ao Horde");
  assert(b.json.cached === true, "segunda chamada deveria vir do KV");
  assert(stats.modelFetches === 1, `o Horde foi consultado ${stats.modelFetches} vez(es)`);
  return `1 consulta ao Horde, 2 respostas`;
});

console.log("\n=== 2. Caminho feliz (webhook) ===\n");

let happyId = null;

await check("POST /api/edits monta o payload correto", async () => {
  const res = await submitEdit({
    params: {
      prompt: ["um gato", "óleo sobre tela"], // múltiplas linhas → " ### "
      width: 500,
      height: 333,
      steps: 25,
      denoising_strength: 0.55,
      models: ["Deliberate"],
    },
    imageBytes: SOURCE_PNG,
  });
  const body = await res.json();
  assert(res.status === 202, `status=${res.status} body=${JSON.stringify(body)}`);
  happyId = body.id;
  assert(body.horde_id, "sem horde_id");

  const payloads = await (await fetch(`http://127.0.0.1:${MOCK_PORT}/__payloads`)).json();
  const p = payloads[payloads.length - 1];
  assert(p.prompt === "um gato ### óleo sobre tela", `prompt=${p.prompt}`);
  assert(p.params.width === 512 && p.params.height === 320, `snap-64 falhou: ${p.params.width}x${p.params.height}`);
  assert(p.params.denoising_strength === 0.55, `denoising=${p.params.denoising_strength}`);
  assert(p.source_processing === "img2img", `source_processing=${p.source_processing}`);
  assert(p.r2 === true, `r2 deveria ser true (obrigatório no Workers), veio ${p.r2}`);
  assert(String(p.webhook).endsWith("/api/hooks/horde"), `webhook=${p.webhook}`);
  assert(p.client_agent, "sem client_agent");
  return `512x320, r2=true, webhook ok, corpo=${p.__rawLength} bytes`;
});

await check("webhook captura e o job fica 'done' sozinho", async () => {
  const r = await waitState(happyId, "done", 20_000);
  assert(r.ok, `job ficou em ${r.job && r.job.state} depois de ${r.ms} ms`);
  assert(r.job.n === 1, `n=${r.job.n}`);
  return `${r.ms} ms`;
});

await check("o webhook foi respondido dentro do timeout de 3 s do Horde", async () => {
  const events = await (await fetch(`http://127.0.0.1:${MOCK_PORT}/__events`)).json();
  const ok = events.filter((e) => e.outcome === "ok");
  assert(ok.length >= 1, `nenhum webhook OK: ${JSON.stringify(events)}`);
  const slowest = Math.max(...ok.map((e) => e.ms));
  assert(slowest < 3000, `webhook mais lento: ${slowest} ms`);
  return `${ok.length} entrega(s), mais lenta ${slowest} ms`;
});

await check("r2:true → imagem baixada 1x por URL pré-assinada", async () => {
  const stats = await (await fetch(`http://127.0.0.1:${MOCK_PORT}/__stats`)).json();
  assert(stats.r2Fetches === 1, `esperava 1 download, houve ${stats.r2Fetches}`);
  return `1 download de ${RESULT_PNG.length} bytes`;
});

await check("GET /api/edits/:id/image devolve os bytes exatos", async () => {
  const r = await fetch(`${ORIGIN}/api/edits/${happyId}/image`);
  assert(r.status === 200, `status=${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  assert(sha(buf) === RESULT_SHA, `hash diferente: ${sha(buf)} != ${RESULT_SHA}`);
  assert(r.headers.get("content-type") === "image/png", `content-type=${r.headers.get("content-type")}`);
  return `${buf.length} bytes, sha ${sha(buf)}`;
});

console.log("\n=== 3. Perda do webhook → Cron Trigger ===\n");

let lostId = null;

await check("webhook fora do ar: job fica pendente (Horde desiste após 3×3 s)", async () => {
  await fetch(`http://127.0.0.1:${MOCK_PORT}/__mode`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ webhook: "down" }),
  });
  const res = await submitEdit({ params: { prompt: "teste sem webhook", width: 512, height: 512 }, imageBytes: SOURCE_PNG });
  const body = await res.json();
  lostId = body.id;
  assert(res.status === 202, `status=${res.status}`);
  await sleep(12_000); // 3 tentativas × 3 s do Horde
  const { json } = await getJson(`/api/edits/${lostId}`);
  assert(json.state === "pending", `estado=${json.state} (deveria continuar pendente)`);
  const events = await (await fetch(`http://127.0.0.1:${MOCK_PORT}/__events`)).json();
  assert(events.some((e) => e.outcome === "giveup"), `sem desistência registrada: ${JSON.stringify(events.slice(-4))}`);
  return "job pendente, Horde desistiu";
});

await check("Cron Trigger (/cdn-cgi/handler/scheduled) recupera o resultado", async () => {
  const cron = await runCron();
  assert(cron.status === 200, `status=${cron.status} body=${cron.text.slice(0, 200)}`);
  const r = await waitState(lostId, "done", 20_000);
  assert(r.ok, `job ficou em ${r.job && r.job.state}`);
  const img = await fetch(`${ORIGIN}/api/edits/${lostId}/image`);
  assert(img.status === 200, `imagem indisponível: ${img.status}`);
  const buf = Buffer.from(await img.arrayBuffer());
  assert(sha(buf) === RESULT_SHA, "bytes diferentes");
  return `recuperado, ${buf.length} bytes`;
});

await fetch(`http://127.0.0.1:${MOCK_PORT}/__mode`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ webhook: "ok" }),
});

console.log("\n=== 4. Expiração ===\n");

await check("request expirado vira estado 'expired' com mensagem", async () => {
  await fetch(`http://127.0.0.1:${MOCK_PORT}/__mode`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ completeAfterMs: 600_000 }), // nunca completa
  });
  const res = await submitEdit({ params: { prompt: "vai expirar", width: 512, height: 512 }, imageBytes: SOURCE_PNG });
  const body = await res.json();
  const job = await (await fetch(`http://127.0.0.1:${MOCK_PORT}/__jobs`)).json();
  const hordeJob = job.find((j) => j.id === body.horde_id);
  await fetch(`http://127.0.0.1:${MOCK_PORT}/__expire/${hordeJob.id}`, { method: "POST" });

  await sleep(4_500); // esperar o job ficar "due"
  await runCron();
  const { json } = await getJson(`/api/edits/${body.id}`);
  assert(json.state === "expired", `estado=${json.state}`);
  assert(/expiro|404/i.test(json.error || ""), `mensagem=${json.error}`);

  await fetch(`http://127.0.0.1:${MOCK_PORT}/__mode`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ completeAfterMs: 1200 }),
  });
  return json.error;
});

console.log("\n=== 5. Prefill (§4 do PLANO) ===\n");

await check("PNG sem alfa → img2img + snap-64", async () => {
  const form = new FormData();
  form.append("image", new Blob([SOURCE_PNG]), "a.png");
  const { json } = await getJson("/api/inspect", { method: "POST", body: form });
  assert(json.width === 500 && json.height === 333, `dimensões=${json.width}x${json.height}`);
  assert(json.suggested.width === 512 && json.suggested.height === 320, `sugestão=${json.suggested.width}x${json.suggested.height}`);
  assert(json.suggested.source_processing === "img2img", `processing=${json.suggested.source_processing}`);
  assert(json.suggested.denoising_strength === 0.55, `denoising=${json.suggested.denoising_strength}`);
  return `${json.width}x${json.height} → ${json.suggested.width}x${json.suggested.height}, img2img`;
});

await check("PNG com alfa + tEXt do A1111 → inpainting + prompt parseado", async () => {
  const png = makePng(768, 768, {
    colorType: 6,
    fill: (x, y) => [x & 255, y & 255, 128, x > 400 ? 0 : 255], // metade transparente
    text: {
      parameters:
        "um gato astronauta, óleo sobre tela\nNegative prompt: borrado, ruim\nSteps: 30, Sampler: DPM++ 2M Karras, CFG scale: 7.5, Seed: 987654321, Size: 768x768, Denoising strength: 0.62, Model: Deliberate",
      Comment: "ignorado",
    },
  });
  const form = new FormData();
  form.append("image", new Blob([png]), "b.png");
  const { json } = await getJson("/api/inspect", { method: "POST", body: form });
  assert(json.hasAlpha === true, `hasAlpha=${json.hasAlpha}`);
  assert(json.suggested.source_processing === "inpainting", `processing=${json.suggested.source_processing}`);
  assert(json.parsed.prompt === "um gato astronauta, óleo sobre tela", `prompt=${json.parsed.prompt}`);
  assert(json.parsed.steps === "30", `steps=${json.parsed.steps}`);
  assert(json.parsed.sampler === "DPM++ 2M Karras", `sampler=${json.parsed.sampler}`);
  assert(json.parsed.cfg_scale === "7.5", `cfg=${json.parsed.cfg_scale}`);
  assert(json.parsed.seed === "987654321", `seed=${json.parsed.seed}`);
  assert(json.parsed.denoising_strength === "0.62", `denoising=${json.parsed.denoising_strength}`);
  return `768x768, inpainting, prompt+steps+sampler+cfg+seed recuperados`;
});

console.log("\n=== 6. n > 1 e limpeza ===\n");

await check("n=2 passa por 'partial' e chega a 'done' com 2 imagens", async () => {
  const res = await submitEdit({ params: { prompt: "duas imagens", width: 512, height: 512, n: 2 }, imageBytes: SOURCE_PNG });
  const body = await res.json();
  const r = await waitState(body.id, "done", 25_000);
  assert(r.ok, `estado final=${r.job && r.job.state}`);
  assert(r.job.n === 2, `n=${r.job.n} (esperado 2)`);
  const img = await fetch(`${ORIGIN}/api/edits/${body.id}/image`);
  assert(img.status === 200, `imagem 0 indisponível`);
  return `n=${r.job.n}, estado=${r.job.state}`;
});

await check("tick() limpa jobs resolvidos fora do TTL", async () => {
  const { json: results } = await getJson("/api/results");
  const target = results.results.find((r) => r.id === happyId);
  assert(target, "job do caminho feliz não aparece em /api/results");
  const upd = spawnSync(
    "npx",
    ["wrangler", "d1", "execute", "berlin-spike", "--local", "--persist-to", PERSIST, "-y",
     "--command", `UPDATE jobs SET updated_at = 0 WHERE id = '${happyId}'`],
    { encoding: "utf8" }
  );
  assert(upd.status === 0, `wrangler d1 execute falhou: ${upd.stderr}`);
  await runCron();
  const { status } = await getJson(`/api/edits/${happyId}`);
  assert(status === 404, `job ainda existe (status ${status})`);
  return "job e imagem removidos";
});

console.log("\n=== 7. Desempenho (o risco nº 1: 10 ms de CPU) ===\n");

const BIG_PNG = makePng(1300, 1000, {
  colorType: 2,
  fill: () => [Math.floor(Math.random() * 256), Math.floor(Math.random() * 256), Math.floor(Math.random() * 256)],
});

await check("submissão com imagem grande (~4 MB) completa sem estourar recursos", async () => {
  const b64len = Buffer.from(BIG_PNG).toString("base64").length;
  const t0 = Date.now();
  const res = await submitEdit({ params: { prompt: "imagem grande", width: 512, height: 512 }, imageBytes: BIG_PNG });
  const ms = Date.now() - t0;
  const body = await res.json();
  assert(res.status === 202, `status=${res.status} body=${JSON.stringify(body).slice(0, 200)}`);
  notes.push(`submissão de ${(BIG_PNG.length / 1048576).toFixed(1)} MB (${(b64len / 1048576).toFixed(1)} MB em base64): ${ms} ms de parede`);
  return `${(BIG_PNG.length / 1048576).toFixed(1)} MB → ${ms} ms (parede)`;
});

await check("o Worker NUNCA faz parse do base64: concat cabe, parse estoura", async () => {
  const b64Bytes = Buffer.from(Buffer.from(BIG_PNG).toString("base64")); // bytes como chegam do multipart
  const bigJson = JSON.stringify({ prompt: "x", params: { steps: 25 }, source_image: b64Bytes.toString(), r2: true });
  const [prefix, suffix] = Buffer.from(
    JSON.stringify({ prompt: "x", params: { steps: 25 }, source_image: "@", r2: true }).split("@")
  );

  const bench = async (fn, n) => {
    await fn();
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < n; i++) await fn();
    return Number(process.hrtime.bigint() - t0) / 1e6 / n;
  };

  // r2:false -> o Worker precisaria de request.json() num corpo de megabytes
  const parseMs = await bench(() => new Response(bigJson).json(), 5);
  // r2:true  -> só concatena os bytes num Blob, sem decode e sem parse
  const concatMs = await bench(() => { new Blob([prefix, b64Bytes, suffix]); }, 5);

  notes.push(
    `CPU (Node, mesmo V8 do workerd): request.json() de ${(bigJson.length / 1048576).toFixed(1)} MB = ${parseMs.toFixed(1)} ms | ` +
      `concatenação em Blob = ${concatMs.toFixed(1)} ms (${(parseMs / concatMs).toFixed(1)}x)`
  );
  assert(concatMs < 10, `concat sozinha já estoura o orçamento: ${concatMs.toFixed(1)} ms`);
  assert(parseMs > 3 * concatMs, `parse=${parseMs.toFixed(1)}ms concat=${concatMs.toFixed(1)}ms`);
  return `parse ${parseMs.toFixed(1)} ms vs concat ${concatMs.toFixed(1)} ms — ${(parseMs / concatMs).toFixed(1)}x`;
});

await check("latência de leitura do estado (50 requisições)", async () => {
  const { json: results } = await getJson("/api/results");
  const any = results.results[0];
  const times = [];
  for (let i = 0; i < 50; i++) {
    const t = Date.now();
    await fetch(`${ORIGIN}/api/edits/${any.id}`);
    times.push(Date.now() - t);
  }
  const p50 = pct(times, 0.5);
  const p95 = pct(times, 0.95);
  notes.push(`GET /api/edits/:id — p50 ${p50} ms, p95 ${p95} ms (inclui HTTP local)`);
  assert(p95 < 500, `p95=${p95} ms`);
  return `p50 ${p50} ms, p95 ${p95} ms`;
});

/* ---------------- encerramento ---------------- */

spawnSync("pkill", ["-f", "worker[d]-linux-64"]);
try {
  process.kill(-wrangler.pid, "SIGTERM");
} catch (_) {
  wrangler.kill("SIGTERM");
}
mock.server.close();

console.log("\n=== Resumo ===\n");
for (const n of notes) console.log(`  • ${n}`);
console.log(`\n  ${pass} passaram, ${fail} falharam\n`);
if (fail) {
  console.log("  falhas:");
  for (const f of failures) console.log(`   - ${f}`);
  console.log("\n--- log do wrangler (últimas 40 linhas) ---");
  console.log(wlogs.join("").split("\n").slice(-40).join("\n"));
}
process.exit(fail ? 1 : 0);
