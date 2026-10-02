# Teste de carga

Objetivo: ver como o serviço se comporta sob carga com três instâncias e confirmar que, mesmo sob pressão, nenhum saldo diverge do ledger. Não há meta de requisições por segundo; os números servem para entender os limites.

## Como rodar

```bash
docker compose up --build -d --wait
bun run test:load
```

| Variável | Padrão | Significado |
|---|---|---|
| `VUS` | 50 | usuários virtuais simultâneos |
| `SECONDS` | 30 | duração de cada cenário |
| `COMPOSE_PROJECT` | `jungle-wagering` | nome do projeto Compose (nome da pasta, por padrão) |

O comando executa o [k6](https://k6.io) em container, ligado à rede do Compose, enviando para o nginx. Depois da carga, um script Bun (`test/load/run.ts`) lê as métricas de cada instância, mede quanto tempo a outbox leva para esvaziar e roda a reconciliação de todas as wallets usadas. O comando falha se alguma wallet divergir ou se aparecer um status inesperado. O resultado fica em `test/load/out/result.json`.

## Ambiente

| Item | Valor |
|---|---|
| Máquina | notebook de desenvolvimento, Windows 11, Docker dentro do WSL 2 |
| Recursos do WSL | 12 CPUs lógicas, 7,7 GB de memória |
| Topologia | 3 instâncias da aplicação, nginx, PostgreSQL 17, LocalStack 3.8 (SQS) |
| Gerador de carga | k6 1.3.0, em container, na mesma máquina |
| Data | 2026-10-02 |

Tudo roda na mesma máquina: gerador de carga, aplicação, banco e fila disputam as mesmas CPUs. Os números são relativos a esse ambiente, não uma medida de capacidade em produção.

## Metodologia

Três cenários, um depois do outro, 50 usuários virtuais por 30 segundos cada. Cada usuário envia uma `BET` de `"1.00"`, espera a resposta e envia a próxima.

| Cenário | O que faz | O que exercita |
|---|---|---|
| `duplicates` | todos reenviam exatamente a mesma requisição (mesma chave, mesmo conteúdo) | caminho de replay da idempotência |
| `contended` | todos apostam na mesma wallet, cada aposta com chave própria | trava de linha: operações serializadas |
| `spread` | cada usuário aposta na própria wallet | paralelismo entre wallets |

As wallets são abertas com saldo suficiente para nenhuma aposta ser rejeitada, de modo que os cenários `contended` e `spread` medem escrita completa (transação, saldo, ledger e dois eventos na outbox).

## Resultados

| Cenário | Requisições | Req/s | p50 | p95 | p99 | Máx | Aplicadas | Replays | 503 | Erros |
|---|---|---|---|---|---|---|---|---|---|---|
| `duplicates` | 30 838 | 1 027,9 | 44,9 ms | 76,9 ms | 96,6 ms | 1 053 ms | 1 | 30 837 | 0 | 0 % |
| `contended` | 2 977 | 99,2 | 601 ms | 1 056 ms | 1 198 ms | 1 720 ms | 2 977 | 0 | 0 | 0 % |
| `spread` | 10 048 | 334,9 | 146 ms | 196 ms | 221 ms | 273 ms | 10 048 | 0 | 0 | 0 % |

Métricas da aplicação (soma das três instâncias, diferença entre antes e depois):

| Métrica | Valor |
|---|---|
| Transações gravadas (`wager_transactions_total`) | 13 026 |
| Duplicatas reconhecidas (`wager_duplicates_total`) | 30 837 |
| Conflitos de idempotência (`wager_idempotency_conflicts_total`) | 0 |
| Esperas de trava esgotadas (`wallet_lock_conflicts_total`) | 0 |
| Eventos pendentes na outbox quando a carga parou | 15 976 |
| Tempo para a outbox esvaziar | 34,5 s |

Reconciliação: 52 wallets conferidas, **nenhuma divergência** entre saldo e soma do ledger. Nenhum status inesperado.

Os números batem entre si: 1 + 2 977 + 10 048 = 13 026 transações gravadas, e os 30 837 replays aparecem como duplicatas reconhecidas.

## Leitura dos números

**Idempotência é barata.** O replay é uma leitura por chave única, sem trava de wallet: mais de mil respostas por segundo, com uma única aposta aplicada em 30 838 tentativas.

**Uma wallet disputada é serializada, por decisão.** Com 50 usuários na mesma wallet, a vazão cai para cerca de 99 operações por segundo e a latência sobe (p50 de 600 ms), porque cada requisição espera na fila da trava de linha. Isso é o custo da trava pessimista descrito no `ARCHITECTURE.md`: a ordem é determinística e não há tempestade de retries. Mesmo com p99 de 1,2 s, nenhuma requisição atingiu o `lock_timeout` de 3 s (zero respostas 503). Com mais usuários na mesma wallet, a fila cresceria até estourar esse limite e o provedor passaria a receber 503 para reenviar.

**Wallets diferentes rodam em paralelo.** Com a carga espalhada, a vazão é 3,4 vezes a da wallet única, com latência estável (p99 de 221 ms). O limite aqui é a máquina: aplicação, banco e gerador de carga dividem as mesmas CPUs.

**O publisher da outbox é mais lento que a escrita nesse ambiente.** Cada aposta aplicada gera dois eventos. No cenário `spread` entram cerca de 670 eventos por segundo, e a outbox esvaziou 15 976 eventos em 34,5 s (cerca de 460 por segundo). O acúmulo é esperado sob pico: a outbox existe justamente para absorver a diferença sem perder evento e sem atrasar a resposta ao provedor. O limite vem do lote de 10 mensagens por envio (limite do SQS) com o envio dentro da transação que segura as linhas, e do LocalStack como fila. Sob carga sustentada acima da vazão do publisher, o atraso (`outbox_lag_seconds`) cresceria; é a métrica a vigiar. Para aumentar a vazão: mais de um lote por ciclo, ou envios em paralelo por instância.

## Limites desta medição

- Uma rodada só, em máquina de desenvolvimento, com tudo no mesmo host. Sem repetição, não há medida de variação.
- Só `BET` por HTTP. A entrada por SQS e as reversões não foram medidas sob carga (são cobertas por testes de correção).
- LocalStack não tem o desempenho do SQS real, para melhor ou para pior.
- 30 segundos por cenário não mostram efeitos de longa duração (crescimento de tabelas, autovacuum).
