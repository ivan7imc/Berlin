/* Suíte local do Berlin.

   Sobe o mock do Horde e o `wrangler dev` (workerd de verdade, com D1 e KV locais)
   e roda os testes contra eles. Não sai da máquina, não precisa de conta Cloudflare
   e não gasta kudos.

     npm test
*/

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { startMockHorde, makePng } from "./horde-mock.mjs";

const ORIGIN = "http://127.0.0.1:8787";
const MOCK = "http://127.0.0.1:8788";
const MOCK_PORT = 8788;
const PERSIST = ".wrangler-state";
const DB = "berlin";

const sha = (buf) => createHash("sha256").update(buf).digest("hex").slice(0, 16);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (arr, p) => arr.slice().sort((a, b) => a - b)[Math.min(arr.length - 1, Math.floor(arr.length * p))];

let pass = 0, fail = 0;
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
function assert(cond, msg) { if (!cond) throw new Error(msg); }

const getJson = async (path, init) => {
  const r = await fetch(`${ORIGIN}${path}`, init);
  const body = await r.text();
  let json = null;
  try { json = JSON.parse(body); } catch (_) { /* não é JSON */ }
  return { status: r.status, json, text: body, res: r };
};
const mockJson = async (path, init) => {
  const r = await fetch(`${MOCK}${path}`, init);
  return { status: r.status, json: await r.json() };
};

/* ---------------- setup ---------------- */

console.log("\n=== Berlin: preparando ===\n");

spawnSync("pkill", ["-f", "worker[d]-linux-64"]); // execução anterior pode ter deixado o workerd vivo
fs.rmSync(PERSIST, { recursive: true, force: true });

const mig = spawnSync("npx", ["wrangler", "d1", "execute", DB, "--local", "--file=schema.sql", "--persist-to", PERSIST, "-y"], { encoding: "utf8" });
if (mig.status !== 0) {
  console.error("falha ao aplicar schema.sql:\n", mig.stdout, mig.stderr);
  process.exit(1);
}
console.log("  • schema.sql aplicado no D1 local");

const SOURCE_PNG = makePng(500, 333); // dimensões "feias" de propósito: o snap-64 precisa agir
const RESULT_PNG = makePng(512, 512, { fill: (x, y) => [(x * 3) & 255, (y * 3) & 255, 128, 255] });
const RESULT_SHA = sha(RESULT_PNG);

const mock = await startMockHorde({ port: MOCK_PORT, completeAfterMs: 1200, imageBytes: RESULT_PNG });
console.log(`  • mock do Horde em ${MOCK}`);

const wrangler = spawn(
  "npx",
  ["wrangler", "dev", "--port", "8787", "--ip", "127.0.0.1", "--persist-to", PERSIST,
   "--var", `HORDE_BASE_URL:${MOCK}`, "--var", "HORDE_API_KEY:spike-key"],
  { env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1", NO_COLOR: "1" },
    stdio: ["ignore", "pipe", "pipe"], detached: true }
);
const wlogs = [];
wrangler.stdout.on("data", (d) => wlogs.push(String(d)));
wrangler.stderr.on("data", (d) => wlogs.push(String(d)));

async function waitWorker() {
  const t0 = Date.now();
  while (Date.now() - t0 < 90_000) {
    try { if ((await fetch(`${ORIGIN}/api/health`)).ok) return Date.now() - t0; } catch (_) { /* subindo */ }
    await sleep(300);
  }
  throw new Error("wrangler dev não respondeu em 90 s");
}
console.log(`  • wrangler dev pronto em ${await waitWorker()} ms\n`);

/* ---------------- helpers ---------------- */

async function submitEdit({ params, imageBytes = SOURCE_PNG, maskBytes = null }) {
  const form = new FormData();
  form.append("params", JSON.stringify(params));
  form.append("image_b64", new Blob([Buffer.from(imageBytes).toString("base64")]), "src.b64");
  if (maskBytes) form.append("mask_b64", new Blob([Buffer.from(maskBytes).toString("base64")]), "mask.b64");
  return getJson("/api/edits", { method: "POST", body: form });
}

