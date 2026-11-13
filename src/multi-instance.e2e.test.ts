import "./test-support/disable-outbox-publisher";
import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { MikroORM } from "@mikro-orm/postgresql";
import mikroOrmConfig from "./shared/infrastructure/database/mikro-orm.config";
import { assertWalletMatchesLedger } from "./test-support/assert-wallet-matches-ledger";
import { executeRows, requiredString } from "./wagering/infrastructure/database/sql";

interface WalletResponse {
  id: string;
  playerId: string;
  balance: { amount: string; currency: string };
}

interface WagerBody {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: "BET";
  money: { amount: string; currency: string };
}

interface WagerResponse {
  transactionId?: string;
  status?: string;
  balance?: { amount: string; currency: string };
  failureCode?: string;
  idempotentReplay?: boolean;
}

const children: ReturnType<typeof Bun.spawn>[] = [];
const ports: number[] = [];
let orm: MikroORM;

async function unusedPort(): Promise<number> {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(),
  });
  const port = server.port;
  if (port === undefined) {
    server.stop(true);
    throw new Error("Bun did not allocate a port for the readiness probe.");
  }
  server.stop(true);
  return port;
}

async function waitForHealth(
  child: ReturnType<typeof Bun.spawn>,
  port: number,
): Promise<void> {
  const deadline = Date.now() + 20_000;
  const url = `http://127.0.0.1:${port}/health/live`;

  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`App process for port ${port} exited before becoming healthy.`);
    }

    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) {
        return;
      }
    } catch {
      // The next readiness probe determines whether the process has started.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(`App process for port ${port} did not become healthy in 20 seconds.`);
}

function wagerBody(wallet: WalletResponse, amount: string): WagerBody {
  const suffix = Bun.randomUUIDv7();
  return {
    providerId: `provider-${suffix}`,
    externalTransactionId: `external-${suffix}`,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: `round-${suffix}`,
    gameId: `game-${suffix}`,
    kind: "BET",
    money: { amount, currency: "BRL" },
  };
}

function idempotencyKey(): string {
  return `key-${Bun.randomUUIDv7()}`;
}

async function createWallet(
  amount: string,
): Promise<{ wallet: WalletResponse; baseUrl: string }> {
  const baseUrl = `http://127.0.0.1:${ports[0]!}`;
  const response = await fetch(`${baseUrl}/wallets`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      playerId: Bun.randomUUIDv7(),
      initialBalance: { amount, currency: "BRL" },
    }),
  });
  expect(response.status).toBe(201);
  return {
    wallet: (await response.json()) as WalletResponse,
    baseUrl,
  };
}

async function submit(
  body: WagerBody,
  key: string,
  index: number,
): Promise<{ status: number; body: WagerResponse }> {
  const port = ports[index % ports.length]!;
  const response = await fetch(
    `http://127.0.0.1:${port}/wagering/transactions`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": key,
      },
      body: JSON.stringify(body),
    },
  );
  return { status: response.status, body: await response.json() };
}

async function rowCount(sql: string, params: unknown[]): Promise<number> {
  const rows = await executeRows(orm.em.fork(), sql, params);
  return Number(requiredString(rows[0]!, "count"));
}

