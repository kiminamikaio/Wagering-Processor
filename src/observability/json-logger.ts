import { LoggerService } from "@nestjs/common";
import { currentLogContext, LogContext } from "./correlation-context";

export type JsonLogLevel = "log" | "error" | "warn" | "debug" | "verbose";

const allowedFields: ReadonlyArray<keyof LogContext> = [
  "correlationId",
  "messageId",
  "transactionId",
  "walletId",
  "providerId",
];

export class JsonLogger implements LoggerService {
  constructor(
    private readonly write: (line: string) => void = (line) =>
      process.stdout.write(`${line}\n`),
  ) {}

  log(message: unknown, context?: string): void {
    this.writeEvent("info", message, context);
  }

  error(message: unknown, _stack?: string, context?: string): void {
    this.writeEvent("error", message, context);
  }

  warn(message: unknown, context?: string): void {
    this.writeEvent("warn", message, context);
  }

  debug(message: unknown, context?: string): void {
    this.writeEvent("debug", message, context);
  }

  verbose(message: unknown, context?: string): void {
    this.writeEvent("trace", message, context);
  }

  event(
    level: "info" | "error" | "warn",
    message: string,
    fields: LogContext = {},
    context = "Application",
  ): void {
    this.writeEvent(level, message, context, fields);
  }

  private writeEvent(
    level: "info" | "error" | "warn" | "debug" | "trace",
    message: unknown,
    context?: string,
    fields: LogContext = {},
  ): void {
    const merged = { ...currentLogContext(), ...fields };
    const record: Record<string, unknown> = {
      timestamp: new Date().toISOString(),
      level,
      message: typeof message === "string" ? message : "Application event",
      context: context ?? "Application",
    };
    for (const key of allowedFields) {
      const value = merged[key];
      if (value !== undefined) {
        record[key] = value;
      }
    }
    this.write(JSON.stringify(record));
  }
}

export const jsonLogger = new JsonLogger();
