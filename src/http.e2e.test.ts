import "./test-support/disable-outbox-publisher";
import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { MikroORM } from "@mikro-orm/postgresql";
import { AppModule } from "./app.module";

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
});
