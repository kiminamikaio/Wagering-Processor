# Status atual do projeto

Atualizado em: 2026-11-12

Relatório baseado no conteúdo presente no repositório, não em etapas planejadas. Nenhum arquivo de código foi alterado; este relatório foi criado a pedido.

## 1. Resumo em 3 linhas

- Hoje existe uma aplicação NestJS mínima, com endpoint de liveness `GET /health/live`.
- Há um value object `Money` baseado em centavos inteiros (`bigint`), testes unitários e uma migration PostgreSQL que define as tabelas do fluxo de apostas.
- Não há implementação dos casos de uso de aposta, processamento de carteira, publicação/consumo de eventos ou worker; a aplicação de migration no banco não foi verificada.

## 2. Etapas do roteiro

1. **Fundação — FEITA:** aplicação Bun/TypeScript/NestJS inicializada, módulo principal e configuração PostgreSQL/MikroORM presentes.
2. **Docker Compose — PARCIAL:** Compose provisiona PostgreSQL 16, MiniStack e filas SQS/FIFO com DLQ; não define serviço para a aplicação.
3. **Money — FEITA:** `Money` usa centavos `bigint`, string decimal e moeda, com operações e testes.
4. **Migrations — PARCIAL:** migration e configuração MikroORM estão implementadas, mas a execução real contra PostgreSQL não foi confirmada; teste de integração não conseguiu conectar.
5. **Domínio — PARCIAL:** existem `Money` e erros de domínio; não há modelo/comportamento de carteira ou transação de aposta.
6. **Use case BET/WIN/LOSS — NÃO INICIADA:** não há casos de uso nem serviços para esses eventos.
7. **REFUND/ROLLBACK/PENDING_REFERENCE — PARCIAL:** migration prevê os tipos/status e a unicidade de refund/rollback processado; lógica desses fluxos não existe.
8. **API HTTP — PARCIAL:** somente `GET /health/live`; não há endpoints de aposta/carteira.
9. **Testes de concorrência — NÃO INICIADA:** não há testes de concorrência; os testes de integração existentes verificam constraints, mas não puderam rodar sem PostgreSQL.
10. **Publicador outbox — PARCIAL:** tabela e índice da outbox existem no schema; não há publicador.
11. **Consumidor SQS + inbox + DLQ — PARCIAL:** Compose provisiona filas e a migration cria inbox; não há consumidor nem tratamento de mensagens.
12. **Worker de referências pendentes — PARCIAL:** o status `PENDING_REFERENCE` existe no schema; não há worker.
13. **Health/logs/métricas — PARCIAL:** há endpoint de liveness; readiness, logs estruturados e métricas não foram encontrados.
14. **README/ARCHITECTURE — PARCIAL:** README tem apenas uma descrição breve; não há documentação de arquitetura ou descrição detalhada dos requisitos do desafio.

## 3. Árvore de pastas de `src/` (2 níveis)

```text
src/
├── app.module.ts
├── health.controller.ts
├── health.controller.test.ts
├── main.ts
└── shared/
    ├── domain/
    └── infrastructure/
```

- `src/`: inicialização da aplicação e composição de módulos/controllers.
- `src/shared/`: código compartilhado, organizado em domínio e infraestrutura.
- `src/shared/domain/`: value object `Money`, erros e testes unitários.
- `src/shared/infrastructure/`: infraestrutura; contém `database/` no nível seguinte, com configuração MikroORM, migration, snapshot e teste de integração.

## 4. Dependências instaladas no `package.json` e scripts

**Dependências de runtime**

- `@mikro-orm/core` `^6`
- `@mikro-orm/migrations` `^6`
- `@mikro-orm/postgresql` `^6`
- `@nestjs/common` `^11.0.0`
- `@nestjs/core` `^11.0.0`
- `@nestjs/platform-express` `^11.0.0`
- `reflect-metadata` `^0.2.2`
- `rxjs` `^7.8.1`

