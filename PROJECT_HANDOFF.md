# Project Handoff — Distributed Wagering Processor

Estado conferido no repositório em 09/11/2026. Este documento descreve o código
observado nessa data. Se houver divergência, o código e as migrations são a
fonte da verdade; comportamento ainda não validado em execução está identificado
como limitação.

## Objetivo e stack

API para processar operações financeiras de wagering com saldo, transações,
ledger, idempotência e mensageria durável. O desafio permite deixar autenticação
fora do escopo, desde que a decisão e o ponto de extensão estejam documentados.

- TypeScript strict, ESM/NodeNext, NestJS 12 e Express.
- MikroORM 7 e PostgreSQL 17.
- AWS SDK SQS v3; LocalStack SQS para desenvolvimento local.
- Bun, Vitest, Oxlint e Prettier.
- Docker Compose sobe PostgreSQL e LocalStack. `infra/localstack/init-queues.sh`
  cria três filas FIFO.

## Estado implementado

### Fluxo financeiro

`POST /wagering/transactions` chama `ProcessWager`. O caso de uso usa
`EntityManager.transactional()`, lock pessimista da wallet e constraints do
PostgreSQL para serializar alterações na mesma wallet e preservar unicidade.
Wallet, transação, ledger, inbox (quando a entrada vem da fila) e eventos de
outbox são gravados dentro da transação SQL aplicável.

Valores usam `Money` com decimal em string e `numeric(20,2)` no banco. A wallet
tem saldo materializado; o ledger é append-only e registra saldo anterior e
posterior. `OPENING` é uma transação interna usada para creditar saldo inicial
positivo ao criar wallet.

Tipos externos: `BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`. `BET` debita;
`WIN` credita; `LOSS` não altera saldo nem cria ledger. `REFUND` credita uma BET
processada referenciada. `ROLLBACK` inverte a direção de BET, WIN ou REFUND
processado que referencia. Referências precisam respeitar provedor, jogador,
wallet, moeda, rodada, tipo e estado permitidos. Uma referência ausente deixa
REFUND/ROLLBACK em `PENDING_REFERENCE`.

`Idempotency-Key` é única globalmente. O payload de negócio é normalizado e
hashado com SHA-256, sem incluir a chave de idempotência. Mesmo chave e mesmo
payload devolvem o snapshot persistido; mesmo chave com payload diferente
conflita. O lock é por wallet, então wallets distintas podem processar em
paralelo.

### Inbox, outbox e SQS

- `InboxMessageEntity`: chave composta `(consumer_name, message_id)` e hash do
  corpo. Redelivery de mensagem já processada recebe ACK sem repetir efeitos.
- `OutboxMessageEntity`: evento JSONB persistido junto com a alteração
  financeira. O publisher só chama SQS depois do commit SQL.
- Eventos versionados: `WagerTransactionProcessed`,
  `WagerTransactionRejected`, `WagerTransactionPendingReference` e
  `WalletBalanceChanged`. A abertura de wallet positiva também emite eventos.
- Publisher: polling de 1 s, lotes de até 10, claim com `FOR UPDATE SKIP LOCKED`,
  lease de 60 s, publicação concorrente e confirmação condicional pelo token do
  lease. Retry exponencial começa em 1 s e limita o intervalo a 5 min. Não há
  limite de tentativas nem descarte automático: falhas permanecem na outbox.
- O envio FIFO usa `aggregateId` como `MessageGroupId` e `eventId` como
  `MessageDeduplicationId`. Uma queda após aceite pelo SQS, mas antes de marcar
  `published_at`, pode duplicar publicação. A garantia é at-least-once.
- Consumer: lê uma mensagem por vez com long polling de até 20 s; valida o
  envelope, chama o mesmo `ProcessWager` do HTTP e só apaga a mensagem após o
  commit. Visibilidade é 60 s, renovada a cada 30 s. Retry técnico ajusta a
  visibilidade com backoff exponencial limitado a 60 s.
- Mensagem de contrato inválido ou conflito de inbox é copiada para a DLQ antes
  do ACK da original. Falhas técnicas ficam na fila; a redrive policy local
  encaminha para DLQ após cinco entregas. Erros de negócio terminais gravam a
  inbox antes do ACK.
- No encerramento, consumer aguarda a operação atual; o publisher espera o loop
  e as publicações do lote. O worker de referências termina o lote reivindicado.

### Referências pendentes

`PendingReferenceWorker` consulta o banco a cada segundo, reivindica até 10
linhas com `SKIP LOCKED` e lease de 60 s, e reusa as regras de `ProcessWager`.
As pendências vencem em 15 minutos ou após oito tentativas. A primeira tentativa
fica devida após 1 s; os intervalos seguintes crescem exponencialmente e são
limitados a 60 s. Se a referência não aparecer, a operação termina rejeitada
com `REFERENCE_NOT_FOUND`. Saldo, ledger, estado e outbox são atualizados na
transação de recuperação.

### API financeira e consultas

- `POST /wallets`: cria wallet; para saldo inicial positivo, grava wallet,
  `OPENING`, crédito de ledger e outbox na mesma transação.
- `GET /wallets/:walletId` e `GET /wallets/:walletId/ledger`: leitura do saldo
  e ledger paginado por cursor opaco estável (`createdAt`, ID).
- `POST /wallets/:walletId/reconciliation`: recalcula e compara saldo e cadeia
  do ledger, devolve divergência, registra log e métrica; não corrige dados.
