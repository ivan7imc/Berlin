# Plano — Editor de imagem por prompt (AI Horde) rodando no Render

**Repositório:** `ivan7imc/Berlin` · **Branch:** `arena/01a06721-berlin`
**Escopo deste documento:** plano de arquitetura + especificação de parâmetros + estrutura de arquivos + deploy. (Nenhum código foi escrito ainda.)

---

## 0. Objetivo e resumo

Um app web simples que:

1. recebe **upload de uma imagem**;
2. pré-preenche **todos os parâmetros da API do AI Horde** com os dados extraídos dessa imagem (dimensões, proporção, presença de alpha, formato, tamanho);
3. deixa o usuário ajustar o prompt e cada parâmetro num formulário completo;
4. submete um job **assíncrono** de edição (`source_processing = img2img | inpainting | outpainting | remix`) em `POST https://aihorde.net/api/v2/generate/async`;
5. acompanha a fila (posição, ETA, workers) por polling de `/v2/generate/check/{id}`;
6. busca o resultado em `/v2/generate/status/{id}`, **mostra o preview da imagem gerada no navegador** e oferece download;
7. expõe uma **API REST própria**, incluindo um endpoint que entrega a imagem gerada (para consumo programático e para envio a outros sistemas);
8. **captura o resultado automaticamente** (webhook do Horde + vigia interno + pulso do navegador), porque a fila pode passar de 20 min, o usuário pode fechar a aba e o resultado **expira** — ver §14, a seção mais importante deste plano. Tudo isso **sem nenhum serviço pago**.

**Decisão de stack (a mais simples possível, como pedido):** Python 3.11 + **Flask** + **gunicorn**, front-end em **HTML + CSS + JavaScript puro** (sem build, sem Node, sem bundler). Zero banco de dados na v1.

---

## 1. Arquitetura

```
Navegador (HTML/JS puro)                Render — Web Service (Python)
┌────────────────────────┐             ┌──────────────────────────────────────┐
│ form (imagem+params)   │─POST /api──▶│ Flask + gunicorn (0.0.0.0:$PORT)     │
│  ↳ prefill via JS      │             │  • valida/normaliza imagem (Pillow)  │
│ barra de progresso     │◀──polling──▶│  • monta payload do Horde            │
│ preview + download     │             │  • proxy fino p/ check/status        │
└────────────────────────┘             │  • stateless (sem DB)                │
                                       └───────────────┬──────────────────────┘
                                                       │ HTTPS (apikey + Client-Agent)
                                                       ▼
                                            AI Horde  https://aihorde.net/api
```

Princípios que guiam as escolhas:

