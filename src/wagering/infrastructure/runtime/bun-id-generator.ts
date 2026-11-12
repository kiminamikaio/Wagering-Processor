import { IdGenerator } from "../../application/ports/wagering-unit-of-work";

export class BunIdGenerator implements IdGenerator {
  next(): string {
    return Bun.randomUUIDv7();
  }
}
