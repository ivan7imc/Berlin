# Avaliação: backend inteiro em Puter Workers (sem Render)

> **⚠️ ARQUIVADA em 2026-09-03 — decisão: não usar Puter** (restrição de custo: a plataforma consome
> créditos da conta do dono via `me.puter`). O plano ativo é o **[PLANO.md](../PLANO.md)** com Render Free.
> Este documento fica no repositório porque o `spike/src/worker.js` é **portável**: o mesmo arquivo roda
> em Cloudflare Workers (free tier com limites publicados), Deno Deploy ou Val.town, e a lógica de
> captura (webhook → store → `/tick`) é reaproveitada sem alteração.

**Status:** avaliação arquivada.
**Contexto:** o plano principal (PLANO.md) roda Python/Flask num Web Service do Render e tem na seção 14 um
conjunto de mecanismos (webhook, vigia interno, pulso do navegador, alternativas externas) criados
**exclusivamente para contornar três limitações do Render Free**: spin-down em 15 min, cold start de 30–60 s
e a franquia de 750 h/mês. Esta avaliação responde: e se a gente simplesmente **remover o Render** da equação?

---

## 1. Veredito

| Pergunta | Resposta |
|---|---|
| Dá para hospedar o backend inteiro no Puter? | **Sim** — rotas HTTP, `fetch` de saída, KV e sistema de arquivos estão disponíveis |
| O problema das esperas longas continua existindo? | **Não do nosso lado.** Sem spin-down, o webhook do Horde sempre chega (timeout de 3 s é tranquilo) e o vigia pode rodar a cada minuto de graça |
| Custa alguma coisa? | **US$ 0** para uso pessoal, mas com uma ressalva importante sobre *de quem* é a cota (§5.2) |
| O que se perde? | Python/Pillow, previsibilidade de limites e a independência de plataforma |
| Recomendação | **Fazer um spike (2–3 h) antes de decidir**, com critérios objetivos de go/no-go (§7) |

O ganho não é só financeiro: é a remoção de **quatro** componentes do plano (vigia interno, pulso do
navegador, keep-alive condicional, caixa postal Cloudflare) e de toda a contabilidade de horas de instância.

---

## 2. O que a documentação confirma

