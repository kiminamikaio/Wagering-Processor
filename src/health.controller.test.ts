import "./test-support/disable-outbox-publisher";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import "reflect-metadata";
import { AppModule } from "./app.module";

describe("GET /health/live", () => {
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    app = await NestFactory.create(AppModule, { logger: false });
    await app.listen(0, "127.0.0.1");
    baseUrl = await app.getUrl();
  });

  afterAll(async () => {
    await app.close();
  });

  it("returns 200 with an ok status", async () => {
    const response = await fetch(`${baseUrl}/health/live`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });

  it("reports PostgreSQL and SQS readiness without authentication", async () => {
    const response = await fetch(`${baseUrl}/health/ready`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "ok",
      checks: { postgres: "up", sqs: "up" },
    });
  });

  it("returns 503 and identifies SQS when its queue endpoint is unavailable", async () => {
    const previousEndpoint = process.env.SQS_ENDPOINT;
    process.env.SQS_ENDPOINT = "http://127.0.0.1:1";
    let unavailableApp: INestApplication | undefined;
    try {
      unavailableApp = await NestFactory.create(AppModule, { logger: false });
      await unavailableApp.listen(0, "127.0.0.1");
      const unavailableUrl = await unavailableApp.getUrl();
      if (previousEndpoint === undefined) {
        delete process.env.SQS_ENDPOINT;
      } else {
        process.env.SQS_ENDPOINT = previousEndpoint;
      }

      const response = await fetch(`${unavailableUrl}/health/ready`);
      const body = await response.json();

      expect(response.status).toBe(503);
      expect(body.status).toBe("error");
      expect(body.checks.postgres).toBe("up");
      expect(body.checks.sqs.status).toBe("down");
      expect(body.checks.sqs.reason).toBeString();
    } finally {
      await unavailableApp?.close();
      if (previousEndpoint === undefined) {
        delete process.env.SQS_ENDPOINT;
      } else {
        process.env.SQS_ENDPOINT = previousEndpoint;
      }
    }
  });

  it("keeps liveness available while the application pool cannot reach PostgreSQL", async () => {
    const previousDatabaseUrl = process.env.DATABASE_URL;
    const databaseUrl = new URL(
      previousDatabaseUrl ??
        "postgresql://wagering:local-password@localhost:5432/wagering",
    );
    databaseUrl.port = "1";
    process.env.DATABASE_URL = databaseUrl.toString();
    let unavailableApp: INestApplication | undefined;
    try {
      unavailableApp = await NestFactory.create(AppModule, { logger: false });
      await unavailableApp.listen(0, "127.0.0.1");
      const unavailableUrl = await unavailableApp.getUrl();

      const live = await fetch(`${unavailableUrl}/health/live`);
      expect(live.status).toBe(200);
      expect(await live.json()).toEqual({ status: "ok" });

      const ready = await fetch(`${unavailableUrl}/health/ready`);
      const body = await ready.json();
      expect(ready.status).toBe(503);
      expect(body.checks.postgres.status).toBe("down");
      expect(body.checks.sqs).toBe("up");
    } finally {
      await unavailableApp?.close();
      if (previousDatabaseUrl === undefined) {
        delete process.env.DATABASE_URL;
      } else {
        process.env.DATABASE_URL = previousDatabaseUrl;
      }
    }
  });
});
