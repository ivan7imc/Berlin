# Como rodar o Berlin no Cloudflare Workers

Avaliação de arquitetura — comparação com o plano ativo ([PLANO.md](../PLANO.md), Flask/Render) e com a
alternativa arquivada ([alternativa-puter.md](alternativa-puter.md)).
**Status:** **spike local validado — 18/18** em 2026-09-03 (ver §11). O código está em
`spike-cloudflare/` e roda sem conta Cloudflare. Todos os limites abaixo foram lidos na documentação
oficial (links na seção 14), não estimados; os números de desempenho são medidos (§11.1).

---

## 1. Veredito

**Sim — e resolve os dois problemas centrais do plano por desenho, não por gambiarra.**

| Problema do PLANO.md | No Render Free | No Cloudflare Workers |
| --- | --- | --- |
| Espera longa perder o resultado | Instância dorme em 15 min; webhook do Horde tem `timeout=3` e pode cair em cold start | **Não existe spin-down.** O webhook é respondido em dezenas de ms, sempre |
| Vigia gratuito | Thread interna morre no spin-down + cron do Render é proibido (US$ 1/mês) | **Cron Triggers nativos e gratuitos** (5 por conta) — zero serviço externo |
| Orçamento de horas | 750 instance-hours/mês, apertado se pingar a cada minuto | Não existe esse conceito |
| Custo | US$ 0 | US$ 0 — **e sem cartão, desde que você não use R2** (seção 4) |

O preço é a linguagem: o backend deixa de ser Python/Flask e passa a ser **JavaScript** (~300 linhas).
O que **não** muda: contrato REST, payload do Horde, regras de prefill, UX, aceite.

---

## 2. A vida de um pedido

1. **Navegador** lê a imagem: extrai dimensões, tipo de cor (alfa) e metadados de geração
   (`tEXt` do PNG) → **preenche o formulário**. Custo zero de CPU no Worker.
2. **Navegador** codifica a imagem em base64 (`FileReader.readAsDataURL`) e faz
   `POST /api/edits` em `multipart/form-data`: um campo `params` (JSON pequeno) e um campo
   `image_b64` (bytes opacos).
3. **Worker** monta o corpo do Horde **sem parsear o base64** — concatena os bytes (seção 7) — e chama
   `POST https://aihorde.net/api/v2/generate/async` com `"webhook": "https://berlin.<sub>.workers.dev/api/hooks/horde"`
   e `"r2": true`.
4. **Worker** grava o job no **D1** (`state = pending`, `next_poll_at = now + 45 s`) e devolve `{ id }`.
5. **Navegador** faz polling de `GET /api/edits/:id` com backoff (4 s → 10 s), pausando quando
   `document.hidden`.
6. **Horde** chama o webhook quando termina. O payload vem **pequeno** (por causa do `r2: true`): o
   Worker busca a URL pré-assinada, faz stream direto para o armazenamento, marca `done` no D1 e
   responde `200` — bem abaixo dos 3 s que o Horde espera.
7. Se o webhook falhar, o **Cron Trigger** (`* * * * *`) chama `scheduled()` → a mesma função `tick()`
   consulta `/v2/status/{id}` dos jobs pendentes e recupera o resultado.
8. **Navegador** mostra o preview (`GET /api/edits/:id/image`) e o botão de download.

Resultado esperado: captura em **segundos** pelo webhook, com rede de segurança de 1 minuto — e nada
disso consome instância, hora ou agendador externo.

---

## 3. Arquitetura

### 3.1 Árvore de arquivos

```
berlin/
├── wrangler.jsonc          # substitui o render.yaml
├── package.json            # única dependência de dev: wrangler
├── schema.sql
├── src/
│   ├── index.js            # export default { fetch, scheduled }
│   ├── router.js           # rotas HTTP
│   ├── horde.js            # submit / check / status / capture
│   ├── store.js            # D1: jobs
│   ├── images.js           # putImage/getImage  ← isola KV vs R2
│   ├── payload.js          # monta o payload (§3 do PLANO)
│   ├── metadata.js         # parse de cabeçalho PNG/JPEG (fallback do prefill)
│   ├── inspect.js          # regras de prefill (§4 do PLANO)
│   └── tick.js             # mesma função do cron, exposta em POST /api/tick
└── public/                 # frontend estático, servido pelo próprio Worker
    ├── index.html
    ├── app.js
    └── styles.css
```

