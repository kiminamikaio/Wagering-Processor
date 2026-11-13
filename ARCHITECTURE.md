# Decisões de arquitetura

## Visão geral

```text
HTTP ─┐
      ├─> caso de uso ── transação SQL ── PostgreSQL
SQS ──┘                    │                 ├─ wallets
                           │                 ├─ wager_transactions
                           │                 ├─ wallet_ledger_entries (append-only)
                           │                 ├─ inbox_messages
                           │                 └─ outbox_messages
                           │
                           └─ commit
                                │
                   publicador da outbox ──> SQS de saída

worker de referências pendentes ──> caso de uso/serviço de reversão
```

HTTP e SQS compartilham `SubmitWagerTransactionUseCase`. As alterações financeiras,
ledger, estado da transação, inbox (quando a entrada é SQS) e outbox são gravados
atomicamente no PostgreSQL. O publicador envia eventos somente depois do commit;
o worker periódico revisita reversões cuja referência ainda não chegou.

## MikroORM e valores monetários

MikroORM fornece a conexão PostgreSQL, transações, contexto de `EntityManager`,
migrations e configuração de pool. As operações financeiras usam repositórios
explícitos e SQL parametrizado onde é necessário controlar locks ou `SKIP LOCKED`;
isso mantém as garantias visíveis sem depender de um estado ORM em memória.

`Money` é imutável e mantém centavos inteiros como `bigint` no domínio. O banco
armazena centavos em colunas PostgreSQL `BIGINT`; o mapper lê como string e
converte para `BigInt`, sem passar por `number`. Na API e nos eventos, o valor é
uma string decimal de duas casas e a moeda é independente.

Não usamos `number`, pois inteiros grandes perdem exatidão além da faixa segura
do JavaScript e operações fracionárias introduzem arredondamento binário. Não
usamos `Decimal` no domínio nem `NUMERIC` para persistência: escala fixa de
centavos permite aritmética exata com `bigint`, checks simples no banco e
serialização explícita. O trade-off é que qualquer escala além de duas casas
exigiria uma mudança deliberada de representação e contrato.

## Esquema e invariantes no banco

As migrations estão em `src/shared/infrastructure/database/migrations/`.
Constraints, índices e triggers são parte da garantia financeira, não apenas
validações da aplicação:

- `wallets`: chave única `(player_id, currency)`, saldo não negativo e versão
  maior ou igual a 1.
- `wager_transactions`: chaves únicas para `idempotency_key` e para
  `(provider_id, external_transaction_id)`, valor positivo, status/tipo válidos,
  referência externa obrigatória em REFUND/ROLLBACK e `failure_code` coerente com
  status. Saldo observado é não negativo e obrigatório em PROCESSED/REJECTED.
- Índice parcial em transações `PENDING_REFERENCE` para buscar vencimentos.
- Índice parcial único limita a **uma reversão processada no total por transação
  de referência**, seja REFUND ou ROLLBACK.
- `wallet_ledger_entries`: chave única `(wallet_id, transaction_id)`, direção e
  valor válidos, check aritmético entre saldo anterior, valor e saldo posterior,
  saldo posterior não negativo e índice por wallet/sequência.
- Trigger rejeita `UPDATE`, `DELETE` e `TRUNCATE` no ledger. O repositório de
  ledger expõe apenas `INSERT`.
- Inbox tem chave primária `(consumer_name, message_id)`. Outbox tem índice
  parcial para mensagens não publicadas e vencidas, além de lease de publisher.

O saldo da wallet não pode ser negativo mesmo diante de uma falha de aplicação:
há constraint no banco, validação no domínio e lock transacional. Não existe
reconciliação automática; uma divergência é sinalizada para investigação.

## Concorrência e ordem de locks

