import { Clock } from "../../application/ports/wagering-unit-of-work";

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}
