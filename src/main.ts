import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { jsonLogger } from "./observability/json-logger";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { logger: jsonLogger });
  app.enableShutdownHooks();
  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
}

void bootstrap();
