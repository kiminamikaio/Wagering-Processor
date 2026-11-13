import "dotenv/config";
import { Migrator } from "@mikro-orm/migrations";
import { defineConfig } from "@mikro-orm/postgresql";

function positiveIntegerEnv(name: string, defaultValue: number): number {
  const rawValue = process.env[name];
  if (rawValue === undefined) {
    return defaultValue;
  }

  const value = Number(rawValue);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }

  return value;
}

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
  pool: {
    max: positiveIntegerEnv("DB_POOL_MAX", 10),
  },
});
