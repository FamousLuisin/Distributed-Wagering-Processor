# Load test — referência local

## Resultado medido

Execução em 09/11/2026, relatório com detalhes locais removidos:
[`load-test-results/cc156f6f-27ec-4b8e-8c30-aa8acf4136ff.json`](load-test-results/cc156f6f-27ec-4b8e-8c30-aa8acf4136ff.json).

| Cenário               | Apostas | Wallets | Throughput OK |       p50 |       p95 |       p99 |  Erros | HTTP 409 | Lock errors | Outbox lag máx. |
| --------------------- | ------: | ------: | ------------: | --------: | --------: | --------: | -----: | -------: | ----------: | --------------: |
| Uma wallet concorrida |     500 |       1 |  116,02 req/s | 258,14 ms | 328,99 ms | 379,59 ms | 0 (0%) |        0 |           0 |         3,846 s |
| Dez wallets           |     500 |      10 |  221,17 req/s | 143,09 ms | 166,66 ms | 176,95 ms | 0 (0%) |        0 |           0 |         3,155 s |

As duas fases usaram concorrência 32 e BETs únicos de R$ 0,01. Todas as 1.000
respostas foram HTTP 200/`PROCESSED`; a taxa de sucesso foi 100%. Depois de cada
fase, a outbox drenou até zero e a reconciliação confirmou saldo igual ao ledger
em todas as wallets. O lag observado após a drenagem foi zero.

Neste ambiente, distribuir o mesmo volume por dez wallets apresentou maior
throughput e menor latência que concentrá-lo em uma wallet. Isso é compatível
com a serialização pelo lock da wallet, mas é uma observação desta execução; não
é uma meta nem uma garantia para outros ambientes. O contador `database_lock_conflicts_total`
mede erros SQL de deadlock/lock/serialização, não o tempo de espera normal pelo
lock pessimista. Portanto, zero lock errors não significa ausência de contenção;
a latência do cenário de wallet única também deve ser considerada.

## Ambiente

- Linux x86_64, 12 CPUs lógicas.
- API compilada (`bun run start:prod`), executada em Node 26.3.0.
- Gerador de carga Bun 1.4.4.
- PostgreSQL Docker `postgres:17-alpine` e LocalStack `localstack/localstack:4`,
  iniciados pelo `compose.yml`; fila de eventos SQS ativa.
- O Compose não define limites de CPU/memória para os containers. API, gerador,
  banco e LocalStack compartilharam o host.

O relatório distribuído omite hostname, modelo e memória da máquina, endereços
de API/banco/SQS e identificadores dos registros financeiros. Mantém apenas
plataforma, arquitetura, quantidade de CPUs lógicas e versões dos runtimes.

## Metodologia e limites

O gerador cria wallets e saldo inicial pela API antes da medição, espera a outbox
ficar drenada e então envia 500 requests por fase com 32 workers HTTP. A primeira
fase envia todas as apostas para uma wallet. A segunda distribui round-robin por
dez wallets. Cada aposta tem `Idempotency-Key`, ID externo e rodada exclusivos.
O valor é R$ 0,01 e o saldo de cada wallet cobre todas as apostas previstas.

Throughput é calculado como respostas 2xx por segundo dentro da janela de
requests. Latências medem o tempo HTTP por request; p50/p95/p99 usam nearest
rank. Setup fica fora dessa janela. O gerador consulta `/health/metrics` a cada
250 ms durante carga e drenagem; esse overhead está incluído na duração. O pico
de outbox lag é o maior valor amostrado do gauge, que o publisher atualiza no
seu próprio ciclo de polling. Mensagens HTTP 409 e o delta do contador de locks
do PostgreSQL são reportados separadamente.

Não houve warm-up nem outro tráfego concorrente. Os logs estruturados da API
ficaram habilitados e foram enviados ao terminal, o que também consome recursos.
É uma execução curta de referência em máquina local, não um benchmark de
produção nem evidência de capacidade sustentada. Repetições podem variar com
carga do host, estado do cache e serviços locais.

O teste cria dados financeiros e não apaga wallets, wagers, ledger ou eventos;
ledger é append-only. Use um banco local descartável para novas execuções.