A unidade de concorrência é `walletId`. Cada operação financeira abre uma
transação SQL, define `lock_timeout` local (`DB_LOCK_TIMEOUT_MS`, padrão
5000 ms), bloqueia a wallet com `SELECT ... FOR UPDATE`, depois resolve/bloqueia
a transação relacionada e grava wallet, ledger e outbox antes do commit. A ordem
de locks é **wallet → transação**. O worker faz um claim curto de IDs vencidos
com `FOR UPDATE SKIP LOCKED`; no processamento financeiro, segue a mesma ordem e
revalida status e vencimento.

Escolhemos lock pessimista no banco em vez de lock otimista como mecanismo
principal porque uma wallet quente já sofre contenção esperada. Optimistic
locking converteria essa contenção em conflitos e retries adicionais,
complicando idempotência e ampliando trabalho sob carga. A versão da wallet
permanece como marcador de mudança e verificação auxiliar, não substitui o lock.
Limitação: operações da mesma wallet são serializadas; a capacidade de uma
wallet quente é limitada pela duração da transação.

Timeout de lock é transitório e vira HTTP `503` com `Retry-After`; o chamador
pode reenviar com a mesma chave idempotente. A fila FIFO usa `walletId` como
`MessageGroupId` para reduzir contenção e preservar ordem de recebimento dentro
do grupo. FIFO é otimização, não garantia final: o banco continua protegendo
instâncias HTTP, workers e mensagens concorrentes.

A wallet nasce com `version = 1`. O crédito interno de `OPENING` representa o
saldo inicial, mas não incrementa a versão; ela só aumenta quando o saldo muda.
Uma operação LOSS não muda saldo e não grava novamente a linha da wallet.

## Idempotência e replay

A garantia é persistente: constraints únicas no banco protegem chave de
idempotência e identidade externa do provedor; não há cache em memória como fonte
de verdade. O `payloadHash` é SHA-256 de JSON canônico (chaves ordenadas) dos
campos de negócio: provedor, IDs externo/jogador/wallet/rodada/jogo, tipo,
dinheiro e referência externa. `Idempotency-Key` e metadados de transporte não
entram no hash.

Mesma chave e mesmo hash retornam a transação existente, inclusive o saldo
observado originalmente e o `failureCode` original. Uma rejeição repetida
continua HTTP `422`, com `idempotentReplay: true`. Mesma chave com payload
diferente é conflito `409`, não replay. Para estados sem saldo observado, como
`PENDING_REFERENCE`, o replay não inventa saldo.

## Referências fora de ordem

REFUND/ROLLBACK cuja referência ainda não existe é persistido como
`PENDING_REFERENCE`. O worker seleciona IDs vencidos com `FOR UPDATE SKIP LOCKED`
e processa cada candidato em transação própria, com lock wallet → transação.
Usa backoff exponencial com jitter (base de um segundo e teto de cinco minutos)
e encerra após oito tentativas ou TTL de 15 minutos. Ao esgotar o limite,
persiste `REFERENCE_NOT_FOUND` e gera evento na outbox.

O processamento de HTTP, SQS e worker compartilha `ApplyWagerReversalService`
para validação da referência, alteração de saldo, ledger e eventos. A regra é
mais rígida que o enunciado: uma transação só pode ser revertida uma vez no
total, entre REFUND e ROLLBACK. A constraint única parcial do banco também
impede duas reversões concorrentes.

## Caixa de saída transacional

Publicar diretamente durante o caso de uso deixaria banco e broker sujeitos a
falhas independentes. Em vez disso, a transação de wagering grava o envelope em
`outbox_messages` junto com saldo, transação e ledger. O publicador reclama lotes
em transação curta com `FOR UPDATE SKIP LOCKED`, define lease, faz commit e envia
ao SQS fora da transação. No sucesso, marca publicado somente se o lease ainda
pertence à instância; em falha, registra erro sem payload e agenda backoff.

