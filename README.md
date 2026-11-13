# Wagering Processor

Serviço de processamento de transações de wagering, com saldo de wallet e ledger auditável.
Processa operações via HTTP e SQS, com idempotência persistida, concorrência por wallet e referências fora de ordem.
Integra PostgreSQL e SQS; eventos de saída são entregues por uma transactional outbox.

**Stack:** Bun 1.x, TypeScript, NestJS, MikroORM, PostgreSQL 16, AWS SQS SDK e MiniStack local.

## Pré-requisitos

- Bun 1.x (use o Bun instalado em `/home/codespace/.bun/bin/bun`, se não estiver no `PATH`).
- Docker Engine e Docker Compose.

## Iniciar do zero

Na raiz do repositório:

```sh
bun install
cp .env.example .env
bun run infra:up
bun run migration:up
bun run start:dev
```

O Compose inicia PostgreSQL e MiniStack, e cria as filas SQS. A aplicação fica em
`http://localhost:3000`. Os scripts acima existem em `package.json`. Para parar os
serviços sem apagar os dados, use `bun run infra:down`; não use `infra:reset`
quando quiser preservar o volume PostgreSQL.

## Testes e typecheck

```sh
bun test
bun run typecheck
```

Os testes de integração precisam de PostgreSQL, migrations e filas SQS disponíveis.
O conjunto atual tem **150 testes** em 19 arquivos (verificado na etapa 14).

| Grupo | O que cobre |
| --- | --- |
| Unidade | `Money`, wallet, transições e referências de `WagerTransaction`, eventos, hash canônico e mapeamento de centavos. |
| Integração | Schema/migrations e constraints, persistência, casos de uso, atomicidade, inbox/outbox, consumidor, retries/DLQ e worker de referências. |
| Concorrência | Disputa de saldo, 50 cópias idempotentes, operações em wallets distintas, reversões concorrentes e publishers/consumidores paralelos. |
| Multi-instância | Três processos reais usando o mesmo PostgreSQL; idempotência, concorrência e recuperação de operações. |
| Reinício e shutdown | Recuperação de outbox após reinício, mensagens após shutdown e consistência após reiniciar processo. |

Não há teste de carga.

## Exemplos HTTP

Os endpoints de negócio usam `AuthGuard` no-op neste desafio. Troque os valores de
exemplo antes de integrar um provedor.

Criar uma wallet:

```sh
curl -sS -X POST http://localhost:3000/wallets \
  -H 'Content-Type: application/json' \
  -d '{
    "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
    "initialBalance": {"amount":"100.00","currency":"BRL"}
  }'
```

Guarde o `id` retornado e use-o como `WALLET_ID`. Submeter uma aposta:

```sh
export WALLET_ID='id-retornado-pela-criacao'
export PLAYER_ID='0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1'

curl -sS -X POST http://localhost:3000/wagering/transactions \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: demo-provider:bet-001' \
  -d "{
    \"providerId\":\"demo-provider\",
    \"externalTransactionId\":\"bet-001\",
    \"playerId\":\"$PLAYER_ID\",
    \"walletId\":\"$WALLET_ID\",
    \"roundId\":\"round-001\",
    \"gameId\":\"demo-game\",
    \"kind\":\"BET\",
    \"money\":{\"amount\":\"10.00\",\"currency\":\"BRL\"}
  }"
```

Consultar saldo, reconciliar com o ledger e verificar health/metrics:

```sh
curl -sS "http://localhost:3000/wallets/$WALLET_ID"
curl -sS -X POST "http://localhost:3000/wallets/$WALLET_ID/reconciliation"
curl -sS http://localhost:3000/health/live
curl -sS http://localhost:3000/health/ready
curl -sS http://localhost:3000/metrics
```

Para publicar uma aposta de demonstração em `wager-transactions.fifo`, indique uma
wallet existente; o consumidor deve estar habilitado (`SQS_CONSUMER_ENABLED=true`):

```sh
SQS_EXAMPLE_WALLET_ID="$WALLET_ID" \
SQS_EXAMPLE_PLAYER_ID="$PLAYER_ID" \
bun run sqs:send
```

## Respostas HTTP

| Status | Significado |
| --- | --- |
| `200` | Operação processada, consulta, reconciliação ou replay. |
| `201` | Wallet criada. |
| `202` | Referência de estorno ainda pendente; a resposta pode não conter saldo observado. |
| `400` | Requisição inválida. Corrija o formato/campos antes de reenviar. |
| `404` | Wallet ou transação inexistente. |
| `409` | Wallet duplicada ou conflito de idempotência. Não reutilize a mesma chave com payload diferente. |
| `422` | Rejeição de negócio; veja `failureCode`. Um replay rejeitado mantém `422` e informa `idempotentReplay: true`. |
| `503` | Falha transitória de dependência/banco; resposta traz `Retry-After`. Reenvie com a mesma chave idempotente. |
| `500` | Falha inesperada; investigue antes de decidir por reenvio. |

## Códigos de falha e ação do provedor

Rejeições `422` são persistidas. Repetir a mesma chave retorna a rejeição original;
não use retry cego para alterar o resultado. Para uma operação corrigida, use uma
nova identidade de transação e chave de idempotência.

