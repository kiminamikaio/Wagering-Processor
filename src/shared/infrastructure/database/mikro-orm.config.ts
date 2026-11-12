import "dotenv/config";
import { Migrator } from "@mikro-orm/migrations";
import { defineConfig } from "@mikro-orm/postgresql";

export default defineConfig({
  clientUrl: process.env.DATABASE_URL,
  entities: [],
  discovery: {
    warnWhenNoEntities: false,
  },
  extensions: [Migrator],
  migrations: {
    path: "dist/shared/infrastructure/database/migrations",
    pathTs: "src/shared/infrastructure/database/migrations",
  },
});
