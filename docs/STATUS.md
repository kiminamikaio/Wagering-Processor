# Status do projeto

Atualizado em: 2026-11-12

## Estado desta etapa

A migration inicial `Migration20261112180000` agora inclui os campos de identidade e referência em `wager_transactions`, valida a relação entre tipo/status e os campos de referência/falha, e cria o índice parcial para referências pendentes. O ledger tem índice por `(wallet_id, id)`, CHECK aritmético simplificado e proteção contra `TRUNCATE`, além de `UPDATE` e `DELETE`. `inbox_messages.message_id` é `TEXT` e `payload_hash` é obrigatório.

O teste de integração verifica as novas constraints de campos obrigatórios, referência externa de REFUND/ROLLBACK e `failure_code` de acordo com status; também verifica o hash obrigatório da inbox, `message_id` textual, tentativas padrão, índices e trigger contra `TRUNCATE`.

## Validação executada

Sequência concluída:

1. `bun run infra:reset` — sucesso.
2. `bun run infra:up` — sucesso.
3. `bun run migration:up` — sucesso.
4. `bun run migration:down` — sucesso.
5. `bun run migration:up` — sucesso.
6. `bun test` — 35 pass, 0 fail (87 assertions).
7. `bun run typecheck` — sucesso (`tsc --noEmit`, exit code 0).

## Enunciado oficial

`docs/DESAFIO.md` não foi encontrado neste checkout (nem na árvore local nem entre os arquivos rastreados); portanto, o enunciado oficial não pôde ser consultado. Este status registra apenas o código e a solicitação disponível.