async function waitState(id, targets, timeoutMs = 25_000) {
  const want = Array.isArray(targets) ? targets : [targets];
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < timeoutMs) {
    const { json } = await getJson(`/api/edits/${id}`);
    if (json) {
      last = json;
      if (want.includes(json.state)) return { ok: true, job: json, ms: Date.now() - t0 };
    }
    await sleep(300);
  }
  return { ok: false, job: last, ms: Date.now() - t0 };
}

const runCron = () => getJson("/cdn-cgi/handler/scheduled?format=json");
const setMode = (cfg) =>
  fetch(`${MOCK}/__mode`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(cfg) });

/* ---------------- 1. básico ---------------- */

console.log("=== 1. Básico ===\n");

await check("GET /api/health responde", async () => {
  const { status, json } = await getJson("/api/health");
  assert(status === 200 && json.ok === true, `status=${status}`);
  return `horde=${json.horde}`;
});

await check("frontend servido como static asset pelo mesmo Worker", async () => {
  const r = await fetch(`${ORIGIN}/`);
  const text = await r.text();
  assert(r.status === 200 && text.includes("<title>"), `status=${r.status}`);
  return `${text.length} bytes`;
});

await check("GET /api/limits expõe as listas (a UI não duplica enum)", async () => {
  const { json } = await getJson("/api/limits");
  assert(json.schedulers.includes("karras"), "sem schedulers");
  assert(json.source_processing.includes("inpainting"), "sem source_processing");
  assert(json.post_processing.includes("GFPGANv1.3"), "sem post_processing");
  return `${json.post_processing.length} pós-processamentos, ${json.schedulers.length} schedulers`;
});

await check("GET /api/models usa cache do KV (5 min)", async () => {
  const a = await getJson("/api/models");
  const b = await getJson("/api/models");
  const { json: stats } = await mockJson("/__stats");
  assert(a.json.models.length === 2, `modelos=${a.json.models.length}`);
  assert(a.json.cached === false && b.json.cached === true, `cache: ${a.json.cached} → ${b.json.cached}`);
  assert(stats.modelFetches === 1, `Horde consultado ${stats.modelFetches}x`);
  return "1 consulta ao Horde, 2 respostas";
});

/* ---------------- 2. caminho feliz ---------------- */

console.log("\n=== 2. Caminho feliz (webhook) ===\n");

let happyId = null;

await check("POST /api/edits monta o payload correto", async () => {
  const { status, json } = await submitEdit({
    params: {
      prompt: "um gato", negative_prompt: "borrado",
      params: { width: 500, height: 333, steps: 25, denoising_strength: 0.55, sampler_name: "k_euler" },
      models: ["Deliberate"],
    },
  });
  assert(status === 202, `status=${status} ${JSON.stringify(json).slice(0, 200)}`);
  happyId = json.id;

  const { json: payloads } = await mockJson("/__payloads");
  const p = payloads[payloads.length - 1];
  assert(p.prompt === "um gato ### borrado", `prompt=${p.prompt}`);
  assert(p.params.width === 512 && p.params.height === 320, `snap-64: ${p.params.width}x${p.params.height}`);
  assert(p.params.denoising_strength === 0.55, `denoising=${p.params.denoising_strength}`);
  assert(p.r2 === true, `r2=${p.r2} (obrigatório ser true)`);
  assert(String(p.webhook).endsWith("/api/hooks/horde"), `webhook=${p.webhook}`);
  assert(p.client_agent, "sem client_agent");
  assert(p.slow_workers === true && p.replacement_filter === true, "defaults do Horde errados");
  return `512x320, r2=true, corpo=${p.__rawLength} bytes`;
});

