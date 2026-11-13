import "./test-support/disable-outbox-publisher";
import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { MikroORM } from "@mikro-orm/postgresql";
import { AppModule } from "./app.module";
import { metricsRegistry } from "./observability/metrics-registry";
import { executeRows } from "./wagering/infrastructure/database/sql";

let app: INestApplication;
let baseUrl: string;

async function postJson(
  path: string,
  body: unknown,
  idempotencyKey?: string,
): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(idempotencyKey === undefined
        ? {}
        : { "idempotency-key": idempotencyKey }),
    },
    body: JSON.stringify(body),
  });
}

function wagerBody(
  walletId: string,
  playerId: string,
  overrides: Record<string, unknown> = {},
) {
  const suffix = Bun.randomUUIDv7();
  return {
    providerId: "provider-e2e",
    externalTransactionId: `external-${suffix}`,
    playerId,
    walletId,
    roundId: "round-e2e",
    gameId: "game-e2e",
    kind: "BET",
    money: { amount: "1.00", currency: "BRL" },
    ...overrides,
  };
}

describe("HTTP API (NestJS + PostgreSQL)", () => {
  beforeAll(async () => {
    app = await NestFactory.create(AppModule);
    await app.get(MikroORM).getMigrator().up();
    await app.listen(0, "127.0.0.1");
    const address = app.getHttpServer().address() as { port: number } | null;
    if (address === null) {
      throw new Error("Nest did not expose an ephemeral HTTP port.");
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await app?.close();
  });

  it("creates wallets and reports duplicate player/currency as a conflict", async () => {
    const playerId = Bun.randomUUIDv7();
    const body = {
      playerId,
      initialBalance: { amount: "20.00", currency: "BRL" },
    };
    const created = await postJson("/wallets", body);
    expect(created.status).toBe(201);
    const wallet = await created.json();
    expect(wallet).toMatchObject({
      playerId,
      balance: { amount: "20.00", currency: "BRL" },
      version: 1,
    });

    const fetched = await fetch(`${baseUrl}/wallets/${wallet.id}`);
    expect(fetched.status).toBe(200);
    expect(await fetched.json()).toMatchObject({
      id: wallet.id,
      playerId,
      balance: { amount: "20.00", currency: "BRL" },
    });

    const duplicate = await postJson("/wallets", body);
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toMatchObject({
      error: { code: "WALLET_ALREADY_EXISTS" },
    });
  });

  it("processes and replays BETs, rejects changed payloads and insufficient funds", async () => {
    const playerId = Bun.randomUUIDv7();
    const created = await postJson("/wallets", {
      playerId,
      initialBalance: { amount: "10.00", currency: "BRL" },
    });
    const wallet = await created.json();
    const body = wagerBody(wallet.id, playerId, {
      money: { amount: "3.00", currency: "BRL" },
    });
    const key = `key-${Bun.randomUUIDv7()}`;

    const first = await postJson("/wagering/transactions", body, key);
    expect(first.status).toBe(200);
    const processed = await first.json();
    expect(processed).toMatchObject({
      status: "PROCESSED",
      balance: { amount: "7.00", currency: "BRL" },
      idempotentReplay: false,
    });

    const replay = await postJson("/wagering/transactions", body, key);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({
      transactionId: processed.transactionId,
      idempotentReplay: true,
    });

    const changed = await postJson(
      "/wagering/transactions",
      { ...body, money: { amount: "2.00", currency: "BRL" } },
      key,
    );
    expect(changed.status).toBe(409);
    expect(await changed.json()).toMatchObject({
      error: { code: "IDEMPOTENCY_CONFLICT" },
    });

    const insufficient = await postJson(
      "/wagering/transactions",
      wagerBody(wallet.id, playerId, {
        money: { amount: "99.00", currency: "BRL" },
      }),
      `key-${Bun.randomUUIDv7()}`,
    );
    expect(insufficient.status).toBe(422);
    expect(await insufficient.json()).toMatchObject({
      error: { code: "INSUFFICIENT_FUNDS" },
      status: "REJECTED",
      failureCode: "INSUFFICIENT_FUNDS",
    });

    const transactionById = await fetch(
      `${baseUrl}/wagering/transactions/${processed.transactionId}`,
    );
    expect(transactionById.status).toBe(200);
    expect(await transactionById.json()).toMatchObject({
      transactionId: processed.transactionId,
      status: "PROCESSED",
    });
    const transactionByExternalId = await fetch(
      `${baseUrl}/providers/provider-e2e/wagering/transactions/${body.externalTransactionId}`,
    );
    expect(transactionByExternalId.status).toBe(200);
  });

  it("returns pending reference, validates the key and money type, and reports missing wallets", async () => {
    const playerId = Bun.randomUUIDv7();
    const created = await postJson("/wallets", {
      playerId,
      initialBalance: { amount: "0.00", currency: "BRL" },
    });
    const wallet = await created.json();
    const pendingBody = wagerBody(wallet.id, playerId, {
      kind: "ROLLBACK",
      referenceExternalTransactionId: `not-yet-arrived-${Bun.randomUUIDv7()}`,
    });
    const pending = await postJson(
      "/wagering/transactions",
      pendingBody,
      `key-${Bun.randomUUIDv7()}`,
    );
    expect(pending.status).toBe(202);
    expect(await pending.json()).toMatchObject({
      status: "PENDING_REFERENCE",
      idempotentReplay: false,
    });

    const missingKey = await postJson(
      "/wagering/transactions",
      wagerBody(wallet.id, playerId),
    );
    expect(missingKey.status).toBe(400);

    const numericAmount = wagerBody(wallet.id, playerId, {
      money: { amount: 1, currency: "BRL" },
    });
    const badAmount = await postJson(
      "/wagering/transactions",
      numericAmount,
      `key-${Bun.randomUUIDv7()}`,
    );
    expect(badAmount.status).toBe(400);
    expect(await badAmount.json()).toMatchObject({
      error: { code: "INVALID_REQUEST" },
    });

    const missingWallet = await postJson(
      "/wagering/transactions",
      wagerBody(Bun.randomUUIDv7(), Bun.randomUUIDv7()),
      `key-${Bun.randomUUIDv7()}`,
    );
    expect(missingWallet.status).toBe(404);
    expect(await missingWallet.json()).toMatchObject({
      error: { code: "WALLET_NOT_FOUND" },
    });
  });

  it("paginates the ledger using an opaque sequence cursor", async () => {
    const playerId = Bun.randomUUIDv7();
    const created = await postJson("/wallets", {
      playerId,
      initialBalance: { amount: "10.00", currency: "BRL" },
    });
    const wallet = await created.json();

    for (let index = 0; index < 2; index += 1) {
      const wager = await postJson(
        "/wagering/transactions",
        wagerBody(wallet.id, playerId),
        `key-${Bun.randomUUIDv7()}`,
      );
      expect(wager.status).toBe(200);
    }

    const firstResponse = await fetch(
      `${baseUrl}/wallets/${wallet.id}/ledger?limit=1`,
    );
    expect(firstResponse.status).toBe(200);
    const first = await firstResponse.json();
    expect(first.items).toHaveLength(1);
    expect(typeof first.nextCursor).toBe("string");

    const secondResponse = await fetch(
      `${baseUrl}/wallets/${wallet.id}/ledger?limit=1&cursor=${encodeURIComponent(first.nextCursor)}`,
    );
    const second = await secondResponse.json();
    expect(second.items).toHaveLength(1);
    expect(second.items[0].id).not.toBe(first.items[0].id);
  });

  it("reconciles the ledger after BET, WIN, REFUND, and ROLLBACK", async () => {
    const playerId = Bun.randomUUIDv7();
    const created = await postJson("/wallets", {
      playerId,
      initialBalance: { amount: "20.00", currency: "BRL" },
    });
    const wallet = await created.json();
    const bet = wagerBody(wallet.id, playerId, {
      money: { amount: "2.00", currency: "BRL" },
    });
    const win = wagerBody(wallet.id, playerId, {
      kind: "WIN",
      money: { amount: "3.00", currency: "BRL" },
    });
    const refund = wagerBody(wallet.id, playerId, {
      kind: "REFUND",
      referenceExternalTransactionId: bet.externalTransactionId,
      money: { amount: "2.00", currency: "BRL" },
    });
    const rollback = wagerBody(wallet.id, playerId, {
      kind: "ROLLBACK",
      referenceExternalTransactionId: win.externalTransactionId,
      money: { amount: "3.00", currency: "BRL" },
    });

    for (const [body, key] of [
      [bet, `key-${Bun.randomUUIDv7()}`],
      [win, `key-${Bun.randomUUIDv7()}`],
      [refund, `key-${Bun.randomUUIDv7()}`],
      [rollback, `key-${Bun.randomUUIDv7()}`],
    ] as const) {
      const response = await postJson("/wagering/transactions", body, key);
      expect(response.status).toBe(200);
    }

    const response = await fetch(
      `${baseUrl}/wallets/${wallet.id}/reconciliation`,
      { method: "POST" },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      walletId: wallet.id,
      storedBalance: { amount: "20.00", currency: "BRL" },
      calculatedBalance: { amount: "20.00", currency: "BRL" },
      difference: { amount: "0.00", currency: "BRL" },
      consistent: true,
      checkedEntries: 5,
    });
  });

  it("reports ledger divergence without correcting the wallet and increments its metric", async () => {
    const playerId = Bun.randomUUIDv7();
    const created = await postJson("/wallets", {
      playerId,
      initialBalance: { amount: "10.00", currency: "BRL" },
    });
    const wallet = await created.json();
    const before = metricsRegistry.counterValue("reconciliation_divergences_total");
    await app
      .get(MikroORM)
      .em.getConnection()
      .execute("UPDATE wallets SET balance_cents = balance_cents + 100 WHERE id = ?", [
        wallet.id,
      ]);

    const response = await fetch(
      `${baseUrl}/wallets/${wallet.id}/reconciliation`,
      { method: "POST" },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      walletId: wallet.id,
      storedBalance: { amount: "11.00", currency: "BRL" },
      calculatedBalance: { amount: "10.00", currency: "BRL" },
      difference: { amount: "1.00", currency: "BRL" },
      consistent: false,
      checkedEntries: 1,
    });
    expect(metricsRegistry.counterValue("reconciliation_divergences_total")).toBe(
      before + 1,
    );
    const stillDivergent = await fetch(
      `${baseUrl}/wallets/${wallet.id}/reconciliation`,
      { method: "POST" },
    );
    expect((await stillDivergent.json()).consistent).toBe(false);
  });

  it("returns 404 for a missing reconciliation wallet", async () => {
    const response = await fetch(
      `${baseUrl}/wallets/${Bun.randomUUIDv7()}/reconciliation`,
      { method: "POST" },
    );
    expect(response.status).toBe(404);
  });

  it("exposes request correlation and Prometheus counters without transaction payloads", async () => {
    const playerId = Bun.randomUUIDv7();
    const created = await postJson("/wallets", {
      playerId,
      initialBalance: { amount: "5.00", currency: "BRL" },
    });
    const wallet = await created.json();
    const wager = wagerBody(wallet.id, playerId, {
      money: { amount: "2.00", currency: "BRL" },
    });
    const idempotencyKey = `key-${Bun.randomUUIDv7()}`;
    const correlationId = `correlation-${Bun.randomUUIDv7()}`;
    const initialProcessed = metricsRegistry.counterValue(
      "wager_transactions_total",
      { status: "PROCESSED", type: "BET", channel: "http" },
    );
    const initialRejected = metricsRegistry.counterValue(
      "wager_transactions_total",
      { status: "REJECTED", type: "BET", channel: "http" },
    );
    const first = await fetch(`${baseUrl}/wagering/transactions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": idempotencyKey,
        "x-correlation-id": correlationId,
      },
      body: JSON.stringify(wager),
    });
    expect(first.headers.get("x-correlation-id")).toBe(correlationId);
    expect(first.status).toBe(200);
    const firstBody = await first.json();
    const replay = await postJson("/wagering/transactions", wager, idempotencyKey);
    expect((await replay.json()).idempotentReplay).toBe(true);

    const rejected = await postJson(
      "/wagering/transactions",
      wagerBody(wallet.id, playerId, {
        money: { amount: "99.00", currency: "BRL" },
      }),
      `key-${Bun.randomUUIDv7()}`,
    );
    expect(rejected.status).toBe(422);

    const eventRows = await executeRows(
      app.get(MikroORM).em.fork(),
      `SELECT payload->>'correlationId' AS correlation_id
       FROM outbox_messages
      WHERE event_type = 'WagerTransactionProcessed'
        AND payload->'data'->>'transactionId' = ?`,
      [firstBody.transactionId],
    );
    expect(eventRows).toHaveLength(1);
    expect(eventRows[0]!.correlation_id).toBe(correlationId);
    expect(
      metricsRegistry.counterValue("wager_transactions_total", {
        status: "PROCESSED",
        type: "BET",
        channel: "http",
      }),
    ).toBe(initialProcessed + 2);
    expect(
      metricsRegistry.counterValue("wager_transactions_total", {
        status: "REJECTED",
        type: "BET",
        channel: "http",
      }),
    ).toBe(initialRejected + 1);
    expect(
      metricsRegistry.counterValue("idempotency_duplicates_total", {
        channel: "http",
      }),
    ).toBeGreaterThan(0);

    const metrics = await fetch(`${baseUrl}/metrics`);
    expect(metrics.status).toBe(200);
    const metricsText = await metrics.text();
    expect(metrics.headers.get("content-type")).toContain("text/plain");
    expect(metricsText).toContain("outbox_lag_seconds ");
    expect(metricsText).toContain("transaction_processing_duration_seconds_bucket");
    expect(metricsText).not.toContain(wager.money.amount);
    expect(metricsText).not.toContain(idempotencyKey);
  });
});
