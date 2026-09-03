# Spike — Berlin em Puter Workers

Dois scripts, dois propósitos. **Nenhuma dependência externa** (só Node 18+).

## 1. `node spike/run-local.mjs` — roda em qualquer lugar, inclusive offline

Executa o **worker de verdade** (`src/worker.js`) contra um mock fiel do AI Horde,
que reproduz o comportamento que importa:

- `POST /v2/generate/async` → `202 {id, kudos}`;
- entrega de webhook idêntica à do Horde real: `requests.post(..., timeout=3)` com **3 tentativas**
  (é o `_deliver_webhook()` deles);
- `GET /v2/generate/check/:id` e `/status/:id`, com expiração (404 depois do prazo).

Cobre 4 cenários: caminho feliz (webhook), webhook perdido por "cold start" → vigia salva,
pedido expirado, e a montagem do payload (snap-64, ` ### `, headers, storage).

```
=== 18/18 verificações passaram ===
```

Resultados medidos (localhost, sem rede):

| Verificação | Medição |
|---|---|
| submit → webhook → captura | **2,8 s** no total; webhook respondido em **7–8 ms** |
| webhook com receiver de 5 s | Horde desiste após 3×3 s; job fica `pending` |
| `/api/tick` como rede de segurança | captura em **2 ms** |
| pedido expirado | estado `expired` + mensagem, sem erro genérico |
| armazenamento | imagem gravada e servida de volta (10.381 bytes) |
| overhead por requisição | p50 = 1 ms, p95 = 2 ms |

> Atenção: os números de latência são **locais**. Eles validam a lógica, não o Puter.

## 2. `node spike/run-real.mjs` — roda na sua máquina (precisa de internet)

É o go/no-go da [seção 7 de `docs/alternativa-puter.md`](../docs/alternativa-puter.md).

```bash
# 2.1 Só o Horde (valida latência real, fila, kudos, expiração)
HORDE_API_KEY=sua-chave node spike/run-real.mjs

# 2.2 Medir quanto tempo o resultado sobrevive antes de expirar (~20 min)
node spike/run-real.mjs --watch-expiry

# 2.3 Com o worker já publicado no Puter
node spike/run-real.mjs \
  --worker https://berlin-api.puter.work \
  --webhook https://berlin-api.puter.work/api/hooks/horde
```

O que ele reporta: latência do `models`, submit real (img2img 512×512), posição na fila e
espera estimada, tempo até concluir, se a imagem vem como base64 ou URL, entrega do webhook,
bytes servidos de volta, p50/p95 de 50 requisições e (com `--watch-expiry`) a janela real de
expiração do resultado.

## Publicar o worker no Puter

```bash
npm i -g @heyputer/cli      # CLI em beta
puter auth login            # precisa de conta com e-mail verificado
puter worker deploy spike/src/worker.js berlin-api
# -> https://berlin-api.puter.work
```

Ou pelo GitHub Action [`HeyPuter/puter-worker-deploy-action`](https://github.com/HeyPuter/puter-worker-deploy-action),
com o `PUTER_TOKEN` como secret.

Depois de publicar, defina os "env vars" do worker editando as constantes em `CONFIG`
(no topo de `src/worker.js`): `HORDE_API_KEY`, `WEBHOOK_BASE_URL`, `DEFAULT_MODEL`.
Não há cofre de segredos documentado — veja o risco 5.3 em `docs/alternativa-puter.md`.

## Estrutura

```
spike/
├─ src/worker.js        # o worker real (arquivo único: é o que o Puter publica)
├─ harness/harness.mjs  # PNG mínimo, backend de arquivos, router estilo Puter, mock do Horde
├─ run-local.mjs        # spike local (18 verificações)
└─ run-real.mjs         # spike real (go/no-go)
```

`src/worker.js` já é o esqueleto da v1: `POST /api/edits`, `GET /api/edits/:id`,
`GET /api/edits/:id/image`, `POST /api/hooks/horde`, `POST /api/tick`, `GET /api/models`.
O storage é abstraído (KV + FS): com `me.puter` usa o Puter; sem ele, usa arquivos locais.
Trocar de plataforma = trocar esse backend.
