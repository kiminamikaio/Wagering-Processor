import { EntityManager } from "@mikro-orm/core";
import { PersistenceMappingError } from "./persistence-errors";

export type SqlRow = Record<string, unknown>;

function isSqlRow(value: unknown): value is SqlRow {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasAffectedRows(value: unknown): value is { affectedRows: number } {
  return (
    typeof value === "object" &&
    value !== null &&
    "affectedRows" in value &&
    typeof value.affectedRows === "number"
  );
}

export async function executeRows(
  em: EntityManager,
  sql: string,
  params: unknown[] = [],
): Promise<SqlRow[]> {
  const result: unknown = await em
    .getConnection()
    .execute<SqlRow>(sql, params, "all", em.getTransactionContext());

  if (!Array.isArray(result)) {
    throw new PersistenceMappingError("The SQL query did not return a row set.");
  }

  return result.map((row: unknown) => {
    if (!isSqlRow(row)) {
      throw new PersistenceMappingError("The SQL query returned an invalid row.");
    }

    return row;
  });
}

export async function executeStatement(
  em: EntityManager,
  sql: string,
  params: unknown[] = [],
): Promise<number> {
  const result: unknown = await em
    .getConnection()
    .execute(sql, params, "run", em.getTransactionContext());

  if (!hasAffectedRows(result)) {
    throw new PersistenceMappingError("The SQL command did not report affected rows.");
  }

  return result.affectedRows;
}

export function requiredString(row: SqlRow, column: string): string {
  const value = row[column];
  if (typeof value !== "string") {
    throw new PersistenceMappingError(`Expected ${column} to be a non-null string.`);
  }

  return value;
}

export function optionalString(
  row: SqlRow,
  column: string,
): string | undefined {
  const value = row[column];
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new PersistenceMappingError(`Expected ${column} to be a nullable string.`);
  }

  return value;
}

export function requiredInteger(row: SqlRow, column: string): number {
  const value = row[column];
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new PersistenceMappingError(`Expected ${column} to be an integer.`);
  }

  return value;
}

export function requiredDate(row: SqlRow, column: string): Date {
  const value = row[column];
  const date =
    value instanceof Date
      ? value
      : typeof value === "string"
        ? new Date(value)
        : undefined;

  if (date === undefined || Number.isNaN(date.getTime())) {
    throw new PersistenceMappingError(`Expected ${column} to be a valid timestamp.`);
  }

  return date;
}

export function optionalDate(row: SqlRow, column: string): Date | undefined {
  const value = row[column];
  if (value === null || value === undefined) {
    return undefined;
  }

  return requiredDate(row, column);
}
