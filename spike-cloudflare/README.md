# Spike: Berlin no Cloudflare Workers

Validação local da arquitetura proposta em [../docs/alternativa-cloudflare-workers.md](../docs/alternativa-cloudflare-workers.md).
Roda **sem conta Cloudflare, sem cartão e sem sair da máquina**: o `wrangler dev` sobe o
`workerd` de verdade (com D1 e KV locais) e um mock do Horde em Node.

## Como rodar

```bash
cd spike-cloudflare
npm install          # única dependência: wrangler (dev)
node run-local.mjs   # ~30 s
```

Saída esperada: **18 passaram, 0 falharam**.

## O que tem aqui

```
wrangler.jsonc          # D1 + 2 KV + Cron Trigger + static assets
schema.sql              # tabela jobs + índice (state, next_poll_at)
src/
  index.js              # export default { fetch, scheduled }
  router.js             # rotas HTTP
  payload.js            # monta o payload e o corpo SEM parsear o base64
  horde.js              # submit / check / status / models
  capture.js            # captura das gerações (webhook e tick usam a mesma)
  tick.js               # o vigia (Cron Trigger e POST /api/tick)
  store.js              # jobs no D1
  images.js             # putImage/getImage — isola KV (v1) de R2 (v1.1)
  metadata.js           # prefill: cabeçalho PNG/JPEG/WebP + tEXt do A1111
public/index.html       # frontend servido pelo mesmo Worker
harness/horde-mock.mjs  # Horde falso com r2:true e webhook de 3×3 s
run-local.mjs           # a suíte
```

## O que foi provado

| Área | Resultado |
| --- | --- |
| Caminho feliz | submissão → webhook → `done` em **1.288 ms**; webhook respondido em **45 ms** (limite do Horde: 3.000 ms) |
| Perda do webhook | Horde desiste após 3×3 s; o job fica `pending` — nada se perde |
| **Cron Trigger** | `/cdn-cgi/handler/scheduled` recupera o resultado sozinho |
| Expiração | estado `expired` + mensagem, em vez de erro genérico |
| `n > 1` | `partial` → `done` com as 2 imagens |
| Prefill sem Pillow | 500×333 → 512×320; alfa → `inpainting`; `tEXt` do A1111 devolve prompt, steps, sampler, CFG e seed |
| Limpeza | `tick()` apaga jobs fora do TTL e as imagens |
| Imagem grande | submissão de 3,7 MB em 79 ms de parede |
| **CPU (o risco nº 1)** | `request.json()` de 5 MB = **16,0 ms** ❌ (o limite do Free é 10 ms) vs `new Blob([...])` = **1,9 ms** ✅ |

O último item é o que decide o desenho: com `r2: false`, uma única chamada de webhook estouraria o
orçamento de CPU do plano Free e o Worker devolveria `Error 1102`. Com `r2: true`, o mesmo trabalho
cabe folgado. Não é micro-otimização — é a diferença entre funcionar e não funcionar.

## Dois bugs que o spike pegou (e que iriam para produção)

1. **O base64 ia sem aspas.** O placeholder do `source_image` fica *entre* as aspas do JSON; substituir
   `"__SOURCE_IMAGE__"` (com as aspas) removia as duas e gerava um corpo inválido. Correção:
   substituir só o token, preservando as aspas.
2. **`capture()` relia o job dentro do laço** e perdia gerações quando `n > 1`. Correção: ler uma vez
   fora do laço e acumular.

## Para levar para produção

1. `npm i -g wrangler` e `wrangler login` (conta Cloudflare gratuita).
2. Criar os recursos: `wrangler d1 create berlin`, `wrangler kv:namespace create IMAGES`,
   `wrangler kv:namespace create CACHE` — e copiar os ids para o `wrangler.jsonc`.
3. `wrangler d1 execute berlin --file=schema.sql --remote`.
4. **Remover o `HORDE_BASE_URL` do `vars`** (o código já assume `https://aihorde.net/api`) e guardar a
   chave como segredo: `wrangler secret put HORDE_API_KEY`.
5. `wrangler deploy` → `https://berlin.<sub>.workers.dev`, que já é HTTPS (pré-requisito do webhook).
6. Conferir o cron: `wrangler triggers list`.

Lembrando: `dry_run: true` custa 0 kudos e valida o payload sem gerar nada.
