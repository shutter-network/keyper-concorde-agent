// Test helpers, the same four the framework keeps in src/test-support and does not export:
// a throwaway database per test file, a schema applied without drizzle-kit's CLI, a wait, and a
// logger that says nothing.

import { pushSchema } from "drizzle-kit/api";
import { sql } from "drizzle-orm";
import { type Db, type Handle, openDb } from "@shutter-network/concorde/db";
import type { Logger } from "@shutter-network/concorde/logging";

const defaultUrl = "postgres://postgres:postgres@localhost:5432/postgres";

/** The server to create test databases on. Its own database is only ever used for that. */
export const serverUrl = process.env.DATABASE_URL ?? defaultUrl;

export type TestDatabase = {
  readonly db: Db;
  readonly url: string;
  drop(): Promise<void>;
};

export async function createTestDatabase(name: string): Promise<TestDatabase> {
  const database = databaseName(name);
  const url = new URL(serverUrl);
  url.pathname = `/${database}`;
  await onServer(async (server) => {
    await server.execute(sql`drop database if exists ${sql.identifier(database)}`);
    await server.execute(sql`create database ${sql.identifier(database)}`);
  });
  const db = openDb(url.href);
  return {
    db,
    url: url.href,
    async drop() {
      await db.stop();
      await onServer(async (server) => {
        await server.execute(sql`drop database if exists ${sql.identifier(database)}`);
      });
    },
  };
}

function databaseName(name: string): string {
  const prefixed = `test_${name.toLowerCase().replaceAll(/[^a-z0-9]+/g, "_")}`;
  if (prefixed.length > 63) {
    throw new Error(`test database name ${prefixed} exceeds PostgreSQL's 63-byte identifier limit`);
  }
  return prefixed;
}

async function onServer(run: (server: Handle) => Promise<void>): Promise<void> {
  const server = openDb(serverUrl);
  try {
    await run(server.handle({}));
  } finally {
    await server.stop();
  }
}

export type PartSchema = Record<string, unknown>;

/** Creates every table the given schema modules export, the way the migrate step would. */
export async function applySchema(db: Db, ...parts: readonly PartSchema[]): Promise<void> {
  const all: Record<string, unknown> = {};
  for (const [index, part] of parts.entries()) {
    for (const [name, value] of Object.entries(part)) all[`${index}:${name}`] = value;
  }
  const { apply } = await pushSchema(all, db.handle({}));
  await apply();
}

const defaultTimeoutMs = 10_000;
const pollIntervalMs = 5;

export async function waitUntil(
  description: string,
  condition: () => Promise<boolean> | boolean,
  timeoutMs: number = defaultTimeoutMs,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await condition()) return;
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${timeoutMs}ms waiting until ${description}`);
    }
    await new Promise((resume) => setTimeout(resume, pollIntervalMs));
  }
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resume) => setTimeout(resume, ms));

export const silent: Logger = { debug() {}, info() {}, warn() {}, error() {} };
