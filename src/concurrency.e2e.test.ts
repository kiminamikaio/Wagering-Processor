import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { MikroORM } from "@mikro-orm/postgresql";
import { AppModule } from "./app.module";
import { assertWalletMatchesLedger } from "./test-support/assert-wallet-matches-ledger";
import { executeRows, requiredString } from "./wagering/infrastructure/database/sql";

interface WalletResponse {
  id: string;
  playerId: string;
  balance: { amount: string; currency: string };
  version: number;
}

interface WagerBody {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: "BET" | "WIN" | "REFUND" | "ROLLBACK";
  money: { amount: string; currency: string };
  referenceExternalTransactionId?: string;
}

interface WagerResponse {
  transactionId?: string;
  status?: string;
  balance?: { amount: string; currency: string };
  failureCode?: string;
  idempotentReplay?: boolean;
  error?: { code: string };
}

let app: INestApplication;
let orm: MikroORM;
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

async function createWallet(initialAmount: string): Promise<WalletResponse> {
  const response = await postJson("/wallets", {
    playerId: Bun.randomUUIDv7(),
    initialBalance: { amount: initialAmount, currency: "BRL" },
  });
  expect(response.status).toBe(201);
  return response.json() as Promise<WalletResponse>;
}

function wagerBody(
  wallet: WalletResponse,
  overrides: Partial<WagerBody> = {},
): WagerBody {
  const suffix = Bun.randomUUIDv7();
  return {
    providerId: `provider-${suffix}`,
    externalTransactionId: `external-${suffix}`,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: `round-${suffix}`,
    gameId: `game-${suffix}`,
    kind: "BET",
    money: { amount: "1.00", currency: "BRL" },
    ...overrides,
  };
}

function key(): string {
  return `key-${Bun.randomUUIDv7()}`;
}

async function rowCount(sql: string, params: unknown[]): Promise<number> {
  const rows = await executeRows(orm.em.fork(), sql, params);
  return Number(requiredString(rows[0]!, "count"));
}

async function submit(
  body: WagerBody,
  idempotencyKey: string,
): Promise<{ status: number; body: WagerResponse }> {
  const response = await postJson(
    "/wagering/transactions",
    body,
    idempotencyKey,
  );
  return { status: response.status, body: await response.json() };
}

