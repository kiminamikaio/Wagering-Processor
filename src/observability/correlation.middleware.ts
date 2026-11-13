import { randomUUID } from "node:crypto";
import { runWithLogContext } from "./correlation-context";

interface HttpRequest {
  headers: Record<string, string | string[] | undefined>;
}

interface HttpResponse {
  setHeader(name: string, value: string): void;
}

export class CorrelationMiddleware {
  use(request: HttpRequest, response: HttpResponse, next: () => void): void {
    const header = request.headers["x-correlation-id"];
    const correlationId =
      typeof header === "string" && header.trim().length > 0
        ? header
        : randomUUID();
    response.setHeader("X-Correlation-Id", correlationId);
    runWithLogContext({ correlationId }, next);
  }
}
