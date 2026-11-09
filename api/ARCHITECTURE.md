# Organização da API

O código é organizado por módulo de domínio. Cada módulo reúne as camadas da
funcionalidade, enquanto `shared` contém apenas conceitos realmente usados por
mais de um módulo. Dependências devem apontar para dentro: apresentação chama
aplicação, aplicação coordena domínio e portas, infraestrutura implementa as
portas.

## Estrutura atual

```text
src/
  main.ts
  app.module.ts
  modules/
    health/
      presentation/health.controller.ts
      health.module.ts
    wallets/
      domain/             # Wallet, Money e regras de saldo
      application/        # abertura, consulta e reconciliação
      infrastructure/     # EntitySchema MikroORM
      presentation/       # controller e parsers HTTP
      wallets.module.ts
    wagering/
      domain/             # WagerTransaction, regras e eventos
      application/        # processamento, queries e worker de referência
      infrastructure/     # EntitySchema MikroORM
      presentation/       # controllers e parser HTTP
      wagering.module.ts
    ledger/
      domain/             # lançamentos imutáveis
      infrastructure/    # EntitySchema MikroORM
    messaging/
      domain/             # inbox, outbox e envelope de evento
      application/        # consumer e publisher SQS
      infrastructure/    # EntitySchema e clientes SQS
      messaging.module.ts
    identity/             # AuthGuard no-op como ponto de extensão
  shared/
    domain/               # LedgerDirection compartilhado
    observability/        # registry de métricas e logs JSON estruturados
  database/
    mikro-orm.config.ts
    migrations/
```

Os diretórios de `domain`, `application`, `infrastructure` e `presentation`
são criados conforme há código para eles; não precisam de arquivos vazios.
`identity` contém o guard HTTP no-op exigido como ponto de extensão, não um
mecanismo de autenticação ativo. O ledger está distribuído entre seu domínio e
as camadas de wallets/wagering; não há um `LedgerModule` autônomo.

## Responsabilidades

- `wallets`: saldo materializado, moeda e abertura da carteira.
- `wagering`: idempotência e regras de BET/WIN/LOSS/REFUND/ROLLBACK.
- `ledger`: lançamentos imutáveis, leitura auditável e reconciliação.
- `messaging`: inbox, outbox, integração SQS e recuperação de mensagens.
- `health`: liveness, readiness do PostgreSQL/SQS e endpoint Prometheus de
  métricas operacionais.
- `identity`: `AuthGuard` no-op anexado às rotas HTTP financeiras; local para
  integração futura com um provedor de identidade externo.
- `database`: configuração do MikroORM e migrations versionadas/reversíveis.
- `shared`: não deve virar uma pasta genérica; tipos permanecem no módulo dono
  até existir uma necessidade real de compartilhamento.

O fluxo financeiro é orquestrado por `ProcessWager`, usando uma transação
MikroORM para persistir transação, wallet, ledger, inbox (quando aplicável) e
outbox de forma atômica.

## Persistência inicial

Os `EntitySchema` ficam nas camadas de infraestrutura e mantêm o domínio sem
dependência do ORM. `Money` é persistido como `numeric(20,2)` e moeda em coluna
separada; o valor numérico é lido/escrito como string decimal. A versão da wallet
é incrementada no domínio; a concorrência entre operações usa lock pessimista
por wallet. As garantias de unicidade, saldo não negativo, aritmética do ledger
e ledger append-only também estão na migration SQL, para continuarem valendo
com mais de uma instância.

As migrations `Migration20261107000000` a `Migration20261110000000` criam as
tabelas financeiras, o snapshot `resulting_balance`, inbox/outbox e os
campos/índices de agenda e lease das referências pendentes. A migration inicial
impõe unicidade global da chave de
idempotência, unicidade por provedor/ID externo, uma reversão por referência e
tipo, no máximo um lançamento por transação/wallet, FKs, checks e trigger que
rejeita UPDATE/DELETE do ledger. Parte dessas garantias SQL não é representada
integralmente nos `EntitySchema`; `db:migration:check` já foi observado
propondo removê-las. Diff gerado não deve ser aplicado sem revisão. O formato
do código de moeda é validado como três letras maiúsculas; não se mantém
catálogo ISO-4217, conforme decisão de escopo.

## Processamento de transações de aposta

`ProcessWager` calcula SHA-256 do JSON canônico dos campos de negócio (chaves
ordenadas recursivamente; `Idempotency-Key` excluído) e executa a operação em
`EntityManager.transactional()`. Ele lê a chave de idempotência, adquire lock
`PESSIMISTIC_WRITE` somente na linha da wallet e volta a consultar a chave depois
do lock. Isso serializa disputas sobre a mesma wallet e permite paralelismo entre
wallets distintas. Uma corrida de inserção da mesma chave em wallets diferentes
é resolvida pela constraint única do PostgreSQL e pela leitura de recuperação
após rollback.

