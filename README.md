# Distributed Wagering Processor

API financeira para processar operações de wagering com PostgreSQL, ledger
append-only, idempotência persistente e mensageria SQS via LocalStack.

## Início rápido

Requer Bun 1.x e Docker Compose. Na raiz do repositório:

```bash
docker compose up -d db localstack
cd api
bun install
bun run db:migrate
```

Configure as filas locais e inicie a API:

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

## Comandos úteis

Na pasta `api`:

```bash
bun run build
bun run lint
bun run test
bun run test:integration
bun run test:e2e
bun run test:load
```

Os testes de integração e de carga usam serviços reais do Compose e criam
registros financeiros que não são apagados; use um banco local descartável
quando quiser limpar os dados. O teste de carga também grava seu relatório em
`api/load-test-results/`.

Para rotas, payloads, variáveis, migrations, mensageria e métricas, consulte
[`api/README.md`](api/README.md). Decisões de domínio, garantias e limitações
estão em [`api/ARCHITECTURE.md`](api/ARCHITECTURE.md).
