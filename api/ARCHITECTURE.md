# Organização da API

O código é organizado por módulo de domínio. Cada módulo reúne as camadas da
funcionalidade, enquanto `shared` contém apenas conceitos realmente usados por
mais de um módulo. Dependências devem apontar para dentro: apresentação chama
aplicação, aplicação coordena domínio e portas, infraestrutura implementa as
portas.

## Estrutura planejada

```text
src/
  main.ts
  app.module.ts
  modules/
    health/
      presentation/
      health.module.ts
    wallets/
      domain/             # Wallet, Money e regras de saldo
      application/        # abrir, consultar e reconciliar wallet
      infrastructure/    # repositório MikroORM e mapeamentos
      presentation/       # controllers, DTOs e validação HTTP
      wallets.module.ts
    wagering/
      domain/             # WagerTransaction, regras e eventos de domínio
      application/        # submissão, processamento e referências pendentes
      infrastructure/    # repositórios MikroORM e adaptadores
      presentation/       # endpoints e contratos HTTP
      wagering.module.ts
    ledger/
      domain/             # lançamentos imutáveis e regras de consistência
      application/        # consulta paginada e reconciliação
      infrastructure/    # persistência e migrations relacionadas
      presentation/       # consulta de ledger, se exposta separadamente
      ledger.module.ts
    messaging/
      application/        # casos de uso de inbox/outbox e workers
      infrastructure/    # adaptadores SQS, publisher e scheduler
      messaging.module.ts
    identity/             # ponto de extensão para IdP/guards; sem auth artesanal
  shared/
    domain/               # tipos/erros base realmente compartilhados
    application/          # contratos como clock e unit of work, se necessários
    infrastructure/       # configuração e adaptadores transversais
  database/
    mikro-orm.config.ts
    migrations/
```

Os diretórios de `domain`, `application`, `infrastructure` e `presentation`
serão criados dentro de cada módulo conforme houver código para eles; não
precisam de arquivos vazios. `identity` é somente o ponto de extensão previsto
pelo desafio: autenticação pode ficar fora do escopo e essa decisão deve ser
documentada.

## Responsabilidades

- `wallets`: saldo materializado, moeda e abertura da carteira.
- `wagering`: idempotência e regras de BET/WIN/LOSS/REFUND/ROLLBACK.
- `ledger`: lançamentos imutáveis, leitura auditável e reconciliação.
- `messaging`: inbox, outbox, integração SQS e recuperação de mensagens.
- `health`: liveness e readiness; readiness será conectada ao PostgreSQL e ao
  SQS quando esses adaptadores forem configurados.
- `database`: configuração do MikroORM e migrations versionadas/reversíveis.
- `shared`: não deve virar uma pasta genérica; tipos permanecem no módulo dono
  até existir uma necessidade real de compartilhamento.

O fluxo financeiro será orquestrado por um caso de uso de `wagering`, usando
uma transação MikroORM para persistir transação, wallet, ledger, inbox (quando
aplicável) e outbox de forma atômica.

## Persistência inicial

Os `EntitySchema` ficam nas camadas de infraestrutura e mantêm o domínio sem
dependência do ORM. `Money` é persistido como `numeric(20,2)` e moeda em coluna
separada; o valor numérico é lido/escrito como string decimal. A versão da wallet
é incrementada no domínio; a concorrência entre operações usa lock pessimista
por wallet. As garantias de unicidade, saldo não negativo, aritmética do ledger
e ledger append-only também estão na migration SQL, para continuarem valendo
com mais de uma instância.

A primeira migration cria `wallets`, `wager_transactions` e
`wallet_ledger_entries`. A migration seguinte adiciona o snapshot
`resulting_balance` usado para responder replays. A primeira migration também impõe unicidade global da chave de
idempotência, unicidade por provedor/ID externo, uma reversão por referência e
tipo, no máximo um lançamento por transação/wallet, e um trigger que rejeita
UPDATE/DELETE do ledger. O formato do código de moeda é validado como três letras
maiúsculas; a lista ISO-4217 não é mantida dentro do domínio, conforme decisão
de escopo.

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
`failureCode`. O worker que reprocessará as pendências ainda será implementado
no módulo de mensageria.

`POST /wagering/transactions` aceita `BET`, `WIN`, `LOSS`, `REFUND` e `ROLLBACK`;
`OPENING` é interno. `WIN` e `LOSS` podem informar referência de `BET`; `REFUND`
e `ROLLBACK` exigem `referenceExternalTransactionId`. Resultados finalizados
retornam `200`, operações aguardando referência retornam `202`. Payload inválido
retorna `400`, conflitos de idempotência/ID externo retornam `409`, wallet
ausente retorna `404` e incompatibilidades de jogador/moeda retornam `422`. A
autenticação permanece fora do escopo, conforme decisão da seção 2 do desafio.

## Outbox e eventos de integração

A migration `Migration20261109000000` cria `inbox_messages` com chave composta
`(consumer_name, message_id)` e `outbox_messages` com payload JSONB, tentativas,
próxima tentativa, publicação e lease de publisher. A inbox e seu modelo de
domínio estão prontos para deduplicação pelo consumer; ainda não são escritos
porque o consumer SQS será implementado na próxima etapa.

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
até 5 minutos, sem descartar a mensagem. O envio FIFO usa `aggregateId` como
`MessageGroupId` e `eventId` como `MessageDeduplicationId`.

Existe uma janela inevitável entre o SQS aceitar a mensagem e o banco confirmar
`published_at`: se o processo cair nessa janela, o publisher tentará novamente
após expirar o lease. A garantia é at-least-once; consumidores precisam deduplicar
por `eventId`. A confirmação no banco é condicional ao token do lease, para um
publisher antigo não atualizar uma linha que outro publisher já reivindicou.
O publisher roda no processo da API quando `SQS_EVENTS_QUEUE_URL` está
configurada. Sem essa configuração, os eventos ficam duráveis na outbox e um
aviso é registrado.

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
transação/wallet também será aplicada por índice único no banco.
