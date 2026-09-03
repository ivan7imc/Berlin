#!/usr/bin/env node
/* Berlin — instalação no Cloudflare (o "blueprint").
 *
 * O Render tem o render.yaml + botão "Deploy to Render". O Cloudflare não tem um
 * arquivo equivalente que provisiona Worker + D1 + KV + Cron de uma vez, então o
 * blueprint aqui é este script: ele executa, em um comando, tudo o que o §9 do
 * PLANO.md descrevia manualmente:
 *
 *   autenticação → D1 (jobs) → KV (IMAGES + CACHE) → schema → segredo → deploy → verificação
 *
 * É idempotente: reler e re-executar não cria recursos duplicados nem sobrescreve
 * ids já configurados em wrangler.jsonc.
 *
 * Uso:
 *   npm run setup                                      # interativo (login no navegador)
 *   CLOUDFLARE_API_TOKEN=… npm run setup               # sem interação (CI/cabeça)
 *   HORDE_API_KEY=… npm run setup                      # chave do Horde via ambiente
 *   node scripts/setup.mjs --help                      # esta ajuda
 *
 * Pré-requisitos: Node ≥ 18 e uma conta Cloudflare (gratuita, sem cartão).
 */

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG = join(ROOT, "wrangler.jsonc");
const SCHEMA = join(ROOT, "schema.sql");
const WRANGLER = join(ROOT, "node_modules", "wrangler", "bin", "wrangler.js");

/* Os placeholders em wrangler.jsonc marcam "ainda não configurado". */
const PLACEHOLDERS = {
  D1: "00000000-0000-0000-0000-000000000000",
  IMAGES: "00000000000000000000000000000001",
  CACHE: "00000000000000000000000000000002",
};

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};
const step = (n, label) => console.log(`\n${c.bold(c.cyan(`[${n}/7]`))} ${c.bold(label)}`);
const ok = (s) => console.log(`  ${c.green("✓")} ${s}`);
const warn = (s) => console.log(`  ${c.yellow("!")} ${s}`);
const info = (s) => console.log(`  ${c.dim(s)}`);

function fail(msg) {
  console.error(`\n${c.red("✗")} ${msg}`);
  process.exit(1);
}

/* ---------------- execução do wrangler ---------------- */

function run(args, { capture = false, input: stdin = undefined } = {}) {
  const res = spawnSync(process.execPath, [WRANGLER, ...args], {
    cwd: ROOT,
    stdio: capture ? ["ignore", "pipe", "pipe"] : stdin === undefined ? "inherit" : ["pipe", "inherit", "inherit"],
    input: stdin,
  });
  const out = (res.stdout || "").toString() + (res.stderr || "").toString();
  if (capture) return { ok: res.status === 0, out, status: res.status };
  return { ok: res.status === 0, status: res.status };
}

