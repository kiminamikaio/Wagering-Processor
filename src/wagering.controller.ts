import {
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
  Body,
  Res,
  UseGuards,
} from "@nestjs/common";
import { SubmitWagerTransactionUseCase } from "./wagering/application/submit-wager-transaction.use-case";
import {
  WagerTransactionNotFoundError,
} from "./wagering/application/errors";
import { WagerTransaction } from "./wagering/domain/wager-transaction";
import { AuthGuard } from "./http/auth.guard";
import {
  parseSubmitWagerInput,
  parseTransactionId,
} from "./http/http-validation";
import { HTTP_READ_REPOSITORY } from "./http/tokens";
import { MikroOrmHttpReadRepository } from "./wagering/infrastructure/database/http-read-repository";

interface StatusResponse {
  status(code: number): unknown;
}

function transactionResponse(transaction: WagerTransaction) {
  return {
    transactionId: transaction.id,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    playerId: transaction.playerId,
    walletId: transaction.walletId,
    roundId: transaction.roundId,
    gameId: transaction.gameId,
    kind: transaction.kind,
    status: transaction.status,
    money: transaction.money.toJSON(),
    ...(transaction.referenceExternalTransactionId === undefined
      ? {}
      : { referenceExternalTransactionId: transaction.referenceExternalTransactionId }),
    ...(transaction.failureCode === undefined
      ? {}
      : { failureCode: transaction.failureCode }),
  };
}

@Controller("wagering/transactions")
@UseGuards(AuthGuard)
export class WageringController {
  constructor(
    private readonly submitWager: SubmitWagerTransactionUseCase,
    @Inject(HTTP_READ_REPOSITORY)
    private readonly readRepository: MikroOrmHttpReadRepository,
  ) {}

  @Post()
  @HttpCode(200)
  async submit(
    @Body() body: unknown,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Res({ passthrough: true }) response: StatusResponse,
  ) {
    const result = await this.submitWager.execute(
      parseSubmitWagerInput(body, idempotencyKey),
    );

    if (result.status === "PENDING_REFERENCE") {
      response.status(202);
      return result;
    }
    if (result.status === "REJECTED") {
      response.status(422);
      const failureCode = result.failureCode ?? "REJECTED";
      return {
        error: {
          code: failureCode,
          message: "The wagering transaction was rejected.",
        },
        transactionId: result.transactionId,
        status: result.status,
        failureCode,
      };
    }
    return result;
  }

  @Get(":transactionId")
  async getById(@Param("transactionId") id: string) {
    const transaction = await this.readRepository.findWagerTransactionById(
      parseTransactionId(id),
    );
    if (transaction === undefined) {
      throw new WagerTransactionNotFoundError();
    }
    return transactionResponse(transaction);
  }
}

@Controller("providers/:providerId/wagering/transactions")
@UseGuards(AuthGuard)
export class ProviderWageringController {
  constructor(
    @Inject(HTTP_READ_REPOSITORY)
    private readonly readRepository: MikroOrmHttpReadRepository,
  ) {}

  @Get(":externalTransactionId")
  async getByExternalId(
    @Param("providerId") providerId: string,
    @Param("externalTransactionId") externalTransactionId: string,
  ) {
    if (providerId.trim().length === 0 || externalTransactionId.trim().length === 0) {
      throw new WagerTransactionNotFoundError();
    }
    const transaction =
      await this.readRepository.findWagerTransactionByExternalId(
        providerId,
        externalTransactionId,
      );
    if (transaction === undefined) {
      throw new WagerTransactionNotFoundError();
    }
    return transactionResponse(transaction);
  }
}
