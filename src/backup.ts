import { createHash, timingSafeEqual } from "node:crypto";

/** `scripts/backup-db.sh` writes exactly this shape, one per day. */
const ARCHIVE_RE = /^tokens-\d{4}-\d{2}-\d{2}\.sql\.7z$/;

/**
 * Newest archive in a directory listing, or null if there is none.
 *
 * The date is in the filename and zero-padded, so lexical order is
 * chronological order — no stat() calls, no mtime to be rewritten by a copy.
 */
export function pickLatestBackup(names: string[]): string | null {
  const archives = names.filter((n) => ARCHIVE_RE.test(n)).sort();
  return archives.length > 0 ? archives[archives.length - 1]! : null;
}

/**
 * Constant-time secret comparison.
 *
 * Both sides are hashed first so that unequal lengths are still compared in
 * constant time — timingSafeEqual throws on a length mismatch, and returning
 * early on one leaks the secret's length.
 */
export function secretEquals(a: string, b: string): boolean {
  return timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
}

/** Shortest BACKUP_TOKEN the endpoint will accept: 32 chars is 128+ bits of hex/base64. */
export const MIN_BACKUP_TOKEN_LENGTH = 32;
/** The value `.env.example` ships with. Long enough to pass the length check, so named here. */
const PLACEHOLDER_TOKENS = new Set(["replace-me-with-a-long-random-string"]);

/**
 * The BACKUP_TOKEN the server should enforce, or "" to keep `/backup/latest`
 * switched off. Fails closed: a token that is set but short, or still the
 * example placeholder, disables the route rather than guarding the whole
 * database with a guessable secret. `reason` says why, for a startup warning.
 */
export function usableBackupToken(raw: string | undefined): { token: string; reason?: string } {
  const token = (raw ?? "").trim();
  if (!token) return { token: "" };
  if (PLACEHOLDER_TOKENS.has(token)) {
    return { token: "", reason: "BACKUP_TOKEN is still the .env.example placeholder" };
  }
  if (token.length < MIN_BACKUP_TOKEN_LENGTH) {
    return { token: "", reason: `BACKUP_TOKEN is shorter than ${MIN_BACKUP_TOKEN_LENGTH} characters` };
  }
  return { token };
}

/** The token from an `Authorization: Bearer <token>` header, or "". */
export function bearerToken(header: string | null): string {
  if (!header) return "";
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m ? m[1]!.trim() : "";
}
