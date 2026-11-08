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
lançamento de débito. A mesma suíte também envia requisições pela rota HTTP para
confirmar replay idempotente e conflito quando a chave é reutilizada com outro
payload. Como o ledger é append-only, os registros criados pelo teste permanecem
no banco; use um banco local descartável para essa validação.

## Endpoint de aposta

Com a API iniciada e uma wallet existente, envie uma aposta `BET`:

```http
POST /wagering/transactions
Idempotency-Key: provider-a:transaction-123
Content-Type: application/json
```

```json
{
  "providerId": "provider-a",
  "externalTransactionId": "transaction-123",
  "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  "walletId": "0192f291-27dd-7d3f-8071-5f8685deef37",
  "roundId": "round-987",
  "gameId": "fortune-chimp",
  "kind": "BET",
  "money": { "amount": "25.00", "currency": "BRL" }
}
```

O endpoint aceita `BET`, `WIN`, `LOSS`, `REFUND` e `ROLLBACK` (`OPENING` é
interno). `WIN` e `LOSS` podem receber `referenceExternalTransactionId`; `REFUND`
e `ROLLBACK` precisam dele. Resultados processados ou rejeitados retornam `200`;
uma operação aguardando a referência retorna `202` com `PENDING_REFERENCE`.
Rejeições de negócio, como saldo insuficiente ou reversão duplicada, aparecem no
corpo como `status: REJECTED` e trazem um `failureCode`. A chave de idempotência
é obrigatória no header.
