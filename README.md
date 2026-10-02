# jungle-wagering

Processador distribuído de apostas: recebe operações (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`) por HTTP e por SQS, decide se aplica ou rejeita, e grava saldo, ledger e evento na mesma transação. Três instâncias rodam ao mesmo tempo sem debitar duas vezes nem deixar saldo negativo.

As decisões, os trade-offs e as limitações estão em [ARCHITECTURE.md](ARCHITECTURE.md).

## Pré-requisitos

- Docker com Compose v2. É o suficiente para rodar tudo.
- [Bun](https://bun.sh) 1.3, só para rodar os testes.

Os exemplos usam `bash` e `curl` (Linux, macOS, WSL ou Git Bash).

## Como rodar

```bash
docker compose up --build
```

Isso sobe:

| Serviço | O que faz |
|---|---|
| `postgres` | PostgreSQL 17 |
| `localstack` | SQS local |
| `setup` | roda as migrations e cria as filas, uma vez, e termina |
| `app-1`, `app-2`, `app-3` | três instâncias da aplicação (HTTP + consumidor SQS + publisher da outbox + resolver) |
| `nginx` | balanceador, em `http://localhost:3000` |

Se alguma porta já estiver em uso, troque por variável:

```bash
APP_PORT=3100 POSTGRES_PORT=5450 LOCALSTACK_PORT=4576 docker compose up --build
```

| Variável | Padrão | Porta de |
|---|---|---|
| `APP_PORT` | 3000 | nginx (entrada HTTP) |
| `POSTGRES_PORT` | 5440 | PostgreSQL |
| `LOCALSTACK_PORT` | 4566 | LocalStack |

Conferir se está no ar:

```bash
curl http://localhost:3000/health/ready
```

Parar e apagar os dados:

```bash
docker compose down -v
```

## Passo a passo: uma aposta

O cenário do enunciado: saldo 100, duas apostas de 80. Valores monetários são sempre **strings** (`"80.00"`), nunca números.

**1. Abrir uma wallet com saldo 100**

```bash
BASE=http://localhost:3000
PLAYER_ID=7f3b2c1e-4a5d-4e6f-8a9b-0c1d2e3f4a5b

curl -s -X POST $BASE/wallets \
  -H 'Content-Type: application/json' \
  -d "{\"playerId\":\"$PLAYER_ID\",\"initialBalance\":{\"amount\":\"100.00\",\"currency\":\"BRL\"}}"
```

Resposta `201`. Guarde o `id` devolvido:

```bash
WALLET_ID=<id devolvido>
```

**2. Apostar 80** — resposta `201`, saldo `20.00`

```bash
curl -s -X POST $BASE/wagering/transactions \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: provider-a:bet-1' \
  -d "{\"providerId\":\"provider-a\",\"externalTransactionId\":\"bet-1\",\"playerId\":\"$PLAYER_ID\",\"walletId\":\"$WALLET_ID\",\"roundId\":\"round-1\",\"gameId\":\"fortune-chimp\",\"kind\":\"BET\",\"money\":{\"amount\":\"80.00\",\"currency\":\"BRL\"}}"
```

```json
{"transactionId":"...","status":"PROCESSED","balance":{"amount":"20.00","currency":"BRL"},"idempotentReplay":false}
```

**3. Repetir exatamente a mesma requisição** — resposta `200`, mesmo `transactionId`, `"idempotentReplay":true`. Nada é debitado de novo.

**4. Apostar 80 de novo, com outra chave** — resposta `422`, saldo continua `20.00`

```bash
curl -s -X POST $BASE/wagering/transactions \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: provider-a:bet-2' \
  -d "{\"providerId\":\"provider-a\",\"externalTransactionId\":\"bet-2\",\"playerId\":\"$PLAYER_ID\",\"walletId\":\"$WALLET_ID\",\"roundId\":\"round-1\",\"gameId\":\"fortune-chimp\",\"kind\":\"BET\",\"money\":{\"amount\":\"80.00\",\"currency\":\"BRL\"}}"
```

```json
{"transactionId":"...","status":"REJECTED","balance":{"amount":"20.00","currency":"BRL"},"idempotentReplay":false,"failureCode":"INSUFFICIENT_FUNDS"}
```

**5. Consultar saldo, ledger e reconciliação**

```bash
curl -s $BASE/wallets/$WALLET_ID
curl -s $BASE/wallets/$WALLET_ID/ledger
curl -s -X POST $BASE/wallets/$WALLET_ID/reconciliation
curl -s $BASE/providers/provider-a/wagering/transactions/bet-2
```

A reconciliação soma o ledger e compara com o saldo gravado:

```json
{"walletId":"...","storedBalance":{"amount":"20.00","currency":"BRL"},"calculatedBalance":{"amount":"20.00","currency":"BRL"},"difference":{"amount":"0.00","currency":"BRL"},"consistent":true,"checkedEntries":2}
```

## API HTTP

| Método | Rota | Para quê | Sucesso |
|---|---|---|---|
| `POST` | `/wallets` | abrir wallet (uma por jogador e moeda) | 201 |
| `GET` | `/wallets/:walletId` | saldo e versão | 200 |
| `GET` | `/wallets/:walletId/ledger` | lançamentos, paginado (`limit`, `cursor`) | 200 |
| `POST` | `/wallets/:walletId/reconciliation` | compara saldo com a soma do ledger | 200 |
| `POST` | `/wagering/transactions` | submeter operação (exige `Idempotency-Key`) | 201, 200 ou 202 |
| `GET` | `/wagering/transactions/:transactionId` | consultar por id interno | 200 |
| `GET` | `/providers/:providerId/wagering/transactions/:externalTransactionId` | consultar pelo id do provedor | 200 |
| `GET` | `/health/live` | processo vivo | 200 |
| `GET` | `/health/ready` | PostgreSQL e SQS respondem | 200 |
| `GET` | `/metrics` | métricas Prometheus, por instância (não passa pelo nginx) | 200 |

Corpo de `POST /wagering/transactions`:

| Campo | Tipo | Observação |
|---|---|---|
| `providerId` | string | |
| `externalTransactionId` | string | único por provedor |
| `playerId`, `walletId` | UUID | |
| `roundId`, `gameId` | string | |
| `kind` | `BET` \| `WIN` \| `LOSS` \| `REFUND` \| `ROLLBACK` | |
| `money` | `{ "amount": "25.00", "currency": "BRL" }` | `amount` é string com até 2 casas |
| `referenceExternalTransactionId` | string | obrigatório em `REFUND` e `ROLLBACK` |

Status de resposta:

| Status | Significado |
|---|---|
| 201 | operação aplicada |
| 200 | replay: mesma chave e mesmo conteúdo, devolve o resultado anterior |
| 202 | `PENDING_REFERENCE`: a referência ainda não chegou, será tentada de novo |
| 400 | requisição inválida ou sem `Idempotency-Key` |
| 401 / 403 | sem identidade / sem permissão |
| 404 | wallet ou transação não existe |
| 409 | mesma chave com conteúdo diferente, ou wallet já existe |
| 422 | rejeitada por regra de negócio (ver `failureCode`) |
| 503 | falha passageira (banco fora, espera de lock esgotada): pode reenviar com a mesma chave |
| 500 | erro inesperado |

Erros saem em `application/problem+json`, com `code` legível por máquina e `correlationId`. O header `X-Correlation-Id` é aceito na entrada e devolvido na resposta.

Para ver as métricas de uma instância:

```bash
docker compose exec app-1 bun -e "console.log(await (await fetch('http://localhost:3000/metrics')).text())"
```

## Mensageria (SQS)

| Fila | Uso |
|---|---|
| `wager-transactions.fifo` | entrada: operações enviadas pelos provedores |
| `wager-transactions-dlq.fifo` | mensagens inválidas ou que esgotaram as tentativas, com o motivo |
| `wager-events.fifo` | saída: eventos publicados pela outbox |

A mensagem de entrada passa pelo mesmo caso de uso do HTTP. Exemplo (um `WIN` de 15 na wallet aberta acima):

```bash
cat > mensagem.json <<EOF
{
  "messageId": "msg-1",
  "type": "WagerTransactionRequested",
  "occurredAt": "2026-10-02T12:00:00.000Z",
  "correlationId": "corr-1",
  "data": {
    "idempotencyKey": "provider-a:win-1",
    "providerId": "provider-a",
    "externalTransactionId": "win-1",
    "playerId": "$PLAYER_ID",
    "walletId": "$WALLET_ID",
    "roundId": "round-1",
    "gameId": "fortune-chimp",
    "kind": "WIN",
    "money": { "amount": "15.00", "currency": "BRL" }
  }
}
EOF

docker compose exec -T localstack awslocal sqs send-message \
  --queue-url http://localhost:4566/000000000000/wager-transactions.fifo \
  --message-group-id "$WALLET_ID" \
  --message-deduplication-id msg-1 \
  --message-body "$(cat mensagem.json)"
```

O `message-group-id` é o id da wallet: mensagens da mesma wallet saem em ordem, wallets diferentes rodam em paralelo. Em poucos segundos o saldo passa a `35.00`:

```bash
curl -s $BASE/wallets/$WALLET_ID
```

Ler um evento publicado e conferir a fila morta:

```bash
docker compose exec -T localstack awslocal sqs receive-message \
  --queue-url http://localhost:4566/000000000000/wager-events.fifo

docker compose exec -T localstack awslocal sqs get-queue-attributes \
  --queue-url http://localhost:4566/000000000000/wager-transactions-dlq.fifo \
  --attribute-names ApproximateNumberOfMessages
```

## Testes

Os testes de integração e de concorrência usam PostgreSQL e SQS reais. Suba só os dois e instale as dependências:

```bash
docker compose up -d --wait postgres localstack
bun install
```

| Comando | O que prova |
|---|---|
| `bun run test` | unidade: regras de domínio, validação e adaptadores, sem infraestrutura |
| `bun run test:integration` | casos de uso, repositórios, HTTP e mensageria contra PostgreSQL e SQS reais; inclui corridas dentro de um processo |
| `bun run test:regression` | um teste por bug encontrado durante o desenvolvimento |
| `bun run test:concurrency` | três processos reais no mesmo banco e nas mesmas filas: disputa de saldo, idempotência, ordem por wallet, queda após commit e antes do ack, queda após publicar e antes de marcar |
| `bun run test:all` | os quatro acima, em sequência |
| `bun run test:load` | teste de carga com k6 contra a stack completa do Compose; números e análise em [docs/LOAD_TEST.md](docs/LOAD_TEST.md) |
| `bun run lint` | Biome |
| `bun run typecheck` | `tsc --noEmit` |

Cada arquivo de teste cria o próprio banco e as próprias filas e os remove no fim. Os testes de `SIGTERM` rodam só em Linux (o sinal não existe no Windows); o CI os executa.

## Variáveis de ambiente

| Variável | Padrão | Significado |
|---|---|---|
| `PORT` | `3000` | porta HTTP da instância |
| `DATABASE_URL` | (obrigatória) | conexão com o PostgreSQL |
| `LOCK_TIMEOUT_MS` | `3000` | espera máxima pela trava de uma wallet; ao estourar, responde 503 |
| `AUTH_MODE` | `noop` | adaptador de identidade (ver ARCHITECTURE.md, Autenticação) |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` ou `silent` |
| `SQS_ENDPOINT` | (vazio) | endpoint do SQS; definido para usar o LocalStack |
| `AWS_REGION` | `us-east-1` | |
| `SQS_TRANSACTIONS_QUEUE` | `wager-transactions.fifo` | fila de entrada |
| `SQS_DLQ_QUEUE` | `wager-transactions-dlq.fifo` | fila morta |
| `SQS_EVENTS_QUEUE` | `wager-events.fifo` | fila de eventos |
| `WORKERS_ENABLED` | `true` | `false` deixa a instância só com HTTP |
| `SQS_WAIT_TIME_SECONDS` | `5` | duração do long poll do consumidor |

`FAULT_CRASH_AT` existe só para os testes de queda; não use fora deles.

## Rodar a aplicação fora do Docker

```bash
docker compose up -d --wait postgres localstack
cp .env.example .env
bun install
bun run setup
bun run start
```

`setup` aplica as migrations e cria as filas. `bun run db:rollback` desfaz a última migration.

## Estrutura do projeto

```
src/
  domain/          regras de negócio puras (Money, Wallet, transação, políticas, eventos)
  application/     casos de uso e portas (interfaces)
  infrastructure/  PostgreSQL (MikroORM), SQS, logs, métricas
  interface/       HTTP (controllers, validação, erros) e workers (consumidor, loops)
  composition/     monta repositórios e casos de uso; usado pelo NestJS e pelos testes
test/
  unit/  integration/  regression/  concurrency/
```

A dependência só aponta para dentro: `interface` e `infrastructure` → `application` → `domain`.
