# Berlin — plano

Editar uma imagem a partir de um prompt, usando a API do **AI Horde**, rodando inteiro no
**Cloudflare Workers** (plano gratuito).

**Status:** implementado e validado localmente — `npm test` → **25/25** (workerd real, D1 e KV locais,
mock do Horde). Falta apenas o deploy com a conta Cloudflare (§9).

---

## 1. Objetivo e requisitos

| # | Requisito | Onde está |
| --- | --- | --- |
| a | Rodar em hospedagem gratuita | Workers Free — US$ 0, **sem cartão** (§9) |
| b | Edição img2img via AI Horde | `src/horde.js`, `src/payload.js` |
| c | Campo de upload da imagem | `public/index.html` (drop zone + máscara) |
| d | **Todos** os parâmetros da API expostos | formulário em 5 grupos; listas servidas por `GET /api/limits` |
| e | Pré-preenchimento pelos dados da imagem | `public/shared/metadata.js` (navegador e servidor) |
| f | Endpoint que entrega a imagem gerada | `GET /api/edits/:id/image` |
| g | Preview antes do download | `public/app.js` — mostra gerada + original lado a lado |
| h | Acompanhamento de fila/status | `GET /api/edits/:id` (posição na fila) + polling com backoff |
| i | **Não perder o resultado em esperas longas** | webhook + Cron Trigger a cada minuto (§3) |
| j | Vigia sem custo e sem serviço pago | Cron Trigger nativo — **nada** de Render Cron, cron-job.org ou GitHub Actions |

---

## 2. Arquitetura

```
Cloudflare (grátis)
├── Worker  src/index.js   → API + frontend (static assets)
├── D1      berlin         → jobs (SQLite, durável, indexado)
├── KV      IMAGES         → imagens geradas (TTL 24 h)
├── KV      CACHE          → lista de modelos (5 min)
└── Cron    * * * * *      → o vigia (1 dos 5 Cron Triggers gratuitos)

AI Horde  ──webhook──▶  Worker  ──▶  D1 + KV
```

Um Worker só, sem build, sem Docker, sem banco para provisionar. O frontend é servido pelo mesmo
Worker, e requisições a assets estáticos são **gratuitas e ilimitadas** — a interface não consome as
100 mil requisições/dia.

**Por que não Render:** o plano Free do Render dorme em 15 min, e o webhook do Horde tem timeout de
3 s — um cold start perdia o resultado. Isso obrigava a uma thread vigia que morre no spin-down, mais
um agendador externo, mais o orçamento de 750 instance-hours. No Workers **não existe spin-down** e o
**Cron Trigger é nativo e gratuito**: as três camadas de contorno somem.

**Por que não Puter Workers:** descartado — o consumo é medido na conta do dono (`me.puter`) e a
conta está sem créditos. Avaliação anterior removida deste repositório.

---

## 3. Ciclo de vida de um pedido

1. O navegador lê a imagem: dimensões, canal alfa e metadados de geração (`tEXt` do A1111) →
   **pré-preenche o formulário**. Custo zero de CPU no Worker.
2. O navegador gera o base64 e faz `POST /api/edits` (multipart: `params` + `image_b64`).
3. O Worker monta o corpo do Horde **sem parsear o base64** (§5), chama `/v2/generate/async` com
   `webhook` e `r2: true`, grava o job no D1 como `pending` e devolve `{ id }`.
4. O navegador faz polling de `GET /api/edits/:id` (4 s → 10 s, pausa com a aba oculta).
5. **Captura, sem depender do navegador:**
   - **webhook** (caminho primário) — o Horde avisa em segundos; o Worker busca a URL pré-assinada,
     grava em KV, marca `done`;
   - **Cron Trigger** (rede de segurança) — a cada minuto, `tick()` chama `/check` dos jobs
     pendentes e, nos que terminaram, `/status` para capturar.
6. Preview (`GET /api/edits/:id/image`) e download.

Se o webhook falhar, o job continua `pending` — **nada se perde** — e o cron recupera. Testado: o
Horde desiste após 3×3 s e o resultado aparece no disparo seguinte do cron.

---

## 4. API do app