- `POST /wagering/transactions`: processa operações externas.
- `GET /wagering/transactions/:transactionId` e
  `GET /providers/:providerId/wagering/transactions/:externalTransactionId`:
  consultam transação.
- Health: `/health/live`, `/health/ready`, `/health/metrics`.

### Autenticação

`api/src/modules/identity/AuthGuard` é aplicado às rotas financeiras, mas é
intencionalmente no-op: todas as chamadas HTTP são permitidas. Health permanece
aberto. Não há autenticação real nem tabela local de senhas. A evolução
documentada é integrar um IdP OIDC externo e vincular principal/claim ao
`providerId`. A fila é tratada como canal interno confiável, mas as mensagens
continuam sujeitas às validações de domínio.

## Persistência e migrations

Migrations em `api/src/database/migrations`:

1. `Migration20261107000000`: wallets, transações, ledger, FKs, constraints,
   índices e trigger append-only.
2. `Migration20261108000000`: snapshot `resulting_balance` para replay.
3. `Migration20261109000000`: inbox e outbox, constraints e índices de claim.
4. `Migration20261110000000`: agenda, limite, expiração e lease de referências
   pendentes.

Migrations são transacionais. Alguns invariantes SQL, especialmente FKs,
constraints e trigger append-only, não são representados integralmente pelos
`EntitySchema`; `db:migration:check` já foi observado propondo remoções dessas
garantias. Não aplicar esse diff automaticamente. Criar e revisar migrations
manualmente e preservar o trigger financeiro.

## Observabilidade

`GET /health/ready` testa PostgreSQL (`SELECT 1`) e acessibilidade das URLs
configuradas para fila de entrada, DLQ e eventos; probe tem timeout de 3 s.
Sem qualquer URL, retorna `503`. Logs JSON compartilham timestamp, nível,
componente, evento, IDs de correlação/mensagem/transação/wallet/provedor, status,
código de erro e duração; não devem registrar payload financeiro completo.

`GET /health/metrics` expõe Prometheus. Há métricas de status de transação,
duplicatas, retries, mensagens na DLQ, conflitos SQL de lock/deadlock,
quantidade/idade da outbox, latência de processamento, consumer e publisher, e
divergências de reconciliação. A implementação é em memória e por processo:
contadores zeram no restart; cada instância precisa ser coletada. O gauge de
DLQ é aproximado pelo atributo do SQS.

## Testes e estado da validação

Existem testes unitários dos domínios e integrações com PostgreSQL/LocalStack.
Os cenários de integração cobrem duas apostas concorrentes, replay e conflito
idempotente, recuperação/rejeição de referência, lease abandonado, 50 submits
iguais concorrentes, wallets distintas, três aplicações Nest independentes,
REFUND/ROLLBACK antes da referência, inbox/DLQ, retry transitório do consumer,
publishers concorrentes, restart simulado e shutdown. Depois de cada cenário,
saldo é comparado com ledger.

Última validação registrada: `bun run test:integration` passou com 16 testes em
09/11/2026 antes das mudanças posteriores de observabilidade e AuthGuard. Depois
dessas mudanças, `bun run build` e `bun run lint` passaram; lint ainda aponta um
aviso existente de `unbound-method` no teste de shutdown do worker. Os testes
não simulam três processos do sistema operacional: são três instâncias Nest no
mesmo processo. O crash/restart também é simulado fechando e recriando Nest.

## Limitações conhecidas / validações pendentes

- AuthGuard ainda permite qualquer chamada; é um ponto de extensão, não uma
  proteção ativa.
- Métricas são efêmeras e não há Prometheus server, scrape config, dashboard ou
  OpenTelemetry no Compose.
- A política de DLQ para falha técnica depende de redrive SQS; o teste de
  integração cobre envio explícito de mensagem inválida à DLQ, mas não valida
  uma falha técnica repetida até cinco entregas.
- Não foi injetada falha transitória específica do publisher para validar
  backoff e incremento da tentativa; publishers concorrentes e publicação foram
  exercitados.
- As três aplicações concorrentes e o restart são testes de instâncias Nest,
  não processos separados nem encerramento forçado do SO.
- Outbox não tem máximo de tentativas nem DLQ própria; evento problemático pode
  permanecer pendente e elevar o lag até intervenção operacional.
- Publisher envia mensagens da mesma batch com concorrência. SQS FIFO ordena pela
  aceitação dentro do `MessageGroupId`, mas a ordem de aceite entre chamadas
  concorrentes para o mesmo agregado não é garantida pelo código.
- Dados gerados em integração permanecem no PostgreSQL local; ledger é
  append-only. Preferir banco descartável para novos experimentos.

## Setup e comandos

Na raiz: `docker compose up -d db localstack`. O script LocalStack cria
`wager-transactions.fifo`, `wager-transactions-dlq.fifo` e `wager-events.fifo`.
Na pasta `api`: `bun install`, `bun run db:migrate`, exportar as variáveis
`SQS_ENDPOINT`, três `SQS_*_QUEUE_URL`, `AWS_REGION`, `AWS_ACCESS_KEY_ID` e
`AWS_SECRET_ACCESS_KEY`, então `bun run start:dev`.

Scripts existentes: `bun run build`, `bun run lint`, `bun run test`,
`bun run test:integration`, `bun run test:e2e`, `bun run db:migrate`,
`bun run db:migrate:down`, `bun run db:migration:create` e
`bun run db:migration:check`.

## Estado Git ao atualizar este handoff

As alterações de AuthGuard e desta atualização documental estão no working tree
sem commit nesta observação. Não descartar alterações locais sem revisar
`git status` e `git diff`.
