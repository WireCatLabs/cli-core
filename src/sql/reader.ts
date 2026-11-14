import type { Duplex } from "node:stream"
import { CliError, isCliError } from "@wirecat/cli-base"
import { providerEvent, providerRequest } from "../cli/command-runs.js"
import type { RequestEvent } from "../runs/events.js"

export type SqlKind = "mysql" | "postgres"

/** A row as the driver gives it: a time without a zone stays the wall-time text it is, never this computer's zone. */
export type SqlRow = Record<string, unknown>

export interface SqlColumn {
  name: string
  /** True for PostgreSQL's `timestamp with time zone`; MySQL keeps no zone with a time. */
  zoned: boolean
}

export interface SqlOptions {
  kind: SqlKind
  /** The server's name; through a tunnel, still the name its TLS certificate carries. */
  host: string
  /** 3306 for MySQL and MariaDB, 5432 for PostgreSQL, when not given. */
  port?: number | null | undefined
  database: string
  user: string
  password: string
  /** TLS with the certificate checked against the computer's trust store; never without the check (WC-SECR-14). */
  tls?: boolean
  /**
   * A stream already connected to the server, opened once for the connection: an SSH tunnel's
   * `connect(host, port)` for a database that listens only on its own server.
   */
  socket?: () => Promise<Duplex>
  connectTimeoutMs?: number
  /** How long one query may run. */
  queryTimeoutMs?: number
  /** The run's events (WC-LIFE-17); the current command's run when not given. */
  events?: (event: RequestEvent) => void
  /** The run's signal: aborting it closes the connection and stops the next page. */
  signal?: AbortSignal | undefined
  /** A seam for tests: the driver in place of mysql2 or pg. */
  driver?: (options: SqlOptions, socket: Duplex | undefined) => Promise<SqlDriver>
}

/** One condition of a paged read: a column compared to a value, sent as a parameter. */
export interface SqlCondition {
  column: string
  op: "=" | "<" | "<=" | ">" | ">="
  value: unknown
}

export interface SqlPages {
  /** A table, or `schema.table`, checked as an identifier. */
  table: string
  /** All of them true. */
  where?: readonly SqlCondition[]
  /** The order of the read, oldest first for a log. */
  orderBy: readonly string[]
  /**
   * True when `orderBy` names each row once: pages then go by the last row's key, so a row written during the read
   * never shifts a page. Otherwise by offset.
   */
  unique?: boolean
  /** 5,000 when not given: a first import of years of rows never holds one answer of millions. */
  pageSize?: number
}

export interface SqlReader {
  readonly kind: SqlKind
  /** The table's columns, from an empty read of it. */
  columns(table: string): Promise<SqlColumn[]>
  /** The rows in pages, in order; each page is a request in the run. */
  pages(read: SqlPages): AsyncIterable<SqlRow[]>
  /**
   * A statement of the host's own, run in the read-only session: values only as parameters, written `?` for MySQL
   * and `$1`, `$2`… for PostgreSQL (`placeholder` gives the right one).
   */
  query(sql: string, params?: readonly unknown[]): Promise<SqlRow[]>
  /** An identifier quoted for this server, after the same check as `pages`'s. */
  quote(identifier: string): string
  placeholder(index: number): string
  close(): Promise<void>
}

/** What a driver does for the reader; mysql2 and pg are the two, a test brings its own. */
export interface SqlDriver {
  columns(sql: string): Promise<SqlColumn[]>
  query(sql: string, params: readonly unknown[]): Promise<SqlRow[]>
  close(): Promise<void>
}

export const SQL_CONNECT_TIMEOUT_MS = 15_000
export const SQL_QUERY_TIMEOUT_MS = 120_000
const PAGE = 5_000
const MOST_PAGE = 50_000

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$]{0,63}$/

const checked = (identifier: string): string[] => {
  const parts = identifier.split(".")
  if (parts.length > 2 || !parts.every((part) => IDENTIFIER.test(part)))
    throw new CliError("validation_error", "a table or column name is letters, digits and _, as name or schema.name", {
      reason: "sql.bad-identifier",
    })
  return parts
}

export const quoteSql = (kind: SqlKind, identifier: string): string =>
  checked(identifier)
    .map((part) => (kind === "mysql" ? `\`${part}\`` : `"${part}"`))
    .join(".")

const library = <T>(name: string, load: () => Promise<T>): Promise<T> =>
  load().catch(() => {
    throw new CliError("configuration_error", `this database needs the ${name} package: add ${name} to this CLI`, {
      reason: "sql.library-missing",
    })
  })

/**
 * The driver's refusal, without its text: it can quote the host, the user or the statement (WC-SECR-6). The reasons
 * are the host's to word again (`db.no-table` → "set db_table").
 */
