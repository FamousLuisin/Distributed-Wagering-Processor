# Project Handoff — Distributed Wagering Processor

Documento de transferência para continuar o projeto em outra conversa. Baseado no histórico desta conversa e no estado observado do repositório em 08/11/2026. Quando há divergência, o código/Git observado descreve a implementação; a documentação pode descrever apenas intenção.

## Como interpretar

- **Confirmado no código**: conferido nos arquivos atuais.
- **Decisão do usuário**: preferência ou escolha expressa durante a conversa.
- **Planejado/sugerido**: direção discutida, ainda sem implementação confirmada.
- **Desconhecido**: não há evidência suficiente; não presumir.

## Addendum atual — API financeira

Este addendum supersede as afirmações anteriores deste handoff sobre ausência
de mensageria, worker de referências e endpoints de consulta; essas seções foram
escritas antes da implementação correspondente. O código atual também contém
`POST /wallets` com abertura `OPENING` e crédito de ledger atômicos para saldo
inicial positivo, `GET /wallets/:walletId`, ledger paginado por cursor, busca de
transação por ID interno/externo e `POST /wallets/:walletId/reconciliation`.
Esses fluxos foram adicionados nesta etapa, mas build e testes ainda não foram
executados nesta etapa.

## 1. Visão geral do projeto

### Objetivo
API de processamento distribuído de operações de wagering/apostas, com wallet, saldo, transações e ledger. Prioridades conhecidas: correção financeira sob concorrência, não debitar duas vezes em repetição/redelivery e relacionar operações como refund/rollback às transações originais.

O desafio foi referido como “Technical Challenge — Distributed Wagering Processor Bem-vindo à Jungle Gaming”. O conteúdo completo do anexo não foi consultado nesta análise; confirmar nele os requisitos exatos, especialmente broker, retries e recuperação.

### Tecnologias confirmadas
- TypeScript strict, ESM/NodeNext.
- NestJS 12 + Express.
- MikroORM 7 + PostgreSQL.
- PostgreSQL 17 Alpine via Docker Compose.
- Bun para dependências e scripts.
- Vitest, Oxlint e Prettier.
- Não há SDK de fila/SQS em `api/package.json` no estado observado.

### Estado atual
Há domínios Money, Wallet, WagerTransaction e ledger; persistência/migrations; caso de uso síncrono `ProcessWager`; endpoint HTTP; lock pessimista da wallet; idempotência; regras BET/WIN/LOSS/REFUND/ROLLBACK.

**Fila, SQS, inbox/outbox, workers e recuperação/retry não estão implementados.** A arquitetura cita esses itens e o usuário indicou que integração de fila e recuperação deve ser prioridade em relação a endpoints de consulta.

## 2. Arquitetura e estrutura

### Árvore atual relevante
```
api/src/
  app.module.ts
  main.ts
  database/
    mikro-orm.config.ts
    migrations/Migration20261107000000.ts
    migrations/Migration20261108000000.ts
  modules/
    health/
      health.module.ts
      presentation/health.controller.ts
    wallets/
      domain/
        money.ts, money.props.ts, money.errors.ts, money.spec.ts
        wallet.ts, wallet.state.ts, wallet.balance-change.ts
        wallet.errors.ts, wallet.spec.ts
      infrastructure/wallet.entity.ts
    wagering/
      domain/
        wager-transaction.ts, wager-transaction.types.ts
        wager-transaction.errors.ts, wager-transaction.spec.ts
      application/
        process-wager.ts, process-wager.types.ts, process-wager.errors.ts
        process-wager.integration.spec.ts
      infrastructure/wager-transaction.entity.ts
      presentation/wagering.controller.ts, submit-wager.request.ts
      wagering.module.ts
    ledger/
      domain/
        wallet-ledger-entry.ts, wallet-ledger-entry.types.ts
        wallet-ledger-entry.errors.ts, wallet-ledger-entry.spec.ts
      infrastructure/wallet-ledger-entry.entity.ts
  shared/domain/ledger-direction.ts
```

