# Status do projeto

Atualizado em: 2026-11-13

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
- Transações `PENDING_REFERENCE` podem não ter `observed_balance`; a etapa 7 implementa o replay sem saldo observado, permitindo resposta HTTP `202` sem saldo.

### Etapa 7 — REFUND, ROLLBACK e referências pendentes

- `REFUND` e `ROLLBACK` agora são processados após o lock da wallet, resolvendo a referência por provider e ID externo dentro da mesma transação; a lógica de resolução ficou reutilizável para o worker futuro.
- Referência ausente gera `PENDING_REFERENCE` e evento de outbox, sem saldo/ledger observado; replay preserva o saldo ausente. Estornos válidos gravam `reference_transaction_id` e ledger atômico, com `REFUND` como crédito e `ROLLBACK` na direção inversa.
- Validações persistem rejeições com `REFERENCE_MISMATCH`, `INVALID_REFERENCE_KIND`, `AMOUNT_MISMATCH`, `ALREADY_REVERSED` ou `REVERSAL_WOULD_OVERDRAW`.
- Decisão: cada transação referenciada pode ter no máximo um estorno processado no total, seja `REFUND` ou `ROLLBACK`; migration ajusta o índice único parcial como segunda proteção contra concorrência.
- Testes PostgreSQL cobrem REFUND de BET, ROLLBACK de WIN, referência fora de ordem, rejeições de referência/valor, overdraw e corrida REFUND/ROLLBACK sobre a mesma BET. O worker da etapa 12 não foi criado.

### Etapa 8 — API HTTP NestJS

- `AppModule` registra controllers, casos de uso, `MikroORM`, Unit of Work, relógio, gerador de IDs e repositório de consultas. `AuthGuard` no-op protege wallet e wagering; health segue público. A decisão de autenticação futura está em `ARCHITECTURE.md`.
- Implementados `POST /wallets`, `GET /wallets/:walletId`, `GET /wallets/:walletId/ledger`, `POST /wagering/transactions`, `GET /wagering/transactions/:transactionId` e a consulta por provider/ID externo. Cursor do ledger é base64 da sequência monotônica; limit padrão 50 e máximo 100.
- `Idempotency-Key` é obrigatório; campos monetários HTTP exigem strings decimais com duas casas. Um exception filter global padroniza erros como `{ error: { code, message } }`.
- Mapa HTTP: processamento e replay `200`; wallet criada `201`; `PENDING_REFERENCE` `202` sem saldo; payload inválido `400`; recurso ausente `404`; conflito de idempotência e wallet duplicada `409`; rejeição `422` com `failureCode`; falha transitória do banco `503` com `Retry-After`.
- Migration adiciona sequência identity ao ledger e índice de consulta por wallet/sequência. E2E usa NestJS real, `app.listen(0)`, `fetch` e PostgreSQL, cobrindo criação/duplicidade, BET/replay/conflito, rejeição sem saldo, referência pendente, validação, 404 e paginação.

### Etapa 9 — concorrência HTTP e multi-instância

- Configurados o pool PostgreSQL por `DB_POOL_MAX` (padrão 10) e o `lock_timeout` local por `DB_LOCK_TIMEOUT_MS` (padrão 5000 ms); timeout de lock mantém resposta transitória HTTP `503` com `Retry-After`.
- `main.ts` já aceitava `PORT` com padrão 3000; preservada a implementação existente.
- Adicionado helper compartilhado de teste que compara saldo com o ledger, valida continuidade dos saldos por `seq` e exige `wallet.version == 1 + lançamentos não-OPENING` (o crédito `OPENING` inicial não incrementa a versão).
- `src/concurrency.e2e.test.ts` cobre concorrência HTTP real, replay, payload divergente, mistura BET/WIN, wallets independentes, estornos concorrentes e referência pendente.
- `src/multi-instance.e2e.test.ts` sobe três processos reais com Bun e distribui as requisições entre eles; cada cenário verifica banco, outbox e invariantes do ledger.
- Respostas HTTP `422` incluem `idempotentReplay`, permitindo distinguir a rejeição original do replay; no replay, o corpo é idêntico ao original exceto pelo campo `idempotentReplay` agora verdadeiro.

## Validação executada

Sequência de migrations:

1. `bun run migration:down` — sucesso.
2. `bun run migration:up` — sucesso.

Ao reexecutar `up` após `down`, uma fixture de teste `PROCESSED` ficou sem o valor observado removido pelo `down`; a fixture local foi revertida para `PENDING` e `up` concluiu. Como o Unit of Work agora usa um fork com transação própria, os testes de persistência usam identificadores aleatórios e não dependem de rollback externo.

Validação após a etapa 6B:

1. `bun test` — 87 pass, 0 fail (369 assertions), com PostgreSQL real.
2. `bun run typecheck` — sucesso (`tsc --noEmit`, exit code 0).

Foram lidas as seções 6, 7, 8 e 11 de `DESAFIO.md` e as regras de `.github/copilot-instructions.md` antes da implementação da etapa 6B.

Validação da etapa 8:

1. `bun test` — 101 testes, 0 falhas, com PostgreSQL real.
2. `bun run typecheck` — sucesso (`tsc --noEmit`, exit code 0).

Validação da etapa 9:

1. `bun test` — três execuções consecutivas: cada uma com 110 testes aprovados e 0 falhas (1046 assertions).
2. `bun run typecheck` — sucesso (`tsc --noEmit`, exit code 0).
