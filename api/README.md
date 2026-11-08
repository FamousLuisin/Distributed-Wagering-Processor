# API

## Banco local e migrations

O projeto usa PostgreSQL pelo Docker Compose e MikroORM. Na raiz do repositório,
suba o banco:

```bash
docker compose up -d db
```

Na pasta `api`, instale as dependências e aplique as migrations versionadas:

```bash
bun install
bun run db:migrate
```

Em seguida, inicie a API:

```bash
bun run start:dev
```

Por padrão, a API conecta em `localhost:5432`, banco `wageringDatabase`, usuário
`user` e senha `password`, conforme o `compose.yml`. Para outro ambiente, use
`DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER` e `DB_PASSWORD`.

Comandos de manutenção:

```bash
bun run db:migrate:down     # reverte a última migration
bun run db:migration:create # gera uma migration candidata a partir dos EntitySchemas
bun run db:migration:check  # confere se ainda há migrations pendentes
```

As migrations são executadas em transação. As migrations contêm constraints e o
trigger append-only do ledger que não são expressos apenas pelos EntitySchemas;
revise e preserve essas garantias ao criar migrations futuras.
Não use `schema:update` em ambientes compartilhados: alterações de schema devem
entrar em uma migration revisável.

## Validar concorrência de apostas

O caso crítico usa PostgreSQL real para conferir o lock da wallet. Com o banco
local iniciado e na pasta `api`, execute:

```bash
bun run test:integration
```

O teste aplica migrations pendentes e dispara, ao mesmo tempo, duas apostas de
R$ 80 em uma wallet com R$ 100. Ele verifica que uma fica `PROCESSED`, a outra
`REJECTED` por saldo insuficiente, o saldo termina em R$ 20 e existe apenas um
lançamento de débito. Como o ledger é append-only, os registros criados pelo
teste permanecem no banco; use um banco local descartável para essa validação.
