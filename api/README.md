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
por vez e usa `ProcessWager`. O `consumerName` e o `messageId` do envelope
formam a chave durável da inbox; o hash SHA-256 do body detecta reutilização do
ID com outro conteúdo. O ACK (DeleteMessage) acontece somente depois
que o use case confirma seu commit; erros de negócio terminais também registram
a inbox antes do ACK. Payloads inválidos são copiados à DLQ antes de remover a
mensagem original. Falhas técnicas não recebem ACK e ganham backoff de
visibilidade; a política SQS redrive encaminha mensagens após cinco entregas.
Durante o processamento, a visibilidade é renovada a cada 30 segundos. No
SIGTERM, a aplicação para de buscar mensagens e espera o processamento em curso
terminar antes de fechar o cliente SQS.

## Health checks e observabilidade

`GET /health/live` verifica se o processo HTTP está ativo. `GET /health/ready`
retorna HTTP 200 somente quando PostgreSQL responde a `SELECT 1` e as filas FIFO
de transações, DLQ e eventos estão acessíveis; falhas retornam HTTP 503 com o
resultado individual dos probes. As URLs das três filas precisam estar
configuradas para a API ser considerada pronta.

`GET /health/metrics` expõe métricas Prometheus por processo, incluindo os
resultados das apostas, replays idempotentes e duplicatas da inbox, retries por
componente, mensagens enviadas à DLQ e atualmente visíveis na DLQ, conflitos
PostgreSQL de deadlock/lock/serialização, quantidade e idade da outbox pendente,
além da duração do processamento financeiro, consumo SQS e publicação da
outbox. Um scraper deve coletar cada instância; os contadores em memória zeram
quando o processo reinicia.

Autenticação está fora do escopo do desafio. As rotas de wallets e wagering
passam pelo `AuthGuard` no-op em `src/modules/identity`, que atualmente permite
todas as chamadas e marca onde conectar um IdP OIDC externo no futuro. As rotas
de health permanecem abertas. Consulte `ARCHITECTURE.md` para a decisão e o
desenho futuro.

Os logs de processamento financeiro, consumer, publisher, worker de referências
e reconciliação são JSON estruturado. Compartilham timestamp, nível, componente,
evento, correlation/causation IDs, transação, wallet, provedor, ID externo,
status, código de erro e duração; campos sem valor são emitidos como `null`.

O `PendingReferenceWorker` também inicia com a API e verifica o PostgreSQL a
cada segundo. Pendências recebem primeira tentativa após 1 segundo, expiram em
15 minutos e têm até 8 tentativas, com backoff exponencial limitado a 60
segundos. Ele reivindica lotes de até 10 linhas por lease e usa
`FOR UPDATE SKIP LOCKED`, permitindo mais de uma instância sem reivindicar a
mesma linha ao mesmo tempo. Quando a referência aparece, o worker chama as
mesmas regras financeiras de `ProcessWager`; saldo, ledger, estado terminal e
eventos da outbox são persistidos na mesma transação. Referências que continuam
ausentes ao esgotar o limite são rejeitadas com `REFERENCE_NOT_FOUND`. No
encerramento, o worker para novas consultas e aguarda o lote já reivindicado;
se ocorrer uma falha técnica, o lease expira em 60 segundos para permitir nova
tentativa por outra instância.

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
`db:migration:check` pode sugerir remover constraints, FKs e o trigger que só
existem no SQL das migrations. Revise o diff; não o aplique automaticamente.

## Validar concorrência de apostas

Os testes de integração usam PostgreSQL e LocalStack reais. Com os serviços
locais iniciados e na pasta `api`, execute:

```bash
bun run test:integration
```

As suites verificam, entre outros cenários: duas apostas de R$ 80 simultâneas
contra saldo de R$ 100; o mesmo wager enviado 50 vezes; wallets diferentes em
paralelo; três instâncias Nest concorrentes; replay e conflito idempotente;
referências ausentes, expiração, recuperação e reversões antes da BET;
deduplicação de inbox, retry transitório do consumer, DLQ de contrato inválido,
publishers concorrentes, recuperação após restart simulado, shutdown e
consistência sistemática entre wallet e ledger. As três instâncias e o restart
são simulados dentro do mesmo processo de teste, não como processos de SO
separados. Como o ledger é append-only, os dados criados permanecem no banco;
use uma base local descartável para essa validação.

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

## Wallets, consultas e reconciliação

Crie uma wallet enviando `playerId` e `initialBalance`:

```http
POST /wallets
Content-Type: application/json
```

```json
{
  "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  "initialBalance": { "amount": "1000.00", "currency": "BRL" }
}
```

Quando o saldo inicial é maior que zero, a API grava wallet, transação interna
`OPENING`, crédito no ledger e os eventos da outbox na mesma transação SQL. Para
saldo inicial zero, cria apenas a wallet. Outra wallet para o mesmo jogador e
moeda retorna `409 WALLET_ALREADY_EXISTS`.

Rotas de leitura disponíveis:

- `GET /wallets/:walletId`
- `GET /wallets/:walletId/ledger?cursor=<cursor>&limit=50`
- `GET /wagering/transactions/:transactionId`
- `GET /providers/:providerId/wagering/transactions/:externalTransactionId`

A listagem do ledger ordena por `createdAt` e ID e retorna `items`, `hasMore` e
`nextCursor`. O cursor é opaco; use o valor retornado na próxima chamada. O
limite padrão é 50 e o máximo é 100.

`POST /wallets/:walletId/reconciliation` reconstrói o saldo pela sequência do
ledger e compara com o saldo materializado. A resposta inclui os dois saldos,
diferença, `consistent` e quantidade de lançamentos verificados. Divergências
são sinalizadas na resposta e em log estruturado; o endpoint não ajusta saldo ou
ledger automaticamente. Cada divergência também incrementa
`wallet_reconciliation_mismatches_total`.
