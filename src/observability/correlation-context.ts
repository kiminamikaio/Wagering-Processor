import { AsyncLocalStorage } from "node:async_hooks";

export interface LogContext {
  correlationId?: string;
  messageId?: string;
  transactionId?: string;
  walletId?: string;
  providerId?: string;
}

const contextStorage = new AsyncLocalStorage<LogContext>();

export function currentLogContext(): LogContext {
  return contextStorage.getStore() ?? {};
}

export function runWithLogContext<T>(
  context: LogContext,
  callback: () => T,
): T {
  return contextStorage.run(
    { ...currentLogContext(), ...context },
    callback,
  );
}
