import { DatabaseSync } from "node:sqlite";
import { normalizeUsername } from "./account";
import { hashPassword } from "./password";
import { adoptLegacyDatabase } from "./adopt-legacy-db";
import { databaseUrl, ensureDataDir, isPostgresUrl, sqliteFile } from "./paths";

type Row = Record<string, unknown>;

type Sql = {
  exec(statement: string): Promise<void>;
  get(statement: string, params?: unknown[]): Promise<Row | undefined>;
  all(statement: string, params?: unknown[]): Promise<Row[]>;
  run(statement: string, params?: unknown[]): Promise<void>;
};

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    name TEXT NOT NULL,
    role TEXT NOT NULL,
    disabled INTEGER NOT NULL DEFAULT 0,
    credential_version INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS connections (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    site_base TEXT NOT NULL,
    openai_base TEXT NOT NULL,
    token_cipher TEXT NOT NULL,
    demo INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL,
    status_detail TEXT,
    last_validated_at INTEGER,
    quota_available REAL,
    quota_used REAL,
    unlimited_quota INTEGER,
    expires_at REAL,
    credential_updated_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS connections_user_id ON connections(user_id)`,
  `CREATE TABLE IF NOT EXISTS gateways (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    base_url TEXT NOT NULL,
    token_cipher TEXT NOT NULL,
    admin_user_id TEXT NOT NULL,
    demo INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS channels (
    id TEXT PRIMARY KEY,
    gateway_id TEXT NOT NULL,
    upstream_id INTEGER NOT NULL,
    creator_user_id TEXT,
    name TEXT NOT NULL,
    type INTEGER NOT NULL,
    group_name TEXT NOT NULL,
    status INTEGER NOT NULL,
    base_url TEXT NOT NULL DEFAULT '',
    models TEXT NOT NULL DEFAULT '',
    model_mapping TEXT NOT NULL DEFAULT '',
    test_model TEXT NOT NULL DEFAULT '',
    remark TEXT NOT NULL DEFAULT '',
    auto_ban INTEGER NOT NULL DEFAULT 1,
    balance REAL,
    used_quota REAL NOT NULL DEFAULT 0,
    today_quota REAL,
    upstream_created_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_sync_at INTEGER,
    sync_status TEXT NOT NULL DEFAULT 'pending',
    sync_error TEXT,
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    next_poll_at INTEGER NOT NULL DEFAULT 0,
    demo_fail_left INTEGER NOT NULL DEFAULT 0,
    priority INTEGER NOT NULL DEFAULT 0,
    weight INTEGER NOT NULL DEFAULT 0,
    tag TEXT NOT NULL DEFAULT '',
    other TEXT NOT NULL DEFAULT '',
    status_code_mapping TEXT NOT NULL DEFAULT '',
    param_override TEXT NOT NULL DEFAULT '',
    header_override TEXT NOT NULL DEFAULT '',
    setting TEXT NOT NULL DEFAULT '',
    settings TEXT NOT NULL DEFAULT '{}',
    openai_organization TEXT NOT NULL DEFAULT '',
    response_time INTEGER,
    last_test_at INTEGER,
    last_test_ok INTEGER,
    last_test_error TEXT NOT NULL DEFAULT '',
    last_test_model TEXT NOT NULL DEFAULT '',
    auto_disable_reason TEXT NOT NULL DEFAULT '',
    auto_disable_history TEXT NOT NULL DEFAULT '[]',
    auto_disabled_at INTEGER,
    test_ok_count INTEGER NOT NULL DEFAULT 0,
    test_total_count INTEGER NOT NULL DEFAULT 0,
    key_fingerprints TEXT NOT NULL DEFAULT '',
    created_here INTEGER NOT NULL DEFAULT 0,
    create_baseline REAL,
    upstream_missing INTEGER NOT NULL DEFAULT 0,
    UNIQUE (gateway_id, upstream_id)
  )`,
  `CREATE INDEX IF NOT EXISTS channels_gateway ON channels(gateway_id)`,
  `CREATE INDEX IF NOT EXISTS channels_creator ON channels(creator_user_id)`,
  `CREATE INDEX IF NOT EXISTS channels_list ON channels(created_here, gateway_id, status)`,
  `CREATE TABLE IF NOT EXISTS channel_bindings (
    id TEXT PRIMARY KEY,
    record_id TEXT NOT NULL,
    gateway_id TEXT NOT NULL,
    newapi_channel_id INTEGER NOT NULL,
    previous_newapi_id INTEGER,
    bound_at INTEGER NOT NULL,
    unbound_at INTEGER,
    reason TEXT NOT NULL DEFAULT '',
    bind_snapshot REAL,
    close_quota REAL,
    close_status TEXT NOT NULL DEFAULT ''
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS channel_bindings_active ON channel_bindings(gateway_id, newapi_channel_id) WHERE unbound_at IS NULL`,
  `CREATE INDEX IF NOT EXISTS channel_bindings_record ON channel_bindings(record_id, bound_at)`,
  `CREATE TABLE IF NOT EXISTS channel_baselines (
    channel_id TEXT NOT NULL,
    day TEXT NOT NULL,
    baseline REAL NOT NULL,
    cumulative REAL NOT NULL,
    today_quota REAL,
    source TEXT NOT NULL,
    pulled_at INTEGER NOT NULL,
    PRIMARY KEY (channel_id, day)
  )`,
  `CREATE TABLE IF NOT EXISTS billing_runs (
    baseline_day TEXT PRIMARY KEY,
    bill_day TEXT NOT NULL,
    status TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    published_at INTEGER,
    total_count INTEGER NOT NULL DEFAULT 0,
    ok_count INTEGER NOT NULL DEFAULT 0,
    failed_count INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS billing_attempts (
    baseline_day TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    status TEXT NOT NULL,
    error TEXT,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (baseline_day, channel_id)
  )`,
  `CREATE TABLE IF NOT EXISTS billing_rows (
    id TEXT PRIMARY KEY,
    bill_day TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    start_day TEXT NOT NULL,
    end_day TEXT NOT NULL,
    span_days INTEGER NOT NULL,
    label TEXT,
    consumption REAL,
    kind TEXT NOT NULL,
    backfill_at INTEGER,
    test_quota REAL NOT NULL DEFAULT 0,
    finding TEXT NOT NULL DEFAULT '',
    log_quota REAL,
    UNIQUE (bill_day, channel_id)
  )`,
  `CREATE TABLE IF NOT EXISTS channel_audits (
    id TEXT PRIMARY KEY,
    actor_user_id TEXT,
    channel_id TEXT,
    upstream_id INTEGER,
    action TEXT NOT NULL,
    result TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS gateway_list_seen (
    gateway_id TEXT NOT NULL,
    upstream_id INTEGER NOT NULL,
    PRIMARY KEY (gateway_id, upstream_id)
  )`,
  `CREATE INDEX IF NOT EXISTS channel_audits_channel ON channel_audits(channel_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS test_runs (
    id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL,
    actor_user_id TEXT,
    model TEXT NOT NULL,
    result TEXT NOT NULL,
    latency_ms INTEGER,
    error TEXT NOT NULL DEFAULT '',
    quota INTEGER,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS test_runs_channel_time ON test_runs(channel_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS recon_rows (
    id TEXT PRIMARY KEY,
    bill_day TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    gateway_id TEXT NOT NULL,
    start_day TEXT NOT NULL,
    end_day TEXT NOT NULL,
    span_days INTEGER NOT NULL DEFAULT 1,
    label TEXT NOT NULL DEFAULT '',
    ours_quota REAL,
    log_quota REAL,
    delta REAL,
    delta_pct REAL,
    yesterday_baseline REAL,
    today_baseline REAL,
    channel_status INTEGER NOT NULL DEFAULT 1,
    zero_streak INTEGER NOT NULL DEFAULT 0,
    gateway_quiet INTEGER NOT NULL DEFAULT 0,
    log_timed_out INTEGER NOT NULL DEFAULT 0,
    upstream_missing INTEGER NOT NULL DEFAULT 0,
    check_status TEXT NOT NULL,
    reason TEXT NOT NULL DEFAULT '',
    tolerance REAL NOT NULL,
    quota_per_unit REAL NOT NULL,
    supplier_action TEXT NOT NULL DEFAULT '',
    supplier_note TEXT NOT NULL DEFAULT '',
    supplier_user_id TEXT,
    supplier_at INTEGER,
    admin_resolution TEXT NOT NULL DEFAULT '',
    admin_note TEXT NOT NULL DEFAULT '',
    admin_user_id TEXT,
    admin_at INTEGER,
    updated_at INTEGER NOT NULL,
    UNIQUE (bill_day, channel_id)
  )`,
  `CREATE INDEX IF NOT EXISTS recon_rows_day ON recon_rows(bill_day, gateway_id)`,
  `CREATE TABLE IF NOT EXISTS recon_gateway_days (
    gateway_id TEXT NOT NULL,
    bill_day TEXT NOT NULL,
    log_quota REAL,
    timed_out INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (gateway_id, bill_day)
  )`,
  `CREATE TABLE IF NOT EXISTS recon_periods (
    month TEXT PRIMARY KEY,
    locked INTEGER NOT NULL DEFAULT 0,
    locked_at INTEGER,
    locked_by TEXT,
    note TEXT NOT NULL DEFAULT ''
  )`,
  `CREATE TABLE IF NOT EXISTS recon_adjustments (
    id TEXT PRIMARY KEY,
    bill_day TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    amount_quota REAL NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    actor_user_id TEXT,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS recon_adjustments_channel ON recon_adjustments(bill_day, channel_id)`,
  `CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    revoked_at INTEGER,
    last_seen INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id)`,
  `CREATE TABLE IF NOT EXISTS recon_manual_entries (
    id TEXT PRIMARY KEY,
    bill_day TEXT NOT NULL,
    channel_id TEXT,
    gateway_id TEXT,
    supplier_user_id TEXT,
    source TEXT NOT NULL,
    amount_quota REAL,
    note TEXT NOT NULL DEFAULT '',
    tolerance REAL,
    created_at INTEGER NOT NULL
  )`,
];

function toPg(statement: string): string {
  let index = 0;
  return statement.replace(/\?/g, () => {
    index += 1;
    return `$${index}`;
  });
}

function asRow(value: unknown): Row | undefined {
  if (!value || typeof value !== "object") return undefined;
  return value as Row;
}

let announcedSqlite = false;

function sqlite(): Sql {
  adoptLegacyDatabase();
  ensureDataDir();
  const file = sqliteFile();
  if (!announcedSqlite) {
    announcedSqlite = true;
    console.log(`[db] opening ${file}`);
  }
  const db = new DatabaseSync(file);
  db.exec("PRAGMA foreign_keys = ON");
  return {
    async exec(statement) {
      db.exec(statement);
    },
    async get(statement, params = []) {
      return asRow(db.prepare(statement).get(...params));
    },
    async all(statement, params = []) {
      return db
        .prepare(statement)
        .all(...params)
        .map((item: unknown) => asRow(item)!);
    },
    async run(statement, params = []) {
      db.prepare(statement).run(...params);
    },
  };
}

async function postgres(): Promise<Sql> {
  const { default: postgresClient } = await import("postgres");
  const sql = postgresClient(databaseUrl(), { max: 5 });
  return {
    async exec(statement) {
      await sql.unsafe(statement);
    },
    async get(statement, params = []) {
      const rows = await sql.unsafe(toPg(statement), params as never[]);
      return asRow(rows[0]);
    },
    async all(statement, params = []) {
      const rows = (await sql.unsafe(toPg(statement), params as never[])) as unknown[];
      return rows.map((item) => asRow(item)!);
    },
    async run(statement, params = []) {
      await sql.unsafe(toPg(statement), params as never[]);
    },
  };
}

let sqlPromise: Promise<Sql> | null = null;
let ready: Promise<void> | null = null;

function sql(): Promise<Sql> {
  if (!sqlPromise) sqlPromise = isPostgresUrl() ? postgres() : Promise.resolve(sqlite());
  return sqlPromise;
}

async function columnNames(db: Sql, table = "users"): Promise<string[]> {
  if (isPostgresUrl()) {
    const rows = await db.all(
      "SELECT column_name AS name FROM information_schema.columns WHERE table_name = ?",
      [table],
    );
    return rows.map((row) => String(row.name));
  }
  const rows = await db.all(`PRAGMA table_info(${table})`);
  return rows.map((row) => String(row.name));
}

async function addMissingColumns(db: Sql, table: string, columns: [string, string][]): Promise<void> {
  const existing = new Set(await columnNames(db, table));
  if (existing.size === 0) return;
  for (const [name, definition] of columns) {
    if (!existing.has(name)) await db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
  }
}

async function migrateUsers(db: Sql): Promise<void> {
  const columns = await columnNames(db);
  if (columns.length === 0) return;
  if (columns.includes("email") && !columns.includes("username")) {
    await db.exec("ALTER TABLE users RENAME COLUMN email TO username");
  }
  const next = await columnNames(db);
  if (next.includes("username") && !next.includes("credential_version")) {
    await db.exec("ALTER TABLE users ADD COLUMN credential_version INTEGER NOT NULL DEFAULT 0");
  }
}

async function seedAdmin(): Promise<void> {
  const username = normalizeUsername(process.env.ADMIN_USERNAME);
  const password = process.env.ADMIN_PASSWORD;
  if (!username || !password || password.length < 8 || /\s/.test(password)) return;
  const db = await sql();
  const existing = await db.get("SELECT id FROM users WHERE username = ?", [username]);
  if (existing) return;
  const admins = await db.all("SELECT id, username FROM users WHERE role = 'admin'");
  const legacy = admins.filter((row) => String(row.username ?? "").includes("@"));
  if (admins.length === 1 && legacy.length === 1) {
    await db.run("UPDATE users SET username = ? WHERE id = ?", [username, legacy[0]?.id]);
    return;
  }
  await db.run(
    `INSERT INTO users (id, username, password_hash, name, role, disabled, credential_version, created_at)
     VALUES (?, ?, ?, ?, 'admin', 0, 0, ?)`,
    [crypto.randomUUID(), username, await hashPassword(password), "管理员", Date.now()],
  );
}

export async function ensureReady(): Promise<void> {
  if (!ready) {
    ready = (async () => {
      const db = await sql();
      for (const statement of SCHEMA) await db.exec(statement);
      await migrateUsers(db);
      await addMissingColumns(db, "channels", [
        ["priority", "INTEGER NOT NULL DEFAULT 0"],
        ["weight", "INTEGER NOT NULL DEFAULT 0"],
        ["tag", "TEXT NOT NULL DEFAULT ''"],
        ["other", "TEXT NOT NULL DEFAULT ''"],
        ["status_code_mapping", "TEXT NOT NULL DEFAULT ''"],
        ["param_override", "TEXT NOT NULL DEFAULT ''"],
        ["header_override", "TEXT NOT NULL DEFAULT ''"],
        ["setting", "TEXT NOT NULL DEFAULT ''"],
        ["settings", "TEXT NOT NULL DEFAULT '{}'"],
        ["openai_organization", "TEXT NOT NULL DEFAULT ''"],
        ["response_time", "INTEGER"],
        ["last_test_at", "INTEGER"],
        ["last_test_ok", "INTEGER"],
        ["last_test_error", "TEXT NOT NULL DEFAULT ''"],
        ["last_test_model", "TEXT NOT NULL DEFAULT ''"],
        ["auto_disable_reason", "TEXT NOT NULL DEFAULT ''"],
        ["auto_disable_history", "TEXT NOT NULL DEFAULT '[]'"],
        ["key_fingerprints", "TEXT NOT NULL DEFAULT ''"],
        ["created_here", "INTEGER NOT NULL DEFAULT 0"],
        ["create_baseline", "REAL"],
        ["upstream_missing", "INTEGER NOT NULL DEFAULT 0"],
        ["auto_disabled_at", "INTEGER"],
        ["test_ok_count", "INTEGER NOT NULL DEFAULT 0"],
        ["test_total_count", "INTEGER NOT NULL DEFAULT 0"],
      ]);
      await addMissingColumns(db, "billing_rows", [
        ["test_quota", "REAL NOT NULL DEFAULT 0"],
        ["finding", "TEXT NOT NULL DEFAULT ''"],
        ["log_quota", "REAL"],
      ]);
      await addMissingColumns(db, "users", [["locale", "TEXT"]]);
      await addMissingColumns(db, "billing_rows", [["binding_id", "TEXT"]]);
      await addMissingColumns(db, "recon_rows", [["binding_id", "TEXT"]]);
      await addMissingColumns(db, "gateways", [["disabled", "INTEGER NOT NULL DEFAULT 0"]]);
      await addMissingColumns(db, "channels", [["missing_handled", "INTEGER NOT NULL DEFAULT 0"]]);
      await db.exec(
        `INSERT INTO channel_bindings (id, record_id, gateway_id, newapi_channel_id, bound_at, reason, bind_snapshot)
         SELECT 'seed-' || id, id, gateway_id, upstream_id, created_at, 'seed', COALESCE(create_baseline, used_quota)
         FROM channels
         WHERE created_here = 1
           AND NOT EXISTS (
             SELECT 1 FROM channel_bindings b WHERE b.record_id = channels.id AND b.unbound_at IS NULL
           )`,
      );
      await seedAdmin();
    })();
  }
  await ready;
}

export async function dbGet(statement: string, params: unknown[] = []): Promise<Row | undefined> {
  await ensureReady();
  return (await sql()).get(statement, params);
}

export async function dbAll(statement: string, params: unknown[] = []): Promise<Row[]> {
  await ensureReady();
  return (await sql()).all(statement, params);
}

export async function dbRun(statement: string, params: unknown[] = []): Promise<void> {
  await ensureReady();
  return (await sql()).run(statement, params);
}

export function resetDatabaseForTests(): void {
  sqlPromise = null;
  ready = null;
  announcedSqlite = false;
}