| Recurso | Confirmado? | Fonte |
|---|---|---|
| Rotas HTTP (`router.get/post/put/delete/options`) | ✅ | [`router`](https://docs.puter.com/Workers/router/) |
| `fetch` de saída sem CORS (`puter.net.fetch()`) — vale para Workers | ✅ | [`puter.net.fetch()`](https://docs.puter.com/Networking/fetch/) (página marcada para Websites/Puter Apps/Node.js/**Workers**) |
| KV e FS no contexto do dono (`me.puter.kv`, `me.puter.fs`) | ✅ | [`router` → Integration with Puter.js](https://docs.puter.com/Workers/router/) |
| Hospedagem estática grátis (`puter.hosting.create(sub, dir)` → `*.puter.site`) | ✅ | exemplos em [docs.puter.com](https://docs.puter.com/) |
| Subdomínio grátis `*.puter.work` com HTTPS | ✅ | [Serverless Workers](https://docs.puter.com/serverless-workers/) |
| Deploy por CLI (`puter worker deploy`) e por GitHub Action | ✅ | [docs.puter.com/Workers/](https://docs.puter.com/Workers/) |
| Respostas binárias (Blob, `Uint8Array`, `ReadableStream`) — serve a imagem de volta | ✅ | [`router`](https://docs.puter.com/Workers/router/) |
| Atualizar = sobrescrever o arquivo-fonte (mesma URL) | ✅ | [`puter.workers.create()`](https://docs.puter.com/Workers/create/) |
| Tamanho máximo do worker: 10 MB · propagação 5–30 s · requer conta com e-mail verificado | ✅ | [`puter.workers.create()`](https://docs.puter.com/Workers/create/) |
| **Cron / `scheduled` handler** | ❌ **não existe** — só rotas HTTP | [`router`](https://docs.puter.com/Workers/router/) lista apenas os 5 métodos HTTP |
| Limites publicados (req/dia, CPU por invocação) | ❌ não documentado | — |
| Variáveis de ambiente / cofre de segredos no worker | ❌ não documentado | — |

---

## 3. Arquitetura proposta (sem Render)

```
Navegador
├─ UI estática .......... https://berlin.puter.site        (puter.hosting, grátis)
│    • lê dimensões/EXIF no cliente
│    • redimensiona por Canvas (≤ 2048 px) e exporta JPEG/PNG
│    • chama a API e faz polling leve
│
└─ API (Puter Worker) ... https://berlin-api.puter.work    (sempre quente)
     POST /api/inspect            → metadados + sugestões de pré-preenchimento
     POST /api/edits              → monta payload, chama /v2/generate/async, registra job no KV
     GET  /api/edits/:id          → proxy de check/status
     GET  /api/edits/:id/image    → serve os bytes do FS do Puter
     POST /api/hooks/horde        → webhook do Horde (chega em ms; o Horde dá 3 s)
     POST /api/tick               → vigia: avança jobs pendentes (chamado por cron externo)
     GET  /api/models             → lista de modelos (cache no KV)

Estado:
     me.puter.kv   → índice de jobs {id, criadoEm, expiry, params, estado}
     me.puter.fs   → resultados: /results/{jobId}/{genId}.webp
```

**Custo de horas de instância: zero.** Não existe instância.

---

## 4. O que muda em relação ao plano atual

| Peça do PLANO.md | Hoje (Render + Flask) | Em Puter Workers |
|---|---|---|
| Runtime | Python 3.11 + gunicorn (2 workers) | JavaScript (V8 isolate, sempre quente) |
| UI | Jinja + estáticos no Flask | HTML estático no `puter.site` + `fetch` p/ a API |
| Normalização da imagem | **Pillow** (RGB/RGBA, ≤2048 px, WebP q90) | **Canvas no navegador**; o próprio Horde converte a fonte para WebP no upload (`upload_source_image_to_r2`) |
| Leitura de dimensões | Pillow no servidor (autoritativo) | navegador + validação de magic bytes/tamanho no worker (ou parser de header ~40 linhas) |
| Estado dos jobs | `store.py` em disco (efêmero no Free) | `me.puter.kv` (durável) |
| Imagens resultantes | disco do container (`RESULT_DIR`) | `me.puter.fs` (durável) |
| Cache de modelos | memória do processo (TTL 5 min) | KV com TTL |
| Vigia | thread interna + pulso da aba + cron | **rota `/api/tick`**, chamada por cron externo gratuito (bater no Puter não custa horas de ninguém) |
| Webhook do Horde | **perdido se a instância dormir** (3 s) | **sempre entregue** |
| Deploy | `render.yaml` + build pip | `puter worker deploy` ou GitHub Action |
| Banco/arquivos | opcional (Key Value/Postgres/R2) | já inclusos (KV + FS) |
| Cold start | 30–60 s | ~5 ms (isolate) |
| Custo mensal | US$ 0 (Free, com restrições) ou US$ 7 (Starter) | US$ 0 |

### 4.1 O que desaparece do plano

- §14.2 camada 2 (vigia interno em thread) e camada 3 (pulso do navegador) — não há mais o que manter acordado;
- §14.5 (a conta de horas de instância) e §14.7-C (pulso externo esparso para economizar franquia) — não há franquia;
- §14.7-D (caixa postal Cloudflare) — o próprio worker já é quente;
- §9.2 (Blueprint do Render) e a recomendação de plano Starter.

**Continua valendo:** §3 (payload do Horde), §4 (pré-preenchimento), §5 (campos da UI), §6 (contratos da
API — as rotas podem ser idênticas), §10 (kudos), §14.1 (prazos de 20 min / 30 min do Horde: esses são do
lado do Horde e ninguém os remove).

---

## 5. Riscos — e o que ainda não sei

### 5.1 Limites não documentados (risco principal)

Não encontrei limites públicos de requisições/dia, CPU por invocação ou tamanho de corpo para
Puter Workers. A plataforma roda sobre o runtime da Cloudflare (segundo a própria comparação deles),
onde o free são 100 mil req/dia e **10 ms de CPU** por invocação — número apertado para decodificar
base64 de 2 MB. **Isso precisa ser medido no spike, não presumido.**

Mitigação: manter o worker magro — responder rápido ao webhook (gravar só o payload pequeno no KV) e
deixar o trabalho pesado (baixar os bytes) para a rota `/tick`, que é chamada por cron e não tem pressão
de latência.

### 5.2 De quem é a cota (importante)

O marketing do Puter é "user-pays": **US$ 0 para o desenvolvedor porque cada usuário paga o próprio
armazenamento/IA com a conta Puter dele** ([pricing](https://developer.puter.com/pricing/)).
Isso exige que o usuário final **faça login no Puter** — péssimo para o nosso caso (e o webhook do Horde
não tem usuário nenhum).

No nosso desenho, o worker usa **`me.puter`** (identidade do dono) e a documentação é explícita:
*"Operations run against your account and are billed to you"*. Ou seja: **o armazenamento sai da sua conta
Puter, não é o almoço grátis do user-pays.** Para uso pessoal (dezenas de imagens/mês) fica dentro da
franquia gratuita da conta — mas a franquia não é pública, e é nela que mora o risco de custo.

### 5.3 Segredos

Não há cofre de segredos documentado para workers. A `HORDE_API_KEY` ficaria no próprio `worker.js`
(arquivo na sua conta Puter) ou em uma chave do KV — **ofuscação, não segredo de verdade**. Para uma
chave gratuita do Horde o impacto é pequeno, mas é preciso saber disso. Se a UI for pública (é),
qualquer "token" que ela carregue também é público.

### 5.4 Plataforma

- Puter é mais novo que Cloudflare/Render: observabilidade menos madura (a própria comparação deles admite).
- Deploy propaga em 5–30 s e o worker é atualizado sobrescrevendo o arquivo — sem versionamento/rollback
  nativo (dá para contornar com o GitHub Action e tags no Git).
- Dependência total de um único fornecedor para API + armazenamento.
- **Mitigação de lock-in:** Puter é AGPL-3.0 e self-hostável. E, como o código do worker é
  `Request`/`Response` + `fetch` padrão, ~80% dele roda em Cloudflare Workers, Deno Deploy ou
  Val.town sem reescrita. O trecho específico do Puter (`me.puter.kv/fs`) fica isolado em um módulo
  `store.js`, e é só isso que se troca ao mudar de plataforma.

### 5.5 Sem agendamento nativo

O "despertador" do vigia continua vindo de fora (cron-job.org 1 min · GitHub Actions 5 min ·
GCP Cloud Scheduler). A diferença é que agora ele bate **no Puter**, e não no Render — então não consome
franquia nenhuma. É aceitável, mas é uma dependência externa a mais.

---

## 6. Esforço de portabilidade

**Quase zero agora, e é por isso que vale decidir já:** a v1 não foi escrita. Não é "reescrever", é
"escolher o alvo". O que realmente muda de linguagem:

| Módulo do PLANO.md | Em JS |
|---|---|
| `payload.py` (montagem e validação do payload do Horde) | ~150 linhas, direto |
| `horde_client.py` | `puter.net.fetch()` / `fetch()` + headers |
| `imaging.py` (Pillow) | **sai do servidor** — Canvas no navegador; o Horde converte para WebP no upload |
| `store.py` | `me.puter.kv` + `me.puter.fs` |
| `watcher.py` | rota `/api/tick` |
| `templates/index.html` + `static/app.js` | HTML estático no `puter.site` |
| `tests/` (pytest) | `node --test` (ou Vitest) |
| `render.yaml` | GitHub Action `HeyPuter/puter-worker-deploy-action` |

O único pedaço com real incógnita técnica é a **validação autoritativa da imagem no servidor** (hoje Pillow):
sem ele, confiamos nas dimensões enviadas pelo navegador. Mitigação aceitável: validar magic bytes e
tamanho no worker, conferir múltiplo de 64, e lembrar que o Horde revalida e converte a imagem de qualquer
forma.

---

## 7. Spike de validação (go/no-go)

### 7.0 O que já foi validado (spike local, 18/18)

`node spike/run-local.mjs` executa o **worker de verdade** contra um mock do Horde que reproduz o
`_deliver_webhook()` real (`timeout=3`, 3 tentativas). Não depende de internet nem de conta Puter.

| Verificação | Resultado | Medição |
|---|---|---|
| submit → webhook → captura | ✅ | **2,8 s** no total; webhook respondido em **7 ms** |
| webhook perdido (receiver de 5 s) | ✅ | Horde desiste após 3 × 3 s; job fica `pending` |
| `/tick` como rede de segurança | ✅ | captura em **2 ms** |
| pedido expirado no Horde | ✅ | estado `expired` + mensagem, sem erro genérico |
| payload (snap-64, ` ### `, `img2img`, `denoising`) | ✅ | conforme §3 do PLANO.md |
| storage (gravar e servir a imagem) | ✅ | 10.381 bytes gravados e devolvidos |
| 50 requisições seguidas | ✅ | p50 = 1 ms · p95 = 2 ms |

Dois bugs reais foram encontrados e corrigidos no processo — ambos clássicos de "ler, modificar,
gravar" concorrente: (1) o handler do webhook sobrescrevia o job com um objeto lido **antes** da
captura; (2) `captureGenerations` relia o job dentro do loop e perdia as gerações anteriores
(quebraria `n > 1`). Sem o spike eles teriam ido para produção.

⚠️ As latências acima são **locais**: validam a lógica, não o Puter.

### 7.1 O que ainda falta medir (`node spike/run-real.mjs`)

O sandbox onde o plano foi escrito **não tem saída para `aihorde.net` nem para `api.puter.com`**
(proxy com allowlist: só pypi/npm/github passam). Por isso os testes de rede real ficaram para a
sua máquina — o script está pronto e leva ~20 min:

| # | Teste | Critério para "go" | Status |
|---|---|---|---|
| 1 | `puter.net.fetch()` para o Horde a partir do worker | funciona, < 2 s | ⏳ pendente (rede real) |
| 2 | `POST /v2/generate/async` real | 202 com `{id, kudos}` | ⏳ pendente |
| 3 | webhook real numa rota do worker | chega e responde em **< 3 s** | 🔶 lógica validada localmente (7 ms) |
| 4 | gravar 2 MB no `me.puter.fs` + 100 chaves KV | sem erro de limite | ⏳ pendente |
| 5 | 500 req em 10 min + `/tick` a cada 1 min por 1 h | sem 429/1102 | ⏳ pendente |
| 6 | UI em `*.puter.site` chamando o worker cross-origin | CORS automático | ⏳ pendente |
| 7 | 24 h de uso e consumo da conta | dentro da franquia | ⏳ pendente |

**Se 1, 3 e 5 passarem → recomendo ir de Puter.** Se 1 falhar (sem saída HTTP) ou 5 mostrar
limitação de cota, a decisão volta para Render + Puter apenas como caixa postal (§14.7-D do PLANO.md).

---

## 8. Comparação final

| | Render Free (plano atual) | Render Starter | **Puter Workers** |
|---|---|---|---|
| Custo | US$ 0 | ~US$ 7/mês | **US$ 0** |
| Spin-down / cold start | 15 min / 30–60 s | nenhum | **nenhum** |
| Franquia de horas | 750 h/mês | ilimitado | **não existe** |
| Webhook do Horde (3 s) | ⚠️ perdido se dormindo | ✅ | ✅ |
| Vigia a cada 1 min | ❌ consome a franquia inteira | ✅ (com worker pago) | ✅ **de graça** |
| Limites publicados | ✅ claros | ✅ claros | ❌ **não documentados** |
| Armazenamento durável | ❌ efêmero (disco é add-on pago) | add-on pago | ✅ **KV + FS inclusos** |
| Linguagem | Python (Pillow de graça) | Python | JavaScript (Canvas no cliente) |
| Lock-in | baixo (Docker/qualquer PaaS) | baixo | médio (mitigado: AGPL + código portável) |
| Complexidade do plano | alta (seção 14 inteira) | média | **baixa** |

---

## 9. Recomendação

1. **Fazer o spike da §7 antes de escrever a v1.** O custo de errar agora é zero; depois de implementado,
   é uma reescrita.
2. **Isolar a dependência**: todo acesso a estado passa por um `store.js` com a interface
   `registerJob / pendingJobs / markDone / saveResult / loadResult`. Assim, migrar Puter → Cloudflare
   Workers + R2 (ou Render + disco) é trocar um arquivo.
3. **Manter os contratos da API idênticos** (`/api/v1/*` da seção 6 do PLANO.md). A UI não muda se a
   gente trocar de backend, e o mesmo vale para quem consome o endpoint da imagem.
4. **Manter o Render como plano B documentado**: se o Puter surpreender (limites, custo, instabilidade),
   o PLANO.md atual continua válido e o `store.js` é o único ponto de atrito.

---

## 10. Referências

- [Serverless Workers (visão geral)](https://developer.puter.com/serverless-workers/)
- [Workers — docs](https://docs.puter.com/Workers/) · [router](https://docs.puter.com/Workers/router/) · [puter.workers.create()](https://docs.puter.com/Workers/create/)
- [puter.net.fetch()](https://docs.puter.com/Networking/fetch/) — fetch de saída, disponível em Workers
- [User-Pays model / pricing](https://developer.puter.com/pricing/)
- [Puter Worker Deploy Action (GitHub)](https://github.com/HeyPuter/puter-worker-deploy-action)
- Prazos e limites do Horde: ver **PLANO.md §14.1**
