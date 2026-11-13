# Architecture decisions

## Authentication

Authentication is intentionally deferred because it is outside the challenge's
scored scope. `AuthGuard` is currently a no-op extension point applied to wallet
and wagering endpoints; health endpoints remain public. A future deployment
should validate bearer tokens issued by an external OIDC identity provider
(such as Keycloak or Zitadel), rather than implement password storage in this
service.

## Concurrency

The concurrency unit is `walletId`. Every wagering transaction runs in a SQL
transaction and locks its wallet row with `SELECT ... FOR UPDATE` before reading
or changing the balance. A pessimistic lock is deliberate: a hot wallet is
expected to contend, and optimistic locking would turn normal contention into
conflicts that require retries, complicating idempotency and increasing work
under load. Transactions for different wallets can still proceed independently.

Each transaction sets PostgreSQL's local `lock_timeout` to
`DB_LOCK_TIMEOUT_MS` (default 5000 ms). A PostgreSQL lock-timeout error is
transient and the HTTP exception filter responds with `503` and `Retry-After`,
so a caller can safely retry using its idempotency key.

The wallet starts at version 1. An initial positive balance is represented by
an `OPENING` credit, which does not increment the wallet version. Later
balance-changing ledger entries advance the version once.

The lock is enforced by PostgreSQL, not by process-local state. Consequently,
any number of service instances sharing the same database serialize operations
on the same wallet while retaining parallelism across wallets. SQS FIFO ordering
by wallet is a useful optimization that can reduce lock contention, but the
database constraints and wallet lock remain the final correctness guarantee.