describe("HTTP concurrency against PostgreSQL", () => {
  beforeAll(async () => {
    app = await NestFactory.create(AppModule);
    orm = app.get(MikroORM);
    await orm.getMigrator().up();
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

  it("serializes competing BETs and replays each original response", async () => {
    const wallet = await createWallet("100.00");
    const bodies = [0, 1].map(() =>
      wagerBody(wallet, { money: { amount: "80.00", currency: "BRL" } }),
    );
    const keys = [key(), key()];
    const original = await Promise.all(
      bodies.map((body, index) => submit(body, keys[index]!)),
    );

    expect(original.filter((item) => item.status === 200)).toHaveLength(1);
    expect(original.filter((item) => item.status === 422)).toHaveLength(1);
    expect(
      original.find((item) => item.status === 422)?.body.failureCode,
    ).toBe("INSUFFICIENT_FUNDS");
    const replay = await Promise.all(
      bodies.map((body, index) => submit(body, keys[index]!)),
    );
    expect(replay.map((item) => item.status)).toEqual(
      original.map((item) => item.status),
    );
    expect(
      replay.map((item) => item.body),
    ).toEqual(
      original.map((item) => ({ ...item.body, idempotentReplay: true })),
    );
    expect(
      await rowCount(
        `SELECT COUNT(*)::text AS count
         FROM wallet_ledger_entries
         WHERE wallet_id = ? AND direction = 'DEBIT'`,
        [wallet.id],
      ),
    ).toBe(1);
    const walletAfter = await (await fetch(`${baseUrl}/wallets/${wallet.id}`)).json();
    expect(walletAfter.balance.amount).toBe("20.00");
    await assertWalletMatchesLedger(orm.em, wallet.id);
  });

  it("processes 50 concurrent copies of one BET exactly once", async () => {
    const wallet = await createWallet("200.00");
    const body = wagerBody(wallet, {
      money: { amount: "7.00", currency: "BRL" },
    });
    const idempotencyKey = key();
    const results = await Promise.all(
      Array.from({ length: 50 }, () => submit(body, idempotencyKey)),
    );
    const responseBodies = results.map((item) => item.body);
    const transactionId = responseBodies[0]?.transactionId;

    expect(results.every((item) => item.status === 200)).toBe(true);
    expect(responseBodies.filter((item) => item.idempotentReplay === false))
      .toHaveLength(1);
    expect(responseBodies.filter((item) => item.idempotentReplay === true))
      .toHaveLength(49);
    expect(responseBodies.every((item) => item.transactionId === transactionId))
      .toBe(true);
    expect(responseBodies.every((item) => item.balance?.amount === "193.00"))
      .toBe(true);
    expect(
      await rowCount(
        `SELECT COUNT(*)::text AS count
         FROM wallet_ledger_entries
         WHERE transaction_id = ? AND direction = 'DEBIT'`,
        [transactionId],
      ),
    ).toBe(1);
    expect(
      await rowCount(
        "SELECT COUNT(*)::text AS count FROM wager_transactions WHERE idempotency_key = ?",
        [idempotencyKey],
      ),
    ).toBe(1);
    expect(
      await rowCount(
        `SELECT COUNT(*)::text AS count
         FROM outbox_messages
         WHERE payload->'data'->>'transactionId' = ?
           AND event_type IN ('WagerTransactionProcessed', 'WalletBalanceChanged')`,
        [transactionId],
      ),
    ).toBe(2);
    await assertWalletMatchesLedger(orm.em, wallet.id);
  });

  it("returns replay for the winning payload and conflicts for the other payload", async () => {
    const wallet = await createWallet("100.00");
    const sharedKey = key();
    const sharedBody = wagerBody(wallet, {
      externalTransactionId: `external-${Bun.randomUUIDv7()}`,
    });
    const bodies = Array.from({ length: 10 }, (_, index) => ({
      ...sharedBody,
      money: {
        amount: index < 5 ? "20.00" : "30.00",
        currency: "BRL",
      },
    }));
    const results = await Promise.all(
      bodies.map((body) => submit(body, sharedKey)),
    );

    const statusGroups = [results.slice(0, 5), results.slice(5)];
    const processedGroup = statusGroups.find((group) =>
      group.every((item) => item.status === 200),
    );
    const conflictGroup = statusGroups.find((group) =>
      group.every((item) => item.status === 409),
    );
    expect(processedGroup).toBeDefined();
    expect(conflictGroup).toBeDefined();
    expect(processedGroup!.filter((item) => item.body.idempotentReplay === false))
      .toHaveLength(1);
    expect(processedGroup!.filter((item) => item.body.idempotentReplay === true))
      .toHaveLength(4);
    expect(conflictGroup!.every(
      (item) => item.body.error?.code === "IDEMPOTENCY_CONFLICT",
    )).toBe(true);
    await assertWalletMatchesLedger(orm.em, wallet.id);
  });

  it("keeps a mixed concurrent BET/WIN balance equal to its processed operations", async () => {
    const wallet = await createWallet("1000.00");
    const operations = Array.from({ length: 30 }, (_, index) => {
      const kind: WagerBody["kind"] = index % 2 === 0 ? "BET" : "WIN";
      const amount = `${(index % 9) + 1}.00`;
      return {
        kind,
        amount,
        body: wagerBody(wallet, {
          kind,
          money: { amount, currency: "BRL" },
        }),
      };
    });
    const results = await Promise.all(
      operations.map(({ body }) => submit(body, key())),
    );
    let expectedCents = 100_000n;
    for (const [index, result] of results.entries()) {
      if (result.status !== 200) {
        continue;
      }

      const cents = BigInt(operations[index]!.amount.replace(".00", "")) * 100n;
      expectedCents += operations[index]!.kind === "WIN" ? cents : -cents;
    }
    const walletAfter = await (await fetch(`${baseUrl}/wallets/${wallet.id}`)).json();
    expect(BigInt(walletAfter.balance.amount.replace(".", ""))).toBe(expectedCents);
    expect(expectedCents).toBeGreaterThanOrEqual(0n);
    await assertWalletMatchesLedger(orm.em, wallet.id);
  });

  it("processes concurrent BETs on ten wallets independently", async () => {
    const wallets = await Promise.all(
      Array.from({ length: 10 }, () => createWallet("100.00")),
    );
    const operations = wallets.flatMap((wallet) =>
      Array.from({ length: 10 }, () =>
        wagerBody(wallet, { money: { amount: "1.00", currency: "BRL" } }),
      ),
    );
    const results = await Promise.all(
      operations.map((body) => submit(body, key())),
    );

    expect(results.every((item) => item.status === 200)).toBe(true);
    for (const wallet of wallets) {
      const walletAfter = await (
        await fetch(`${baseUrl}/wallets/${wallet.id}`)
      ).json();
      expect(walletAfter.balance.amount).toBe("90.00");
      await assertWalletMatchesLedger(orm.em, wallet.id);
    }
  });

  it("allows only one concurrent REFUND or ROLLBACK of a BET", async () => {
    const wallet = await createWallet("50.00");
    const betBody = wagerBody(wallet, {
      money: { amount: "20.00", currency: "BRL" },
    });
    const bet = await submit(betBody, key());
    expect(bet.status).toBe(200);
    const reversalKinds: Array<WagerBody["kind"]> = ["REFUND", "ROLLBACK"];
    const reversalBodies: WagerBody[] = reversalKinds.map((kind) => ({
      ...betBody,
      externalTransactionId: `reversal-${Bun.randomUUIDv7()}`,
      kind,
      referenceExternalTransactionId: betBody.externalTransactionId,
    }));
    const results = await Promise.all(
      reversalBodies.map((body) => submit(body, key())),
    );

    expect(results.filter((item) => item.status === 200)).toHaveLength(1);
    expect(results.filter((item) => item.status === 422)).toHaveLength(1);
    expect(results.find((item) => item.status === 422)?.body.failureCode)
      .toBe("ALREADY_REVERSED");
    expect(
      await rowCount(
        `SELECT COUNT(*)::text AS count
         FROM wallet_ledger_entries
         WHERE transaction_id IN (
           SELECT id FROM wager_transactions
           WHERE wallet_id = ? AND kind IN ('REFUND', 'ROLLBACK')
         ) AND direction = 'CREDIT'`,
        [wallet.id],
      ),
    ).toBe(1);
    await assertWalletMatchesLedger(orm.em, wallet.id);
  });

  it("keeps a ROLLBACK pending when its BET reference has not arrived", async () => {
    const wallet = await createWallet("0.00");
    const pending = await submit(
      wagerBody(wallet, {
        kind: "ROLLBACK",
        referenceExternalTransactionId: `missing-${Bun.randomUUIDv7()}`,
        money: { amount: "5.00", currency: "BRL" },
      }),
      key(),
    );

    expect(pending.status).toBe(202);
    expect(pending.body.status).toBe("PENDING_REFERENCE");
    expect(
      await rowCount(
        "SELECT COUNT(*)::text AS count FROM wallet_ledger_entries WHERE wallet_id = ?",
        [wallet.id],
      ),
    ).toBe(0);
    const walletAfter = await (await fetch(`${baseUrl}/wallets/${wallet.id}`)).json();
    expect(walletAfter.balance.amount).toBe("0.00");
    await assertWalletMatchesLedger(orm.em, wallet.id);
  });
});
