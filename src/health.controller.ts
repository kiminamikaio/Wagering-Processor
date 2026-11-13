import { Controller, Get, Inject, Res } from "@nestjs/common";
import { GetQueueAttributesCommand, SQSClient } from "@aws-sdk/client-sqs";
import { MikroORM } from "@mikro-orm/postgresql";
import { executeRows } from "./wagering/infrastructure/database/sql";
import { SQS_CLIENT } from "./http/tokens";

interface HealthResponse {
  status(code: number): HealthResponse;
}

type CheckResult = "up" | { status: "down"; reason: string };

function sqsQueueUrl(): string {
  const endpoint = process.env.SQS_ENDPOINT ?? "http://localhost:4566";
  return (
    process.env.SQS_QUEUE_URL ??
    `${endpoint.replace(/\/$/, "")}/000000000000/wager-transactions.fifo`
  );
}

async function withinTwoSeconds<T>(operation: Promise<T>): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("timeout")), 2_000);
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

function shortReason(error: unknown): string {
  if (error instanceof Error && error.message === "timeout") {
    return "timeout";
  }
  if (error instanceof Error) {
    return error.name;
  }
  return "unavailable";
}

@Controller("health")
export class HealthController {
  constructor(
    @Inject(MikroORM) private readonly orm: MikroORM,
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
  ) {}

  @Get("live")
  getLive(): { status: "ok" } {
    return { status: "ok" };
  }

  @Get("ready")
  async getReady(@Res({ passthrough: true }) response: HealthResponse) {
    const [postgres, sqs] = await Promise.all([
      withinTwoSeconds(
        executeRows(this.orm.em.fork(), "SELECT 1 AS health_check"),
      ).then(
        (): CheckResult => "up",
        (error: unknown): CheckResult => ({
          status: "down",
          reason: shortReason(error),
        }),
      ),
      this.sqs
        .send(
          new GetQueueAttributesCommand({
            QueueUrl: sqsQueueUrl(),
            AttributeNames: ["QueueArn"],
          }),
          { abortSignal: AbortSignal.timeout(2_000) },
        )
        .then(
          (): CheckResult => "up",
          (error: unknown): CheckResult => ({
            status: "down",
            reason: shortReason(error),
          }),
        ),
    ]);
    const healthy = postgres === "up" && sqs === "up";
    if (!healthy) {
      response.status(503);
    }
    return {
      status: healthy ? "ok" : "error",
      checks: { postgres, sqs },
    };
  }
}
