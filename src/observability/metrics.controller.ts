import { Controller, Get, Inject, Res } from "@nestjs/common";
import { GetQueueAttributesCommand, SQSClient } from "@aws-sdk/client-sqs";
import { MikroORM } from "@mikro-orm/postgresql";
import { executeRows, requiredString } from "../wagering/infrastructure/database/sql";
import { SQS_CLIENT } from "../http/tokens";
import { jsonLogger } from "./json-logger";
import { MetricsRegistry, metricsRegistry } from "./metrics-registry";

interface TextResponse {
  setHeader(name: string, value: string): void;
  send(body: string): void;
}

function dlqQueueUrl(): string {
  const endpoint = process.env.SQS_ENDPOINT ?? "http://localhost:4566";
  return (
    process.env.SQS_DLQ_URL ??
    `${endpoint.replace(/\/$/, "")}/000000000000/wager-transactions-dlq.fifo`
  );
}

@Controller()
export class MetricsController {
  constructor(
    @Inject(MikroORM) private readonly orm: MikroORM,
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
    @Inject(MetricsRegistry) private readonly metrics: MetricsRegistry = metricsRegistry,
  ) {}

  @Get("metrics")
  async getMetrics(@Res() response: TextResponse): Promise<void> {
    const em = this.orm.em.fork();
    const [outboxRows, pendingRows] = await Promise.all([
      executeRows(
        em,
        `SELECT COUNT(*)::text AS count,
                COALESCE(EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - MIN(created_at))), 0)::text AS lag
         FROM outbox_messages
         WHERE published_at IS NULL`,
      ),
      executeRows(
        em,
        `SELECT COUNT(*)::text AS count
         FROM wager_transactions
         WHERE status = 'PENDING_REFERENCE'`,
      ),
    ]);
    const outboxCount = BigInt(requiredString(outboxRows[0]!, "count"));
    const pendingCount = BigInt(requiredString(pendingRows[0]!, "count"));
    const outboxLag = Number(requiredString(outboxRows[0]!, "lag"));
    const gauges: Record<string, number> = {
      outbox_unpublished_count: Number(outboxCount),
      outbox_lag_seconds: outboxLag,
      pending_reference_count: Number(pendingCount),
    };

    try {
      const attributes = await this.sqs.send(
        new GetQueueAttributesCommand({
          QueueUrl: dlqQueueUrl(),
          AttributeNames: ["ApproximateNumberOfMessages"],
        }),
        { abortSignal: AbortSignal.timeout(2_000) },
      );
      const depth = attributes.Attributes?.ApproximateNumberOfMessages;
      if (depth !== undefined && /^\d+$/.test(depth)) {
        gauges.dlq_queue_depth = Number(depth);
      }
    } catch (error) {
      jsonLogger.event("warn", "Could not read DLQ queue depth.", {}, "MetricsController");
    }

    response.setHeader("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
    response.send(this.metrics.render(gauges));
  }
}
