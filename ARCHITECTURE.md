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

## Transactional Outbox

The application does not publish an integration event directly while handling
a wager. A direct publish and a database commit are two independent writes:
either can succeed while the other fails, leaving a committed balance change
without an event or an event for a rolled-back change. Instead, the event
envelope is inserted into `outbox_messages` in the same SQL transaction as the
wallet, ledger, and wager transaction updates.

The publisher claims eligible rows in a short transaction with
`FOR UPDATE SKIP LOCKED`, ordered by event time and ID. It records an instance
ID and a lease expiration, commits, then sends to `wagering-events.fifo`
outside the transaction. A successful send is marked published only while the
row is still locked by that instance. A failed send increments the attempt
count, records a payload-free error summary, and schedules an exponential
backoff with jitter, capped at five minutes. Expired leases allow another
instance to reclaim work after a publisher stops unexpectedly.

Delivery is at-least-once: a process can stop after SQS accepts a message but
before the database records it as published. The consumer must deduplicate by
the envelope's `eventId`; FIFO deduplication uses that same ID, but is not a
substitute for consumer-side idempotency. `aggregateId` is the FIFO message
group, so ordering for a wallet is best effort when multiple publishers claim
rows concurrently. Consumers that require strict per-wallet ordering can use
the envelope's wallet version to detect and order events.

## SQS Transaction Consumer

The `wager-transactions.fifo` consumer invokes the same
`SubmitWagerTransactionUseCase` as HTTP. For SQS input, the use case inserts the
`(consumer_name, message_id)` inbox row, applies the wager, writes the ledger and
outbox, and sets `processed_at` in one SQL transaction. `message_id` is taken
from the message envelope, never from SQS's `MessageId`. The HTTP path does not
provide inbox data and retains its existing behavior.

The consumer acknowledges with `DeleteMessage` only after the SQL transaction
commits. A failed delete is logged and left for safe redelivery through the
inbox. Same-ID/same-hash redelivery is acknowledged without repeating effects;
same-ID/different-hash input is permanent.

| Classification | Examples | Action |
| --- | --- | --- |
| Business | `REJECTED` with `failureCode`, `PENDING_REFERENCE`, idempotent replay | Commit and delete |
| Transient | Database/SQS outage, connection or timeout, `lock_timeout`, deadlock, serialization failure | Keep in the main queue and change visibility with exponential backoff |
| Permanent | Invalid JSON/schema, idempotency conflict, missing wallet, inbox ID with a different payload | Send to `wager-transactions-dlq.fifo` with `errorCode` and `consumerName` attributes, then delete |

`SQS_MAX_RECEIVES` defaults to 5. A transient failure at or above that receive
count is also moved to the DLQ, independently of MiniStack redrive behavior.
`SQS_RETRY_MAX_DELAY_SECONDS` caps the visibility backoff. If sending to the
DLQ fails, the original message is retained and retried.

FIFO message groups use `walletId`; processing is sequential within each group
and parallel across groups. A poison message can block later messages for its
wallet until it is moved to the DLQ, so permanent failures must be removed
promptly. On `SIGTERM`, the consumer stops receiving, finishes started
messages, and changes visibility to zero for messages not yet started in the
received batch. Set `SQS_CONSUMER_ENABLED=true` to start the background
long-poll loop; `pollOnce()` remains available for controlled processing.