O frontend é servido pelo mesmo Worker via **Static Assets** — e requisições a static assets são
**gratuitas e ilimitadas**, ou seja, a interface não consome as 100 mil requisições/dia.

### 3.2 `wrangler.jsonc`

```jsonc
{
  "name": "berlin",
  "main": "src/index.js",
  "compatibility_date": "2026-09-01",
  "compatibility_flags": ["nodejs_compat"],
  "assets": { "directory": "./public" },
  "d1_databases": [
    { "binding": "DB", "database_name": "berlin", "database_id": "<id>" }
  ],
  "kv_namespaces": [
    { "binding": "IMAGES", "id": "<id>" },   // imagens (v1)
    { "binding": "CACHE",  "id": "<id>" }    // lista de modelos, 5 min
  ],
  "vars": {
    "CLIENT_AGENT": "berlin/0.1",
    "RESULT_TTL_HOURS": "24"
  },
  "triggers": { "crons": ["* * * * *"] },     // o vigia — gratuito
  "observability": { "enabled": true }
}
```

Segredo (nunca no arquivo): `npx wrangler secret put HORDE_API_KEY`.

### 3.3 Schema D1 (`schema.sql`)

```sql
CREATE TABLE IF NOT EXISTS jobs (
  id           TEXT PRIMARY KEY,
  horde_id     TEXT,
  state        TEXT NOT NULL,            -- pending | partial | done | expired | error
  expected_n   INTEGER NOT NULL DEFAULT 1,
  n            INTEGER NOT NULL DEFAULT 0,
  params       TEXT NOT NULL,            -- JSON enviado ao Horde
  payload_json TEXT,                     -- último payload visto (webhook ou /status)
  error        TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  next_poll_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jobs_poll ON jobs (state, next_poll_at);
```

O índice é o que mantém o `tick()` barato: uma query indexada devolve só os jobs maduros, sem varrer
a tabela (cada linha varrida conta como *row read*).

### 3.4 Rotas

| Método | Rota | Função |
| --- | --- | --- |
| `GET` | `/api/health` | ping |
| `GET` | `/api/models` | lista de modelos, cache 5 min no KV `CACHE` |
| `POST` | `/api/inspect` | prefill server-side (**fallback**; o normal é no navegador) |
| `POST` | `/api/edits` | cria job + submete ao Horde |
| `GET` | `/api/edits/:id` | estado do job (polling) |
| `GET` | `/api/edits/:id/image` | imagem gerada (stream) |
| `POST` | `/api/hooks/horde` | webhook — **tem que responder em < 3 s** |
| `POST` | `/api/tick` | a mesma `tick()` do cron, para pulso manual/debug |
| `GET` | `/api/results` | últimos resultados |

As rotas continuam as do PLANO.md §6 — só muda o prefixo (`/api` em vez de `/api/v1`, opcional) e o
fato de o frontend morar na mesma origem: **adeus CORS**.

---

## 4. Onde guardar as imagens — a decisão que depende de cartão

Esta é a parte mais importante para quem está sem grana. Os quatro candidatos, com os limites lidos na
documentação:

| Onde | Franquia gratuita | Pede forma de pagamento? | Veredito |
| --- | --- | --- | --- |
| **R2** | 10 GB-mês, 1 M Class A (escrita) + 10 M Class B (leitura) por mês, **egress grátis** | ⚠️ **Sim, aparentemente.** A doc diz: *"Complete the checkout flow to add an R2 subscription"* — na prática, forma de pagamento na conta, mesmo faturando US$ 0 | Melhor técnico (stream, sem teto de escrita), mas **fora** por ora |
| **KV** | 100 mil leituras/dia, **1.000 escritas/dia** (chaves diferentes), 1 GB por conta, valor até **25 MiB** | Não | ✅ **v1.** Cabe: um job = ~2 escritas; 1 GB ≈ 300–500 imagens; TTL 24 h |
| **D1 (BLOB)** | 500 MB por banco (Free), 5 GB por conta | Não | ❌ Inviável: statement máximo de **100 KB** e linha de 2 MB — uma imagem não cabe |
| **Durable Object (SQLite)** | 5 GB, 100 mil linhas escritas/dia, 5 M lidas/dia | Não | Reserva para v1.1 (blobs grandes cabem), mas acrescenta complexidade |

