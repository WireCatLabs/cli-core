# SQL

`@wirecat/cli-core/sql` reads a MySQL, MariaDB or PostgreSQL database for a CLI that keeps its records there: a
PBX's call records (CDR), a system's export table. It only reads. The host brings its own schema: which table, which
columns, which order, and what a row means.

## Set up

`mysql2` and `pg` are optional peers of cli-core, so a CLI that reads no database neither installs nor loads them. A
CLI adds the one it reads, or both, and leaves them out of the bundle:

```sh
pnpm add mysql2 pg
cli-dev bundle --bin dist/bin/<cli>.js --external mysql2 --external pg
```

Without the package, the first connection fails with `configuration_error` and reason `sql.library-missing`.

## Read

```ts
import { openSqlReader } from "@wirecat/cli-core/sql"

await context.run(async (events) => {
  const db = await openSqlReader({
    kind: "mysql",                          // or "postgres"
    host: "pbx.example.com",
    database: "asteriskcdrdb",
    user: "cdr_reader",
    password,                               // from the keyring, never an argument
    tls: true,
    events,
    ...(signal ? { signal } : {}),
  })
  try {
    const columns = await db.columns("cdr") // [{ name: "calldate", zoned: false }, …]
    for await (const page of db.pages({
      table: "cdr",
      where: [{ column: "calldate", op: ">=", value: "2026-11-01 00:00:00" }],
      orderBy: ["calldate", "uniqueid", "sequence"],
      unique: true,
    }))
      for (const row of page) keep(row)
  } finally {
    await db.close()
  }
})
```

- The session is read-only: MySQL's `SET SESSION TRANSACTION READ ONLY`, PostgreSQL's
  `default_transaction_read_only`. A write the host sends anyway is refused by the server (`db.read-only`).
- `tls: true` checks the server's certificate against the computer's trust store, and never turns the check off.
- A time without a zone (MySQL `DATETIME`, PostgreSQL `timestamp`) stays the text the server sent, so the host reads
  it in its own zone, never this computer's. `columns` says which PostgreSQL columns keep a zone (`zoned`).
- `pages` reads 5,000 rows at a time (`pageSize`, up to 50,000). With `unique: true`, `orderBy` names each row once
  and the next page starts after the last row's key, so a row written during the read never shifts a page;
  otherwise pages go by offset. Every table and column name is checked as an identifier (letters, digits and `_`,
  as `name` or `schema.name`) and quoted for the server; every value is a parameter.
- `query(sql, params)` runs a statement of the host's own in the same read-only session; `placeholder(n)` gives `?`
  or `$n`, and `quote(name)` a checked, quoted name.
- `socket` takes a stream already connected to the server, opened once per connection: an SSH tunnel's
  `connect(host, port)` for a database that listens only on its own server — see [SFTP, "A tunnel to a database
  behind the server"](sftp.md#a-tunnel-to-a-database-behind-the-server). `host` is then still the name the server's
  certificate carries.

## Time limits

| | Default | Option |
|---|---|---|
| Connect | 15 s | `connectTimeoutMs` |
| One query or page | 120 s | `queryTimeoutMs` |

The run's signal closes the connection and stops before the next page with `cancelled`. Nothing is tried again: a
host that wants a retry opens the reader again.

## Errors

| Code | Reason | When |
|---|---|---|
| `authentication_error` | `db.refused` | the server refused the user or password |
| `not_found` | `db.no-database` | no such database |
| `not_found` | `db.no-table` | no such table; the host names its setting |
| `permission_error` | `db.no-select` | the user may not read the table |
| `permission_error` | `db.read-only` | a statement tried to write |
| `timeout` | `db.timeout` | the server did not answer in time |
| `network_error` | `network.failed` | the server could not be reached |
| `provider_error` | `db.failed` | any other failure, with the driver's code only |
| `validation_error` | `sql.bad-identifier` | a name is not an identifier |
| `configuration_error` | `sql.library-missing` | `mysql2` or `pg` is not installed |

No message quotes the driver's text, a statement, a value, the host, the user or the password: a driver's message can
quote any of them (WC-SECR-6). `sqlFailure(kind, error)` gives the same mapping to a host's own driver code.

## The run's events

Each connect, column read, page and query is a pair of `request` and `response` events with `transport: "sql"` and
`level: "wire"`: `sql.connect`, `sql.columns` (`counts.columns`), `sql.rows` and `sql.query` (`counts.rows`). The
response carries `ids.host`, and an error its code. No event carries a statement, a value or a name. A test brings
its own `driver`, as `src/sql/reader.test.ts` does.
