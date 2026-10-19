import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";

/** Named volume mount. Compose and the image both point SQLite here. */
export const VOLUME_SQLITE_PATH = "/data/app.db";

function envValue(name: string): string {
  // Bracket access so the production bundler cannot inline a build-time value.
  // A relative DATABASE_URL baked in as "file:./data/app.db" would ignore the
  // container env and write the database under /app instead of the volume.
  const value = process.env[name];
  return typeof value === "string" ? value.trim() : "";
}

export function databaseUrl(): string {
  return envValue("DATABASE_URL") || "file:./data/app.db";
}

export function isPostgresUrl(url = databaseUrl()): boolean {
  return url.startsWith("postgres://") || url.startsWith("postgresql://");
}

export function resolveSqlitePath(url: string, cwd = process.cwd()): string {
  let raw = url.replace(/^file:/, "");
  if (raw.startsWith("//")) {
    const slash = raw.indexOf("/", 2);
    raw = slash >= 0 ? raw.slice(slash) : raw;
  }
  return path.isAbsolute(raw) ? path.normalize(raw) : path.join(/* turbopackIgnore: true */ cwd, raw);
}

export function pinSqliteToVolume(
  configured: string,
  env: { nodeEnv?: string; phase?: string; docker?: boolean },
): string {
  if (env.phase === "phase-production-build") return configured;
  if (env.nodeEnv !== "production" || !env.docker) return configured;
  const normalized = path.normalize(configured);
  if (normalized === VOLUME_SQLITE_PATH || normalized.startsWith("/data/")) return normalized;
  if (normalized === "/app/data/app.db" || normalized === "/app/app.db" || normalized.startsWith("/app/")) {
    return VOLUME_SQLITE_PATH;
  }
  return normalized;
}

function runtimeSqliteFile(): string {
  const url = databaseUrl();
  const configured = resolveSqlitePath(url);
  return pinSqliteToVolume(configured, {
    nodeEnv: envValue("NODE_ENV"),
    phase: envValue("NEXT_PHASE"),
    docker: existsSync("/.dockerenv"),
  });
}

export function dataDir(): string {
  const url = databaseUrl();
  if (isPostgresUrl(url)) return path.join(/* turbopackIgnore: true */ process.cwd(), "data");
  return path.dirname(runtimeSqliteFile());
}

export function sqliteFile(): string {
  return runtimeSqliteFile();
}

/** Locations an older image used when DATABASE_URL was relative to WORKDIR /app. */
export function legacySqliteCandidates(cwd = process.cwd()): string[] {
  const url = databaseUrl();
  const configured = isPostgresUrl(url) ? "" : resolveSqlitePath(url, cwd);
  const list = ["/app/data/app.db", "/app/app.db"];
  if (cwd === "/app" || cwd.startsWith("/app/")) {
    list.push(path.join(/* turbopackIgnore: true */ cwd, "data", "app.db"), path.join(/* turbopackIgnore: true */ cwd, "app.db"));
  }
  if (configured) list.push(configured);
  return list;
}

export function ensureDataDir(): string {
  const dir = dataDir();
  mkdirSync(dir, { recursive: true });
  return dir;
}