| Método | Rota | O que faz |
| --- | --- | --- |
| `GET` | `/api/health` | ping |
| `GET` | `/api/limits` | listas e faixas aceitas (`schedulers`, `post_processing`, …) |
| `GET` | `/api/models` | modelos ativos, cache 5 min no KV |
| `POST` | `/api/inspect` | multipart `image` → metadados + sugestões de prefill |
| `POST` | `/api/edits` | multipart `params` (JSON) + `image_b64` (+ `mask_b64`) → `202 {id}` |
| `GET` | `/api/edits/:id` | estado, gerações, avisos e **posição na fila** |
| `GET` | `/api/edits/:id/image?index=0` | ⬅ **entrega a imagem** (`X-Seed`, `X-Worker-Name` no header) |
| `DELETE` | `/api/edits/:id` | cancela no Horde |
| `POST` | `/api/hooks/horde` | receptor do webhook |
| `POST` | `/api/tick` | a mesma `tick()` do cron, sob demanda |
| `GET` | `/api/results` | últimos jobs |

`dry_run: true` em `params` devolve `200 {kudos}` sem criar job nem gastar kudos.

Erros de validação (faixa, enum, `nsfw` + `censor_nsfw`) → **400** com mensagem legível.

---

## 5. Payload do Horde

`src/payload.js` cobre todos os campos de `POST /v2/generate/async`:

- **raiz:** `prompt` (com ` ### ` antes do negativo), `models`, `source_image`, `source_processing`,
  `source_mask`, `nsfw`, `censor_nsfw`, `trusted_workers`, `validated_backends`, `slow_workers`,
  `extra_slow_workers`, `workers`, `worker_blacklist`, `shared`, `replacement_filter`, `dry_run`,
  `allow_downgrade`, `disable_batching`, `style`, `proxied_account`, `webhook`, `client_agent`.
- **`params`:** `steps`, `n`, `width`, `height`, `sampler_name`, `scheduler`, `cfg_scale`,
  `denoising_strength`, `clip_skip`, `seed`, `karras`, `hires_fix`, `hires_fix_denoising_strength`,
  `tiling`, `transparent`, `post_processing`, `post_processing_order`, `facefixer_strength`,
  `use_nsfw_censor`.

Duas regras que vêm do limite de CPU:

1. **`r2: true` sempre.** Com `false`, a imagem voltaria em base64 dentro do JSON do webhook;
   `request.json()` num corpo de 5 MB custa **~13 ms** de CPU contra o limite de **10 ms** do plano
   Free — daria `Error 1102` exatamente no caminho mais importante. Com `true`, o JSON tem ~1 KB.
2. **O base64 de entrada nunca vira string JS.** Ele chega como `Blob` e é colado no corpo por
   concatenação (`new Blob([prefixo, bytes, sufixo])`). Medido: **2,3 ms** contra 12,6 ms do parse.

Dimensões são ajustadas para múltiplos de 64; `width/height` entre 64 e 3072.

---

## 6. Pré-preenchimento

`public/shared/metadata.js` roda **no navegador e no Worker** (mesmo arquivo, sem duplicação). Lê só
cabeçalho e chunks de texto — nunca decodifica pixels, o que importa nos 128 MB do Worker.

| Achado na imagem | Efeito no formulário |
| --- | --- |
| dimensões | `width`/`height` com snap em 64 |
| canal alfa | `source_processing = inpainting` (senão `img2img`) |
| `tEXt` do A1111 | prompt, negativo, steps, sampler, CFG, seed, `denoising_strength` |
| nada disso | defaults: 512×512, `denoising_strength 0.55`, 25 passos, CFG 7.5 |

JPEG e WebP têm dimensões; EXIF de JPEG fica para v1.1.

---

## 7. O que os limites do Workers Free impuseram

| Limite (Free) | Consequência no desenho |
| --- | --- |
| **10 ms de CPU** por requisição e por cron | Worker magro: base64 e metadados no navegador; `r2: true`; nada de parse grande |
| **128 MB** de memória | stream de bytes; nada de decodificar imagem |
| 100 mil requisições/dia | polling com backoff; assets não contam |
| **5 Cron Triggers** por conta | 1 basta (`* * * * *`) |
| KV: 1.000 escritas/dia, 1 GB | imagens com TTL 24 h; R2 entra em v1.1 |
| D1: 5 M linhas lidas/dia, 500 MB | índice `(state, next_poll_at)` para o `tick()` não varrer a tabela |
| 3 MB de Worker | sem dependências de runtime: só `fetch` e Web APIs |