A entrega ocorre pelo menos uma vez: a instância pode parar após o SQS aceitar a mensagem,
mas antes de registrar o sucesso no banco. Consumidores devem deduplicar por
`eventId`. A fila `wagering-events.fifo` usa `aggregateId` como grupo. Com vários
publishers, a ordem de saída por wallet é melhor esforço; `walletVersion` ajuda
consumidores a detectar lacunas ou ordenar eventos.

## Consumidor SQS e inbox

O consumidor da `wager-transactions.fifo` usa o mesmo caso de uso HTTP. Insere
`(consumer_name, message_id)` na inbox na mesma transação que aplica a operação,
grava ledger/outbox e marca a mensagem processada. `DeleteMessage` só ocorre
depois do commit; redelivery não duplica o efeito.

Erros de negócio são confirmados e reconhecidos. Falhas transitórias recebem
backoff por mudança de visibilidade e, ao exceder `SQS_MAX_RECEIVES`, vão para a
DLQ. JSON/schema inválidos, conflito de idempotência, wallet inexistente e
conflito de inbox são permanentes e vão diretamente para a DLQ. Se não for
possível enviar à DLQ, a mensagem original não é apagada. No shutdown, o
consumidor termina o trabalho iniciado e libera mensagens ainda não iniciadas.

## HTTP e autenticação

`AuthGuard` é intencionalmente no-op, aplicado aos endpoints de wallet e
wagering. O ponto de extensão é `src/http/auth.guard.ts`; liveness/readiness
permanecem públicos, assim como o enunciado determina. Em produção, adotaria um
provedor de identidade externo OIDC, como Keycloak: validar bearer token, issuer,
audience, expiração e scopes/roles no guard, e associar o subject autenticado à
identidade do provedor. Não implementaria armazenamento próprio de senhas neste
serviço.

## MiniStack

O Compose usa MiniStack para oferecer SQS local sem exigir conta LocalStack para
desenvolver e testar. As mesmas APIs AWS SDK são usadas em execução local; o
endpoint é configurado por `SQS_ENDPOINT`. O trade-off é que o emulador local
pode não reproduzir cada detalhe operacional do SQS gerenciado, portanto
comportamentos de produção que dependam de diferenças do serviço real precisam
ser validados separadamente.

## Observabilidade

`/health/live` verifica apenas o processo. `/health/ready` consulta PostgreSQL e
SQS em paralelo, com timeout individual de dois segundos, e retorna 503 quando
uma dependência falha. Logs JSON e `X-Correlation-Id` propagam contexto entre
HTTP, SQS, outbox e worker sem registrar payloads, valores monetários, saldos ou
headers de autorização.

`/metrics` expõe métricas Prometheus: transações por status/tipo/canal,
duplicatas, retries, DLQ, conflitos de lock, divergências, latência, estado/lag
da outbox e referências pendentes. Reconciliação compara saldo da wallet com a
soma do ledger na mesma transação e não corrige divergências automaticamente.

## Limitações conhecidas e próximos passos

- Contadores e histograma ficam em memória por instância e são reiniciados no
  restart; a agregação depende do scrape do Prometheus.
- Com múltiplos publishers, a ordem de eventos de saída por wallet é melhor
  esforço; o consumidor deve usar `walletVersion` para detectar ordenação.
- O publicador, consumidor e worker de referências fazem polling; não há
  coordenação via notificações/eventos do banco.
- Não há teste de carga nem metas de vazão/latência medidas.
- `AuthGuard` ainda não valida credenciais; integrar um IdP OIDC é trabalho de
  produção pendente.

## Uso de IA

Escrevi o código com GitHub Copilot em modo Agent, etapa por etapa, apresentando
um plano antes de executar cada etapa. As regras fixas de implementação estão
em `.github/copilot-instructions.md`. Um mentor de IA me explicou conceitos e
ajudou a escrever os prompts; eu revisei cada etapa e rodei os testes três vezes
contra PostgreSQL e SQS reais em containers. Registrei os erros encontrados e as
correções em [docs/ERROS-E-CORRECOES.md](./docs/ERROS-E-CORRECOES.md).