**Recomendação: KV no v1, R2 depois**, com o storage isolado em `src/images.js`:

```js
export const putImage = (env, key, bytes) =>
  env.IMAGES.put(key, bytes, { expirationTtl: 86400 });
export const getImage = (env, key) =>
  env.IMAGES.get(key, { type: 'arrayBuffer' });
```

Trocar para R2 são ~15 linhas (e passa a fazer stream, sem estourar memória). O resto do Worker nem
sabe que houve mudança. O `tick()` apaga o que passou do TTL, mantendo o KV enxuto.

---

## 5. O vigia: Cron Trigger (com alternativa em Durable Object)

```js
// src/index.js
export default {
  async fetch(request, env, ctx) { return router(request, env, ctx); },
  async scheduled(controller, env, ctx) {
    await tick(env, { limit: 10 });          // mesma função de POST /api/tick
  },
};
```

- `triggers.crons = ["* * * * *"]` usa **1 dos 5 Cron Triggers** da conta e roda em UTC.
- Teste local, sem deploy: `curl "http://localhost:8787/cdn-cgi/handler/scheduled"`.

**Orçamento:** 1.440 disparos/dia. O Horde limita `/status` a **10/min** e `/check` a 10/s — então o
`tick()` deve processar no máximo ~5–10 jobs por disparo, chamando `/check` para sondar e `/status`
só quando `done`. Sobra folga de duas ordens de grandeza.

**O detalhe que importa:** CPU por Cron Trigger no Free é de **10 ms** (o mesmo teto de uma requisição
HTTP). Como espera de rede **não** conta como CPU, uma rodada de "1 query indexada + 5 chamadas
`/check` + parse de JSONs pequenos" cabe folgada — desde que ninguém faça parse de base64 grandão
(seção 7).

**v1.1, se precisar de precisão:** um **Durable Object por job** com `state.storage.setAlarm(+45 s)`.
Cada job tem seu próprio timer, sem varredura global nem requisições desperdiçadas. Custa mais código;
só vale se o volume subir.

---

## 6. O que muda em relação ao PLANO.md

| Assunto | PLANO.md (Render + Flask) | Cloudflare Workers | Efeito |
| --- | --- | --- | --- |
| Linguagem/stack | Python 3.11 + Flask + gunicorn | JavaScript + `wrangler` | Fim de `requirements.txt`, Dockerfile, gunicorn |
| Estado dos jobs | `store.py` (JSON em disco **efêmero**) | **D1** (SQLite, durável, indexado) | Resultado não desaparece nunca |
| Vigia | `watcher.py` (thread, morre no spin-down) | **Cron Trigger** (`* * * * *`) | Some a seção inteira de contorno |
| Webhook | Risco real de cold start > 3 s | Sempre quente, responde em ms | Risco eliminado |
| Prefill (Pillow) | Decodifica a imagem no servidor | Navegador lê cabeçalho + `tEXt`; fallback em JS puro | Menos CPU e menos memória (128 MB não decodifica imagem grande) |
| `r2` no payload | `false` (padrão) — base64 no webhook | **`true`** (obrigatório) | Webhook minúsculo; custa um fetch extra (URL válida 30 min) |
| Imagens | Sistema de arquivos | **KV** (v1) → R2 (v1.1) | TTL explícito de 24 h |
| Deploy | `render.yaml` | `wrangler.jsonc` + `npx wrangler deploy` | `https://berlin.<sub>.workers.dev`, HTTPS de graça (pré-requisito do webhook) |
| Segredos | Env vars no painel | `wrangler secret put` | — |
| Frontend | Servido pelo Flask | Static assets do mesmo Worker | Uma origem só, requests de asset gratuitas |

**Desaparecem do plano:** §8 `watcher.py`; §9.2 `render.yaml`; §14.2 camada 3 (pulso externo);
§14.5 orçamento de instance-hours; §14.7 cardápio de agendadores externos (cron-job.org, GitHub
Actions, etc.). Tudo isso existia só para contornar o spin-down.

**Fica idêntico:** §3 payload e faixas dos parâmetros; §4 regras de prefill (snap-64, `inpainting`
quando há alfa, `denoising_strength 0.55`); §5 endpoints e limites do Horde; §6 contrato REST; §7 UX;
§11 critérios de aceite; §12 roadmap; §14.1 prazos (esses são do Horde).