await check("webhook captura e o job fica 'done' sozinho", async () => {
  const r = await waitState(happyId, "done", 20_000);
  assert(r.ok, `estado=${r.job && r.job.state} após ${r.ms} ms`);
  return `${r.ms} ms`;
});

await check("o webhook é respondido dentro do timeout de 3 s do Horde", async () => {
  const { json: events } = await mockJson("/__events");
  const ok = events.filter((e) => e.outcome === "ok");
  assert(ok.length >= 1, `nenhum webhook OK: ${JSON.stringify(events.slice(0, 3))}`);
  const slowest = Math.max(...ok.map((e) => e.ms));
  assert(slowest < 3000, `webhook mais lento: ${slowest} ms`);
  return `${ok.length} entrega(s), mais lenta ${slowest} ms`;
});

await check("r2:true → a imagem é baixada 1x pela URL pré-assinada", async () => {
  const { json } = await mockJson("/__stats");
  assert(json.r2Fetches === 1, `esperava 1 download, houve ${json.r2Fetches}`);
  return `1 download de ${RESULT_PNG.length} bytes`;
});

await check("GET /api/edits/:id/image devolve os bytes exatos", async () => {
  const r = await fetch(`${ORIGIN}/api/edits/${happyId}/image`);
  assert(r.status === 200, `status=${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  assert(sha(buf) === RESULT_SHA, `hash diferente`);
  assert(r.headers.get("content-type") === "image/png", `content-type=${r.headers.get("content-type")}`);
  return `${buf.length} bytes, sha ${sha(buf)}`;
});

await check("o job guarda os metadados da geração (seed, worker, modelo)", async () => {
  const { json } = await getJson(`/api/edits/${happyId}`);
  const g = json.generations[0];
  assert(g, "sem gerações registradas");
  assert(g.seed === "1234567890", `seed=${g.seed}`);
  assert(g.worker_name === "MockWorker#1", `worker=${g.worker_name}`);
  assert(g.model === "Deliberate", `modelo=${g.model}`);
  assert(json.image_urls.length === 1, `image_urls=${JSON.stringify(json.image_urls)}`);
  return `seed ${g.seed}, ${g.worker_name}, ${g.model}`;
});

/* ---------------- 3. fila e expiração ---------------- */

console.log("\n=== 3. Fila, perda do webhook e expiração ===\n");

let slowId = null;

await check("job pendente expõe posição na fila", async () => {
  await setMode({ completeAfterMs: 600_000 }); // nunca completa
  const { json } = await submitEdit({ params: { prompt: "vai ficar na fila" } });
  slowId = json.id;
  const { json: job } = await getJson(`/api/edits/${slowId}`);
  assert(job.state === "pending", `estado=${job.state}`);
  assert(job.queue && job.queue.queue_position === 2, `fila=${JSON.stringify(job.queue)}`);
  return `posição ${job.queue.queue_position}, espera ${job.queue.wait_time}s`;
});

await check("request expirado vira estado 'expired' com mensagem", async () => {
  const { json: job } = await getJson(`/api/edits/${slowId}`);
  await fetch(`${MOCK}/__expire/${job.horde_id}`, { method: "POST" });
  await sleep(4_500);          // esperar o job ficar "due"
  await runCron();
  const { json } = await getJson(`/api/edits/${slowId}`);
  assert(json.state === "expired", `estado=${json.state}`);
  assert(/expiro|404/i.test(json.error || ""), `mensagem=${json.error}`);
  await setMode({ completeAfterMs: 1200 });
  return json.error;
});

let lostId = null;

await check("webhook fora do ar: job fica pendente (Horde desiste após 3×3 s)", async () => {
  await setMode({ webhook: "down" });
  const { status, json } = await submitEdit({ params: { prompt: "sem webhook" } });
  lostId = json.id;
  assert(status === 202, `status=${status}`);
  await sleep(12_000);
  const { json: job } = await getJson(`/api/edits/${lostId}`);
  assert(job.state === "pending", `estado=${job.state}`);
  const { json: events } = await mockJson("/__events");
  assert(events.some((e) => e.outcome === "giveup"), "Horde não desistiu");
  return "job pendente, nada perdido";
});

await check("Cron Trigger recupera o resultado", async () => {
  await setMode({ webhook: "ok" });
  const cron = await runCron();
  assert(cron.status === 200, `status=${cron.status} ${cron.text.slice(0, 120)}`);
  const r = await waitState(lostId, "done", 20_000);
  assert(r.ok, `estado=${r.job && r.job.state}`);
  const img = await fetch(`${ORIGIN}/api/edits/${lostId}/image`);
  assert(img.status === 200 && sha(Buffer.from(await img.arrayBuffer())) === RESULT_SHA, "bytes diferentes");
  return "recuperado pelo cron";
});

/* ---------------- 4. prefill e máscara ---------------- */

console.log("\n=== 4. Pré-preenchimento e máscara ===\n");

await check("PNG sem alfa → img2img + snap-64", async () => {
  const form = new FormData();
  form.append("image", new Blob([SOURCE_PNG]), "a.png");
  const { json } = await getJson("/api/inspect", { method: "POST", body: form });
  assert(json.width === 500 && json.height === 333, `${json.width}x${json.height}`);
  assert(json.suggested.width === 512 && json.suggested.height === 320, `${json.suggested.width}x${json.suggested.height}`);
  assert(json.suggested.source_processing === "img2img", json.suggested.source_processing);
  assert(json.suggested.denoising_strength === 0.55, `${json.suggested.denoising_strength}`);
  return `500x333 → 512x320`;
});

await check("PNG com alfa + tEXt do A1111 → inpainting + parâmetros recuperados", async () => {
  const png = makePng(768, 768, {
    colorType: 6,
    fill: (x, y) => [x & 255, y & 255, 128, x > 400 ? 0 : 255],
    text: {
      parameters: "um gato astronauta, óleo sobre tela\nNegative prompt: borrado, ruim\nSteps: 30, Sampler: DPM++ 2M Karras, CFG scale: 7.5, Seed: 987654321, Size: 768x768, Denoising strength: 0.62",
    },
  });
  const form = new FormData();
  form.append("image", new Blob([png]), "b.png");
  const { json } = await getJson("/api/inspect", { method: "POST", body: form });
  const s = json.suggested;
  assert(json.hasAlpha === true, `hasAlpha=${json.hasAlpha}`);
  assert(s.source_processing === "inpainting", s.source_processing);
  assert(s.prompt === "um gato astronauta, óleo sobre tela", `prompt=${s.prompt}`);
  assert(s.steps === 30 && s.cfg_scale === 7.5 && s.seed === "987654321", JSON.stringify(s));
  assert(s.denoising_strength === 0.62, `${s.denoising_strength}`);
  return "768x768, inpainting, prompt + steps + CFG + seed";
});

await check("máscara entra no payload como source_mask", async () => {
  const mask = makePng(512, 512, { colorType: 2, fill: (x) => [x > 256 ? 255 : 0, 0, 0] });
  const { status, json } = await submitEdit({
    params: { prompt: "com máscara", source_processing: "inpainting", params: { width: 512, height: 512 } },
    maskBytes: mask,
  });
  assert(status === 202, `status=${status} ${JSON.stringify(json).slice(0, 160)}`);
  const { json: payloads } = await mockJson("/__payloads");
  const p = payloads[payloads.length - 1];
  assert(p.source_processing === "inpainting", `processing=${p.source_processing}`);
  assert(p.source_mask && p.source_mask.startsWith("<") && p.source_mask.endsWith(" bytes b64>"), `máscara=${p.source_mask}`);
  await waitState(json.id, "done", 15_000);
  return `máscara enviada (${p.source_mask})`;
});

/* ---------------- 5. n>1, dry_run, cancelar, validação ---------------- */

console.log("\n=== 5. n>1, estimativa, cancelamento e validação ===\n");

await check("n=2 passa por 'partial' e serve as duas imagens", async () => {
  const { json } = await submitEdit({ params: { prompt: "duas", params: { n: 2, width: 512, height: 512 } } });
  const r = await waitState(json.id, "done", 25_000);
  assert(r.ok, `estado=${r.job && r.job.state}`);
  assert(r.job.n === 2, `n=${r.job.n}`);
  const second = await fetch(`${ORIGIN}/api/edits/${json.id}/image?index=1`);
  assert(second.status === 200, `index=1 → ${second.status}`);
  return `n=2, index=0 e index=1 servidos`;
});

await check("dry_run estima kudos sem criar job", async () => {
  const before = (await getJson("/api/results")).json.results.length;
  const { status, json } = await submitEdit({ params: { prompt: "só estimar", dry_run: true } });
  assert(status === 200, `status=${status} ${JSON.stringify(json).slice(0, 160)}`);
  assert(json.dry_run === true && json.kudos === 12.3, `kudos=${json.kudos}`);
  const after = (await getJson("/api/results")).json.results.length;
  assert(after === before, `jobs: ${before} → ${after} (dry_run não deveria criar)`);
  return `${json.kudos} kudos, 0 job criado`;
});

await check("DELETE /api/edits/:id cancela no Horde", async () => {
  const { json: created } = await submitEdit({ params: { prompt: "vou cancelar" } });
  const { json } = await getJson(`/api/edits/${created.id}`, { method: "DELETE" });
  assert(json.state === "error", `estado=${json.state}`);
  const { json: after } = await getJson(`/api/edits/${created.id}`);
  assert(after.state === "error" && /cancelad/i.test(after.error || ""), `erro=${after.error}`);
  return "cancelado";
});

await check("validação devolve 400 com mensagem legível", async () => {
  const bad = [
    [{ nsfw: true, censor_nsfw: true }, /incompatíve/i],
    [{ params: { denoising_strength: 5 } }, /denoising_strength/],
    [{ params: { steps: 9999 } }, /steps/],
    [{ params: { post_processing: [" inexistente "] } }, /post_processing/],
  ];
  for (const [params, re] of bad) {
    const { status, json } = await submitEdit({ params });
    assert(status === 400, `esperava 400 para ${JSON.stringify(params)}, veio ${status}`);
    assert(re.test(json.error || ""), `mensagem fora do esperado: ${json.error}`);
  }
  return "4 rejeições corretas";
});

/* ---------------- 6. limpeza ---------------- */

await check("tick() limpa jobs resolvidos fora do TTL", async () => {
  const upd = spawnSync("npx", ["wrangler", "d1", "execute", DB, "--local", "--persist-to", PERSIST, "-y",
    "--command", `UPDATE jobs SET updated_at = 0 WHERE id = '${happyId}'`], { encoding: "utf8" });
  assert(upd.status === 0, `wrangler d1 execute falhou: ${upd.stderr}`);
  await runCron();
  const { status } = await getJson(`/api/edits/${happyId}`);
  assert(status === 404, `job ainda existe (${status})`);
  return "job e imagem removidos";
});

await check("Horde recusando a submissão → 502 e job marcado como erro", async () => {
  await setMode({ submitStatus: 500 });
  const { status, json } = await submitEdit({ params: { prompt: "vai falhar" } });
  assert(status === 502, `status=${status} ${JSON.stringify(json).slice(0, 120)}`);
  const { json: job } = await getJson(`/api/edits/${json.id}`);
  assert(job.state === "error", `estado=${job.state}`);
  assert(/HTTP 500/.test(job.error || ""), `erro=${job.error}`);
  await setMode({ submitStatus: 0 });
  return "502 na hora, job em estado de erro";
});

await check("/status/models fora → 502 com cache frio, e recupera depois", async () => {
  const del = spawnSync("npx", ["wrangler", "kv", "key", "delete", "--binding=CACHE", "models:v1",
    "--local", "--persist-to", PERSIST], { encoding: "utf8" });
  assert(del.status === 0, `wrangler kv key delete falhou: ${del.stderr}`);
  await setMode({ models: "down" });
  const cold = await getJson("/api/models");
  assert(cold.status === 502, `cache frio: status=${cold.status}`);

  await setMode({ models: "ok" });
  const warm = await getJson("/api/models");
  assert(warm.status === 200 && warm.json.models.length === 2, `recuperou? status=${warm.status}`);
  return "502 quando o Horde cai, 200 quando volta";
});

/* ---------------- 7. desempenho ---------------- */

console.log("\n=== 7. Desempenho (o risco nº 1: 10 ms de CPU) ===\n");

const BIG_PNG = makePng(1300, 1000, {
  colorType: 2,
  fill: () => [Math.random() * 256 | 0, Math.random() * 256 | 0, Math.random() * 256 | 0],
});

await check("submissão com imagem grande (~4 MB) completa sem estourar recursos", async () => {
  const t0 = Date.now();
  const { status, json } = await submitEdit({ params: { prompt: "imagem grande" }, imageBytes: BIG_PNG });
  const ms = Date.now() - t0;
  assert(status === 202, `status=${status} ${JSON.stringify(json).slice(0, 160)}`);
  notes.push(`submissão de ${(BIG_PNG.length / 1048576).toFixed(1)} MB: ${ms} ms de parede`);
  return `${(BIG_PNG.length / 1048576).toFixed(1)} MB → ${ms} ms`;
});

await check("o Worker NUNCA faz parse do base64: concat cabe, parse estoura", async () => {
  const b64Bytes = Buffer.from(Buffer.from(BIG_PNG).toString("base64"));
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
  const parseMs = await bench(() => new Response(bigJson).json(), 5);
  const concatMs = await bench(() => { new Blob([prefix, b64Bytes, suffix]); }, 5);
  notes.push(`CPU (Node, mesmo V8 do workerd): request.json() de ${(bigJson.length / 1048576).toFixed(1)} MB = ${parseMs.toFixed(1)} ms | concatenação em Blob = ${concatMs.toFixed(1)} ms`);
  assert(concatMs < 10, `concat sozinha estoura o orçamento: ${concatMs.toFixed(1)} ms`);
  assert(parseMs > 3 * concatMs, `parse=${parseMs.toFixed(1)} concat=${concatMs.toFixed(1)}`);
  return `parse ${parseMs.toFixed(1)} ms vs concat ${concatMs.toFixed(1)} ms`;
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
  const p50 = pct(times, 0.5), p95 = pct(times, 0.95);
  notes.push(`GET /api/edits/:id — p50 ${p50} ms, p95 ${p95} ms`);
  assert(p95 < 500, `p95=${p95} ms`);
  return `p50 ${p50} ms, p95 ${p95} ms`;
});

/* ---------------- encerramento ---------------- */

spawnSync("pkill", ["-f", "worker[d]-linux-64"]);
try { process.kill(-wrangler.pid, "SIGTERM"); } catch (_) { wrangler.kill("SIGTERM"); }
mock.server.close();

console.log("\n=== Resumo ===\n");
for (const n of notes) console.log(`  • ${n}`);
console.log(`\n  ${pass} passaram, ${fail} falharam\n`);
if (fail) {
  console.log("  falhas:");
  for (const f of failures) console.log(`   - ${f}`);
  console.log("\n--- log do wrangler (últimas 30 linhas) ---");
  console.log(wlogs.join("").split("\n").slice(-30).join("\n"));
}
process.exit(fail ? 1 : 0);
