# API

## Banco local e migrations

O projeto usa PostgreSQL pelo Docker Compose e MikroORM. Na raiz do repositório,
suba o banco:

```bash
docker compose up -d db localstack
```

Na pasta `api`, instale as dependências e aplique as migrations versionadas:

```bash
bun install
bun run db:migrate
```

Por padrão, a API conecta em `localhost:5432`, banco `wageringDatabase`, usuário
`user` e senha `password`, conforme o `compose.yml`. Para outro ambiente, use
`DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER` e `DB_PASSWORD`.

O LocalStack cria as filas FIFO `wager-transactions.fifo`,
`wager-transactions-dlq.fifo` e `wager-events.fifo`. O publisher da outbox roda
junto com a API. Para habilitar o envio local, configure o endpoint e a URL da
fila de eventos antes de iniciar a aplicação:

```bash
export SQS_ENDPOINT=http://localhost:4566
export SQS_EVENTS_QUEUE_URL=http://localhost:4566/000000000000/wager-events.fifo
export SQS_TRANSACTIONS_QUEUE_URL=http://localhost:4566/000000000000/wager-transactions.fifo
export SQS_TRANSACTIONS_DLQ_QUEUE_URL=http://localhost:4566/000000000000/wager-transactions-dlq.fifo
export AWS_REGION=us-east-1
export AWS_ACCESS_KEY_ID=test
export AWS_SECRET_ACCESS_KEY=test
bun run start:dev
```

Sem `SQS_EVENTS_QUEUE_URL`, o publisher fica desabilitado e eventos permanecem
na outbox. O publisher reivindica mensagens com `FOR UPDATE SKIP LOCKED` e lease
de 60 segundos, envia fora da transação SQL e marca como publicada somente após
sucesso do SQS. Falhas são reagendadas com backoff exponencial de 1 segundo até
5 minutos, sem descartar eventos. Se o SQS aceitar a mensagem e o processo cair
antes de marcar a outbox, a mensagem pode ser enviada novamente depois que o
lease expirar; consumidores devem deduplicar pelo `eventId`.

Com `SQS_TRANSACTIONS_QUEUE_URL`, o consumer faz long polling de uma mensagem
por vez e usa `ProcessWager`. O `messageId` do envelope e o hash SHA-256 do body
formam a chave durável da inbox. O ACK (DeleteMessage) acontece somente depois
que o use case confirma seu commit; erros de negócio terminais também registram
a inbox antes do ACK. Payloads inválidos são copiados à DLQ antes de remover a
mensagem original. Falhas técnicas não recebem ACK e ganham backoff de
visibilidade; a política SQS redrive encaminha mensagens após cinco entregas.
Durante o processamento, a visibilidade é renovada a cada 30 segundos. No
SIGTERM, a aplicação para de buscar mensagens e espera o processamento em curso
terminar antes de fechar o cliente SQS.

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
