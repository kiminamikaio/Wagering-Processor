# Regras do projeto

1. Dinheiro nunca é `number`, float ou double. Use uma string decimal com 2 casas e um value object `Money`.
2. O saldo só muda dentro de uma transação SQL com lock da wallet, gravando ledger e outbox na mesma transação.
3. O ledger aceita apenas `INSERT`: nunca use `UPDATE` nem `DELETE`.
4. Nenhum evento é publicado antes do commit; use uma transactional outbox.
5. A idempotência é garantida por constraints únicas no banco, nunca em memória.
