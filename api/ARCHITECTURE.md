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