**Dependências de desenvolvimento**

- `@mikro-orm/cli` `^6`
- `@types/bun` `^1.2.0`
- `@types/node` `^22.0.0`
- `dotenv` `^18.0.10`
- `ts-node` `^10.9.2`
- `typescript` `^5.8.0`

**Scripts**

- `start:dev`: `bun --watch src/main.ts`
- `start`: `bun src/main.ts`
- `test`: `bun test`
- `typecheck`: `tsc --noEmit`
- `infra:up`: `docker compose up -d`
- `infra:down`: `docker compose down`
- `infra:reset`: `docker compose down -v`
- `migration:up`: executa migration MikroORM usando a configuração em `src/shared/infrastructure/database/mikro-orm.config.ts`
- `migration:down`: reverte migration pela mesma configuração

## 5. Schema atual definido na migration

Valores monetários são armazenados em `BIGINT` em centavos. IDs usam `UUID`; timestamps usam `TIMESTAMPTZ`. Chaves primárias e constraints `UNIQUE` geram índices no PostgreSQL.

### `wallets`

- Colunas: `id UUID` (PK, default `gen_random_uuid()`), `player_id UUID`, `currency CHAR(3)`, `balance_cents BIGINT` (default `0`), `version INTEGER` (default `1`), `created_at TIMESTAMPTZ`, `updated_at TIMESTAMPTZ`.
- Constraints: `UNIQUE (player_id, currency)`; saldo `>= 0`; versão `>= 1`.

### `wager_transactions`

- Colunas: `id UUID` (PK), `wallet_id UUID`, `provider_id TEXT`, `external_transaction_id TEXT`, `idempotency_key TEXT`, `payload_hash TEXT`, `kind TEXT`, `status TEXT`, `amount_cents BIGINT`, `currency CHAR(3)`, `reference_transaction_id UUID` (nullable), `created_at TIMESTAMPTZ`, `processed_at TIMESTAMPTZ` (nullable).
- FKs: `wallet_id → wallets.id`; `reference_transaction_id → wager_transactions.id`.
- Constraints: `UNIQUE (provider_id, external_transaction_id)`; `UNIQUE (idempotency_key)`; `amount_cents > 0`; `kind` em `OPENING`, `BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`; `status` em `PENDING`, `PENDING_REFERENCE`, `PROCESSED`, `REJECTED`, `FAILED`.
- Índice parcial único `wager_transactions_processed_reference_kind_unique` em `(reference_transaction_id, kind)`, para registros `PROCESSED` de tipo `REFUND` ou `ROLLBACK`.

### `wallet_ledger_entries`

- Colunas: `id UUID` (PK), `wallet_id UUID`, `transaction_id UUID`, `direction TEXT`, `amount_cents BIGINT`, `balance_before_cents BIGINT`, `balance_after_cents BIGINT`, `created_at TIMESTAMPTZ`.
- FKs: `wallet_id → wallets.id`; `transaction_id → wager_transactions.id`.
- Constraints: `UNIQUE (wallet_id, transaction_id)`; direção `DEBIT` ou `CREDIT`; valor positivo; aritmética de saldo consistente com direção; saldo após lançamento `>= 0`.
- Trigger `wallet_ledger_entries_append_only`, antes de qualquer `UPDATE` ou `DELETE`, chama `prevent_wallet_ledger_entries_mutation()` e lança erro. Não impede `INSERT`.

### `inbox_messages`

- Colunas: `consumer_name TEXT`, `message_id UUID`, `payload JSONB`, `received_at TIMESTAMPTZ`, `processed_at TIMESTAMPTZ` (nullable).
- Constraint: chave primária composta `(consumer_name, message_id)`.

### `outbox_messages`