`api/ARCHITECTURE.md` descreve também módulos planejados: messaging, identity e camadas completas de application/infrastructure/presentation para wallets e ledger. Eles não aparecem na árvore atual e não devem ser descritos como implementados. `app.module.ts` registra HealthModule e WageringModule.

### Responsabilidades e fluxo
- `wallets`: Money, agregado Wallet e regras de saldo.
- `wagering`: tipos/regras da transação, referências e coordenação do processamento.
- `ledger`: lançamento imutável.
- `health`: liveness; readiness conectada a banco/fila não confirmada.
- `database`: configuração MikroORM e migrations.
- `shared/domain`: LedgerDirection usado por mais de um módulo.
- `messaging`: SQS, inbox/outbox e workers são planejados, ausentes.

Fluxo atual: controller recebe POST e `Idempotency-Key` → parser valida body → `ProcessWager` normaliza Money/calcula hash → transação MikroORM → consulta idempotência → lock pessimista na linha da wallet → nova consulta da chave → resolve conflitos e referência → aplica regra do domínio → grava wager e, se aplicável, wallet/ledger na mesma transação SQL → responde. É fluxo **síncrono**, não usa fila.

## 3. Implementações realizadas

### Money e Wallet
- Arquivos em `api/src/modules/wallets/domain/`: Money, props/erros/specs; Wallet, estado, mudança de saldo, erros/specs.
- Valores monetários persistidos como `numeric(20,2)` e tratados como string decimal.
- **Decisão do usuário**: não implementar validação contra lista ISO-4217; formato de moeda de três letras maiúsculas existe como regra de formato no banco.
- Verificar os arquivos antes de ampliar precisão/escala ou API dos agregados.

### WagerTransaction e ledger
- Arquivos em `api/src/modules/wagering/domain/` e `api/src/modules/ledger/domain/`.
- Tipos conhecidos: OPENING, BET, WIN, LOSS, REFUND, ROLLBACK; estados PENDING, PENDING_REFERENCE, PROCESSED, REJECTED, FAILED.
- OPENING é interno e possui factory separada; endpoint não aceita.
- Ledger é imutável. Débito subtrai, crédito soma; LOSS não gera ledger.
- ROLLBACK inverte BET/WIN/REFUND processada que referencia; REFUND credita BET processada.
- Domínio valida transições e direção; validações que exigem persistência (ownership, rodada, duplicidade) são coordenadas pelo use case.

### Banco e migrations
- Configuração: `api/src/database/mikro-orm.config.ts`.
- Entidades: `wallet.entity.ts`, `wager-transaction.entity.ts`, `wallet-ledger-entry.entity.ts`.
- Migration 20261107000000 cria wallets, wager_transactions e wallet_ledger_entries, com checks, FKs, índices e constraints. Inclui unicidade wallet por jogador/moeda, idempotency key, provider/external ID, reversão por referência/tipo, ledger por wallet/transação; trigger proíbe UPDATE/DELETE do ledger.
- Migration 20261108000000 acrescenta `resulting_balance` para snapshot de replay.
- Migrations são transacionais; README orienta não usar schema:update em ambientes compartilhados.

### ProcessWager, referências e operações
Arquivo principal: `api/src/modules/wagering/application/process-wager.ts`.

