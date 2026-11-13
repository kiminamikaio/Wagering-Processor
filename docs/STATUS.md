# Status do projeto

Atualizado em: 2026-11-13

## Etapas

| Etapa | Situação | Entrega |
| --- | --- | --- |
| 1 | Concluída | Fundação Bun, TypeScript e NestJS. |
| 2 | Concluída | Infraestrutura local com PostgreSQL e MiniStack/SQS. |
| 3 | Concluída | Value object `Money` com aritmética exata em centavos. |
| 4 | Concluída | Migrations, schema, constraints e testes de integração do banco. |
| 5 | Concluída | Domínio de wallet, transação, ledger e transições válidas. |
| 6A | Concluída | Persistência transacional, repositories, lock pessimista e hash canônico. |
| 6B | Concluída | Casos de uso de wallet e wagering, eventos, ledger e outbox atômicos. |
| 7 | Concluída | REFUND/ROLLBACK, referências fora de ordem e worker de pendências. |
| 8 | Concluída | API HTTP, validação, idempotência e mapa de status. |
| 9 | Concluída | Concorrência por wallet, 50 replays e testes com três instâncias. |
| 10 | Concluída | Publicador SQS com transactional outbox, lease e recuperação. |
| 11 | Concluída | Consumidor SQS com inbox, retries, DLQ e shutdown. |
| 12 | Concluída | Worker de referências pendentes e resolução/rejeição por política. |
| 13 | Concluída | Health, logs JSON, métricas e reconciliação. |
| 14 | Concluída | Documentação final, erros registrados, README e arquitetura revisados. |

## Validação final da etapa 14

- `bun test` — **150 testes aprovados**, sem falhas (PostgreSQL e MiniStack reais em containers).
- `bun run typecheck` — sucesso (`tsc --noEmit`, exit code 0).

O conjunto cobre unidade, schema/persistência, casos de uso, HTTP, concorrência,
multi-instância, consumidor/outbox, DLQ, worker de referências, reinício e
shutdown. Não há teste de carga.

## Histórico relevante da validação

Na execução de migrations `down` seguida de `up`, uma fixture de teste
`PROCESSED` permaneceu sem `observed_balance`, removido pelo `down`. A fixture
foi revertida para `PENDING` antes do `up`. Os testes de persistência passaram a
usar IDs aleatórios para não colidir entre execuções. O episódio está detalhado
em [ERROS-E-CORRECOES.md](./ERROS-E-CORRECOES.md).

As validações históricas registradas nas etapas 9 a 13 foram executadas três
vezes cada; na etapa 13, cada rodada informou 150 testes aprovados, zero falhas e
2150 assertions, incluindo PostgreSQL e MiniStack reais. A etapa 14 repete a
validação completa uma vez.

## Documentação

- [Erros e correções](./ERROS-E-CORRECOES.md)
- [Decisões de arquitetura](../ARCHITECTURE.md)
- [Enunciado do desafio](./DESAFIO.md)