describe("HTTP concurrency across three real app processes", () => {
  beforeAll(async () => {
    orm = await MikroORM.init(mikroOrmConfig);
    await orm.getMigrator().up();
    ports.push(...(await Promise.all([unusedPort(), unusedPort(), unusedPort()])));

    for (const port of ports) {
      children.push(
        Bun.spawn([process.execPath, "src/main.ts"], {
          cwd: process.cwd(),
          env: { ...process.env, PORT: String(port) },
          stdout: "inherit",
          stderr: "inherit",
        }),
      );
    }
    await Promise.all(
      children.map((child, index) => waitForHealth(child, ports[index]!)),
    );
  }, 30_000);

  afterAll(async () => {
    for (const child of children) {
      if (child.exitCode === null) {
        child.kill();
      }
    }
    await Promise.all(children.map((child) => child.exited));
    await orm?.close(true);
  });

  it("serializes competing BETs across all three instances and replays them", async () => {
    const { wallet } = await createWallet("100.00");
    const bodies = [
      wagerBody(wallet, "80.00"),
      wagerBody(wallet, "80.00"),
    ];
    const keys = [idempotencyKey(), idempotencyKey()];
    const original = await Promise.all(
      bodies.map((body, index) => submit(body, keys[index]!, index)),
    );

    expect(original.filter((item) => item.status === 200)).toHaveLength(1);
    expect(original.filter((item) => item.status === 422)).toHaveLength(1);
    expect(
      original.find((item) => item.status === 422)?.body.failureCode,
    ).toBe("INSUFFICIENT_FUNDS");
    const replay = await Promise.all(
      bodies.map((body, index) =>
        submit(body, keys[index]!, index + bodies.length),
      ),
    );
    expect(replay.map((item) => item.status)).toEqual(
      original.map((item) => item.status),
    );
    expect(replay.map((item) => item.body)).toEqual(
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
    const response = await fetch(
      `http://127.0.0.1:${ports[1]!}/wallets/${wallet.id}`,
    );
    expect((await response.json()).balance.amount).toBe("20.00");
    await assertWalletMatchesLedger(orm.em, wallet.id);
  });

  it("deduplicates 50 copies of one BET across the three instances", async () => {
    const { wallet } = await createWallet("200.00");
    const body = wagerBody(wallet, "7.00");
    const key = idempotencyKey();
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, index) => submit(body, key, index)),
    );
    const bodies = results.map((item) => item.body);
    const transactionId = bodies[0]?.transactionId;

    expect(results.every((item) => item.status === 200)).toBe(true);
    expect(bodies.filter((item) => item.idempotentReplay === false))
      .toHaveLength(1);
    expect(bodies.filter((item) => item.idempotentReplay === true))
      .toHaveLength(49);
    expect(bodies.every((item) => item.transactionId === transactionId)).toBe(true);
    expect(bodies.every((item) => item.balance?.amount === "193.00")).toBe(true);
    expect(
      await rowCount(
        `SELECT COUNT(*)::text AS count
         FROM wallet_ledger_entries
         WHERE wallet_id = ? AND direction = 'DEBIT'`,
        [wallet.id],
      ),
    ).toBe(1);
    expect(
      await rowCount(
        "SELECT COUNT(*)::text AS count FROM wager_transactions WHERE idempotency_key = ?",
        [key],
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

  it("recovers 30 idempotent wagers after killing and restarting an app mid-flight", async () => {
    const wallets = await Promise.all(
      Array.from({ length: 3 }, async () => (await createWallet("100.00")).wallet),
    );
    const requests = wallets.flatMap((wallet) =>
      Array.from({ length: 10 }, () => ({
        body: wagerBody(wallet, "1.00"),
        key: idempotencyKey(),
      })),
    );
    const inFlight = requests.map(({ body, key }, index) =>
      submit(body, key, index).then(
        (result) => ({ result }),
        (error: unknown) => ({ error }),
      ),
    );

    await new Promise((resolve) => setTimeout(resolve, 1));
    const stopped = children[1]!;
    stopped.kill("SIGKILL");
    await stopped.exited;
    children[1] = Bun.spawn([process.execPath, "src/main.ts"], {
      cwd: process.cwd(),
      env: { ...process.env, PORT: String(ports[1]!) },
      stdout: "inherit",
      stderr: "inherit",
    });
    await waitForHealth(children[1]!, ports[1]!);
    await Promise.all(inFlight);

    const replays = await Promise.all(
      requests.map(({ body, key }, index) => submit(body, key, index + 1)),
    );
    expect(replays.every((result) => result.status === 200)).toBe(true);

    for (const wallet of wallets) {
      expect(
        await rowCount(
          `SELECT COUNT(*)::text AS count
           FROM wager_transactions
           WHERE wallet_id = ? AND kind = 'BET'`,
          [wallet.id],
        ),
      ).toBe(10);
      expect(
        await rowCount(
          `SELECT COUNT(*)::text AS count
           FROM wallet_ledger_entries
           WHERE wallet_id = ? AND direction = 'DEBIT'`,
          [wallet.id],
        ),
      ).toBe(10);
      const reconciliation = await fetch(
        `http://127.0.0.1:${ports[0]!}/wallets/${wallet.id}/reconciliation`,
        { method: "POST" },
      );
      expect(reconciliation.status).toBe(200);
      expect((await reconciliation.json()).consistent).toBe(true);
      await assertWalletMatchesLedger(orm.em, wallet.id);
    }

    for (const { key } of requests) {
      expect(
        await rowCount(
          "SELECT COUNT(*)::text AS count FROM wager_transactions WHERE idempotency_key = ?",
          [key],
        ),
      ).toBe(1);
    }
  });
});
