import { CanActivate, ExecutionContext, Injectable } from "@nestjs/common";

@Injectable()
export class AuthGuard implements CanActivate {
  // Authentication is intentionally deferred; see ARCHITECTURE.md.
  canActivate(_context: ExecutionContext): boolean {
    return true;
  }
}
