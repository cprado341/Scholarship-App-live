import { neon } from "@neondatabase/serverless";

type NeonSql = ReturnType<typeof neon>;

let sqlClient: NeonSql | undefined;

export function getNeonSql(): NeonSql {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required for SaaS Neon Postgres access.");
  }
  sqlClient ??= neon(process.env.DATABASE_URL);
  return sqlClient;
}

export async function assertNeonReady(): Promise<void> {
  const sql = getNeonSql();
  await sql`select 1 as ok`;
}
