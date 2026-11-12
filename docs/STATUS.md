# Status do projeto

Atualizado em: 2026-11-12

## Etapas concluídas

A migration inicial `Migration20261112180000` agora inclui os campos de identidade e referência em `wager_transactions`, valida a relação entre tipo/status e os campos de referência/falha, e cria o índice parcial para referências pendentes. O ledger tem índice por `(wallet_id, id)`, CHECK aritmético simplificado e proteção contra `TRUNCATE`, além de `UPDATE` e `DELETE`. `inbox_messages.message_id` é `TEXT` e `payload_hash` é obrigatório.

O teste de integração verifica as novas constraints de campos obrigatórios, referência externa de REFUND/ROLLBACK e `failure_code` de acordo com status; também verifica o hash obrigatório da inbox, `message_id` textual, tentativas padrão, índices e trigger contra `TRUNCATE`.

### Etapa 5 — domínio puro

Implementados em `src/wagering/domain/`:

- `WalletLedgerEntry`: entidade imutável; `create` verifica valor positivo, aritmética e saldo após lançamento; `rehydrate` reconstrói estado.
- `Wallet`: aggregate root com `open` e `rehydrate`; débito/crédito retornam lançamento, atualizam saldo e incrementam versão somente quando o saldo muda. IDs e horários são recebidos por parâmetro.
- `WagerTransaction`: enums de tipo/status, criação pública em `PENDING`, factory interna de `OPENING`, reidratação sem validar histórico de transições, transições permitidas, consultas e direção do ledger.
- `FailureCode` e erros de domínio tipados em arquivo próprio.
- Testes unitários co-localizados; sem dependência de NestJS, MikroORM ou banco no domínio.

### Etapa 6A — persistência

- Nova migration `Migration20261112200000` adiciona `observed_balance_cents` com checks para não-negatividade e obrigatoriedade em transações `PROCESSED`/`REJECTED`; a migration anterior não foi alterada.
- Portas `WageringUnitOfWork`, `WageringTx` e repositórios de wallet, transação, ledger e outbox em `src/wagering/application/ports/`.
- Adaptadores MikroORM usam `EntityManager.transactional()` e SQL parametrizado; wallet usa `SELECT ... FOR UPDATE` e controle otimista de versão; o ledger só expõe `insert`.
- Mapeamento de centavos centralizado: leitura de `BIGINT` como string seguida de `BigInt`, sem conversão monetária para `number`.
- `computePayloadHash` gera SHA-256 de JSON canônico dos campos de negócio especificados, sem idempotency key nem metadados.
- Testes cobrem schema, round-trips de persistência, concorrência de versão, append-only do ledger, conversão monetária e canonicalização do hash.
- Nenhum use case ou endpoint foi adicionado nesta etapa.

### Etapa 6B — casos de uso

- Adicionados os ports `Clock` e `IdGenerator`, com `SystemClock` e implementação `BunIdGenerator` usando UUIDv7. O Unit of Work agora cria um `EntityManager` forkado por execução.
- A busca idempotente retorna a transação e o saldo originalmente observado, usando a moeda da wallet mesmo em rejeições por divergência de moeda.
- Implementados os erros de aplicação, `PLAYER_MISMATCH` e os eventos de integração tipados, serializados como envelope JSON com valores monetários em `MoneyProps`.
- `SubmitWagerTransactionUseCase` processa BET/WIN/LOSS, persiste rejeições, aplica replay idempotente, grava ledger e outbox atomicamente; REFUND/ROLLBACK/OPENING são rejeitados antes de abrir a transação.
- `CreateWalletUseCase` cria wallets com ou sem saldo inicial; saldo positivo grava OPENING, ledger CREDIT e eventos na mesma transação.
- Testes PostgreSQL cobrem processamento, replay e conflito, rejeições, eventos, criação de wallet e duas apostas simultâneas disputando o mesmo saldo. Ainda não foram adicionados controllers ou módulos NestJS.
- Para a etapa 7: transações `PENDING_REFERENCE` podem não ter `observed_balance`; o replay deverá aceitar saldo observado ausente e a resposta HTTP será `202` sem saldo.

## Validação executada

Sequência de migrations:

1. `bun run migration:down` — sucesso.
2. `bun run migration:up` — sucesso.

Ao reexecutar `up` após `down`, uma fixture de teste `PROCESSED` ficou sem o valor observado removido pelo `down`; a fixture local foi revertida para `PENDING` e `up` concluiu. Como o Unit of Work agora usa um fork com transação própria, os testes de persistência usam identificadores aleatórios e não dependem de rollback externo.

Validação após a etapa 6B:

1. `bun test` — 86 pass, 0 fail (369 assertions), com PostgreSQL real.
2. `bun run typecheck` — sucesso (`tsc --noEmit`, exit code 0).

Foram lidas as seções 6, 7, 8 e 11 de `DESAFIO.md` e as regras de `.github/copilot-instructions.md` antes da implementação da etapa 6B.