| `failureCode` | Orientação ao provedor |
| --- | --- |
| `INSUFFICIENT_FUNDS` | Desistir desta operação ou corrigir o estado/valor; não repetir a mesma aposta com a mesma identidade. |
| `REVERSAL_WOULD_OVERDRAW` | Corrigir a sequência/saldo de origem ou desistir da reversão; não repetir sem mudança. |
| `REFERENCE_NOT_FOUND` | Confirmar que a transação referenciada foi entregue; após a rejeição final, reenviar uma operação corrigida com nova identidade. |
| `REFERENCE_MISMATCH` | Corrigir provedor, jogador, wallet, moeda ou rodada da referência e reenviar com nova identidade. |
| `INVALID_REFERENCE_KIND` | Corrigir o tipo da transação referenciada ou desistir da reversão. |
| `AMOUNT_MISMATCH` | Corrigir o valor para coincidir com a referência e reenviar com nova identidade. |
| `ALREADY_REVERSED` | Desistir: a transação de referência já foi revertida. |
| `CURRENCY_MISMATCH` | Corrigir a moeda/wallet e reenviar com nova identidade. |
| `PLAYER_MISMATCH` | Corrigir a identidade do jogador e reenviar com nova identidade. |

## Variáveis de ambiente

Os padrões vêm de `.env.example` ou dos valores de fallback no código. Variáveis
de `POSTGRES_*` são consumidas pelo Compose; as demais configuram a aplicação ou
os scripts locais.

| Nome | Padrão | Para que serve |
| --- | --- | --- |
| `PORT` | `3000` | Porta HTTP. |
| `DATABASE_URL` | `postgresql://wagering:local-password@localhost:5432/wagering` | Conexão PostgreSQL. |
| `POSTGRES_USER` | `wagering` | Usuário criado pelo container PostgreSQL. |
| `POSTGRES_PASSWORD` | `local-password` | Senha local do PostgreSQL; substitua fora do ambiente local. |
| `POSTGRES_DB` | `wagering` | Banco criado pelo container PostgreSQL. |
| `DB_POOL_MAX` | `10` | Máximo de conexões do pool MikroORM. |
| `DB_LOCK_TIMEOUT_MS` | `5000` | Tempo máximo de espera por lock SQL; timeout é transitório. |
| `AWS_REGION` | `us-east-1` | Região AWS usada pelo cliente SQS. |
| `AWS_ACCESS_KEY_ID` | `test` | Credencial local para MiniStack. |
| `AWS_SECRET_ACCESS_KEY` | `test` | Credencial local para MiniStack. |
| `SQS_ENDPOINT` | `http://localhost:4566` | Endpoint MiniStack/AWS SQS. |
| `SQS_QUEUE_URL` | `http://localhost:4566/000000000000/wager-transactions.fifo` | Fila de entrada do consumidor. |
| `SQS_DLQ_URL` | `http://localhost:4566/000000000000/wager-transactions-dlq.fifo` | Fila de mensagens inválidas/falhas finais. |
| `SQS_EVENTS_QUEUE_URL` | `http://localhost:4566/000000000000/wagering-events.fifo` | Fila de eventos publicados pela outbox. |
| `SQS_CONSUMER_ENABLED` | `false` | Habilita polling da fila de entrada (`true`/`false`). |
| `SQS_CONSUMER_NAME` | `wager-transactions` | Identidade do consumidor usada na inbox. |
| `SQS_WAIT_TIME_SECONDS` | `20` | Long polling (máximo 20 segundos). |
| `SQS_MAX_NUMBER_OF_MESSAGES` | `10` | Máximo de mensagens por recebimento (até 10). |
| `SQS_VISIBILITY_TIMEOUT_SECONDS` | `30` | Visibilidade inicial da mensagem recebida. |
| `SQS_MAX_RECEIVES` | `5` | Tentativas transitórias antes de mover a mensagem à DLQ. |
| `SQS_RETRY_MAX_DELAY_SECONDS` | `300` | Teto do backoff de visibilidade do consumidor. |
| `SQS_POLL_INTERVAL_MS` | `1000` | Intervalo entre ciclos de polling do consumidor. |
| `OUTBOX_PUBLISHER_ENABLED` | `true` | Habilita publicador de outbox; use `false` para desabilitar. |
| `OUTBOX_PUBLISHER_BATCH_SIZE` | `100` | Tamanho máximo do lote reclamado pelo publicador. |
| `OUTBOX_PUBLISHER_INTERVAL_MS` | `1000` | Intervalo de polling da outbox. |
| `OUTBOX_PUBLISHER_LEASE_MS` | `30000` | Duração do lease de publicação. |
| `OUTBOX_INSTANCE_ID` | UUID aleatório | Identidade da instância do publicador. |
| `PENDING_REFERENCE_WORKER_ENABLED` | `false` | Habilita o worker periódico de referências pendentes. |
| `PENDING_REFERENCE_WORKER_BATCH_SIZE` | `100` | Tamanho do lote do worker de referências. |
| `PENDING_REFERENCE_WORKER_INTERVAL_MS` | `1000` | Intervalo de polling do worker. |
| `REFERENCE_MAX_ATTEMPTS` | `8` | Tentativas máximas para resolver uma referência ausente. |
| `REFERENCE_TTL` | `900000` ms | Tempo máximo de vida de uma referência pendente (15 minutos). |
| `SQS_EXAMPLE_WALLET_ID` | sem padrão | Wallet existente exigida pelo script `sqs:send`. |
| `SQS_EXAMPLE_PLAYER_ID` | sem padrão | Jogador da wallet exigido pelo script `sqs:send`. |

## Mais documentação

- [Decisões de arquitetura](./ARCHITECTURE.md)
- [Erros e correções](./docs/ERROS-E-CORRECOES.md)
- [Enunciado do desafio](./docs/DESAFIO.md)
