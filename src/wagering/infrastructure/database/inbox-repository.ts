import { EntityManager } from "@mikro-orm/core";
import { InboxMessageInput, InboxRepository } from "../../application/ports/wagering-unit-of-work";
import { InboxMessageConflictError } from "../../application/errors";
import { executeRows, executeStatement, requiredString } from "./sql";

export class MikroOrmInboxRepository implements InboxRepository {
  constructor(private readonly em: EntityManager) {}

  async insertIfAbsent(message: InboxMessageInput): Promise<boolean> {
    const payload = JSON.stringify(message.payload);
    if (payload === undefined) {
      throw new TypeError("The inbox payload must be JSON serializable.");
    }

    const inserted = await executeRows(
      this.em,
      `INSERT INTO inbox_messages (
        consumer_name, message_id, payload_hash, payload
      ) VALUES (?, ?, ?, ?::jsonb)
      ON CONFLICT (consumer_name, message_id) DO NOTHING
      RETURNING message_id`,
      [message.consumerName, message.messageId, message.payloadHash, payload],
    );
    if (inserted.length > 0) {
      return true;
    }

    const existing = await executeRows(
      this.em,
      `SELECT payload_hash
       FROM inbox_messages
       WHERE consumer_name = ? AND message_id = ?`,
      [message.consumerName, message.messageId],
    );
    if (existing.length !== 1) {
      throw new Error("The inbox conflict row could not be found.");
    }
    if (requiredString(existing[0]!, "payload_hash") !== message.payloadHash) {
      throw new InboxMessageConflictError(message.consumerName, message.messageId);
    }
    return false;
  }

  async markProcessed(consumerName: string, messageId: string): Promise<void> {
    const affectedRows = await executeStatement(
      this.em,
      `UPDATE inbox_messages
       SET processed_at = CURRENT_TIMESTAMP
       WHERE consumer_name = ? AND message_id = ? AND processed_at IS NULL`,
      [consumerName, messageId],
    );
    if (affectedRows !== 1) {
      throw new Error("The inbox message could not be marked as processed.");
    }
  }
}