- Colunas: `id UUID` (PK), `aggregate_type TEXT`, `aggregate_id UUID`, `event_type TEXT`, `payload JSONB`, `created_at TIMESTAMPTZ`, `published_at TIMESTAMPTZ` (nullable), `next_attempt_at TIMESTAMPTZ`, `attempt_count INTEGER`.
- Constraint: `attempt_count >= 0`.
- Índice parcial `outbox_messages_unpublished_next_attempt_at_idx` em `(next_attempt_at)` quando `published_at IS NULL`.

## 6. Decisões técnicas já tomadas

- ORM/banco: MikroORM 6 configurado para PostgreSQL; `entities: []`, então não há entidades ORM registradas atualmente.
- Money: entrada decimal como string, moeda com três letras maiúsculas, representação interna em `bigint` de centavos; serialização retorna string decimal com duas casas. Não usa `number` para aritmética monetária.
- Persistência monetária: colunas `*_cents BIGINT`; a migration define checks de saldo e aritmética do ledger.
- Organização observada: NestJS, `shared/domain` e `shared/infrastructure`; testes Bun junto dos módulos.
- Regras de `.github/copilot-instructions.md`: dinheiro nunca como `number`/float/double; alterar saldo dentro de transação SQL com lock da wallet e registrar ledger/outbox na mesma transação; ledger somente `INSERT`; não publicar evento antes do commit (usar outbox); idempotência via constraints únicas do banco, não memória; usar Bun em `/home/codespace/.bun/bin/bun`, sem instalá-lo via npm.
- Essas regras descrevem convenções instruídas; a transação de saldo e publicação ainda não aparecem implementadas no código atual.

## 7. Resultado real de testes e typecheck

Comandos executados em 2026-11-12:

```text
$ /home/codespace/.bun/bin/bun test
10 pass
1 fail
44 expect() calls
Ran 11 tests across 3 files.
```

O teste de integração `PostgreSQL schema constraints` falhou no `beforeAll` porque a conexão com PostgreSQL foi recusada em `::1:5432` e `127.0.0.1:5432` (`ECONNREFUSED`). Os outros 10 testes passaram: 9 de `Money` e 1 de `GET /health/live`. Assim, não foi verificado se os casos individuais do schema passam.

```text
$ /home/codespace/.bun/bin/bun run typecheck
$ tsc --noEmit
```

Exit code `0` (sucesso).

## 8. Pendências, dívidas técnicas e divergências documentais

- Principal pendência funcional: não há fluxo que processe apostas e altere saldo; wallet lock, transação SQL, ledger e outbox atômicos ainda não têm implementação de aplicação.
- Não há API de negócio, publisher, consumidor SQS, lógica de inbox, worker de referência pendente ou testes de concorrência.
- A migration descreve schema amplo sem entidades MikroORM. A aplicação da migration e os constraints no banco real não foram verificados, pois PostgreSQL não estava disponível durante `bun test`.
- A integração de testes depende de banco ativo e falha toda a suíte quando ele não está iniciado/configurado; isso impediu validar constraints neste ambiente.
- O Compose não inclui a aplicação e o serviço SQS local usa MiniStack. Não foi verificado o comportamento de execução dessas imagens/filas no ambiente.
- O `README.md` atual não expõe os requisitos completos do desafio — contém apenas uma frase de descrição. Portanto, divergências com critérios que não estejam registrados no repositório são **não verificadas**. Em relação ao roteiro listado neste relatório, a maioria dos comportamentos de negócio continua ausente.

## 9. Próximo passo recomendado

Iniciar o domínio transacional de carteira e o caso de uso BET/WIN/LOSS: implementar o saldo alterado sob lock dentro de transação SQL, com registro de transação/ledger/outbox atômicos e idempotência por constraints; antes disso, disponibilizar PostgreSQL para validar a migration e os testes de integração.

## 10. Registro da etapa

Este arquivo é o registro do estado verificado em 2026-11-12. Atualizar este relatório quando uma nova etapa do roteiro for concluída, incluindo estado, evidência no código e resultado dos testes relevantes.