- Hash SHA-256 do JSON canônico de campos de negócio: external transaction ID, game, kind, Money, player, provider, reference external ID, round e wallet. Chave de idempotência é excluída do hash; chaves do JSON são ordenadas recursivamente.
- Mesmo idempotency key + mesmo hash: replay retorna snapshot original e `idempotentReplay: true`. Mesmo key com payload divergente gera conflito.
- Lock `PESSIMISTIC_WRITE` somente na wallet serializa alterações da mesma carteira. Reconsulta chave após o lock.
- Wager, atualização da wallet e ledger são persistidos no mesmo contexto transacional; wager é flushado antes do ledger para satisfazer FK, sem sair da transação SQL.
- BET debita; saldo insuficiente fica REJECTED/INSUFFICIENT_FUNDS.
- WIN credita; referência de BET é opcional.
- LOSS registra sem mover saldo nem criar ledger; referência de BET opcional.
- REFUND exige referência a BET processada e mesmo valor; credita uma vez.
- ROLLBACK exige referência processada permitida (BET/WIN/REFUND), mesmo valor e só uma reversão por referência/tipo; inverte direção.
- Referência precisa corresponder a provider, jogador, wallet, moeda, rodada, status e tipo permitidos.
- Referência ausente gera PENDING_REFERENCE e HTTP 202; referência inválida é rejeitada com failureCode. **O reprocessamento da pendência ainda não existe.**
- Leia o código corrente antes de confiar em todas essas regras; testes específicos desses tipos estão ausentes.

### Endpoint
Arquivos: `api/src/modules/wagering/presentation/wagering.controller.ts`, `submit-wager.request.ts`, `wagering.module.ts`.

Rota `POST /wagering/transactions`; header `Idempotency-Key` obrigatório. Aceita BET/WIN/LOSS/REFUND/ROLLBACK, não OPENING. REFUND/ROLLBACK exigem referência. HTTP 200 para resultado final, 202 pending, 400 entrada inválida/valor não positivo, 409 conflitos, 404 wallet ausente, 422 player/moeda incompatíveis. Auth consta como fora do escopo na documentação; validar com o enunciado.

### Reimplementação depois do re-clone
O usuário perdeu trabalho local por problema de Git e pediu reimplementar BET/WIN/LOSS/REFUND/ROLLBACK. Essa refatoração está no working tree atual, sem commit (ver seção 5). Substituiu nomes process-bet/submit-bet por process-wager/submit-wager.

## 4. Decisões arquiteturais e técnicas

| Decisão | Motivo/evidência | Estado |
|---|---|---|
| Organização modular por domínio/camadas | `api/ARCHITECTURE.md`; domínio sem dependência do ORM | Documentada e parcialmente aplicada |
| MikroORM + PostgreSQL | Código atual; transação e lock relacional para saldo | Implementado |
| Money com decimal/string e numeric SQL | Evitar aritmética monetária com float | Implementado/documentado |
| Sem catálogo ISO-4217 | Usuário explicitamente dispensou | Decisão confirmada |
| Constraints SQL para invariantes | Segurança mesmo com múltiplas instâncias | Implementado em migration |
| Lock pessimista por wallet | Impedir overspending concorrente na mesma wallet | Implementado |
| Hash para idempotência | Repetição igual retorna resultado original; alteração conflita | Implementado |
| SQS/inbox/outbox/workers | Constam no architecture e usuário priorizou fila | Ainda não implementado; requisito específico do desafio não revalidado |
| At-least-once + idempotência | Foi sugerido como abordagem de broker | Sugestão, não implementação/decisão final |

O usuário perguntou “por que não MikroORM?”; projeto atual efetivamente usa MikroORM. Não há no histórico decisão aprovada de trocar ORM.

## 5. Problemas e correções

### Erro de tipo no integration spec
`common.kind` era inferido como enum amplo, incluindo OPENING, incompatível com tipo externo de ProcessWager. Corrigido para `WagerTransactionKind.Bet as const` em `api/src/modules/wagering/application/process-wager.integration.spec.ts`. Depois foi executado `bun run build` em api e passou (`$ nest build`).

