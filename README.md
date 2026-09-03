# Berlin

Edição de imagem por prompt usando a API do [AI Horde](https://aihorde.net), rodando inteiramente no
**Cloudflare Workers** (plano gratuito, sem cartão de crédito).

O plano completo está em **[PLANO.md](PLANO.md)**. Este arquivo é só o começo rápido.

## Como é

- Upload da imagem + **todos** os parâmetros da API do Horde na tela;
- o formulário é **pré-preenchido pelos dados da própria imagem** (dimensões, canal alfa e os
  metadados de geração, quando existirem);
- preview lado a lado com a original antes de baixar;
- acompanhamento da fila (posição e espera estimada);
- se você fechar a aba, o servidor **continua vigiando** o job e guarda o resultado — nada se perde.

## Rodando local (sem conta Cloudflare)

```bash
npm install
npm run dev          # http://localhost:8787
```

Testes (workerd real, D1 e KV locais, mock do Horde — não sai da máquina):

```bash
npm test             # 25 checagens
```

## Deploy

O "blueprint" da instalação é o **`npm run setup`**: um comando que faz, na ordem certa e de
forma idempotente (pode rodar de novo sem duplicar recursos), tudo o que antes era manual:

```bash
npm install
npm run setup
```

O que ele faz:

1. autentica na Cloudflare (abre o navegador — ou use `CLOUDFLARE_API_TOKEN=… npm run setup` para CI);
2. cria o banco D1 `berlin` e os namespaces KV `IMAGES` e `CACHE`;
3. grava os ids em `wrangler.jsonc` (substituindo os placeholders);
4. aplica `schema.sql` no D1 remoto;
5. pergunta se quer gravar a `HORDE_API_KEY` como segredo (opcional — anônimo funciona;
   ou passe `HORDE_API_KEY=… npm run setup`);
6. faz `wrangler deploy` e confirma o `GET /api/health`.

O Cron Trigger (`* * * * *`) já está declarado em `wrangler.jsonc` e é aplicado no deploy — é o
equivalente nativo do que, no Render, exigiria um serviço extra. No fim, a URL é
`https://berlin.<sub>.workers.dev` (HTTPS de fábrica, pré-requisito do webhook do Horde).

> **Por que não existe um `render.yaml` aqui:** o Cloudflare não tem um arquivo único de blueprint
> que provisione Worker + D1 + KV + Cron. O `scripts/setup.mjs` faz esse papel. Os passos manuais
> equivalentes (para quem prefere na mão) estão no §9 do [PLANO.md](PLANO.md).

```bash
npx wrangler login                       # conta Cloudflare gratuita

npx wrangler d1 create berlin            # → database_id
npx wrangler kv:namespace create IMAGES  # → id
npx wrangler kv:namespace create CACHE   # → id
# cole os três ids em wrangler.jsonc

npx wrangler d1 execute berlin --remote --file=schema.sql
npx wrangler secret put HORDE_API_KEY
npm run deploy
```

## API

```bash
# submeter (o base64 é o da imagem de entrada, sem prefixo data:)
curl -X POST https://berlin.<sub>.workers.dev/api/edits \
  -F 'params={"prompt":"um gato ### borrado","params":{"steps":25,"width":512,"height":512,"denoising_strength":0.55}}' \
  -F 'image_b64=@source.b64'

curl https://berlin.<sub>.workers.dev/api/edits/<id>          # estado + posição na fila
curl https://berlin.<sub>.workers.dev/api/edits/<id>/image -o resultado.png
```

Rotas completas na seção 4 do [PLANO.md](PLANO.md). `dry_run: true` em `params` devolve o custo em
kudos sem gerar nada.

## Notas

- `r2: true` é obrigatório: com `false`, o webhook do Horde traria a imagem em base64 e o parse
  estouraria o limite de 10 ms de CPU do plano Free.
- As imagens ficam em KV por 24 h. Para guardar mais, troque `src/images.js` por R2 (o R2 pede
  "checkout flow", ou seja, forma de pagamento na conta).