const tail = (s, n = 600) => s.replace(/\x1b\[[0-9;]*m/g, "").trim().slice(-n);

/* ---------------- utilitários puros ---------------- */

/* Extrai o primeiro grupo de uma regex; tolera TOML ("id = \"...\"") e JSON. */
function extract(output, re) {
  const m = output.match(re);
  return m ? m[1] : null;
}

/* Lê wrangler.jsonc e devolve o id atual de um recurso (ou null se placeholder). */
function currentId(key) {
  const text = readFileSync(CONFIG, "utf8");
  if (key === "D1") {
    const id = extract(text, /"database_id"\s*:\s*"([^"]*)"/) ?? extract(text, /database_id\s*=\s*"([^"]*)"/);
    return id && id !== PLACEHOLDERS.D1 ? id : null;
  }
  // KV: { "binding": "IMAGES", "id": "..." }
  const block = new RegExp(`"binding"\\s*:\\s*"${key}"\\s*,\\s*"id"\\s*:\\s*"([^"]*)"`);
  const toml = new RegExp(`binding\\s*=\\s*"${key}"[\\s\\S]{0,80}?id\\s*=\\s*"([^"]*)"`);
  const id = extract(text, block) ?? extract(text, toml);
  return id && id !== PLACEHOLDERS[key] ? id : null;
}

/* Troca o placeholder pelo id real, preservando comentários e formatação. */
function patchConfig(key, id) {
  const text = readFileSync(CONFIG, "utf8");
  if (!text.includes(PLACEHOLDERS[key])) {
    fail(`placeholder de ${key} não encontrado em wrangler.jsonc — edite manualmente.`);
  }
  writeFileSync(CONFIG, text.split(PLACEHOLDERS[key]).join(id));
  ok(`wrangler.jsonc atualizado (${key} → ${id})`);
}

async function ask(question, yesDefault = false) {
  if (!input.isTTY) return yesDefault ? "s" : "n";
  const rl = createInterface({ input, output });
  const suffix = yesDefault ? " [S/n] " : " [s/N] ";
  const answer = (await rl.question(question + suffix)).trim().toLowerCase();
  rl.close();
  return answer === "" ? (yesDefault ? "s" : "n") : answer;
}

/* ---------------- etapas ---------------- */

function checkPrereqs() {
  const ver = process.versions.node.split(".").map(Number);
  if (ver[0] < 18) fail(`Node ≥ 18 é necessário (você está no ${process.versions.node}).`);
  if (!existsSync(join(ROOT, "package.json"))) fail("package.json não encontrado — rode dentro do repositório.");
  if (!existsSync(WRANGLER)) {
    warn("wrangler não está instalado. Rodando npm install…");
    const res = spawnSync("npm", ["install"], { cwd: ROOT, stdio: "inherit", shell: process.platform === "win32" });
    if (res.status !== 0 || !existsSync(WRANGLER)) fail("npm install falhou.");
  }
  ok(`Node ${process.versions.node} · wrangler via ${WRANGLER.replace(ROOT, ".")}`);
}

async function auth() {
  if (process.env.CLOUDFLARE_API_TOKEN) {
    ok("CLOUDFLARE_API_TOKEN detectado — sem login interativo.");
    return;
  }
  if (run(["whoami"], { capture: true }).ok) {
    ok("já autenticado na Cloudflare.");
    return;
  }
  warn("não autenticado — o navegador vai abrir para o login OAuth da Cloudflare.");
  warn("em ambiente sem navegador, defina CLOUDFLARE_API_TOKEN e rode de novo.");
  const r = run(["login"]);
  if (!r.ok || !run(["whoami"], { capture: true }).ok) fail("login não concluído.");
  ok("autenticado.");
}

function ensureD1() {
  const existing = currentId("D1");
  if (existing) {
    ok(`D1 já configurado: ${existing}`);
    return;
  }
  info("criando banco D1 'berlin'…");
  const r = run(["d1", "create", "berlin"], { capture: true });
  if (!r.ok) fail(`d1 create falhou:\n${tail(r.out)}`);
  const id =
    extract(r.out, /database_id\s*=\s*"([0-9a-fA-F-]{8,})"/) ??
    extract(r.out, /"database_id"\s*:\s*"([0-9a-fA-F-]{8,})"/);
  if (!id) fail(`não consegui ler o database_id da saída:\n${tail(r.out)}`);
  patchConfig("D1", id);
}

function ensureKV(binding) {
  const existing = currentId(binding);
  if (existing) {
    ok(`KV ${binding} já configurado: ${existing}`);
    return;
  }
  info(`criando namespace KV '${binding}'…`);
  const r = run(["kv", "namespace", "create", binding], { capture: true });
  if (!r.ok) fail(`kv namespace create ${binding} falhou:\n${tail(r.out)}`);
  const id =
    extract(r.out, /id\s*=\s*"([0-9a-fA-F]{8,})"/) ??
    extract(r.out, /"id"\s*:\s*"([0-9a-fA-F]{8,})"/);
  if (!id) fail(`não consegui ler o id do namespace ${binding}:\n${tail(r.out)}`);
  patchConfig(binding, id);
}

function applySchema() {
  info("aplicando schema.sql no D1 remoto…");
  const r = run(["d1", "execute", "berlin", "--remote", "--file", SCHEMA, "--yes"]);
  if (!r.ok) fail("d1 execute falhou.");
  ok("schema aplicado (tabela jobs + índice).");
}

async function ensureSecret() {
  if (process.env.HORDE_API_KEY) {
    info("HORDE_API_KEY vinda do ambiente — gravando como segredo…");
    const r = run(["secret", "put", "HORDE_API_KEY"], { input: process.env.HORDE_API_KEY });
    if (!r.ok) fail("secret put falhou.");
    ok("HORDE_API_KEY gravado como segredo (nunca vai para o repositório).");
    return;
  }
  const yes = (await ask("Configurar a chave do AI Horde agora? (Enter para continuar anônimo)", false)) === "s";
  if (!yes) {
    warn("seguindo sem chave (Horde anônimo). Para definir depois: npx wrangler secret put HORDE_API_KEY");
    return;
  }
  if (!input.isTTY) {
    warn("sem terminal interativo — defina a variável HORDE_API_KEY e rode de novo.");
    return;
  }
  const r = run(["secret", "put", "HORDE_API_KEY"]);
  if (!r.ok) fail("secret put falhou.");
  ok("HORDE_API_KEY gravado como segredo.");
}

function deploy() {
  info("fazendo deploy do Worker…");
  const r = run(["deploy"], { capture: true });
  if (!r.ok) fail(`deploy falhou:\n${tail(r.out)}`);
  const url = extract(r.out, /https:\/\/[a-z0-9-]+\.workers\.dev/) ?? null;
  ok(`deploy concluído${url ? ` → ${c.bold(url)}` : ""}`);
  // O próprio deploy registra o cron e imprime "schedule: * * * * *" na saída.
  const schedule = extract(r.out, /schedule:\s*(\S+)/);
  if (schedule) ok(`Cron Trigger registrado: ${c.bold(schedule)}`);
  else warn("não vi o cron na saída do deploy — confira em Workers → Berlin → Settings → Triggers.");
  return url;
}

function verify(url) {
  if (!url) return;
  info(`verificando GET ${url}/api/health …`);
  const r = spawnSync("curl", ["-sf", `${url}/api/health`], { timeout: 15000 });
  if (r.status === 0) ok("API respondeu no ar.");
  else warn("não consegui checar (sem curl ou ainda propagando) — tente abrir a URL no navegador.");
}

function summary(url) {
  console.log(`\n${c.bold("━━━ Berlin instalado no Cloudflare ━━━")}`);
  console.log(`  URL:            ${c.bold(url ?? "consulte 'npx wrangler deploy'")}`);
  console.log(`  Cron (vigia):   a cada minuto (definido em wrangler.jsonc, aplicado no deploy)`);
  console.log(`  Conferir cron:  Workers → Berlin → Settings → Triggers`);
  console.log(`  Acompanhar:     npx wrangler tail            # logs ao vivo`);
  console.log(`  Rodar local:    npm run dev`);
  console.log(`  Testes:         npm test`);
}

function help() {
  console.log(`Berlin — instalação no Cloudflare (blueprint)

Faz em um comando: login → D1 → KV (IMAGES, CACHE) → schema → segredo → deploy → verificação.

Uso:
  npm run setup                       interativo (login no navegador)
  CLOUDFLARE_API_TOKEN=… npm run setup   sem interação (CI)
  HORDE_API_KEY=… npm run setup          chave do Horde via ambiente

É idempotente: reler e re-executar não cria recursos duplicados.
`);
}

/* ---------------- main ---------------- */

async function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    help();
    return;
  }

  console.log(c.bold("Berlin · instalação no Cloudflare Workers (plano gratuito, sem cartão)"));
  console.log(c.dim("blueprint: Worker + D1 + 2× KV + Cron Trigger + segredo"));

  checkPrereqs();

  step(1, "Autenticação na Cloudflare");
  await auth();

  step(2, "Banco D1 (jobs)");
  ensureD1();

  step(3, "Namespaces KV (IMAGES e CACHE)");
  ensureKV("IMAGES");
  ensureKV("CACHE");

  step(4, "Schema no D1");
  applySchema();

  step(5, "Segredo HORDE_API_KEY");
  await ensureSecret();

  step(6, "Deploy do Worker");
  const url = deploy();

  step(7, "Verificação");
  verify(url);

  summary(url);
}

main().catch((err) => fail(String((err && err.message) || err)));