### Working tree não commitado
No `git status --short` observado:
- modificados: `api/ARCHITECTURE.md`, `api/README.md`, `wager-transaction.ts`, controller e wagering.module;
- removidos: arquivos antigos `process-bet.errors.ts`, `process-bet.integration.spec.ts`, `process-bet.ts`, `process-bet.types.ts`, `submit-bet.request.ts`;
- untracked: versões `process-wager.*` e `submit-wager.request.ts`.
Git pode detectar renames após staging. **Não descartar/resetar essas alterações.** O handoff é a única alteração adicional solicitada nesta etapa.

Commits existentes observados:
- `b30b6bb feat(wagering): add bet submission endpoint`
- `8293a37 fix(wagering): prevent overspending on concurrent bets`
- `93a7896 feat(wagering): persist bets and ledger entries with PostgreSQL`
- `4f7276b feat(wagering): add wagering and ledger`
- `b08d575 feat(wallets): add wallet and money domain models`
- `f2d9320 feat(api): bootstrap NestJS API with liveness endpoint`
- `1d4fbfe Initial commit`

### Pendências e limitações conhecidas
- PENDING_REFERENCE pode ser persistido e replayado como pending; não existe worker para reprocessar após chegada da referência.
- Compose sobe apenas PostgreSQL; sem fila, SDK, publisher, consumer, inbox/outbox, retry ou DLQ.
- Endpoint financeiro é síncrono.
- Integração atual não cobre WIN/LOSS/REFUND/ROLLBACK, erros de referência nem broker.
- Queries de wallet/ledger, paginação e reconciliação não implementadas.
- FailureCode.ReferenceNotFound e PermanentInfrastructureFailure existem; revisar uso na recuperação futura.
- Não confirmado se SQS é requisito do challenge. O conteúdo do anexo original não foi consultado agora.
- Não foi feita auditoria adicional de SQL/runtime durante a preparação deste documento.

## 6. Testes e validações

Scripts em `api/package.json`: `bun run test`, `test:integration`, `test:e2e`, `lint`, `build`; migrations: `db:migrate`, `db:migrate:down`, `db:migration:create`, `db:migration:check`.

Specs presentes: Money, Wallet, WagerTransaction, WalletLedgerEntry; integração em `process-wager.integration.spec.ts` cobre (1) duas apostas concorrentes de R$80 contra R$100; (2) replay idempotente sem débito adicional; (3) conflito com payload diferente na mesma chave. Usa PostgreSQL real, executa migrations e deixa dados de ledger append-only; usar banco descartável/local.

Resultados conhecidos:
- Build passou após ajuste `as const`.
- Na reconstrução anterior, agente reportou lint e build aprovados, mas lint não foi reexecutado nesta análise.
- Não afirmar testes de integração como passantes: não foram executados na última sequência.
- Nenhum teste comprovou WIN/LOSS/REFUND/ROLLBACK, retry, DLQ ou recuperação de referência.
- README documenta `docker compose up -d db`, depois `bun install`, `bun run db:migrate`, `bun run start:dev`; defaults DB_HOST localhost, porta 5432, wageringDatabase/user/password.

## 7. Estado atual

**Implementado**: Nest API, liveness, MikroORM/Postgres/migrations, domínios financeiros, endpoint síncrono, BET/WIN/LOSS/REFUND/ROLLBACK no código de aplicação, idempotência, lock wallet, ledger append-only, snapshot de replay. Build passou após fix de tipo.

**Parcial**: pending reference é persistida, mas não retomada; reimplementação de Wager está sem commit e sem testes novos específicos; arquitetura por camadas ainda tem módulos planejados ausentes.

**Não implementado**: integração de fila (SQS ou outro), inbox/outbox, publisher, consumer, workers, retries/backoff/DLQ/recovery; worker pending reference; readiness de DB/broker; queries de wallet/ledger/reconciliação; autenticação conforme escopo a confirmar.

**Quebrado/pendente**: nenhum erro de build conhecido após último fix, mas estado completo não foi testado com integração. Alterações locais devem ser preservadas e revisadas.

## 8. Próximas tarefas (prioridade)