**R2 não é usado de propósito:** criar bucket passa por "checkout flow" (forma de pagamento). KV
resolve o v1 a US$ 0 e sem cartão; a troca são ~15 linhas em `src/images.js`.

---

## 8. Arquivos

```
wrangler.jsonc          config: D1, 2 KV, cron, assets
schema.sql              jobs + índice
src/
  index.js              { fetch, scheduled }
  router.js             rotas
  payload.js            monta e valida o payload; concatena o base64
  horde.js              submit / check / status / models / cancel
  capture.js            captura das gerações (webhook e tick compartilham)
  tick.js               o vigia
  store.js              jobs no D1
  images.js             putImage/getImage — isola KV (v1) de R2 (v1.1)
public/
  index.html            formulário completo
  app.js                upload, prefill, polling, preview, histórico
  styles.css
  shared/metadata.js    leitura de metadados (navegador + Worker)
test/
  horde-mock.mjs        Horde falso: r2:true, webhook de 3×3 s, expiração
  run-local.mjs         a suíte (25 checagens)
```

---

## 9. Deploy

```bash
npm install
npx wrangler login                       # conta Cloudflare gratuita

npx wrangler d1 create berlin            # → database_id
npx wrangler kv:namespace create IMAGES  # → id
npx wrangler kv:namespace create CACHE   # → id
# cole os três ids no wrangler.jsonc

npx wrangler d1 execute berlin --remote --file=schema.sql
npx wrangler secret put HORDE_API_KEY    # nunca vai no arquivo de config

npm run deploy                           # → https://berlin.<sub>.workers.dev
npx wrangler triggers list               # confirma o cron
```

O domínio `*.workers.dev` já é HTTPS, que é pré-requisito do webhook do Horde.
Para desenvolvimento: `npm run dev` (tudo local, sem conta) e `npm test`.

---

## 10. Custo

| Item | Free | Se um dia precisar |
| --- | --- | --- |
| Worker | 100 mil req/dia | US$ 5/mês (10 M req, 30 s de CPU) |
| Cron Trigger | 5 por conta | incluído |
| D1 | 5 M linhas lidas + 100 mil escritas/dia | incluído |
| KV | 100 mil leituras + 1.000 escritas/dia | incluído |
| **Total** | **US$ 0, sem cartão** | US$ 5/mês |

Kudos do Horde são outra conta: `dry_run: true` não gasta nada e a chave anônima funciona.

---

## 11. Riscos

1. **CPU de 10 ms** — mitigado por desenho (§5). Se mesmo assim estourar: Workers Paid (US$ 5).
2. **KV: 1.000 escritas/dia** — suficiente para uso pessoal; migrar imagens para R2 se virar público.
3. **Consistência eventual do KV** (até 60 s entre colos) — o job só fica `done` depois do `put()`
   bem-sucedido; o navegador faz retry se a imagem der 404.
4. **URL pré-assinada do Horde expira em 30 min** — a captura acontece em segundos; se falhar, o
   `/status` do tick devolve URL nova.
5. **App aberto na internet** — qualquer pessoa com a URL gasta os seus kudos. Mitigação gratuita:
   Cloudflare Access (até 50 usuários) na frente do Worker. v1.1.
6. **Lock-in** — baixo: R2 é compatível com S3, D1 é SQLite (`wrangler d1 export`), e o Worker usa
   só Web APIs.

---

## 12. Roadmap

- **v1.1:** R2 para as imagens; galeria; EXIF de JPEG; proteção por Cloudflare Access; Durable Object
  com alarme por job (timer individual em vez de varredura).
- **v1.2:** ControlNet; editor de máscara no navegador; comparação antes/depois com slider.

---

## 13. Referências

- [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) ·
  [pricing](https://developers.cloudflare.com/workers/platform/pricing/) ·
  [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
- [KV limits](https://developers.cloudflare.com/kv/platform/limits/) ·
  [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) ·
  [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)
- [R2 pricing](https://developers.cloudflare.com/r2/pricing/) ·
  [R2 get-started](https://developers.cloudflare.com/r2/get-started/) (o "checkout flow")
- [AI Horde API](https://aihorde.net/api) · [Horde no GitHub](https://github.com/Haidra-Org/AI-Horde)
