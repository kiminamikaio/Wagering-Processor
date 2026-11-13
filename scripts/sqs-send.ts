import { SendMessageCommand } from "@aws-sdk/client-sqs";
import { createOutboxSqsClient } from "../src/wagering/infrastructure/outbox/sqs-outbox-publisher";

const walletId = process.env.SQS_EXAMPLE_WALLET_ID;
const playerId = process.env.SQS_EXAMPLE_PLAYER_ID;
if (walletId === undefined || playerId === undefined) {
  throw new Error(
    "Set SQS_EXAMPLE_WALLET_ID and SQS_EXAMPLE_PLAYER_ID to an existing wallet.",
  );
}

const endpoint = process.env.SQS_ENDPOINT ?? "http://localhost:4566";
const queueUrl =
  process.env.SQS_QUEUE_URL ??
  `${endpoint.replace(/\/$/, "")}/000000000000/wager-transactions.fifo`;
const suffix = crypto.randomUUID();
const payload = {
  messageId: crypto.randomUUID(),
  type: "WagerTransactionRequested",
  occurredAt: new Date().toISOString(),
  data: {
    providerId: "demo-provider",
    externalTransactionId: `demo-${suffix}`,
    idempotencyKey: `demo:${suffix}`,
    playerId,
    walletId,
    roundId: "demo-round",
    gameId: "demo-game",
    kind: "BET",
    money: { amount: "1.00", currency: "BRL" },
  },
};

const client = createOutboxSqsClient();
try {
  const result = await client.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageGroupId: walletId,
      MessageDeduplicationId: payload.messageId,
      MessageBody: JSON.stringify(payload),
    }),
  );
  console.log(`Sent message ${payload.messageId} (${result.MessageId ?? "unknown SQS id"}).`);
} finally {
  client.destroy();
}
