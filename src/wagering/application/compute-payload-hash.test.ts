import { describe, expect, it } from "bun:test";
import {
  computePayloadHash,
  WagerPayloadHashInput,
} from "./compute-payload-hash";

const payload: WagerPayloadHashInput = {
  providerId: "provider-1",
  externalTransactionId: "external-1",
  playerId: "player-1",
  walletId: "wallet-1",
  roundId: "round-1",
  gameId: "game-1",
  kind: "BET",
  money: { amount: "10.00", currency: "BRL" },
  referenceExternalTransactionId: "reference-1",
};

describe("computePayloadHash", () => {
  it("is independent of business field and money key insertion order", () => {
    const reordered = {
      referenceExternalTransactionId: payload.referenceExternalTransactionId,
      money: { currency: "BRL", amount: "10.00" },
      kind: payload.kind,
      gameId: payload.gameId,
      roundId: payload.roundId,
      walletId: payload.walletId,
      playerId: payload.playerId,
      externalTransactionId: payload.externalTransactionId,
      providerId: payload.providerId,
    };

    expect(computePayloadHash(reordered)).toBe(computePayloadHash(payload));
  });

  it("changes when any business field changes", () => {
    const variants: WagerPayloadHashInput[] = [
      { ...payload, providerId: "provider-2" },
      { ...payload, externalTransactionId: "external-2" },
      { ...payload, playerId: "player-2" },
      { ...payload, walletId: "wallet-2" },
      { ...payload, roundId: "round-2" },
      { ...payload, gameId: "game-2" },
      { ...payload, kind: "WIN" },
      { ...payload, money: { amount: "10.01", currency: "BRL" } },
      { ...payload, money: { amount: "10.00", currency: "USD" } },
      { ...payload, referenceExternalTransactionId: "reference-2" },
    ];

    for (const variant of variants) {
      expect(computePayloadHash(variant)).not.toBe(computePayloadHash(payload));
    }
  });
});
