import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
} from "@nestjs/common";
import { currentLogContext } from "../observability/correlation-context";
import { jsonLogger } from "../observability/json-logger";
import {
  IdempotencyConflictError,
  UnsupportedTransactionKindError,
  WalletAlreadyExistsError,
  WalletNotFoundError,
  WagerTransactionNotFoundError,
} from "../wagering/application/errors";
import {
  InvalidMoneyAmountError,
  InvalidWalletBalanceError,
  InvalidWagerTransactionError,
  MissingReferenceError,
  InvalidReferenceKindError,
  InvalidTransactionStateError,
  InvalidLedgerEntryError,
} from "../wagering/domain/errors";
import { InvalidMoneyError } from "../shared/domain/errors";
import { PersistenceMappingError } from "../wagering/infrastructure/database/persistence-errors";

interface HttpResponse {
  status(code: number): HttpResponse;
  setHeader(name: string, value: string): void;
  json(body: unknown): void;
}

function errorCode(error: unknown): string | undefined {
  let current = error;
  for (let depth = 0; depth < 6 && typeof current === "object" && current !== null; depth += 1) {
    if ("code" in current && typeof current.code === "string") {
      return current.code;
    }
    if ("cause" in current) {
      current = current.cause;
    } else if ("originalError" in current) {
      current = current.originalError;
    } else {
      break;
    }
  }
  return undefined;
}

function isTransientDatabaseError(error: unknown): boolean {
  const code = errorCode(error);
  return (
    (code !== undefined &&
      (code.startsWith("08") ||
        [
          "40001",
          "40P01",
          "53300",
          "55P03",
          "57014",
          "57P01",
          "57P02",
          "57P03",
        ].includes(code))) ||
    ["ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "EPIPE", "ESOCKETTIMEDOUT"].includes(
      code ?? "",
    )
  );
}

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<HttpResponse>();
    let status = 500;
    let code = "INTERNAL_ERROR";
    let message = "An unexpected error occurred.";

    if (
      exception instanceof WalletNotFoundError ||
      exception instanceof WagerTransactionNotFoundError
    ) {
      status = 404;
      code =
        exception instanceof WalletNotFoundError
          ? "WALLET_NOT_FOUND"
          : "WAGER_TRANSACTION_NOT_FOUND";
      message = exception.message;
    } else if (exception instanceof WalletAlreadyExistsError) {
      status = 409;
      code = "WALLET_ALREADY_EXISTS";
      message = exception.message;
    } else if (exception instanceof IdempotencyConflictError) {
      status = 409;
      code = "IDEMPOTENCY_CONFLICT";
      message = exception.message;
    } else if (
      exception instanceof InvalidMoneyError ||
      exception instanceof InvalidMoneyAmountError ||
      exception instanceof InvalidWalletBalanceError ||
      exception instanceof InvalidWagerTransactionError ||
      exception instanceof MissingReferenceError ||
      exception instanceof InvalidReferenceKindError ||
      exception instanceof InvalidTransactionStateError ||
      exception instanceof InvalidLedgerEntryError ||
      exception instanceof UnsupportedTransactionKindError ||
      exception instanceof HttpException
    ) {
      status = 400;
      code = "INVALID_REQUEST";
      message =
        exception instanceof HttpException
          ? "The request payload is invalid."
          : exception.message;
    } else if (isTransientDatabaseError(exception)) {
      status = 503;
      code = "TRANSIENT_DATABASE_FAILURE";
      message = "A temporary database failure occurred. Retry the request.";
      response.setHeader("Retry-After", "1");
    } else if (exception instanceof PersistenceMappingError) {
      code = "PERSISTENCE_ERROR";
      message = "A persistence error occurred.";
    } else if (exception instanceof Error) {
      jsonLogger.event(
        "error",
        `Unhandled API exception: ${exception.name}.`,
        currentLogContext(),
        "ApiExceptionFilter",
      );
    } else {
      jsonLogger.event(
        "error",
        "An unexpected non-error value was thrown.",
        currentLogContext(),
        "ApiExceptionFilter",
      );
    }

    if (status === 500) {
      jsonLogger.event(
        "error",
        `Returning ${code}.`,
        currentLogContext(),
        "ApiExceptionFilter",
      );
    }
    response.status(status).json({ error: { code, message } });
  }
}