export const sqlFailure = (kind: SqlKind, error: unknown): CliError => {
  if (isCliError(error)) return error
  const code = String((error as { code?: unknown } | null)?.code ?? "")
  const where = `the ${kind === "mysql" ? "MySQL" : "PostgreSQL"} server`
  if (["ER_ACCESS_DENIED_ERROR", "28P01", "28000"].includes(code))
    return new CliError("authentication_error", `${where} refused the user or password`, { reason: "db.refused" })
  if (["ER_BAD_DB_ERROR", "3D000"].includes(code))
    return new CliError("not_found", `${where} has no such database`, { reason: "db.no-database" })
  if (["ER_NO_SUCH_TABLE", "42P01"].includes(code))
    return new CliError("not_found", `${where} has no such table`, { reason: "db.no-table" })
  if (["ER_TABLEACCESS_DENIED_ERROR", "ER_COLUMNACCESS_DENIED_ERROR", "42501"].includes(code))
    return new CliError("permission_error", `the user may not read that table; grant it SELECT`, {
      reason: "db.no-select",
    })
  if (["ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION", "25006"].includes(code))
    return new CliError("permission_error", `${where} refused a write: this connection only reads`, {
      reason: "db.read-only",
    })
  if (["ETIMEDOUT", "PROTOCOL_SEQUENCE_TIMEOUT", "57014"].includes(code) || /timeout/i.test(String(error)))
    return new CliError("timeout", `${where} did not answer in time`, { reason: "db.timeout", retryable: true })
  if (["ECONNREFUSED", "ENOTFOUND", "EHOSTUNREACH", "ECONNRESET", "EAI_AGAIN", "EPIPE"].includes(code))
    return new CliError("network_error", `${where} could not be reached`, { reason: "network.failed", retryable: true })
  return new CliError(
    "provider_error",
    `${where} failed the query (${/^[\w-]{1,40}$/.test(code) ? code : "no code"})`,
    {
      reason: "db.failed",
    },
  )
}

const mysqlDriver = async (options: SqlOptions, socket: Duplex | undefined): Promise<SqlDriver> => {
  const { createConnection } = await library("mysql2", () => import("mysql2/promise"))
  const queryMs = options.queryTimeoutMs ?? SQL_QUERY_TIMEOUT_MS
  const connection = await createConnection({
    host: options.host,
    port: options.port ?? 3306,
    user: options.user,
    password: options.password,
    database: options.database,
    connectTimeout: options.connectTimeoutMs ?? SQL_CONNECT_TIMEOUT_MS,
    // DATETIME stays the wall time it is; the host's zone reads it, not this computer's.
    dateStrings: true,
    supportBigNumbers: true,
    bigNumberStrings: true,
    ...(socket ? { stream: socket } : {}),
    ...(options.tls ? { ssl: { rejectUnauthorized: true } } : {}),
  })
  try {
    await connection.query("SET SESSION TRANSACTION READ ONLY")
  } catch (error) {
    await connection.end().catch(() => undefined)
    throw error
  }
  return {
    columns: async (sql) => {
      const [, fields] = await connection.query({ sql, timeout: queryMs })
      return (fields ?? []).map((field) => ({ name: field.name, zoned: false }))
    },
    query: async (sql, params) => {
      const [rows] = await connection.query({ sql, timeout: queryMs }, params as unknown[])
      return rows as SqlRow[]
    },
    close: () => connection.end(),
  }
}

const TIMESTAMP_WITHOUT_ZONE = 1114
const TIMESTAMP_WITH_ZONE = 1184

const postgresDriver = async (options: SqlOptions, socket: Duplex | undefined): Promise<SqlDriver> => {
  const { default: pg } = await library("pg", () => import("pg"))
  const queryMs = options.queryTimeoutMs ?? SQL_QUERY_TIMEOUT_MS
  const client = new pg.Client({
    host: options.host,
    port: options.port ?? 5432,
    user: options.user,
    password: options.password,
    database: options.database,
    connectionTimeoutMillis: options.connectTimeoutMs ?? SQL_CONNECT_TIMEOUT_MS,
    query_timeout: queryMs,
    statement_timeout: queryMs,
    options: "-c default_transaction_read_only=on",
    ...(socket ? { stream: () => socket } : {}),
    ...(options.tls ? { ssl: { rejectUnauthorized: true, servername: options.host } } : {}),
    types: {
      getTypeParser: ((oid: number, format?: "text" | "binary") =>
        oid === TIMESTAMP_WITHOUT_ZONE
          ? (value: string) => value
          : pg.types.getTypeParser(oid, format)) as typeof pg.types.getTypeParser,
    },
  })
  await client.connect()
  return {
    columns: async (sql) =>
      (await client.query(sql)).fields.map(({ name, dataTypeID }) => ({
        name,
        zoned: dataTypeID === TIMESTAMP_WITH_ZONE,
      })),
    query: async (sql, params) => (await client.query(sql, params as unknown[])).rows as SqlRow[],
    close: () => client.end(),
  }
}

