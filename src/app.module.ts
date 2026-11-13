import { Inject, Injectable, Module, OnApplicationShutdown } from "@nestjs/common";
import { MikroORM } from "@mikro-orm/postgresql";
import { APP_FILTER } from "@nestjs/core";
import { HealthController } from "./health.controller";
import { ApiExceptionFilter } from "./http/api-exception.filter";
import {
  CLOCK,
  HTTP_READ_REPOSITORY,
  ID_GENERATOR,
  WAGERING_UNIT_OF_WORK,
} from "./http/tokens";
import { Clock, IdGenerator, WageringUnitOfWork } from "./wagering/application/ports/wagering-unit-of-work";
import { CreateWalletUseCase } from "./wagering/application/create-wallet.use-case";
import { SubmitWagerTransactionUseCase } from "./wagering/application/submit-wager-transaction.use-case";
import { BunIdGenerator } from "./wagering/infrastructure/runtime/bun-id-generator";
import { SystemClock } from "./wagering/infrastructure/runtime/system-clock";
import { MikroOrmHttpReadRepository } from "./wagering/infrastructure/database/http-read-repository";
import { MikroOrmWageringUnitOfWork } from "./wagering/infrastructure/database/wagering-unit-of-work";
import mikroOrmConfig from "./shared/infrastructure/database/mikro-orm.config";
import { WalletsController } from "./wallets.controller";
import { ProviderWageringController, WageringController } from "./wagering.controller";

@Injectable()
class MikroOrmLifecycle implements OnApplicationShutdown {
  constructor(@Inject(MikroORM) private readonly orm: MikroORM) {}

  async onApplicationShutdown(): Promise<void> {
    await this.orm.close(true);
  }
}

@Module({
  controllers: [
    HealthController,
    WalletsController,
    WageringController,
    ProviderWageringController,
  ],
  providers: [
    {
      provide: MikroORM,
      useFactory: () => MikroORM.init(mikroOrmConfig),
    },
    MikroOrmLifecycle,
    {
      provide: WAGERING_UNIT_OF_WORK,
      useFactory: (orm: MikroORM): WageringUnitOfWork =>
        new MikroOrmWageringUnitOfWork(orm.em),
      inject: [MikroORM],
    },
    { provide: CLOCK, useClass: SystemClock },
    { provide: ID_GENERATOR, useClass: BunIdGenerator },
    {
      provide: CreateWalletUseCase,
      useFactory: (unitOfWork: WageringUnitOfWork, clock: Clock, ids: IdGenerator) =>
        new CreateWalletUseCase(unitOfWork, clock, ids),
      inject: [WAGERING_UNIT_OF_WORK, CLOCK, ID_GENERATOR],
    },
    {
      provide: SubmitWagerTransactionUseCase,
      useFactory: (
        unitOfWork: WageringUnitOfWork,
        clock: Clock,
        ids: IdGenerator,
      ) => new SubmitWagerTransactionUseCase(unitOfWork, clock, ids),
      inject: [WAGERING_UNIT_OF_WORK, CLOCK, ID_GENERATOR],
    },
    {
      provide: HTTP_READ_REPOSITORY,
      useFactory: (orm: MikroORM) => new MikroOrmHttpReadRepository(orm.em),
      inject: [MikroORM],
    },
    { provide: APP_FILTER, useClass: ApiExceptionFilter },
  ],
})
export class AppModule {}
