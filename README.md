# Berlin

Editor de imagens por prompt usando a API do [AI Horde](https://aihorde.net), pensado para rodar como
Web Service no [Render](https://render.com).

Stack: Python 3.11 + Flask + gunicorn, front-end em HTML/CSS/JavaScript puro (sem build step) e
nenhum banco de dados na v1 (o servidor é stateless; o `job_id` do AI Horde é a fonte da verdade).

O plano completo — arquitetura, especificação de todos os parâmetros da API, mapeamento dos campos da
UI, pré-preenchimento a partir da imagem original, contratos da API REST do app, estrutura de
arquivos, `render.yaml` e critérios de aceite — está em **[PLANO.md](PLANO.md)**.
