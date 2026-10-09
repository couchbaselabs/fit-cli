/**
 * Split an s3:// URI into its bucket and key. The key is everything after the bucket's "/"
 * (empty for `s3://bucket` or `s3://bucket/`); `requireKey` refuses a URI without one, for
 * callers that need a single object.
 */
export function parseS3Uri(uri: string, opts: { requireKey?: boolean } = {}): { bucket: string; key: string } {
  const m = /^s3:\/\/([^/]+)(?:\/(.*))?$/.exec(uri);
  const key = m?.[2] ?? "";
  if (!m || (opts.requireKey && !key)) throw new Error(`Invalid S3 URI${opts.requireKey ? " (must name an object: s3://bucket/key)" : ""}: ${uri}`);
  return { bucket: m[1], key };
}
