// Hash-route helpers for links that embed a model id.
//
// Model ids are `author/slug` with optional `:variant` and `~` alias prefix —
// all characters that are legal raw inside a URL fragment. Encoding them with
// bare encodeURIComponent turns every link into `z-ai%2Fglm-5.2`, which is
// what people copy and share. So: encode fully (future-proof against an id
// that someday carries a space, `%` or `?`), then restore the two safe
// characters that make the link readable. Old `%2F` links keep resolving —
// the decode side is unchanged in meaning, just crash-proofed.

/** Model id → readable path fragment: `z-ai/glm-5.2:free` stays literal. */
export function encodeModelId(id: string): string {
  return encodeURIComponent(id).replace(/%2F/gi, "/").replace(/%3A/gi, ":");
}

/**
 * decodeURIComponent that survives malformed input: a hand-typed `#/model/100%`
 * throws URIError inside the router and white-screens the app. A bad escape
 * falls back to the raw string, which then just misses the catalog lookup.
 */
export function safeDecode(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}
