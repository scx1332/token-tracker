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

/** The token from an `Authorization: Bearer <token>` header, or "". */
export function bearerToken(header: string | null): string {
  if (!header) return "";
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m ? m[1]!.trim() : "";
}