| Restrição do ambiente | Consequência no design |
|---|---|
| Free tier do Render **desliga após 15 min sem tráfego** e leva ~1 min para acordar ([docs](https://render.com/docs/free)) | Nada de esperar a geração dentro da requisição. Tudo é assíncrono e o estado fica **no AI Horde** (o `job_id` dele é a fonte da verdade). |
| **Filesystem efêmero** — uploads e SQLite locais somem em restart/spin-down; disco persistente só em plano pago ([docs](https://render.com/docs/free)) | Uploads **nunca** são gravados em disco: vão para memória → Pillow → base64 → Horde. Nenhum banco na v1. |
| Proxy HTTP do Render na frente do app (porta `PORT`, default `10000`, bind em `0.0.0.0`) ([docs](https://render.com/docs/web-services)) | Requisições curtas (< ~2 s). Uploads grandes são o único corpo pesado, e mesmo assim limitados a ~10 MB. |
| Free: 750 h/mês, banda contabilizada, sem shell, sem scaling | `gunicorn --workers 2 --threads 4`; cache em memória da lista de modelos (TTL 5 min). |
| **O pedido no Horde expira em ~20 min** (60 min com `extra_slow_workers`) | Não dá para confiar no polling do navegador: **webhook + vigia** capturam o resultado assim que ele fica pronto (§14). |
| **O resultado também expira**: base64 dura até o `expiry` do pedido; URL R2 é presinada p/ 30 min | Persistir a imagem no nosso armazenamento no instante em que `done == true`. |

**Stateless é a escolha central:** o servidor não guarda job. O navegador guarda o `job_id` (e um histórico no `localStorage`), e há um campo "Retomar job" para colar um id manualmente. Assim o app sobrevive a spin-down, restart e deploy sem perder o usuário.

**Sobre `r2`:** com `r2: true` o Horde devolve uma **URL** do Cloudflare R2 em `generations[].img`; com `r2: false` devolve o **base64 do WebP** dentro do JSON. A v1 usa **`r2: false` como padrão** para que o preview e o download saiam do nosso próprio endpoint (`GET /api/v1/edits/{id}/image`), com fallback para URL R2 quando o JSON vier como link. Motivo extra confirmado no código do Horde: a URL R2 é **presinada para 30 min**, enquanto recebendo os bytes nós podemos persisti-los.

**Três componentes extras exigidos pela espera longa** (detalhados na seção 14):

1. **Receptor de webhook** (`POST /api/v1/hooks/horde`) — o Horde avisa no instante em que a geração fica pronta; o servidor baixa e persiste a imagem **independentemente de o usuário estar com a aba aberta**.
2. **Vigia interno** (thread daemon em `watcher.py`, a cada 30–60 s enquanto houver job pendente) — avança os jobs registrados e captura os que terminaram. **Sem serviço pago**: nenhum Cron Job do Render (§14.7 lista as alternativas gratuitas).
3. **Armazenamento de resultados** (`store`) — fora do processo Python (disco do container, opcionalmente Render Key Value/Postgres), porque cache em memória **não é compartilhado** entre os workers do gunicorn.

---

## 2. Endpoints do AI Horde que serão usados

| Finalidade | Método + URL | Rate limit no servidor hoje |
|---|---|---|
| Submeter edição | `POST /api/v2/generate/async` | `90/minute` por IP, `2/second` por IP, `2/second` por apikey |
| Progresso (barato) | `GET /api/v2/generate/check/{id}` | `10/second` por IP+caminho |
| Resultado (imagens) | `GET /api/v2/generate/status/{id}` | **`10/minute`** por IP+caminho ← gargalo |
| Cancelar | `DELETE /api/v2/generate/status/{id}` | — |
| Modelos disponíveis | `GET /api/v2/status/models?type=image&model_state=all` | — |
| Estimar custo | `POST /api/v2/generate/async` com `"dry_run": true` | idem ao submit |

*Valores lidos em `horde/apis/limiter_api.py` e nos decorators `limiter.limit` de `horde/apis/v2/stable.py` no branch principal do [AI-Horde](https://github.com/Haidra-Org/AI-Horde). IPs/padroeiros com mais kudos recebem limites maiores (300/min, 600/h, 60/s).*

> ⏱️ Além dos rate limits, cada um desses endpoints tem **prazos de validade do pedido e do resultado** (20 min / 60 min / 30 min). É a seção **14. Esperas longas** que trata disso — e é ela que explica por que o polling do navegador não pode ser o único mecanismo.

**Regra de ouro:** o polling existe só para **desenhar** a barra de progresso. **Quem garante o resultado é o webhook + o vigia** (§14), porque o usuário pode fechar a aba e a instância pode dormir no meio da fila.

**Política de polling (obrigatória para não tomar 429):**

```
t=0        POST /generate/async            → { id, kudos, warnings }
loop:      GET  /generate/check/{id}       a cada 4 s (+ jitter), backoff 4→6→8→10 s
           GET  /generate/status/{id}      SOMENTE se done == true  (ou no máx. 1×/20 s)
fim:       para quando done && len(generations) == n, faulted == true, ou JOB_TIMEOUT (15 min)
```

Headers obrigatórios em toda chamada:

```
apikey: <HORDE_API_KEY ou 0000000000 para anônimo>
Client-Agent: Berlin-Horde-Editor:1.0:https://github.com/ivan7imc/Berlin
Content-Type: application/json
```

---

## 3. Especificação completa do payload (AI Horde v2)

Abaixo está **todo** o conjunto de campos aceitos por `POST /v2/generate/async`, extraído dos modelos do servidor (`horde/apis/models/stable_v2.py` → `GenerationInputStable` + `ModelGenerationInputStable`/`ModelPayloadRootStable`) e do SDK oficial (`horde_sdk/.../apimodels/base.py`, `generate/async_.py`).

### 3.1 Nível raiz

| Campo | Tipo / faixa | Obrigatório | Default | Observações |
|---|---|---|---|---|
| `prompt` | string | ✅ | — | Prompt positivo. Negativo entra depois de **` ### `** (o servidor faz `split("###", 1)`). |
| `params` | objeto | não | `{}` | Ver 3.2. |
| `models` | string[] | ✅ | — | Ex.: `["Deliberate"]`, `["SDXL 1.0"]`. Popular de `/v2/status/models`. |
| `source_image` | string (base64 ou URL) | ✅ p/ edição | — | Base64 puro. Se URL, o Horde exige `Content-Length` e **máx. 5 MB**. |
| `source_processing` | enum | não | `txt2img` | `txt2img`, `img2img`, `inpainting`, `outpainting`, `remix`. **Nossa v1: `img2img`.** |
| `source_mask` | string (base64 WebP) | não | `null` | Obrigatório p/ `inpainting`/`outpainting` se a máscara não vier no canal alpha. |
| `extra_source_images` | `{image, strength}`[] | não | `null` | `strength` −5..5. Usado p/ ControlNet extra. |
| `nsfw` | bool | não | `true` | `true` = permite NSFW e pula workers censores. |
| `censor_nsfw` | bool | não | `false` | **Incompatível com `nsfw: true`** (validação do SDK/cliente). |
| `trusted_workers` | bool | não | `false` | |
| `validated_backends` | bool | não | `null` | |
| `slow_workers` | bool | não | `true` | Desligar custa kudos extras. |
| `extra_slow_workers` | bool | não | `false` | |
| `workers` | string[] (ids) | não | `[]` | Whitelist de workers. |
| `worker_blacklist` | bool | não | `false` | Transforma `workers` em blacklist. |
| `r2` | bool | não | `true` | `true` = resultado vem como URL R2; `false` = base64 WebP no JSON. |
| `shared` | bool | não | `false` | Compartilha c/ LAION, −2 kudos. **Anônimo é sempre `true`.** |
| `replacement_filter` | bool | não | `true` | Saneia prompts suspeitos. |
| `dry_run` | bool | não | `false` | Só estima kudos (retorna 200 `{kudos}`). |
| `allow_downgrade` | bool | não | `false` | Reduz steps/resolução se faltar kudos. |
| `disable_batching` | bool | não | `false` | Sementes exatas. Restrito a trusted/patreons. |
| `webhook` | string (URL) | não | `null` | Horde faz POST a cada geração entregue. |
| `proxied_account` | string | não | `null` | Só p/ service accounts. |
| `style` | string (uuid) | não | `null` | Estilo salvo no Horde. |

### 3.2 `params` (geração)

**Essenciais (aparecem sempre na UI):**

| Campo | Tipo / faixa | Default | Notas |
|---|---|---|---|
| `steps` | int 1–500 | 30 (server) / 25 (SDK) | Alias legado `ddim_steps`. |
| `n` | int 1–20 | 1 | Alias legado `n_iter`. |
| `width` | int 64–3072, **múltiplo de 64** | 512 | ⬅ pré-preenchido pela imagem. |
| `height` | int 64–3072, **múltiplo de 64** | 512 | ⬅ pré-preenchido pela imagem. |
| `sampler_name` | enum (40+ valores) | `k_euler` | `k_lms, k_heun, k_euler, k_euler_a, k_dpm_2, k_dpm_2_a, k_dpm_fast, k_dpm_adaptive, k_dpmpp_2s_a, k_dpmpp_2m, dpmsolver, k_dpmpp_sde, lcm, DDIM, uni_pc, uni_pc_bh2, dpmpp_2m_sde, dpmpp_3m_sde, ddpm, deis, ipndm, res_multistep, gradient_estimation, heunpp2, er_sde, sa_solver, euler_cfg_pp, …, sa_solver_pece`. |
| `scheduler` | enum | `null` (deriva de `karras`) | `normal, karras, exponential, sgm_uniform, simple, ddim_uniform, beta, linear_quadratic, kl_optimal, align_your_steps, gits`. Tem precedência sobre `karras`. |
| `karras` | bool | `true` | Deprecado em favor de `scheduler` (`true`→`karras`, `false`→`normal`). |
| `cfg_scale` | float 0–100 | 7.5 | |
| `denoising_strength` | float **0.01–1.0** | 1 | ⬅ **o parâmetro central do img2img.** |
| `clip_skip` | int 1–12 | 1 | |
| `seed` | string | `null` (aleatório) | Reaproveitada p/ "gerar de novo igual". |
| `seed_variation` | int 1–1000 | `null` | Deprecado. |
| `hires_fix` | bool | `false` | |
| `hires_fix_denoising_strength` | float 0.01–1.0 | `null` | |
| `tiling` | bool | `false` | |
| `transparent` | bool | `false` | Gera com fundo transparente. |
| `post_processing` | string[] | `[]` | Upscalers: `4x_AnimeSharp, 4xNomos8kSC, 4xLSDIRplus, 4xNomosWebPhoto_RealPLKSR, 4xNomos2_realplksr_dysample, 4xNomos2_hq_dat2, 2xModernSpanimationV1`. Facefixers: `GFPGANv1.3`. |
| `post_processing_order` | enum | `facefixers_first` | `facefixers_first` \| `upscalers_first` (afeta custo em kudos). |
| `facefixer_strength` | float 0–1 | `null` | |
| `use_nsfw_censor` | bool | `false` | |

**ControlNet / fluxos (grupo "Avançado"):**

| Campo | Tipo / faixa | Default |
|---|---|---|
| `control_type` | enum | `null` — `canny, hed, depth, normal, openpose, seg, scribble, fakescribbles, hough, mlsd, binary, standard_lineart, lineart, lineart_anime, lineart_anime_denoise, pidinet, scribble_xdog, scribble_pidinet, teed, pyracanny, midas_depth, zoe_depth, depth_anything, depth_anything_v2, normal_bae, oneformer_ade20k, oneformer_coco, color, shuffle, recolor_luminance, recolor_intensity, tile, tile_ttplanet_guided, tile_ttplanet_simple` |
| `control_strength` | float 0.01–3.0 | `null` (= 1.0 no worker) |
| `image_is_control` | bool | `false` |
| `return_control_map` | bool | `false` |
| `workflow` | enum (`qr_code`) | `null` |
| `extra_texts` | `{text, reference}`[] | `null` (obrigatório p/ `workflow: qr_code`) |
| `loras` | `{name, model −5..5, clip −5..5, inject_trigger, is_version}`[] | `null` |
| `tis` | `{name, inject_ti: "prompt"\|"negprompt", strength −5..5}`[] | `null` |
| `special` | objeto livre | `null` |

**Solvers (painel colapsado "Solver — especialista"):**
`sampler_eta`, `sampler_s_noise`, `sampler_s_churn`, `sampler_s_tmin`, `sampler_s_tmax` (todos float ≥ 0), `sampler_solver_type` (enum por sampler), `sampler_order` (int ≥ 1), `flow_shift` (float ≥ 0). Todos `null` por padrão.

> `max_pixels`, `step_count`, `img2img`, `painting`, `lora`, `controlnet` **não** são campos de cliente — pertencem ao parser de *job pop* do worker. Não enviar.

### 3.3 Exemplo de payload que o app vai montar

```json
{
  "prompt": "a cyberpunk street at night, neon reflections on wet asphalt ### blurry, lowres, watermark, text",
  "params": {
    "steps": 30,
    "n": 1,
    "width": 832,
    "height": 1216,
    "sampler_name": "k_euler",
    "scheduler": "karras",
    "cfg_scale": 7.5,
    "denoising_strength": 0.55,
    "clip_skip": 1,
    "hires_fix": false,
    "karras": true,
    "tiling": false,
    "post_processing": [],
    "seed": ""
  },
  "models": ["Deliberate"],
  "source_image": "<base64 puro, sem prefixo data:>",
  "source_processing": "img2img",
  "nsfw": false,
  "censor_nsfw": false,
  "trusted_workers": false,
  "slow_workers": true,
  "r2": false,
  "shared": false,
  "replacement_filter": true,
  "dry_run": false,
  "allow_downgrade": false
}
```

Resposta (202): `{ "id": "<uuid>", "kudos": 12.4, "warnings": [{ "code": "...", "message": "..." }] }`

---

## 4. Pré-preenchimento pelos dados da imagem original (requisito central)

### 4.1 Fluxo em duas camadas

1. **Instantâneo, no navegador (JS):** ao soltar/selecionar o arquivo, o JS lê `naturalWidth/naturalHeight` via `URL.createObjectURL` + `Image`, e preenche na hora: largura, altura, megapixels, proporção — já "snapadas" para múltiplo de 64.
2. **Autoritativo, no servidor:** `POST /api/v1/inspect` (multipart) usa **Pillow** para ler a imagem de verdade e devolve o JSON canônico que alimenta o painel "Dados da imagem original" e normaliza os campos. É a fonte da verdade — o JS é só conforto. Funciona mesmo com JS desativado (submit normal do form já vem pré-preenchido pelo servidor).

`GET/POST /api/v1/inspect` → resposta:

```json
{
  "filename": "praca.jpg",
  "format": "JPEG",
  "bytes": 1843200,
  "width": 4032, "height": 3024,
  "megapixels": 12.19,
  "aspect_ratio": "4:3",
  "has_alpha": false,
  "mode": "RGB",
  "suggested": {
    "width": 1024, "height": 768,
    "source_processing": "img2img",
    "denoising_strength": 0.55
  },
  "adjustments": [
    "dimensões arredondadas para múltiplo de 64 (4032x3024 → 1024x768)",
    "imagem reduzida para caber no limite de 10 MB / 2048 px"
  ]
}
```

### 4.2 Tabela de pré-preenchimento

| Campo da UI | Valor inicial | Origem |
|---|---|---|
| `width` | dimensão real arredondada p/ múltiplo de 64, clamp 64–3072 | 🖼️ imagem |
| `height` | idem, proporção preservada | 🖼️ imagem |
| `source_image` | base64 WebP normalizado (qualidade 90, ≤ 2048 px, ≤ 10 MB) | 🖼️ imagem |
| `source_processing` | `img2img`; se a imagem tiver canal alpha com conteúdo → sugere `inpainting` | 🖼️ imagem |
| `denoising_strength` | `0.55` quando `img2img` (padrão sensato p/ "editar mantendo a foto") | ⚙️ heurística |
| `models` | modelo default configurado (`DEFAULT_MODEL`, ex. `Deliberate`), validado contra `/v2/status/models` | ⚙️ config |
| `steps`, `cfg_scale`, `sampler_name`, `scheduler`, `clip_skip`, `karras`, `n` | defaults do Horde (30 / 7.5 / `k_euler` / `karras` / 1 / `true` / 1) | ⚙️ defaults da API |
| `nsfw`, `censor_nsfw`, `r2`, `shared`, `replacement_filter`, `slow_workers` | `false / false / false / false / true / true` | ⚙️ defaults do app |
| `seed` | vazio (aleatório); após uma geração, o seed volta da resposta e fica travável | 🔁 reuso |

**Controles de proporção na UI:**
- checkbox *"Manter proporção da original"* (default ligado) — ao editar `width`, `height` recalcula e vice-versa;
- botão *"Usar dimensões originais"* — volta ao tamanho snapado da imagem;
- seletor de escala rápida: **25% · 50% · 75% · 100%** da original;
- aviso quando `width × height` ultrapassar o que o modelo/workers costumam atender (sugere `hires_fix` ou reduzir).

**Camada extra (opcional, v1.1):** botão *"Descrever a imagem"* → `POST /v2/interrogate` com o form `caption` do AI Horde devolve uma legenda que **pré-preenche o prompt** automaticamente. É o uso mais literal de "pré-preenchido com os dados da imagem original" e entra logo depois da v1.

---

## 5. Interface (campos do formulário)

Layout em uma coluna, com grupos colapsáveis; à direita, o painel fixo com **preview da original → preview do resultado → download**.

| Grupo | Campos |
|---|---|
| **1. Imagem** | upload (drag & drop) · painel "Dados da imagem original" · `source_processing` · `source_mask` (upload) · `denoising_strength` |
| **2. Prompt** | prompt positivo (textarea) · prompt negativo (textarea) → unidos com ` ### ` · `replacement_filter` |
| **3. Amostragem** | `steps` · `sampler_name` · `scheduler` (+ `karras` legado) · `cfg_scale` · `clip_skip` · `seed` · `n` |
| **4. Dimensões** | `width` · `height` · escala rápida · manter proporção · `hires_fix` · `hires_fix_denoising_strength` · `tiling` · `transparent` |
| **5. Modelo e workers** | `models` (select populado de `/v2/status/models`, mostra `queued`/`eta`/`count`) · `trusted_workers` · `validated_backends` · `slow_workers` · `extra_slow_workers` · `workers[]` + `worker_blacklist` |
| **6. Pós-processamento** | `post_processing[]` (checkboxes de upscalers/facefixers) · `post_processing_order` · `facefixer_strength` |
| **7. ControlNet / avançado** | `control_type` · `control_strength` · `image_is_control` · `return_control_map` · `workflow` · `extra_texts[]` · `loras[]` · `tis[]` |
| **8. Solver (especialista)** | `sampler_eta`, `sampler_s_noise`, `sampler_s_churn`, `sampler_s_tmin`, `sampler_s_tmax`, `sampler_solver_type`, `sampler_order`, `flow_shift` |
| **9. Requisição** | `nsfw` · `censor_nsfw` · `r2` · `shared` · `allow_downgrade` · `disable_batching` · `dry_run` (botão "estimar kudos") · `webhook` · `style` |

**Barra de progresso / status (durante a geração):** `queue_position`, `wait_time` (s), `waiting/processing/finished/restarted`, `kudos` consumido, `is_possible`, `eligible_workers`, `might_stall`, `done`, `faulted`, warnings do servidor, e por geração: `worker_name`, `worker_id`, `model`, `seed`, `censored`, `gen_metadata`. Botões: **Cancelar** (`DELETE /status/{id}`), **Copiar job id**, **Avisar quando terminar** e **Aceito esperar mais (até 1 h)** = `extra_slow_workers`. Aviso permanente: *"este pedido expira em ~20 min no Horde"* (§14).

---

## 6. API REST do próprio app

Além da UI, o app expõe uma API — é aqui que mora o requisito *"endpoint para envio da imagem gerada"*.

### 6.1 Endpoints

| Método | Rota | Descrição |
|---|---|---|
| `GET` | `/` | UI (HTML). |
| `GET` | `/healthz` | Health check do Render → `200 {"ok": true}`. |
| `POST` | `/api/v1/inspect` | Multipart (`image`). Devolve metadados + sugestões de pré-preenchimento (§4.1). |
| `POST` | `/api/v1/edits` | **Submete a edição.** Aceita `multipart/form-data` (campo `image` + campos de params) **ou** `application/json` com `image_base64`. Responde `202`. |
| `GET` | `/api/v1/edits/{job_id}` | Estado consolidado (proxy de `check` + `status`). |
| `GET` | `/api/v1/edits/{job_id}/image[?index=0]` | ⬅ **entrega a imagem gerada**: `200 image/webp` com `Content-Disposition`, `Cache-Control` e `X-Seed`/`X-Worker-Name`; `425` enquanto não estiver pronta; `404` se o job expirou. |
| `GET` | `/api/v1/edits/{job_id}/image/{gen_id}` | Imagem específica quando `n > 1`. |
| `DELETE` | `/api/v1/edits/{job_id}` | Cancela no Horde (`DELETE /v2/generate/status/{id}`). |
| `POST` | `/api/v1/edits/dry-run` | Estima kudos (`dry_run: true`) sem gastar. |
| `GET` | `/api/v1/models` | Modelos ativos (cache 5 min em memória). |
| `POST` | `/api/v1/hooks/horde?token=…` | **Receptor do webhook do Horde.** Ao receber, chama `/v2/generate/status/{id}`, baixa os bytes e persiste. **Caminho primário de captura do resultado.** |
| `POST` | `/api/v1/cron/tick` | **Vigia (idempotente).** Avança os jobs pendentes e captura os que ficaram prontos. Pode ser chamado pela **thread interna**, pela **aba do navegador**, por `curl` ou por qualquer agendador externo gratuito (§14.7). Header `X-Cron-Token` quando vier de fora; sem trabalho a fazer responde `204`. |
| `GET` | `/api/v1/jobs/pending` | Ops/debug: jobs pendentes, estado e prazo de expiração. |
| `POST` | `/api/v1/edits` c/ `callback_url` | **Entrega server-to-server:** ao terminar, o app faz POST multipart da imagem para a URL informada, assinado com HMAC (`X-Berlin-Signature`). |

### 6.2 Contratos

```http
POST /api/v1/edits
Content-Type: multipart/form-data

image=@foto.jpg
prompt=a cyberpunk street at night
negative_prompt=blurry, watermark
denoising_strength=0.55
steps=30
```

```json
{
  "job_id": "b3f1…",
  "kudos": 12.4,
  "warnings": [],
  "status_url": "/api/v1/edits/b3f1…",
  "image_url": "/api/v1/edits/b3f1…/image",
  "poll_interval_ms": 4000
}
```

```json
GET /api/v1/edits/b3f1…
{
  "state": "processing",
  "done": false, "faulted": false, "is_possible": true,
  "waiting": 0, "processing": 1, "finished": 0, "restarted": 0,
  "queue_position": 3, "wait_time": 41, "kudos": 12.4,
  "might_stall": false, "eligible_workers": 57,
  "generations": [
    { "id": "…", "worker_name": "Nyx#1234", "model": "Deliberate", "seed": "41823", "censored": false }
  ],
  "image_urls": ["/api/v1/edits/b3f1…/image?index=0"]
}
```

**Autenticação da API:** header `X-App-Token` comparado a `APP_API_TOKEN` via `hmac.compare_digest` (se a variável estiver vazia, a API roda aberta — só para dev local). Rate limit próprio por IP (`flask-limiter`: 10 submissões/hora, 60 leituras/min).

**Retomada:** `GET /api/v1/edits/{job_id}` aceita **qualquer** id válido do Horde, mesmo criado fora do app. É o que torna o servidor stateless e o app resiliente a spin-down.

---

## 7. Fluxo ponta a ponta

1. Usuário solta a imagem → JS lê dimensões → pré-preenche `width/height` → `POST /api/v1/inspect` confirma e devolve metadados/sugestões.
2. Usuário escreve o prompt e ajusta parâmetros; um `debounce` de 800 ms chama `/api/v1/edits/dry-run` e mostra **"custo estimado: N kudos"** ao lado do botão.
3. Submit → servidor: valida campos (faixas, múltiplos de 64, `nsfw` XOR `censor_nsfw`), normaliza a imagem (Pillow: RGB/RGBA, ≤ 2048 px, WebP q90, ≤ 10 MB), monta o payload, `POST /v2/generate/async` com `Client-Agent` e `apikey`.
4. `202` → o servidor **registra o job no `store`** (id, criado em, `expiry` estimado, params) e devolve `job_id`. O navegador inicia o polling — mas ele é **só para a UI** (§14.2).
5. **Captura automática, sem depender do navegador:**
   - **caminho primário — webhook:** o Horde faz `POST /api/v1/hooks/horde` assim que cada geração é entregue, **com a imagem no corpo** (`get_details()` inclui `img`); o handler grava no `store` sem precisar chamar `status`. Funciona quando a instância está acordada (§14.7-A).
   - **rede de segurança — vigia interno:** a thread do `watcher.py` roda a cada 45 s **enquanto houver job pendente**, faz `check` e captura o que já está `done`. **Sem serviço pago.** O endpoint `/api/v1/cron/tick` expõe o mesmo trabalho para pulsos externos gratuitos ou do navegador (§14.7-B/C).
6. Polling da UI em `/api/v1/edits/{id}` a cada 4 s (backoff até 10 s com jitter). Quando o `store` já tem a imagem, o próprio endpoint responde `state: "done"` + `image_urls` **sem gastar** uma chamada de `status` no Horde (limite de 10/min).
7. UI mostra o **preview** (com a original lado a lado, slider antes/depois), seed usada, worker, modelo, e botão **Download (.webp)** + **Copiar** + **Gerar de novo** (reusa seed) + **Editar resultado** (manda a gerada como nova original).
8. Entrega/encerramento: se `callback_url` foi informado, o servidor faz o POST assinado da imagem assim que a captura termina. Se `faulted`, `restarted` ou expirado → *Retentar* / *Cancelar* / *Reenviar aceitando esperar 1 h* (`extra_slow_workers`).

**Tratamento de erros**

| Situação | Conduta |
|---|---|
| `429` do Horde | Respeitar `Retry-After`; backoff exponencial com jitter; avisar na UI. |
| `warnings[]` na submissão | Exibir em banner amarelo (ex.: "nenhum worker aceita essa combinação agora"). |
| `is_possible: false` / `might_stall: true` | Sugerir reduzir steps/resolução ou trocar de modelo. |
| `faulted: true` | `DELETE` + oferecer retry. |
| `censored: true` | Mostrar aviso de censura do worker. |
| Saldo de kudos insuficiente | `dry_run` prévio + sugestão de `allow_downgrade: true`. |
| Imagem grande demais | Reduzir automaticamente (Pillow) e informar; acima de `MAX_UPLOAD_MB` → `413`. |
| Job > `JOB_TIMEOUT_MIN` (60) | O **cliente** para de perguntar, mas o job continua no Horde e continua sendo vigiado pelo cron; retomável pelo id a qualquer momento. |
| Pedido expirou no Horde (404 em `check`) | Avisar "o Horde descartou este pedido (~20 min sem worker)" e oferecer reenvio com `extra_slow_workers: true`. |
| Webhook recebido mas imagem indisponível | Tentar `status`; se 404, marcar `expired` e avisar que o resultado não foi capturado a tempo. |
| Horde fora do ar | Mensagem amigável + link de status; não quebrar a UI. |

---

## 8. Estrutura de arquivos

```
Berlin/
├─ README.md                 # visão geral + link para este plano
├─ PLANO.md                  # este documento
├─ requirements.txt          # flask, gunicorn, requests, pillow, flask-limiter, python-dotenv
├─ runtime.txt               # python-3.11.9
├─ render.yaml               # Blueprint do Render (Infra-as-Code)
├─ .env.example              # variáveis documentadas (sem segredos)
├─ .gitignore                # __pycache__, .env, venv/, *.webp gerados
├─ app.py                    # rotas Flask (UI + /api/v1/*), erros, health check
├─ horde_client.py           # cliente fino do AI Horde (async/check/status/delete/models)
│                            #   • headers apikey + Client-Agent
│                            #   • retries c/ backoff, respeita Retry-After
│                            #   • traduz erros do Horde p/ exceções do app
├─ imaging.py                # Pillow: inspeção, normalização, snap-64, base64 WebP
├─ payload.py                # form → payload do Horde; validações de faixa; prompt ### negativo
├─ config.py                 # config via env vars (dataclass)
├─ store.py                  # persistência de resultados (disco/Key Value) + registro de jobs
├─ watcher.py                # vigia interno (thread daemon) + lógica do tick
├─ templates/
│  └─ index.html             # formulário completo (Jinja), grupos colapsáveis
├─ static/
│  ├─ styles.css
│  └─ app.js                 # prefill no cliente, polling, preview, antes/depois
├─ tests/
│  ├─ test_payload.py        # mapeamento e faixas dos parâmetros
│  ├─ test_imaging.py        # snap-64, limites, alpha
│  └─ test_api.py            # rotas com Horde mockado (responses/respx)
└─ docs/
   └─ exemplos.md            # exemplos de curl da API
```

**Módulos-chave (assinaturas previstas)**

```python
# imaging.py
def inspect(file_storage) -> ImageInfo          # formato, dims, alpha, sugestões
def normalize(file_storage, *, max_px=2048, max_mb=10) -> bytes   # WebP q90
def to_b64(data: bytes) -> str                  # base64 puro, sem prefixo
def snap64(n: int, lo=64, hi=3072) -> int

# payload.py
def build_payload(form: Mapping, image_b64: str) -> dict
def join_prompt(positive: str, negative: str) -> str   # "pos ### neg"

# horde_client.py
def submit(payload: dict) -> tuple[str, float, list]   # id, kudos, warnings
def check(job_id: str) -> dict
def status(job_id: str) -> dict
def cancel(job_id: str) -> None
def models() -> list[dict]

# store.py
def register_job(job_id: str, payload: dict, expires_at: datetime) -> None
def pending_jobs() -> list[JobRecord]
def mark_done(job_id: str, generations: list[dict]) -> None
def save_result(job_id: str, index: int, data: bytes) -> str
def load_result(job_id: str, index: int) -> bytes | None

# watcher.py
def capture(job_id: str) -> int        # baixa e persiste as gerações prontas; qtd capturada
def tick(max_jobs: int = 20) -> dict   # {"checked": n, "captured": n, "expired": n}
```

---

## 9. Configuração e deploy no Render

### 9.1 Variáveis de ambiente

| Variável | Exemplo | Notas |
|---|---|---|
| `PORT` | `10000` | O Render injeta; o app lê `os.environ["PORT"]`. |
| `HORDE_API_KEY` | `0000000000` | Anônimo por padrão; **secret** no Render. |
| `HORDE_BASE_URL` | `https://aihorde.net/api` | Permite apontar p/ instância privada. |
| `CLIENT_AGENT` | `Berlin-Horde-Editor:1.0:https://github.com/ivan7imc/Berlin` | Exigido pelas boas práticas do Horde. |
| `APP_API_TOKEN` | — | Protege `/api/v1/*` (vazio = aberto, só dev). |
| `DEFAULT_MODEL` | `Deliberate` | Pré-seleção no campo `models`. |
| `MAX_UPLOAD_MB` | `10` | `MAX_CONTENT_LENGTH` do Flask. |
| `MAX_SOURCE_PX` | `2048` | Redução automática da original. |
| `RESULT_TTL_SECONDS` | `86400` | TTL das imagens **persistidas** no `store` (24 h). |
| `POLL_INTERVAL_MS` / `POLL_MAX_MS` | `4000` / `10000` | Ritmo do polling (ecoado na resposta). |
| `JOB_TIMEOUT_MIN` | `60` | Desistência do **cliente**; o job continua no Horde e no vigia (§14). |
| `WEBHOOK_BASE_URL` / `WEBHOOK_TOKEN` | `https://berlin.onrender.com` | Monta a URL de `webhook` e valida o POST do Horde. **Essencial p/ não perder resultados** (§14). |
| `RESULT_DIR` | `/tmp/berlin-results` (Free) ou `/var/data/results` (disco persistente) | Onde o `store` grava as imagens capturadas. |
| `CRON_TOKEN` | — | Protege `POST /api/v1/cron/tick` quando chamado de fora (vazio = desabilita chamadas externas). |
| `WATCHER_THREAD` | `true` | Liga a thread interna do vigia (§14.2 camada 2). |
| `WATCHER_INTERVAL_SECONDS` | `45` | Intervalo do vigia interno **enquanto houver job pendente**. |
| `WATCHER_BATCH` | `20` | Máx. de jobs avançados por tick. |
| `BROWSER_TICK_MS` | `30000` | Intervalo do pulso da aba aberta (0 = desliga). |
| `ALLOWED_ORIGINS` | — | Se no futuro a API for chamada de outro domínio. |

### 9.2 `render.yaml` (Blueprint)

```yaml
services:
  - type: web
    name: berlin-horde-editor
    runtime: python
    region: oregon            # escolher região
    plan: free                # ou starter, se for uso real
    branch: arena/01a06721-berlin
    buildCommand: pip install -r requirements.txt
    startCommand: gunicorn --workers 2 --threads 4 --timeout 120 --bind 0.0.0.0:$PORT app:app
    healthCheckPath: /healthz
    envVars:
      - key: PYTHON_VERSION
        value: "3.11.9"
      - key: HORDE_API_KEY
        sync: false           # definido no dashboard (secret)
      - key: CLIENT_AGENT
        value: Berlin-Horde-Editor:1.0:https://github.com/ivan7imc/Berlin
      - key: DEFAULT_MODEL
        value: Deliberate
```

> **Sem serviço `cron`.** O Cron Job do Render é pago (mín. ~US$ 1/mês) e não acessa disco persistente, então ele **não** faz parte do deploy. O vigia roda como **thread interna** do web service e o endpoint `/api/v1/cron/tick` fica disponível para pulsos gratuitos externos ou do próprio navegador — ver §14.7.

`requirements.txt`:

```
Flask==3.0.*
gunicorn==22.*
requests==2.32.*
Pillow==10.*
flask-limiter==3.*
python-dotenv==1.*
```

### 9.3 Plano Free vs. Starter

| | Free | Starter (~US$ 7/mês) |
|---|---|---|
| Spin-down após 15 min ocioso | ✅ (~1 min p/ acordar) | ❌ sempre ligado |
| 750 h/mês | ✅ (compartilhado no workspace) | ilimitado |
| Filesystem efêmero | ✅ | ✅ (disco persistente é add-on separado) |
| Ideal para | demo / testes | uso real do app |

**Recomendação:** começar no **Free** (o app é stateless, então spin-down só atrasa o primeiro acesso). Mas atenção ao ponto que decide o desenho:

- **Nada de serviço cron do Render** (pago) e **nada de ping externo frequente**: cada requisição mantém a instância acordada por 15 min, e a franquia é de **750 h/mês por workspace**. Pingar a cada 5 min = instância acordada 100 % do tempo = **~744 h/mês, a franquia inteira** (tabela completa em §14.5).
- A captura do resultado, portanto, é feita **de dentro para fora**: thread interna do web service + pulso da aba do navegador (grátis e só enquanto alguém está esperando) + webhook do Horde. As alternativas externas gratuitas (cron-job.org, GitHub Actions, GCP Cloud Scheduler, Cloudflare Worker) estão em **§14.7**.
- Se um dia o app virar "uso real", o plano **Starter (~US$ 7/mês)** remove o spin-down e elimina todo esse problema — é a saída mais barata em horas de engenharia.

**Passos de deploy (manual, alternativa ao Blueprint):**
1. Dashboard → **New > Web Service** → conectar `ivan7imc/Berlin` → branch `arena/01a06721-berlin`.
2. Runtime **Python 3**, build `pip install -r requirements.txt`, start `gunicorn --workers 2 --threads 4 --timeout 120 --bind 0.0.0.0:$PORT app:app`.
3. **Advanced → Health check path:** `/healthz`.
4. **Environment:** `HORDE_API_KEY` (secret), `CLIENT_AGENT`, `DEFAULT_MODEL`, `APP_API_TOKEN`.
5. Deploy → abrir `https://berlin-horde-editor.onrender.com`.

---

## 10. Custos (kudos) e limites do Horde

- `dry_run: true` devolve o custo **antes** de gastar → usar no botão "estimar kudos" e no cálculo ao vivo.
- `shared: true` → **−2 kudos** (obrigatório p/ anônimos).
- `slow_workers: false`, `trusted_workers: true`, `workers[]` → custo extra.
- Post-processors (upscale/facefix) cobram kudos adicionais; `post_processing_order` influencia o custo.
- Anônimo (`0000000000`) funciona, mas fica no fim da fila: **usar uma API key** (registro gratuito em aihorde.net/register) melhora muito a espera.
- **`dry_run: true` não gasta kudos** (devolve `200 {kudos}` em vez de `202`). É o modo de desenvolvimento:
  dá para validar payload, faixas, avisos e custo estimado **sem gerar nada** — incluindo os testes
  automatizados e o botão "estimar kudos" da UI.
- Quem estiver com saldo baixo: o app continua funcionando (fila maior), e `extra_slow_workers: true`
  aumenta a janela de 20 para 60 min sem custo extra de kudos.
- Imagens via URL são limitadas a **5 MB**; enviamos base64, mas mantemos `MAX_UPLOAD_MB = 10` e reduzimos a 2048 px para não estourar o corpo da requisição no Render.

---

## 11. Critérios de aceite (v1)

- [ ] Upload de PNG/JPEG/WebP; dimensões e proporção pré-preenchidas automaticamente; painel "Dados da imagem original" confere com o arquivo.
- [ ] Todos os campos das seções 3.1 e 3.2 presentes na UI **ou** explicitamente marcados como "não exposto (default da API)".
- [ ] `POST /api/v1/edits` aceita multipart e JSON; válido via `curl` (exemplos em `docs/exemplos.md`).
- [ ] `GET /api/v1/edits/{id}` reflete fila/ETA/worker; nunca excede 1 chamada de `status` a cada 20 s por job.
- [ ] `GET /api/v1/edits/{id}/image` devolve `image/webp` (e funciona também com `r2: true`, redirecionando/fluxo de proxy).
- [ ] Preview da gerada antes do download, com comparação antes/depois.
- [ ] Cancelar, retentar e retomar job por id.
- [ ] `curl` de estimativa (`dry-run`) mostra kudos sem gerar.
- [ ] Todo submit registra o job no `store` e envia `webhook`; **a imagem é capturada sem o navegador** (teste: submeter, fechar a aba, conferir que ela aparece salva).
- [ ] Com o webhook desligado, a **thread interna do vigia** captura os resultados de jobs pendentes (teste: submeter, fechar a aba, e a imagem aparece salva enquanto a instância está acordada).
- [ ] `POST /api/v1/cron/tick` é idempotente: chamado 3× seguidas não duplica captura nem estoura o limite de 10/min de `status`.
- [ ] `/api/v1/cron/tick` com `CRON_TOKEN` vazio recusa chamadas externas (401) e responde `204` quando não há job pendente.
- [ ] `GET /api/v1/edits/{id}/image` responde igual em qualquer worker do gunicorn (armazenamento fora do processo).
- [ ] A UI avisa "pedido expira em ~20 min no Horde" e oferece `extra_slow_workers` (60 min) quando `wait_time` estiver alto.
- [ ] Retomar um job 30+ min depois funciona (imagem persistida) ou falha com a mensagem "resultado expirou no Horde; reenvie".
- [ ] `/healthz` 200; deploy no Render sobe com Blueprint `render.yaml`.
- [ ] `pytest` verde com o Horde mockado.

---

## 12. Roadmap pós-v1

| Versão | Item |
|---|---|
| v1.1 | **Editor de máscara em canvas** (pincel, borracha, limpar) → `inpainting`/`outpainting` reais com `source_mask`; suporte a `extra_source_images` (ControlNet). |
| v1.2 | Botão **"Descrever a imagem"** (`/v2/interrogate` + form `caption`) para pré-preencher o prompt a partir da original. |
| v1.3 | Galeria/histórico com **Render Postgres** (ou disco persistente em plano pago) — guardando job ids, seeds e imagens. |
| v1.4 | Seletor visual de **LoRAs e textual inversions** (busca na lista pública do Horde). |
| v1.5 | **Alchemy** (`/v2/generate/alchemy`) p/ upscale, remoção de fundo e caption como pós-edição. |
| v1.6 | Fila para múltiplos jobs em lote — preferir **Cloudflare Worker + KV (grátis)**; **Background Worker + Redis do Render** só se o app já estiver em plano pago. |

---

## 13. Riscos e observações

1. **A API do Horde muda.** Os enums (samplers, schedulers, controlnets) crescem com o tempo. Mitigação: centralizar as listas em `config.py`/busca dinâmica e tratar valores desconhecidos de forma permissiva, logando aviso em vez de quebrar.
2. **Rate limits compartilhados por IP.** No Free do Render o IP é compartilhado com outros serviços; ser conservador no polling (4 s → 10 s) e nunca abusar de `/status`.
3. **Cold start (~30–60 s) × timeout de 3 s do webhook do Horde:** se a instância estiver dormindo quando a geração termina, o aviso é perdido (3 tentativas × 3 s). Mitigação em §14.7-D (caixa postal quente) ou, na v1, o aviso honesto na UI para manter a aba aberta.
4. **Resultados não são eternos — e o prazo é curto:** o pedido expira em ~20 min e, depois de pronto, o resultado só fica disponível até o `expiry` (ou 30 min, no caso da URL R2 presinada). A captura automática por **webhook + vigia** (§14) é obrigatória, não opcional.
5. **Conteúdo sensível:** NSFW e censura são responsabilidade do usuário + configuração `nsfw`/`censor_nsfw`; o app nunca deve logar o base64 das imagens.
6. **Bandwidth** conta no limite mensal do workspace; `r2: false` traz a imagem pelo Render — se o uso crescer, trocar o default para `r2: true` e redirecionar.

---

## 14. Esperas longas: prazos do Horde e estratégia de captura

A geração pode levar de segundos a dezenas de minutos (fila + worker lento + jobs `restarted`). Esta seção é a resposta de projeto a isso — e foi escrita depois de ler o código do servidor do Horde, não a documentação.

### 14.1 Prazos que o Horde impõe

| Prazo | Valor | Onde no código | Consequência |
|---|---|---|---|
| Validade do pedido (`expiry`) | **20 min** após o submit | `get_expiry_date()` — `horde/utils.py` | Se nenhum worker pegar nesse prazo → `EXPIRED_UNSTARTED`, pedido apagado, **nunca haverá imagem**. |
| Modo "aceito esperar" | **60 min** | `get_extra_slow_expiry_date()`, ativado por `extra_slow_workers: true` | Único jeito de esticar a janela. |
| Extensão automática | a cada `refresh()` quando um worker pega o job | `WaitingPrompt.refresh()` — `classes/base/waiting_prompt.py` | Job em processamento não expira no meio. |
| TTL do job no worker (`job_ttl`) | 150 s por tentativa | coluna `job_ttl` | Job não entregue volta p/ fila e incrementa `restarted`. |
| Resultado com `r2: false` | enquanto a **linha do pedido existir** (até o `expiry`) | `ProcessingGeneration.get_details()` — `classes/stable/processing_generation.py` | Depois disso, `/status/{id}` → 404. |
| Resultado com `r2: true` | URL presinada **válida 30 min** | `generate_procgen_download_url(..., expires_in=1800)` — `horde/r2.py` | O link morre 30 min depois de pronto. |
| Limpeza | rotina periódica apaga pedidos expirados (e as imagens no R2) | `check_waiting_prompts()` — `database/threads.py` | Sem captura automática, o resultado se perde. |
| Entrega do **webhook** | `requests.post(url, json=data, timeout=3)`, **3 tentativas**, exige `https://`, fila de 256 (descarta se cheia) | `_deliver_webhook()` — `classes/base/processing_generation.py` | ⚠️ Um cold start de 30–60 s **estoura o timeout de 3 s**: se a instância estiver dormindo, o aviso é perdido. |
| Conteúdo do webhook | `get_details()` + `request` (wp id) + `id` (procgen) + `kudos` — ou seja, **inclui o `img`** (base64 com `r2: false`, URL com `r2: true`) | `send_webhook()` | Dá para capturar a imagem sem chamar `status` — ótimo, desde que o POST chegue. |

**Tradução prática:** a janela para pegar a imagem é de **alguns minutos até ~30 min** depois de pronta. Desenhar o app supondo que "o usuário vai estar com a aba aberta" é perder imagem.

### 14.2 Estratégia em três camadas (todas sem custo)

**Nota:** o Cron Job do Render foi **removido do plano** (§9.2) — não tem plano free e não acessa disco persistente. A camada 2 usa um **vigia interno** (thread do próprio processo) em vez de um serviço pago; as alternativas externas gratuitas ficam na seção 14.7.

| Camada | Mecanismo | Papel | Falha se… |
|---|---|---|---|
| 1 | **Webhook do Horde** (`webhook` → `/api/v1/hooks/horde`) | Captura em segundos, sem polling, e **já traz a imagem no corpo** | instância **dormindo** (timeout de 3 s × 3 tentativas ≈ 9 s < cold start) ou URL incorreta |
| 2 | **Vigia interno** (`watcher.py`, thread daemon no processo do Flask, a cada 30–60 s enquanto houver job pendente) | Avança os jobs registrados e captura os que ficaram prontos | o processo não estiver rodando (spin-down) — aí entram as camadas 1 e 3 |
| 3 | **Tick do navegador** (a aba aberta chama `/api/v1/cron/tick` a cada 30 s) | Mantém a instância acordada **exatamente enquanto alguém espera** e captura rápido | aba fechada ou em segundo plano (timers estrangulados) |

As camadas 1 e 2 executam o mesmo trecho de captura (com uma otimização: se o webhook já trouxe o `img`, não é preciso chamar `status`):

```
status = GET /v2/generate/status/{id}
para cada generation:
    bytes = base64_decode(gen.img)   se r2 == false
    bytes = GET(gen.img)             se r2 == true   # URL presinada, válida 30 min
    store.save_result(job_id, i, bytes)
store.mark_done(job_id, generations)
se callback_url: POST assinado da imagem (HMAC)
```

### 14.3 Matriz de cenários

| Cenário | O que acontece | Resultado |
|---|---|---|
| Espera de 2 min, aba aberta | webhook captura; o tick da aba mantém tudo acordado | ✅ imagem no `store`, preview instantâneo |
| Espera de 25 min, **aba fechada** | o **vigia interno** continua rodando enquanto a instância estiver acordada (15 min após o último request) | ✅ se voltar dentro da janela; ⚠️ se a instância dormir antes, só o webhook salva |
| Instância do Render dormiu no meio | o **webhook do Horde** acorda o serviço — mas com `timeout=3` ele provavelmente **falha** se o cold start passar de ~3 s | ⚠️ é o caso que a §14.7 resolve (caixa postal quente ou pulso externo) |
| Worker falha / job `restarted` | Horde reenfileira; o `expiry` é reestendido | ✅ contador `restarted` visível na UI |
| Ninguém pega o job em 20 min | pedido expira (`EXPIRED_UNSTARTED`) | ⚠️ UI avisa e oferece reenvio com `extra_slow_workers: true` |
| Webhook e vigia falham, usuário volta 2 h depois | pedido apagado no Horde | ❌ mensagem clara: "resultado expirou no Horde; reenvie" |
| `n > 1`, gerações entregues em momentos diferentes | cada webhook captura a sua; `finished` cresce | ✅ imagens parciais aparecem conforme chegam |

### 14.4 UX para espera longa

- Banner no submit: **"estimativa ~N min na fila (posição P). Este pedido expira em ~20 min se nenhum worker o pegar."**
- Opção **"Aceito esperar mais (até 1 h)"** → `extra_slow_workers: true` (estende o `expiry` para 60 min).
- Barra com `waiting/processing/finished/restarted`, `kudos`, `queue_position`, `wait_time`, `might_stall`, `eligible_workers`.
- **Page Visibility API:** ao voltar para a aba, sincroniza imediatamente (timers de aba oculta são estrangulados pelo navegador).
- Botões: **Cancelar**, **Copiar job id**, **Avisar quando terminar** (e-mail/Pushover disparado pelo handler do webhook) e **Retentar**.
- `JOB_TIMEOUT_MIN = 60`: o cliente para de perguntar, mas o job continua sendo vigiado e é retomável pelo id.
- Histórico no `localStorage` (`{job_id, prompt, miniatura, estado, criado_em}`): se o `store` já tem a imagem, o preview abre mesmo que o Horde já tenha apagado o pedido.

### 14.5 A conta que manda: horas de instância no Free

**Cada requisição acorda o serviço e ele fica acordado por 15 min** (janela de spin-down). O limite do Free é **750 h/mês por workspace** ([docs](https://render.com/docs/free)):

| Intervalo do pulso externo | Instância acordada | Consumo estimado |
|---|---|---|
| 1 min (cron-job.org, Cloudflare Worker, Cloud Scheduler) | 100 % do tempo | **~744 h/mês — a franquia inteira** |
| 5 min (GitHub Actions `*/5`) | 100 % do tempo | **~744 h/mês — a franquia inteira** |
| 15 min | praticamente 100 % | ~744 h/mês |
| 30 min | ~50 % | ~370 h/mês |
| 60 min | ~25 % | ~186 h/mês |

**Conclusão de projeto:** no plano Free, **quem espera não pode ser o Render.** Manter a instância acordada 24/7 para não perder um resultado consome toda a franquia e só é viável se este for o único serviço free do workspace — e ainda assim sem margem. Por isso a ordem de preferência é: (1) capturar *enquanto o usuário está na página* (grátis e rápido), (2) capturar *por evento* (webhook), (3) só então considerar pulso externo — e, nesse caso, esparso (§14.7).

Regras práticas:

- **Pingar de dentro para fora, não de fora para dentro:** enquanto a aba está aberta, o navegador pulsa (grátis, e só enquanto importa).
- **Nada de ping quando não há job pendente:** o endpoint `/api/v1/cron/tick` responde `204` sem trabalho, e o vigia interno dorme.
- Se um dia o app virar "uso real", o plano Starter (~US$ 7/mês) remove o spin-down e torna todo esse problema irrelevante — é a saída mais barata em horas de engenharia.

### 14.6 Onde o registro de jobs vive

O `store` precisa sobreviver a restart do processo (mas **não** precisa sobreviver a spin-down, porque o Horde continua com o job). Opções, em ordem de preferência:

1. **Disco do container** (`RESULT_DIR`) — simples e suficiente no plano pago; no Free sobrevive a restart dentro do mesmo ciclo de vida da instância, e se perder só perdemos o vigia (o usuário ainda tem o `job_id` no navegador).
2. **Render Key Value** (25 MB no Free, **não persistente**) — bom p/ o índice de jobs pendentes; as imagens continuam no disco.
3. **Cloudflare R2 + KV (grátis)** — 10 GB-mês e 1 M escritas/mês sem taxa de egresso; é o destino natural quando a opção **D** do §14.7 estiver ligada (a imagem já nasce lá e não depende do `RESULT_DIR` efêmero do Free).
4. **Render Postgres** — se/quando virar galeria (§12), é o destino natural do índice.

### 14.7 Alternativas **sem custo** ao Cron Job do Render

O Cron Job do Render está fora (não tem plano free, mín. ~US$ 1/mês, e não acessa disco persistente). Abaixo, o menu do que sobra — tudo gratuito — e a combinação recomendada.

#### Menu

| # | Alternativa | Custo | Captura típica | Horas do Render | Complexidade |
|---|---|---|---|---|---|
| **A** | **Webhook do Horde** direto no Render (camada 1 do §14.2) | 0 | segundos — **só se a instância estiver acordada** | 1 despertada por job | baixa |
| **B** | **Vigia interno + tick da aba** (camadas 2 e 3) | 0 | segundos, enquanto alguém usa o app | só durante o uso | baixa |
| **C** | **Agendador externo** chamando `/api/v1/cron/tick`: cron-job.org (1 min), GitHub Actions (5 min), GCP Cloud Scheduler | 0 | = intervalo do ping | ⚠️ alto (tabela do §14.5) | baixa |
| **D** | **Caixa postal quente:** webhook → **Cloudflare Worker** (sempre acordado, responde em ms) → grava o payload no **R2**; o Render busca quando acordar | 0 | segundos, **mesmo com o Render dormindo** | ~zero | média |
| **E** | **Vigia externo:** Worker com cron de 1 min consulta o Horde e só acorda o Render quando o resultado está pronto | 0 | ≤ 1 min | ~zero (1 despertada por job) | média-alta |

#### Combinação recomendada

1. **v1 — A + B (zero dependência externa).** Cobre o uso normal: aba aberta → tick do navegador + vigia interno capturam em segundos; aba fechada mas instância ainda acordada → o vigia interno captura; webhook é bônus quando a instância está quente. Aviso honesto na UI: *"mantenha esta aba aberta até terminar — se a instância dormir, o resultado pode expirar"*.
2. **Endurecimento recomendado — A + B + D.** Resolve o único furo real (cold start × timeout de 3 s do webhook) sem custo e sem queimar horas: o Worker da Cloudflare é sempre quente, recebe o webhook em milissegundos e guarda a imagem no R2 (10 GB grátis). O Render só precisa acordar quando o usuário voltar — e a imagem estará lá.
3. **Se quiser pulso externo de verdade — C com pulso esparso (30–60 min).** Custo aceitável (~186–370 h/mês) e serve como rede de segurança, **não** como mecanismo principal (o intervalo é maior que a janela de 20–30 min do resultado).

#### Como configurar cada uma

**B — vigia interno + tick do navegador** (já no plano; nada a instalar)

```python
# watcher.py — thread daemon iniciada em app.py (uma por processo)
def start_watcher(interval_seconds: int = 45) -> threading.Thread:
    def loop():
        while True:
            try:
                if store.has_pending():
                    tick(max_jobs=WATCHER_BATCH)
            except Exception:
                logger.exception("watcher tick failed")
            time.sleep(interval_seconds)

    t = threading.Thread(target=loop, daemon=True, name="watcher")
    t.start()
    return t
```

No navegador: `setInterval(() => fetch('/api/v1/cron/tick', {method: 'POST'}), 30000)` — suspenso quando a aba fica oculta (`document.hidden`) e retomado no `visibilitychange`.

**C — agendadores externos gratuitos**

| Serviço | Limites do free | Observação |
|---|---|---|
| **cron-job.org** | jobs ilimitados, **intervalo mínimo de 1 min**, timeout de 30 s, **sem retry**, atraso de 4–40 s | projeto comunitário, sem SLA — bom como rede de segurança |
| **GitHub Actions** (`on.schedule`) | **intervalo mínimo de 5 min**, sem garantia de pontualidade (atrasos e execuções perdidas sob carga); em **repositório público**, agendamentos são desativados após **60 dias sem atividade**; minutos: ilimitados em repo público, 2.000/mês no privado | já estamos num repo GitHub — é a opção mais natural |
| **GCP Cloud Scheduler** | **3 jobs/mês grátis** por conta de faturamento (US$ 0,10/job/mês depois) | o "cron de verdade" gratuito; exige conta GCP com faturamento ativo (não cobrado dentro da franquia) |

Exemplo de workflow (GitHub Actions) com pulso esparso:

```yaml
name: horde-watcher
on:
  schedule:
    - cron: "*/30 * * * *"     # a cada 30 min ≈ 370 h/mês de instância
  workflow_dispatch:
jobs:
  tick:
    runs-on: ubuntu-latest
    steps:
      - name: Tick
        env:
          APP_URL: ${{ secrets.APP_URL }}
          CRON_TOKEN: ${{ secrets.CRON_TOKEN }}
        run: curl -fsS -X POST "$APP_URL/api/v1/cron/tick" -H "X-Cron-Token: $CRON_TOKEN"
```

**D — caixa postal quente (Cloudflare Worker + R2)** — a que resolve o cold start

```js
// recebe o webhook do Horde em milissegundos, mesmo com o Render dormindo
export default {
  async fetch(request, env) {
    if (request.method !== "POST") return new Response(null, { status: 204 });
    if (request.headers.get("x-mailbox-token") !== env.MAILBOX_TOKEN) {
      return new Response("forbidden", { status: 403 });
    }
    const data = await request.json();              // já vem com o campo "img"
    await env.BUCKET.put(`${data.request}/${data.id}.webp`, decode(data.img));
    await env.BUCKET.put(`${data.request}.json`, JSON.stringify(data));
    return new Response("ok", { status: 200 });     // responde rápido: o Horde só espera 3 s
  },
};
```

O app aponta `webhook` para `https://<worker>.workers.dev/hook` e, ao acordar, varre o bucket materializando as imagens no `store`. Limites do free: Workers 100 mil requisições/dia; R2 **10 GB-mês, 1 M escritas, 10 M leituras, sem taxa de egresso**.

**E — vigia externo (opcional).** O mesmo Worker com `[triggers] crons = ["* * * * *"]` (1 min; 3–5 triggers no free) consulta `check` dos jobs pendentes (lista em KV) e só chama o Render quando `done == true`. Custo zero de horas do Render, captura em ≤ 1 min. Ressalva: 10 ms de CPU por execução no free — manter o handler enxuto (só `fetch`).

#### Alternativa arquivada: backend sem Render

A avaliação de levar o backend para **Puter Workers** foi **arquivada** em 2026-09-03 por restrição de
custo ([docs/alternativa-puter.md](docs/alternativa-puter.md)). O `spike/src/worker.js` produzido nela
fica no repositório porque é **portável** (Cloudflare Workers, Deno Deploy) e a lógica de captura
(webhook → store → `/tick`) é reaproveitável. O caminho ativo deste plano é **Render Free + as medidas
desta seção**, tudo a **US$ 0**.

#### O que **não** fazer

- ❌ Criar um segundo web service free no Render só para ficar pingando: as 750 h são **do workspace**, não por serviço — dois serviços acordados estouram a franquia em ~15 dias.
- ❌ Achar que a thread interna sobrevive ao spin-down: quando a instância dorme, a thread morre junto (por isso o vigia interno é a camada 2, nunca a única).
- ❌ Pingar de 5 em 5 minutos "para garantir": custa a franquia inteira (§14.5) e ainda assim deixa o primeiro acesso lento.

---

## 15. Referências

- AI Horde (servidor, modelos de API e rate limits): <https://github.com/Haidra-Org/AI-Horde> · `horde/apis/v2/stable.py`, `horde/apis/models/stable_v2.py`, `horde/apis/limiter_api.py`, `horde/image.py`
- horde-sdk (modelos Pydantic com defaults e faixas): <https://github.com/Haidra-Org/horde-sdk> · <https://horde-sdk.readthedocs.io/>
- Documentação interativa da API: <https://aihorde.net/api/>
- Render — Web Services: <https://render.com/docs/web-services>
- Render — Free tier / limitações: <https://render.com/docs/free>
- Render — Blueprint (IaC): <https://render.com/docs/infrastructure-as-code>
- Render — Cron Jobs: <https://render.com/docs/cronjobs> — **descartado**: sem plano free (mín. ~US$ 1/mês) e sem acesso a disco persistente
- Avaliação "backend sem Render": [docs/alternativa-puter.md](docs/alternativa-puter.md) · [Puter Workers](https://docs.puter.com/Workers/) · [puter.net.fetch()](https://docs.puter.com/Networking/fetch/) · [User-Pays model](https://developer.puter.com/pricing/)
- Alternativas gratuitas de agendamento: [cron-job.org](https://cron-job.org/) · [GitHub Actions `schedule`](https://docs.github.com/actions/using-workflows/events-that-trigger-workflows) (mín. 5 min; desativa após 60 dias sem atividade em repo público) · [GCP Cloud Scheduler](https://cloud.google.com/scheduler/pricing) (3 jobs/mês grátis) · [Cloudflare Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/) (3–5 triggers, 1 min, 10 ms CPU no free) · [Cloudflare R2](https://developers.cloudflare.com/r2/pricing/) (10 GB-mês grátis, sem egresso)
- Prazos/expiração do Horde: `horde/utils.py` (`get_expiry_date`, `get_extra_slow_expiry_date`), `horde/classes/base/waiting_prompt.py` (`job_ttl`, `refresh`), `horde/database/threads.py` (`check_waiting_prompts`), `horde/r2.py` (`expires_in=1800`), `horde/classes/stable/processing_generation.py` (`get_details`)
- Webhook do Horde: `horde/classes/base/processing_generation.py` — `send_webhook()` (payload = `get_details()` + `request`/`id`/`kudos`) e `_deliver_webhook()` (`requests.post(..., timeout=3)`, 3 tentativas, fila de 256)
