import { EntityManager } from "@mikro-orm/core";
import {
  EnqueueOutboxMessage,
  OutboxRepository,
} from "../../application/ports/wagering-unit-of-work";
import { executeStatement } from "./sql";

export class MikroOrmOutboxRepository implements OutboxRepository {
  constructor(private readonly em: EntityManager) {}

  async enqueue(message: EnqueueOutboxMessage): Promise<void> {
    const payload = JSON.stringify(message.payload);
    if (payload === undefined) {
      throw new TypeError("The outbox payload must be JSON serializable.");
    }

    await executeStatement(
      this.em,
      `INSERT INTO outbox_messages (
        aggregate_type, aggregate_id, event_type, payload
      ) VALUES (?, ?, ?, ?::jsonb)`,
      [
        message.aggregateType,
        message.aggregateId,
        message.eventType,
        payload,
      ],
    );
  }
}