1. Preservar e revisar `git status`/diff atual; não usar reset/checkout destrutivo. Confirmar build ao retomar.
2. Consultar o enunciado original para confirmar broker, contrato, ACK, ordenação, retry, DLQ e observabilidade. Não assumir SQS obrigatório só por constar no plano.
3. Desenhar fluxo durável API → banco → broker. Architecture prevê outbox gravada atomicamente com dados financeiros; evitar publicar antes do commit SQL.
4. Implementar schema/migration de inbox e outbox, se compatível com contrato confirmado; decidir estados, tentativas, leases/locks e publisher.
5. Implementar consumer e deduplicação da inbox para redelivery; definir ACK somente após resultado durável e retry de falhas transitórias.
6. Projetar/implementar worker que retoma PENDING_REFERENCE sem violar idempotência ou estados terminais.
7. Definir falhas permanentes, limites e backoff, DLQ e replay operacional.
8. Acrescentar testes de integração: tipos/referências, duplicidade/reversões, redelivery, crash windows e concorrência; executar com dependências locais apropriadas.
9. Atualizar compose, README e ARCHITECTURE com setup real, env vars e operação do broker.
10. Endpoints de consulta/reconciliação depois, se prazo ou enunciado exigir.

“At-least-once + idempotência” e SQS foram direção/sugestão da conversa, não implementação, e SQS não foi confirmado contra o desafio.

## 9. Convenções e orientações para o próximo agente

### Padrões observados
- TypeScript ESM; imports locais com extensão `.js`.
- Arquivos kebab-case; classes/tipos PascalCase.
- `*.types.ts`, `*.errors.ts`, `*.spec.ts`, `*.integration.spec.ts`.
- Domínio não importa MikroORM; Entity/EntitySchema ficam em infrastructure.
- Usar Money para valores financeiros; não converter para number sem justificativa.
- Controller mapeia erros de aplicação para HTTP.
- Alterações de schema via migrations revisáveis; preservar garantias de banco.
- Commits existentes usam prefixos como feat/fix e escopo em parênteses, mas não foi encontrada convenção formal adicional.

### Preferências do usuário
- Responder em português e explicar mudanças/motivos didaticamente; está aprendendo conceitos do sistema.
- Seguir documentação, distinguindo plano de código real.
- Prazo mencionado: três dias; foco nos requisitos principais.
- Não considera necessária validação ISO-4217.
- Explicitamente priorizou fila e recuperação em relação a endpoints de consulta.
- Nenhuma publicação/mensagem externa é necessária ou autorizada por esse pedido.

### Cuidados
- Ler o challenge antes de fixar broker/retry behavior.
- Revisar working tree antes de editar; arquivos removidos/untracked fazem parte da refatoração recuperada.
- Preservar atomicidade do saldo/transação/ledger e idempotência ao introduzir broker.
- Não prometer exactly-once; distinguir garantias do banco, broker e aplicação.
- Evitar abstrações genéricas; respeitar direção apresentação → aplicação → domínio/portas → infraestrutura.
- Relatar exatamente validações executadas; não declarar testes verdes sem execução.
- Antes de mudar transições, conferir enums, agregado, migrations, snapshots e índices.

## 10. Contexto adicional

- O usuário perguntou sobre Money, crédito/débito, transação, replay, flush, lock e referências; explicações de termos são úteis.
- Em `resolveReference`, primeiro busca provider + external ID; se não acha, busca só external ID para detectar associação a outro provider. Isso pressupõe que essa busca seja informativa quando IDs externos possam repetir entre provedores. Confirmar contrato antes de alterar.
- O usuário perguntou “por que não MikroORM?”; projeto usa MikroORM e não há decisão de troca.
- Testes de integração deixam ledger append-only no banco; evitar banco compartilhado.
- O usuário tem horizonte curto de três dias; separar requisito obrigatório de melhoria opcional.