const OPERATORS = new Set(["=", "<", "<=", ">", ">="])

/**
 * A MySQL, MariaDB or PostgreSQL database, read only: the session is opened read-only, and a paged read is one SELECT
 * whose names were checked as identifiers and whose values are parameters. The host brings its own schema: which
 * table, which columns, which order. Every connect and page is a request in the run's events, with no statement,
 * value or name in it.
 */
export const openSqlReader = async (options: SqlOptions): Promise<SqlReader> => {
  const { kind } = options
  const events = options.events ?? providerEvent
  const traced = async <T>(
    operation: string,
    work: () => Promise<T>,
    counts?: (value: T) => Record<string, number>,
  ) => {
    const answered = providerRequest(operation, events, { transport: "sql" })
    try {
      const value = await work()
      answered({ ids: { host: options.host }, ...(counts ? { counts: counts(value) } : {}) })
      return value
    } catch (error) {
      const failure = options.signal?.aborted
        ? new CliError("cancelled", "the database read was stopped", { reason: "command.cancelled" })
        : sqlFailure(kind, error)
      answered({ ids: { host: options.host }, error: failure, errorCode: failure.code })
      throw failure
    }
  }
  options.signal?.throwIfAborted()
  const driver = await traced("sql.connect", async () => {
    const socket = options.socket ? await options.socket() : undefined
    return (options.driver ?? (kind === "mysql" ? mysqlDriver : postgresDriver))(options, socket)
  })
  const stop = () => void driver.close().catch(() => undefined)
  options.signal?.addEventListener("abort", stop, { once: true })
  const quote = (identifier: string) => quoteSql(kind, identifier)
  const placeholder = (index: number) => (kind === "mysql" ? "?" : `$${index}`)
  const stopped = () => {
    if (options.signal?.aborted)
      throw new CliError("cancelled", "the database read was stopped", { reason: "command.cancelled" })
  }
  return {
    kind,
    quote,
    placeholder,
    columns: (table) =>
      traced(
        "sql.columns",
        () => driver.columns(`SELECT * FROM ${quote(table)} LIMIT 0`),
        (columns) => ({ columns: columns.length }),
      ),
    query: (sql, params = []) => {
      stopped()
      return traced(
        "sql.query",
        () => driver.query(sql, params),
        (rows) => ({ rows: rows.length }),
      )
    },
    async *pages(read) {
      const size = read.pageSize ?? PAGE
      if (!Number.isSafeInteger(size) || size < 1 || size > MOST_PAGE)
        throw new CliError("validation_error", `a page is 1 to ${MOST_PAGE} rows`, { reason: "input.invalid" })
      if (read.orderBy.length === 0)
        throw new CliError("validation_error", "a paged read needs an order", { reason: "input.invalid" })
      const conditions = read.where ?? []
      for (const { op } of conditions)
        if (!OPERATORS.has(op))
          throw new CliError("validation_error", "an unknown comparison", { reason: "input.invalid" })
      const table = quote(read.table)
      const order = read.orderBy.map(quote)
      const filters = conditions.map(({ column, op }, index) => `${quote(column)} ${op} ${placeholder(index + 1)}`)
      const values = conditions.map(({ value }) => value)
      const keyset = read.unique === true
      let last: SqlRow | undefined
      for (let offset = 0; ; offset += size) {
        stopped()
        const after = keyset && last !== undefined
        const where = [
          ...filters,
          ...(after
            ? [
                `(${order.join(", ")}) > (${read.orderBy.map((_, index) => placeholder(conditions.length + index + 1)).join(", ")})`,
              ]
            : []),
        ]
        const params = after ? [...values, ...read.orderBy.map((name) => last?.[name] ?? null)] : values
        const sql =
          `SELECT * FROM ${table}${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY ${order.join(", ")} ` +
          `LIMIT ${size}${keyset ? "" : ` OFFSET ${offset}`}`
        const page = await traced(
          "sql.rows",
          () => driver.query(sql, params),
          (rows) => ({ rows: rows.length }),
        )
        if (page.length > 0) yield page
        last = page.at(-1)
        if (page.length < size) return
      }
    },
    close: async () => {
      options.signal?.removeEventListener("abort", stop)
      await driver.close()
    },
  }
}
