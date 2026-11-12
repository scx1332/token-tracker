import { describe, expect, it } from "bun:test";
import { MIN_BACKUP_TOKEN_LENGTH, bearerToken, pickLatestBackup, secretEquals, usableBackupToken } from "./backup";

describe("pickLatestBackup", () => {
  it("returns the newest archive by date in the filename", () => {
    expect(
      pickLatestBackup(["tokens-2026-08-13.sql.7z", "tokens-2026-08-15.sql.7z", "tokens-2026-08-14.sql.7z"]),
    ).toBe("tokens-2026-08-15.sql.7z");
  });

  it("sorts by date, not by directory order", () => {
    expect(pickLatestBackup(["tokens-2026-09-02.sql.7z", "tokens-2026-10-01.sql.7z"])).toBe(
      "tokens-2026-10-01.sql.7z",
    );
  });

  it("ignores the log, the lock, a half-written .part and stray files", () => {
    expect(
      pickLatestBackup([
        "backup.log",
        ".lock",
        "tokens-2026-08-16.sql.7z.part",
        "tokens-2026-08-15.sql.7z",
        "tokens-2026-08-15.sql",
        "notes.txt",
      ]),
    ).toBe("tokens-2026-08-15.sql.7z");
  });

  it("returns null for an empty or archive-free directory", () => {
    expect(pickLatestBackup([])).toBeNull();
    expect(pickLatestBackup(["backup.log", ".lock"])).toBeNull();
  });
});

describe("bearerToken", () => {
  it("pulls the token out of a bearer header", () => {
    expect(bearerToken("Bearer abc123")).toBe("abc123");
    expect(bearerToken("bearer abc123")).toBe("abc123");
    expect(bearerToken("  Bearer   abc123  ")).toBe("abc123");
  });

  it("is empty for a missing or non-bearer header", () => {
    expect(bearerToken(null)).toBe("");
    expect(bearerToken("")).toBe("");
    expect(bearerToken("Basic abc123")).toBe("");
    expect(bearerToken("abc123")).toBe("");
  });
});

describe("secretEquals", () => {
  it("accepts only an exact match", () => {
    expect(secretEquals("s3cret", "s3cret")).toBe(true);
    expect(secretEquals("s3cret", "s3creT")).toBe(false);
  });

  it("handles unequal lengths without throwing", () => {
    // The hash-then-compare exists for this case: timingSafeEqual rejects
    // buffers of different sizes outright.
    expect(secretEquals("short", "a-much-longer-secret")).toBe(false);
    expect(secretEquals("", "nonempty")).toBe(false);
    expect(secretEquals("", "")).toBe(true);
  });
});

describe("usableBackupToken", () => {
  it("keeps the route off when no token is configured", () => {
    expect(usableBackupToken(undefined)).toEqual({ token: "" });
    expect(usableBackupToken("")).toEqual({ token: "" });
    expect(usableBackupToken("   ")).toEqual({ token: "" });
  });

  it("fails closed on a short token instead of guarding the dump with it", () => {
    const short = usableBackupToken("x".repeat(MIN_BACKUP_TOKEN_LENGTH - 1));
    expect(short.token).toBe("");
    expect(short.reason).toContain("shorter than");
  });

  it("fails closed on the .env.example placeholder", () => {
    const placeholder = usableBackupToken("replace-me-with-a-long-random-string");
    expect(placeholder.token).toBe("");
    expect(placeholder.reason).toContain("placeholder");
  });

  it("accepts a long random token, trimmed", () => {
    const strong = "a1".repeat(32);
    expect(usableBackupToken(strong)).toEqual({ token: strong });
    expect(usableBackupToken(` ${strong}\n`)).toEqual({ token: strong });
  });
});