---

## 7. Limites verificados e o orçamento de CPU

### 7.1 Limites (Workers Free)

| Recurso | Limite gratuito |
| --- | --- |
| Requisições | 100.000/dia (assets estáticos **não contam**) |
| CPU por requisição | **10 ms** |
| CPU por Cron Trigger | **10 ms** |
| Memória | 128 MB |
| Subrequests | 50 por requisição |
| Tamanho do Worker | 3 MB |
| Workers por conta | 100 |
| **Cron Triggers** | **5 por conta** (1 é suficiente) |
| Static assets | 20.000 arquivos, 25 MiB cada |
| Corpo de requisição | 100 MB (plano Cloudflare Free) |
| Workers KV | 100 mil leituras/dia · **1.000 escritas/dia** · 1 GB · valor até 25 MiB |
| D1 | 5 M linhas lidas/dia · 100 mil escritas/dia · 500 MB/banco · 10 bancos · 50 queries por invocação · linha/statement de 2 MB/100 KB |
| Durable Objects | 100 mil requisições/dia · 13.000 GB-s/dia · SQLite · 5 GB |
| Logs | 200 mil eventos/dia, retenção de 3 dias |
| Paid (se um dia precisar) | US$ 5/mês · 10 M req/mês · 30 s de CPU (até 5 min) |

### 7.2 Três regras para caber em 10 ms

1. **`r2: true` sempre.** Com `r2: false`, o Horde manda a imagem em base64 dentro do JSON do webhook
   (megabytes) e o Worker teria que fazer `JSON.parse` disso — inviável em 10 ms. Com `r2: true` o
   JSON vem com ~1 KB e a URL pré-assinada; buscar e fazer stream para o storage custa quase nada de
   CPU (espera de rede não conta).
2. **Nunca materialize o base64 de entrada como string JS.** O navegador manda a imagem já em base64
   como um campo `multipart` opaco; o Worker usa esses bytes direto como parte do corpo enviado ao
   Horde (`new Blob([prefixo, bytesBase64, sufixo])`), sem `JSON.parse`, sem `atob`, sem `btoa`.
3. **Sempre stream, nunca bufferzão em string.** Ao servir a imagem, devolva o corpo do storage
   direto; ao gravar, passe o stream adiante.

Estimativa (a medir com `wrangler dev` + CPU profiling):

| Rota | CPU estimado | Gargalo |
| --- | --- | --- |
| `POST /api/edits` | ~2–5 ms | parse do `multipart` de alguns MB |
| `POST /api/hooks/horde` (`r2: true`) | ~1–3 ms | — |
| `POST /api/hooks/horde` (`r2: false`) | **50–100 ms** ❌ | `JSON.parse` de megabytes |
| `GET /api/edits/:id` | < 1 ms | 1 query indexada |
| `scheduled()` / `tick()` | ~3–6 ms (10 jobs) | parse dos JSONs de `/check` |
| `GET /api/edits/:id/image` | < 1 ms (stream) | — |

A documentação avisa que há tolerância para estouros *eventuais*; o que derruba é estourar
sistematicamente. Se acontecer, o plano B é Workers Paid (US$ 5/mês, 30 s de CPU).

---

## 8. Esforço de portabilidade

- O `spike/src/worker.js` (feito para o Puter) já tem **~200 linhas reaproveitáveis sem alteração**:
  estados do job, captura do webhook, `tick`, e o tratamento de `expired`/`partial`. Ele foi escrito
  com `Request`/`Response`/`fetch` padrão — exatamente o que o Workers usa.
- O que muda: storage (`me.puter` KV/FS → D1 + KV/R2) e o handler do cron (`/api/tick` HTTP → handler
  `scheduled()` nativo).
- **Lock-in baixo:** R2 é compatível com S3, D1 é SQLite (`wrangler d1 export` devolve um dump), e o
  Worker usa APIs web padrão. Sair para Node/Flask custa reescrever ~200–300 linhas — ordens de
  grandeza melhor que o Puter, onde os dados ficavam presos na plataforma.
- **Existe Python Workers** (beta; pacotes puros, PyEmscripten e Pyodide), então o conhecimento do
  PLANO.md não se perde. Ainda assim a recomendação é JS: uma linguagem só, bundle minúsculo
  (limite de 3 MB) e o frontend já é JS.