O saldo, a versão e o timestamp da wallet, a transação e o ledger são flushados
na mesma transação SQL. A transação guarda `resulting_balance`, snapshot usado
para responder replays sem devolver o saldo atual, inclusive em operações
rejeitadas. `BET` debita, `WIN` credita e `LOSS` registra o resultado sem mover
saldo nem gravar ledger. `REFUND` credita uma `BET` processada. `ROLLBACK`
inverte o sentido da `BET`, `WIN` ou `REFUND` processada que referencia.

Referências são resolvidas por provedor/ID externo e precisam pertencer ao mesmo
jogador, wallet, moeda e rodada; também devem estar processadas e ter um tipo
permitido. `REFUND` e `ROLLBACK` precisam usar o mesmo valor da referência e só
podem ocorrer uma vez por referência e tipo. Uma referência informada que ainda
não existe fica `PENDING_REFERENCE` e retorna HTTP `202`; referências inválidas,
saldo insuficiente ou reversão duplicada são registradas como `REJECTED` com
`failureCode`. O `PendingReferenceWorker` agenda novas tentativas com backoff,
reivindica linhas com lease e `SKIP LOCKED`, e chama as mesmas regras financeiras.
Ao esgotar oito tentativas ou 15 minutos, rejeita com `REFERENCE_NOT_FOUND`.

`POST /wagering/transactions` aceita `BET`, `WIN`, `LOSS`, `REFUND` e `ROLLBACK`;
`OPENING` é interno. `WIN` e `LOSS` podem informar referência de `BET`; `REFUND`
e `ROLLBACK` exigem `referenceExternalTransactionId`. Resultados finalizados
retornam `200`, operações aguardando referência retornam `202`. Payload inválido
retorna `400`, conflitos de idempotência/ID externo retornam `409`, wallet
ausente retorna `404` e incompatibilidades de jogador/moeda retornam `422`. A
autenticação permanece fora do escopo, conforme decisão da seção 2 do desafio.

## Autenticação e identidade

Não implementamos autenticação neste desafio. As rotas de
wallets e wagering já passam por `AuthGuard`, mas a implementação atual é
intencionalmente no-op e permite todas as chamadas. Isso deixa um ponto de
substituição explícito sem criar a falsa impressão de que as rotas estão
protegidas. `/health/live`, `/health/ready` e `/health/metrics` não usam o guard
e permanecem abertos, como pede o enunciado.

Como evolução, integraríamos um IdP OIDC externo (por exemplo Keycloak ou
Zitadel), sem tabela local de senhas. O guard validaria assinatura, emissor,
audience e expiração do token, e disponibilizaria o principal autenticado no
request. Para operações de provedor, a identidade/claim do token deveria ser
vinculada ao `providerId` informado na requisição. Mensagens SQS são tratadas
como canal interno confiável pelo desafio, mas `providerId`, wallet, jogador,
referências e demais invariantes continuam passando pelas validações de domínio
de `ProcessWager`. Ao implementar auth, substituir `AuthGuard` e adicionar essa
vinculação; os controllers já aplicam o guard.

## API de wallets e reconciliação

`WalletApplicationService` abre a wallet e, para saldo inicial positivo, grava
wallet, transação interna `OPENING`, crédito do ledger e os eventos
`WagerTransactionProcessed`/`WalletBalanceChanged` na mesma transação SQL. Uma
wallet com saldo inicial zero não cria lançamento. A unicidade de
`(player_id, currency)` no PostgreSQL transforma criação duplicada em conflito.

O módulo expõe leitura da wallet, ledger paginado por cursor opaco baseado em
`(createdAt, id)`, busca de wager pelo ID interno ou pelo par
`(providerId, externalTransactionId)`, e reconciliação. A reconciliação bloqueia
a wallet para leitura enquanto percorre o ledger em ordem estável; compara a
cadeia de saldos e o saldo calculado ao saldo materializado. Divergências são
devolvidas sem correção automática, geram log estruturado e incrementam
`wallet_reconciliation_mismatches_total`.

## Outbox e eventos de integração

A migration `Migration20261109000000` cria `inbox_messages` com chave composta
`(consumer_name, message_id)` e `outbox_messages` com payload JSONB, tentativas,
próxima tentativa, publicação e lease de publisher. O consumer escreve a inbox
junto com o processamento financeiro; o caso de uso grava a outbox na mesma
transação, e o publisher envia os eventos depois do commit.

`ProcessWager` cria um evento tipado e sua linha de outbox dentro da mesma
transação PostgreSQL que grava a wager, atualiza a wallet e persiste o ledger.
Resultados `PROCESSED`, `REJECTED` e `PENDING_REFERENCE` geram respectivamente
`WagerTransactionProcessed`, `WagerTransactionRejected` e
`WagerTransactionPendingReference`. Uma operação que muda o saldo também gera
`WalletBalanceChanged`. Eventos carregam envelope versionado; valores monetários
seguem como decimal em string. Nenhuma chamada ao SQS ocorre no caso de uso.

