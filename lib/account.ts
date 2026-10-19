import type { Role } from "./types";

export type LoginFieldIssue = "empty" | "tooLong" | "invalid";

/** Login form only. Empty, too long, and illegal characters are separate from a wrong password. */
export function loginUsernameIssue(value: unknown): LoginFieldIssue | null {
  if (typeof value !== "string") return "empty";
  const username = value.trim();
  if (!username) return "empty";
  if (username.length > 20) return "tooLong";
  if (/\s/.test(value) || username.includes("@") || !/^[\p{L}\p{N}_-]+$/u.test(username)) return "invalid";
  return null;
}

/** A short password is not a format error here; authentication reports it as a mismatch. */
export function loginPasswordIssue(value: unknown): LoginFieldIssue | null {
  if (typeof value !== "string" || value.length === 0) return "empty";
  if (value.length > 128) return "tooLong";
  if (/\s/.test(value)) return "invalid";
  return null;
}

export function loginFieldError(username: unknown, password: unknown): "credentialsRequired" | "usernameTooLong" | "loginUsernameInvalid" | "passwordTooLong" | "passwordHasSpace" | null {
  const name = loginUsernameIssue(username);
  const pass = loginPasswordIssue(password);
  if (name === "tooLong") return "usernameTooLong";
  if (name === "invalid") return "loginUsernameInvalid";
  if (pass === "tooLong") return "passwordTooLong";
  if (pass === "invalid") return "passwordHasSpace";
  if (name === "empty" || pass === "empty") return "credentialsRequired";
  return null;
}

export function normalizeUsername(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const username = value.trim();
  if (username.length < 1 || username.length > 20) return null;
  if (/\s/.test(username) || username.includes("@")) return null;
  if (!/^[\p{L}\p{N}_-]+$/u.test(username)) return null;
  return username;
}

export function normalizeName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim().replace(/\s+/g, " ");
  if (!name || name.length > 40) return null;
  return name;
}

export function normalizePassword(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (value.length < 8 || value.length > 128) return null;
  if (/\s/.test(value)) return null;
  return value;
}

export function parseRole(value: unknown): Role | null {
  return value === "admin" || value === "supplier" ? value : null;
}
