# Erros e correções

Itens confirmados no histórico, no código atual, nos testes e em
`docs/STATUS.md`. Quando o registro não permite provar qual teste revelou um
problema, isso é indicado explicitamente como “não registrado”.

| # | Etapa | Erro (o que acontecia) | Como foi encontrado (qual teste: arquivo e nome do teste, ou typecheck, ou execução manual) | Causa | Correção | Commit | Teste que hoje impede a volta do erro |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Domínio | `WagerTransaction` aceitava transições sem guardas suficientes e não protegia de forma completa as referências/regras de estado. | não registrado | As operações de transição não aplicavam integralmente a matriz de estados permitidos e as exigências de referência. | Adicionadas guardas de referência e validação da matriz; estados terminais não podem transicionar. | `e222073` | `src/wagering/domain/wager-transaction.test.ts` — `enforces the complete state transition matrix`, `requires an internal reference before processing refunds and rollbacks`, `rejects every transition from terminal states`. |
| 2 | Persistência | A persistência de wagering não tinha garantias transacionais e lock pessimista suficientes para operações concorrentes. | não registrado | A leitura/alteração de wallet e os registros financeiros precisavam compartilhar a mesma transação e lock no banco. | Criado o Unit of Work transacional com lock pessimista da wallet, persistência de ledger/outbox e mapeamento exato de centavos. | `80392bc` | `src/wagering/application/use-cases.integration.test.ts` — `serializes concurrent bets on one wallet so only one can spend the balance`; `src/wagering/infrastructure/database/persistence.integration.test.ts` — `round-trips wallets and saves with an expected version`. |
| 3 | Casos de uso | Uma operação `LOSS`, que não altera saldo, ainda fazia `UPDATE` da linha da wallet. | não registrado | O fluxo persistia a wallet mesmo quando não havia mudança financeira. | Evitado o `UPDATE` desnecessário; incluída verificação do tuple PostgreSQL antes/depois do `LOSS`. | `8347417` | `src/wagering/application/use-cases.integration.test.ts` — `does not write the wallet row when processing LOSS`. |
| 4 | Wallet/versionamento | O crédito inicial `OPENING` incrementava a versão, apesar de a wallet já nascer com `version = 1`. | não registrado | A versão era associada ao lançamento, não à mudança efetiva do saldo durante a criação. | A wallet nasce em versão 1; só incrementa ao mudar o saldo, e `OPENING` não avança a versão. | não registrado | `src/wagering/domain/wallet.test.ts` — `increments version only when a successful balance change occurs`; `src/wagering/application/use-cases.integration.test.ts` — `creates positive-balance wallets with an OPENING transaction, ledger, and events`. |
| 5 | HTTP/idempotência | Replay de uma transação `REJECTED` retornava HTTP 422 sem informar `idempotentReplay: true`. | não registrado | A resposta de rejeição não refletia o resultado de replay devolvido pelo caso de uso. | A resposta 422 agora inclui `idempotentReplay` e replay mantém o status/corpo original da rejeição. | não registrado | `src/concurrency.e2e.test.ts` — `serializes competing BETs and replays each original response`. |
| 6 | HTTP/concorrência | Erro PostgreSQL de `lock_timeout` era convertido em HTTP 500 em vez de falha transitória. | não registrado | O SQLSTATE de lock indisponível não estava classificado como erro transitório no filtro HTTP. | O timeout de lock é HTTP 503 e inclui `Retry-After: 1`. | não registrado | Não há teste atual identificado que force um `lock_timeout` e verifique `Retry-After`. |
| 7 | Migrations/testes | Após `migration:down`/`migration:up`, uma fixture `PROCESSED` ficou sem `observed_balance`, removido pelo `down`. | Execução manual de `bun run migration:down` seguida de `bun run migration:up`, registrada em `docs/STATUS.md`. | O rollback removeu a coluna e a fixture persistida continuou com status que exige saldo observado. | Fixture local revertida para `PENDING` antes do `up`; a limitação do ciclo down/up foi registrada. | `80392bc` (migration de `observed_balance`; correção da fixture durante a validação não tem commit identificado). | Não há teste atual identificado que reproduza o ciclo down/up com essa fixture. |
| 8 | Testes de persistência | IDs fixos nas fixtures podiam colidir ao executar testes de persistência repetidamente. | não registrado | Fixtures reutilizavam identificadores em banco persistente, inclusive depois de uma execução anterior. | Testes de persistência passaram a gerar IDs aleatórios. | `80392bc` | `src/wagering/infrastructure/database/persistence.integration.test.ts` — `round-trips wallets and saves with an expected version` (cria IDs aleatórios). |
| 9 | Repositório | Artefatos de build/relatórios (`tsconfig.tsbuildinfo` e `reports/`) não deveriam ser versionados. | não registrado | Arquivos gerados e relatórios de execução entraram ou podiam entrar no índice do Git. | `*.tsbuildinfo` e `reports/` foram adicionados ao `.gitignore`; relatórios rastreados foram removidos. | `111521c` (`*.tsbuildinfo`); `6590072` (`reports/`). | Não se aplica: a proteção atual é `.gitignore`, sem teste automatizado. |

## Problemas de ambiente

Sem teste associado:

- Bun fora do `PATH` no terminal do agente; o executável correto está em `/home/codespace/.bun/bin/bun`.
- A pasta `.bun-bootstrap` foi criada por engano durante a preparação do ambiente.
- LocalStack passou a exigir conta; o ambiente local foi trocado para MiniStack.
- Duas sessões do agente editaram os mesmos arquivos ao mesmo tempo; regra operacional: uma sessão de edição por vez.

## Lições

- Transações, locks, constraints e testes de integração devem proteger juntos cada invariante financeira.
- Uma operação sem mudança de saldo não deve escrever na wallet nem avançar sua versão.
- Replays precisam preservar não só o estado, mas também o contrato HTTP original.
- Testes repetíveis precisam de dados isolados e identificadores únicos.
- Registre a causa, o teste que a revelou e a regressão correspondente enquanto o contexto ainda está disponível.