O `OutboxPublisher` reivindica lotes com `FOR UPDATE SKIP LOCKED`, atribui um
lease de 60 segundos e confirma essa reivindicação antes de chamar o SQS. O envio
acontece fora da transação SQL. A linha só recebe `published_at` depois do ACK
positivo do SQS; erros liberam o lease e agendam retry exponencial de 1 segundo
até 5 minutos, sem limite de tentativas nem descarte automático. Publica até 10
eventos concorrentes por batch. O envio FIFO usa `aggregateId` como
`MessageGroupId` e `eventId` como `MessageDeduplicationId`.

Existe uma janela inevitável entre o SQS aceitar a mensagem e o banco confirmar
`published_at`: se o processo cair nessa janela, o publisher tentará novamente
após expirar o lease. A garantia é at-least-once; consumidores precisam deduplicar
por `eventId`. A confirmação no banco é condicional ao token do lease, para um
publisher antigo não atualizar uma linha que outro publisher já reivindicou.
O publisher roda no processo da API quando `SQS_EVENTS_QUEUE_URL` está
configurada. Sem essa configuração, os eventos ficam duráveis na outbox e um
aviso é registrado.

Como os envios dentro da batch são concorrentes, o código não garante que dois
eventos do mesmo agregado sejam aceitos pelo SQS na ordem em que foram gravados
na outbox. A fila FIFO preserva a ordem de aceite por grupo, mas não serializa
as chamadas concorrentes de publicação.

O `SqsWagerConsumer` faz long polling de uma mensagem por vez da fila de entrada
e passa o payload validado ao mesmo `ProcessWager` usado pelo HTTP. Para mensagens
financeiras, a inbox usa o `messageId` do envelope e SHA-256 do body, e é gravada
como processada na mesma transação SQL da wager/saldo/ledger/outbox. O consumer
apaga a mensagem SQS só depois do retorno do use case, que ocorre após o commit.
Em redelivery, inbox já processada é reconhecida e a mensagem recebe ACK sem
reaplicar efeitos.

Rejeições de negócio que o use case devolve como estado terminal persistem inbox
e são confirmadas. Erros de contrato são enviados à DLQ e a mensagem original é
apagada somente após a cópia ser aceita. Falhas técnicas permanecem na fila e
recebem atraso de visibilidade exponencial; a redrive policy local envia à DLQ
após cinco entregas. A visibilidade é renovada enquanto o use case trabalha.
Com `enableShutdownHooks()`, o consumer deixa de fazer novos polls no encerramento
e aguarda o processamento atual, mantendo a mensagem invisível até poder concluir
o commit e o ACK.

## Regras de transação e ledger

`WagerTransaction` nasce em `PENDING`. As transições permitidas são:

```text
PENDING -> PENDING_REFERENCE | PROCESSED | REJECTED | FAILED
PENDING_REFERENCE -> PROCESSED | REJECTED | FAILED
```

`PROCESSED`, `REJECTED` e `FAILED` são terminais. `OPENING` usa uma factory
interna separada e nasce `PROCESSED`; a API/fila deve aceitar somente os tipos
externos. O agregado valida exigência de referência, estado terminal, hash de
payload e direção contábil. A validação de ownership da referência, rodada,
valor, duplicidade de reversão e saldo cabe ao caso de uso que tem acesso aos
repositórios e à wallet.

`WalletLedgerEntry` é imutável. A factory exige valor positivo, moeda igual em
valor e saldos, saldo final não negativo e aritmética consistente: débito subtrai
o valor e crédito soma. `LOSS` não gera lançamento. `ROLLBACK` inverte a direção
do BET/WIN/REFUND processado que referencia. A restrição de um lançamento por
transação/wallet é aplicada por índice único no banco.

## Health, logs e métricas

`GET /health/live` verifica que o processo HTTP responde. `GET /health/ready`
faz probe de PostgreSQL e das três filas configuradas (entrada, DLQ e eventos),
com timeout de 3 segundos. Sem configuração ou acesso, retorna `503`. Os
endpoints de health permanecem abertos.

`GET /health/metrics` expõe texto Prometheus, gerado por um registry em memória.
O código registra contadores de transações por status, duplicatas, retries,
envios e mensagens visíveis na DLQ, conflitos SQL de lock/deadlock, tamanho e
idade da outbox, latência de processamento e divergências de reconciliação. Os
valores zeram em restart e são locais a cada instância; não há Prometheus,
OpenTelemetry ou dashboard no Compose.

Logs JSON dos fluxos financeiros e workers usam campos comuns de timestamp,
level, component, event, correlationId, messageId, transactionId, walletId,
providerId, externalTransactionId, status, errorCode e durationMs. Campos sem
valor ficam `null`; payload financeiro completo não é registrado.

## Limitações de validação

Os testes de três instâncias Nest e restart rodam dentro de um mesmo processo de
teste; não são três processos do sistema operacional nem encerramento forçado.
Os testes cobrem concorrência de publishers e retry transitório do consumer,
mas não injetam falha temporária no publisher até validar seu backoff, nem
aguardam uma falha técnica chegar à DLQ pela redrive policy de cinco entregas.
O registry de métricas é efêmero e publisher não tem DLQ própria nem limite de
retries; eventos permanentemente problemáticos podem acumular na outbox.