---

## 9. Custo

| Item | Free | Paid |
| --- | --- | --- |
| Worker | US$ 0 (100 mil req/dia) | US$ 5/mês (10 M req/mês + 30 M CPU-ms) |
| Cron Triggers | US$ 0 (5 por conta) | incluído |
| D1 | US$ 0 | incluído (25 bilhões de linhas lidas/mês) |
| KV | US$ 0 (100 mil leituras + 1.000 escritas/dia) | incluso |
| R2 | US$ 0 até 10 GB-mês + 1 M Class A | — (**pede checkout/forma de pagamento**) |
| Static assets | US$ 0, requisições ilimitadas | US$ 0 |
| **Total para este projeto** | **US$ 0** | US$ 5/mês se o CPU de 10 ms apertar |

---

## 10. Riscos

1. **CPU de 10 ms no Free** — mitigado pelas três regras (§7.2); monitorar `exceededCpu` no painel;
   plano B = US$ 5/mês.
2. **KV: 1.000 escritas/dia** — para uso pessoal sobra muito (um job ≈ 2 escritas), mas se virar
   público, migrar imagens para R2.
3. **R2 pede forma de pagamento** — por isso o v1 usa KV. Se você adicionar um cartão depois, a troca
   são 15 linhas.
4. **Consistência eventual do KV** (propagação de até 60 s entre colos) — mitigar marcando `done` só
   depois do `put()` bem-sucedido e fazendo um retry no navegador se o `/image` der 404.
5. **D1 no Free**: 50 queries por invocação e 500 MB por banco — usar `batch()` e limpar resultados
   antigos no próprio cron.
6. **`r2: true` dá URL que expira em 30 min** — mitigação: capturar no webhook (segundos); se falhar,
   o `/status` do tick devolve URL nova.
7. **Lock-in moderado** na Cloudflare — mas com saída barata (§8).

---

## 11. Go / no-go

### 11.1 Validado localmente em 2026-09-03 — 18/18 ✅

O spike está em `spike-cloudflare/` e roda **sem conta Cloudflare, sem cartão e sem rede**: o
`wrangler dev` sobe o `workerd` de verdade, com D1 e KV locais, e um mock do Horde em Node que
reproduz o `_deliver_webhook` real (timeout de 3 s, 3 tentativas).

```bash
cd spike-cloudflare && npm install && node run-local.mjs   # ~30 s
```

| # | Teste | Resultado medido |
| --- | --- | --- |
| 1 | Happy path: submissão → webhook → `done` | **1.288 ms** do envio ao resultado |
| 2 | Webhook respondido dentro do timeout do Horde | **45 ms** (limite: 3.000 ms) |
| 3 | `r2: true` → um download por URL pré-assinada | 1 fetch de 282 KB |
| 4 | Bytes servidos de volta | idênticos (sha256) |
| 5 | Perda do webhook (Horde desiste após 3×3 s) | job fica `pending` — **nada se perde** |
| 6 | **Cron Trigger recupera o resultado** | `/cdn-cgi/handler/scheduled` → `done` ✅ |
| 7 | Expiração | estado `expired` + mensagem, não erro genérico |
| 8 | `n = 2` | `partial` → `done`, 2 imagens |
| 9 | Prefill sem Pillow (§4 do PLANO) | 500×333 → 512×320; alfa → `inpainting`; `tEXt` do A1111 devolve prompt, steps, sampler, CFG e seed |
| 10 | Limpeza por TTL | `tick()` apaga o job e a imagem |
| 11 | Submissão de 3,7 MB | **79 ms** de parede, sem estourar recursos |
| 12 | **CPU: parse × concatenação** | `request.json()` de 5 MB = **16,0 ms** ❌ (limite: 10 ms) vs `new Blob([...])` = **1,9 ms** ✅ |
| 13 | Leitura de estado (50 req) | p50 9 ms, p95 13 ms |

**O teste 12 é o que decide o desenho.** Com `r2: false`, uma única chamada de webhook consumiria
16 ms de CPU contra o limite de 10 ms do plano Free — o Worker devolveria `Error 1102` e o resultado
se perderia justamente no caminho mais importante. Com `r2: true`, o mesmo trabalho custa 1,9 ms.
Não é micro-otimização: é a diferença entre funcionar e não funcionar.

