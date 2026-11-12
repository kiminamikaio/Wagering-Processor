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

## Validação executada

Sequência de infraestrutura concluída na etapa anterior:

1. `bun run infra:reset` — sucesso.
2. `bun run infra:up` — sucesso.
3. `bun run migration:up` — sucesso.
4. `bun run migration:down` — sucesso.
5. `bun run migration:up` — sucesso.

Validação após a etapa 5:

1. `bun test` — 57 pass, 0 fail (199 assertions).
2. `bun run typecheck` — sucesso (`tsc --noEmit`, exit code 0).

Foram lidas as seções 5, 6 e 7 de `DESAFIO.md` e as regras de `.github/copilot-instructions.md` antes da implementação.
