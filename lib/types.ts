import type { Locale } from "./locale";

export type Role = "admin" | "supplier";

export type SessionUser = {
  id: string;
  username: string;
  name: string;
  role: Role;
  locale: Locale | null;
  /** Top-bar site name. Defaults to the product brand. */
  siteName?: string;
};

export type ConnectionStatus = "unknown" | "ok" | "expiring" | "failing" | "expired";

export type Connection = {
  id: string;
  userId: string;
  ownerUsername: string;
  ownerName: string;
  /** True when the signed-in user owns this row and may reveal or change the token. */
  owned: boolean;
  name: string;
  /** Site root with trailing slash and a trailing `/v1` removed. `demo` for the local fixture. */
  siteBase: string;
  openaiBase: string;
  /** Masked token. The raw value stays encrypted in the database. */
  tokenMasked: string;
  demo: boolean;
  createdAt: number;
  updatedAt: number;
  /** Changes only when the token, site, or demo flag changes. Heartbeat ignores status updates. */
  credentialUpdatedAt: number;
  lastValidatedAt?: number;
  status: ConnectionStatus;
  statusDetail?: string;
  /** Last probed remaining quota. Absent until a usage probe succeeds. */
  quotaAvailable?: number;
  quotaUsed?: number;
  unlimitedQuota?: boolean;
  /** Upstream `expires_at`, seconds or milliseconds, 0 when the token does not expire. */
  expiresAt?: number;
};

export type TokenUsage = {
  name: string;
  total_granted: number;
  total_used: number;
  total_available: number;
  unlimited_quota: boolean;
  expires_at: number;
  model_limits: string[];
  model_limits_enabled: boolean;
};

export type ModelInfo = {
  id: string;
  owned_by?: string;
  created?: number;
};

export type UsageSnapshot = {
  usage: TokenUsage | null;
  error?: string;
  fetchedAt: number;
};

export type RequestLog = {
  id: string;
  createdAt: number;
  model: string;
  quota: number;
  promptTokens: number;
  completionTokens: number;
  useTime: number;
  tokenName: string;
};