O spike também pegou dois bugs que iriam para produção: o base64 sendo injetado **sem as aspas** no
JSON (o placeholder fica entre elas) e a captura relendo o job dentro do laço, o que perdia gerações
quando `n > 1`.

### 11.2 O que só você pode validar (conta Cloudflare + rede)

| # | Teste | Bloqueio |
| --- | --- | --- |
| 1 | `wrangler deploy` e o domínio `*.workers.dev` | conta Cloudflare gratuita |
| 2 | Webhook público do Horde de verdade | rede + uma conta no Horde |
| 3 | Cron Trigger em produção (UTC, 1/min) |deploy feito |
| 4 | Consumo real de CPU por rota no painel | deploy + algumas horas de uso |

Nada disso custa dinheiro: `dry_run: true` não gasta kudos e o Workers Free não pede cartão
(contanto que você não crie bucket no R2 — seção 4).

## 12. Comparação final

| Critério | Render Free (plano ativo) | Puter (arquivado) | **Cloudflare Workers** |
| --- | --- | --- | --- |
| Custo mensal | US$ 0 | consome créditos da conta | **US$ 0** |
| Pede cartão/crédito | Não | **Sim — foi o motivo do arquivamento** | Não (evitando R2) |
| Spin-down | 15 min | Nunca | **Nunca** |
| Vigia agendado | Externo e gambiarra | Inexistente (sem cron) | **Cron Trigger nativo, grátis** |
| Armazenamento durável | Disco efêmero | KV/FS do Puter | **D1 + KV (5 GB)** |
| Limites publicados | Sim | Não | **Sim** |
| CPU por requisição | 30 s+ | Não publicado | **10 ms (Free)** |
| Linguagem | Python | JS | **JS** |
| Lock-in | Baixo | Alto | **Baixo–médio** |
| Esforço para sair do plano ativo | — | — | Médio (~300 linhas + schema + config) |

---

## 13. Recomendação

**Migrar.** O spike local passou 18/18, incluindo os dois pontos que decidiam a questão:

- o **Cron Trigger** recupera sozinho um resultado cujo webhook foi perdido (teste 6);
- o **orçamento de CPU fecha** com folga, desde que `r2: true` e o base64 nunca virem string JS no
  Worker (teste 12).

O Workers elimina spin-down, vigia externo e orçamento de instance-hours — os três pontos que mais
consumiram o PLANO.md — e o custo continua **US$ 0 sem cartão** (D1 + KV, sem R2). O que fica em
aberto (§11.2) não é risco de arquitetura: é só o deploy com a sua conta.

Passo seguinte sugerido: portar o `spike-cloudflare/` para o app de verdade (frontend completo,
todos os parâmetros na tela, histórico em `localStorage`) mantendo `src/payload.js`, `capture.js` e
`tick.js` como estão — eles já estão testados.

---

## 14. Referências

- [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) — 100 mil req/dia, 10 ms de CPU, 128 MB, 50 subrequests, 3 MB, 5 Cron Triggers
- [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) — Free inclui Workers, Pages Functions, Workers KV e Hyperdrive; assets estáticos gratuitos e ilimitados
- [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/) — handler `scheduled()`, 5 campos, UTC, teste local em `/cdn-cgi/handler/scheduled`
- [KV limits](https://developers.cloudflare.com/kv/platform/limits/) — 100 mil leituras, 1.000 escritas/dia, 1 GB, 25 MiB por valor
- [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/) e [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) — 5 M linhas lidas/dia, 100 mil escritas/dia, 500 MB/banco, statement de 100 KB, linha de 2 MB
- [R2 pricing](https://developers.cloudflare.com/r2/pricing/) e [R2 get-started](https://developers.cloudflare.com/r2/get-started/) — 10 GB-mês, 1 M Class A, egress grátis; *"Complete the checkout flow to add an R2 subscription"*
- [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) — 100 mil req/dia, 13.000 GB-s/dia, SQLite no Free
- [Python packages in Workers](https://developers.cloudflare.com/workers/languages/python/packages/) — pacotes puros, PyEmscripten e Pyodide
- [PLANO.md](../PLANO.md) §3 (payload), §4 (prefill), §5 (limites do Horde), §6 (REST), §14 (prazos e estratégias)
