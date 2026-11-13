import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { CreateWalletUseCase } from "./wagering/application/create-wallet.use-case";
import { WalletNotFoundError } from "./wagering/application/errors";
import { Wallet } from "./wagering/domain/wallet";
import { AuthGuard } from "./http/auth.guard";
import {
  decodeLedgerCursor,
  encodeLedgerCursor,
  parseCreateWalletInput,
  parseLedgerLimit,
  parseWalletId,
} from "./http/http-validation";
import { HTTP_READ_REPOSITORY } from "./http/tokens";
import { MikroOrmHttpReadRepository } from "./wagering/infrastructure/database/http-read-repository";

function walletResponse(wallet: Wallet) {
  return {
    id: wallet.id,
    playerId: wallet.playerId,
    balance: wallet.balance.toJSON(),
    version: wallet.version,
  };
}

@Controller("wallets")
@UseGuards(AuthGuard)
export class WalletsController {
  constructor(
    private readonly createWallet: CreateWalletUseCase,
    @Inject(HTTP_READ_REPOSITORY)
    private readonly readRepository: MikroOrmHttpReadRepository,
  ) {}

  @Post()
  async create(@Body() body: unknown) {
    const wallet = await this.createWallet.execute(parseCreateWalletInput(body));
    return walletResponse(wallet);
  }

  @Get(":walletId")
  async getById(@Param("walletId") id: string) {
    const wallet = await this.readRepository.findWalletById(parseWalletId(id));
    if (wallet === undefined) {
      throw new WalletNotFoundError(id);
    }
    return walletResponse(wallet);
  }

  @Get(":walletId/ledger")
  async getLedger(
    @Param("walletId") rawId: string,
    @Query("cursor") rawCursor?: string,
    @Query("limit") rawLimit?: string,
  ) {
    const walletId = parseWalletId(rawId);
    const wallet = await this.readRepository.findWalletById(walletId);
    if (wallet === undefined) {
      throw new WalletNotFoundError(walletId);
    }

    const limit = parseLedgerLimit(rawLimit);
    const beforeSeq = decodeLedgerCursor(rawCursor);
    const page = await this.readRepository.findLedgerPage(
      walletId,
      beforeSeq,
      limit,
    );
    const lastEntry = page.entries.at(-1);
    return {
      items: page.entries.map(({ entry }) => ({
        id: entry.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        createdAt: entry.createdAt.toISOString(),
      })),
      nextCursor:
        page.hasMore && lastEntry !== undefined
          ? encodeLedgerCursor(lastEntry.seq)
          : null,
    };
  }
}
