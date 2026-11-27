/**
 * S3 with the credentials a target carries: a session of the link's IAM role. Never with the
 * worker's own identity: a target has no way to ask for it. A fresh, uncached client per request, so a client built with one link's credentials never serves another.
 * One folder level per listing; a search walks every level under its folder.
 */
import { GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, S3Client, type S3ClientConfig } from "@aws-sdk/client-s3";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { Disposition } from "./protocol";

export interface Folder {
  prefix: string;
  name: string;
}

export interface S3Object {
  key: string;
  name: string;
  size: number;
  last_modified: string | null;
  storage_class?: string;
  etag?: string;
}

export interface Listing {
  bucket: string;
  region: string | null;
  prefix: string;
  folders: Folder[];
  objects: S3Object[];
  next_token: string | null;
  truncated: boolean;
}

/**
 * What one search call found under `prefix`, at any depth: the files and folders whose name contains
 * `query`, whatever its case. A call stops at its time budget or at `limit` matches; `next_token` is
 * where the next one resumes, null once the whole folder was looked at.
 */
export interface SearchResult {
  bucket: string;
  region: string | null;
  prefix: string;
  query: string;
  folders: Folder[];
  objects: S3Object[];
  /** How many keys this call looked at. */
  scanned: number;
  next_token: string | null;
  truncated: boolean;
}

export interface ObjectMeta {
  key: string;
  size: number;
  content_type?: string;
  last_modified: string | null;
  etag?: string;
  storage_class?: string;
  metadata: Record<string, string>;
}

export interface Download {
  key: string;
  url: string;
  expires_at: string;
}

/** One field of an upload form: S3 takes `name` literally (`X-Amz-Signature`, `Content-Type`). */
export interface UploadField {
  name: string;
  value: string;
}

/** A presigned POST: the form the browser sends the file with, straight to S3. */
export interface Upload {
  key: string;
  url: string;
  /**
   * The form fields to send before the file, as S3 signed them. A list, not a map: the catalog
   * rewrites the keys of an action's output to snake_case (`X-Amz-Signature` would come back
   * `x_amz_signature`), and a name carried as a value crosses it untouched.
   */
  fields: UploadField[];
  expires_at: string;
}

/** Static credentials for one target (a link's IAM role session); never logged, never returned. */
export interface StaticCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  /** Present for a role session (STS AssumeRole). */
  sessionToken?: string;
  /** When a role session ends; presigned URLs never outlive it. */
  expiration?: Date;
}

export interface Target {
  bucket: string;
  region?: string;
  /** What S3 is opened with: always the link's, never the worker's identity. */
  credentials: StaticCredentials;
}

export interface ObjectStore {
  list(target: Target, prefix: string, token?: string, limit?: number): Promise<Listing>;
  /** The names containing `query` under `prefix`, resuming after the key `after`; ends at `limit` matches or its time budget. */
  search(target: Target, prefix: string, query: string, after?: string, limit?: number): Promise<SearchResult>;
  head(target: Target, key: string): Promise<ObjectMeta>;
  /** A signed GET. `inline` is a short-lived link that serves the object as plain text (never as HTML or SVG). */
  presign(target: Target, key: string, disposition?: Disposition): Promise<Download>;
  /** Whether an object with exactly this key exists; asked by listing, which every access level allows. */
  exists(target: Target, key: string): Promise<boolean>;
  /** A form that uploads one file of exactly `size` bytes to exactly `key`, and nothing else. */
  presignUpload(target: Target, key: string, size: number, contentType?: string): Promise<Upload>;
}

export class StoreError extends Error {
  constructor(message: string, readonly status: number, readonly code = "S3") {
    super(message);
    this.name = "StoreError";
  }
}

interface Options {
  defaultRegion?: string;
  downloadTtlSeconds?: number;
  /** Lifetime of an `inline` (view) link: short, since it is meant to be opened at once. */
  viewTtlSeconds?: number;
  uploadTtlSeconds?: number;
  clientFactory?: (config: S3ClientConfig & { credentials: NonNullable<S3ClientConfig["credentials"]> }) => S3Client;
  presign?: typeof getSignedUrl;
  presignPost?: typeof createPresignedPost;
  /** How long one search call keeps asking S3 for more keys before it answers with what it has. */
  searchBudgetMs?: number;
  /** Keys per S3 request while searching (S3's maximum is 1000). */
  searchPageSize?: number;
  now?: () => number;
}

function nameOf(key: string, prefix: string): string {
  return key.slice(prefix.length).replace(/\/$/, "");
}

/** Maps an SDK error to the status the caller should see. */
export function s3ErrorStatus(error: unknown): number {
  const e = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  if (e?.name === "NoSuchKey" || e?.name === "NotFound" || e?.name === "NoSuchBucket") return 404;
  if (e?.name === "AccessDenied" || e?.$metadata?.httpStatusCode === 403) return 403;
  if (e?.name === "CredentialsProviderError" || e?.name === "ExpiredToken" || e?.name === "InvalidAccessKeyId") return 500;
  return 502;
}

/** A client with exactly the credentials it is given (a link's role session). */
export function defaultClientFactory(config: S3ClientConfig & { credentials: NonNullable<S3ClientConfig["credentials"]> }): S3Client {
  return new S3Client(config);
}

/** Replaces every occurrence of the secrets in a message; empty secrets are ignored. */
export function redact(message: string, secrets: Array<string | undefined>): string {
  let out = message;
  for (const secret of secrets) if (secret) out = out.split(secret).join("[redacted]");
  return out;
}

export function createS3({ defaultRegion, downloadTtlSeconds = 900, viewTtlSeconds = 60, uploadTtlSeconds = 300, searchBudgetMs = 8000, searchPageSize = 1000, clientFactory = defaultClientFactory, presign = getSignedUrl, presignPost = createPresignedPost, now = Date.now }: Options = {}): ObjectStore {
  const client = (target: Target) => {
    const region = target.region || defaultRegion || "us-east-1";
    const { credentials } = target;
    // A target without credentials would fall back to the SDK's default chain, the worker's own
    // identity: refused, whatever the types say.
    if (!credentials?.accessKeyId || !credentials.secretAccessKey) throw new StoreError("no link credentials for this request", 500, "NO_CREDENTIALS");
    // A fresh client per request, never cached: a client built with one link's session can never
    // serve another request.
    return clientFactory({ region, credentials: { accessKeyId: credentials.accessKeyId, secretAccessKey: credentials.secretAccessKey, ...(credentials.sessionToken ? { sessionToken: credentials.sessionToken } : {}) } });
  };
  const wrap = async <T>(target: Target, work: () => Promise<T>): Promise<T> => {
    const secrets = [target.credentials?.accessKeyId, target.credentials?.secretAccessKey, target.credentials?.sessionToken];
    try {
      return await work();
    } catch (error) {
      if (error instanceof StoreError) throw new StoreError(redact(error.message, secrets), error.status, error.code);
      const e = error as { name?: string; message?: string };
      throw new StoreError(redact(`${e?.name ?? "S3Error"}: ${e?.message ?? String(error)}`, secrets), s3ErrorStatus(error), e?.name ?? "S3");
    }
  };

  return {
    list: (target, prefix, token, limit = 200) =>
      wrap(target, async () => {
        const response = await client(target).send(new ListObjectsV2Command({ Bucket: target.bucket, Prefix: prefix, Delimiter: "/", MaxKeys: limit, ContinuationToken: token }));
        const folders: Folder[] = (response.CommonPrefixes ?? []).flatMap((entry) => (entry.Prefix ? [{ prefix: entry.Prefix, name: nameOf(entry.Prefix, prefix) }] : []));
        const objects: S3Object[] = (response.Contents ?? [])
          .filter((entry) => entry.Key && entry.Key !== prefix)
          .map((entry) => ({ key: entry.Key!, name: nameOf(entry.Key!, prefix), size: entry.Size ?? 0, last_modified: entry.LastModified?.toISOString() ?? null, storage_class: entry.StorageClass, etag: entry.ETag }));
        return { bucket: target.bucket, region: target.region ?? defaultRegion ?? null, prefix, folders, objects, next_token: response.NextContinuationToken ?? null, truncated: Boolean(response.IsTruncated) };
      }),
    search: (target, prefix, query, after, limit = 200) =>
      wrap(target, async () => {
        const needle = query.toLowerCase();
        const matches = (name: string) => name.toLowerCase().includes(needle);
        const s3 = client(target);
        const started = now();
        const folders: Folder[] = [];
        const objects: S3Object[] = [];
        const result = (next: string | null): SearchResult => ({ bucket: target.bucket, region: target.region ?? defaultRegion ?? null, prefix, query, folders, objects, scanned, next_token: next, truncated: next !== null });
        let scanned = 0;
        let last = after;
        // S3 lists keys in order, so a folder's keys come together: a folder is new when the key before was not in it.
        let open = after ? after.slice(prefix.length).split("/").slice(0, -1) : [];
        for (;;) {
          // Resumes by key, not by S3's token: the call can stop at any key, and the next one starts right after it.
          const response = await s3.send(new ListObjectsV2Command({ Bucket: target.bucket, Prefix: prefix, MaxKeys: searchPageSize, StartAfter: last }));
          for (const entry of response.Contents ?? []) {
            const key = entry.Key;
            if (!key) continue;
            scanned += 1;
            last = key;
            const path = key.slice(prefix.length).split("/");
            // Empty for the key that stands for a folder itself (`docs/`): it names no file.
            const name = path.pop()!;
            let shared = 0;
            while (shared < path.length && shared < open.length && path[shared] === open[shared]) shared += 1;
            for (let depth = shared; depth < path.length; depth += 1) {
              if (matches(path[depth])) folders.push({ prefix: `${prefix}${path.slice(0, depth + 1).join("/")}/`, name: path[depth] });
            }
            open = path;
            if (name && matches(name)) objects.push({ key, name, size: entry.Size ?? 0, last_modified: entry.LastModified?.toISOString() ?? null, storage_class: entry.StorageClass, etag: entry.ETag });
            if (folders.length + objects.length >= limit) return result(key);
          }
          if (!response.IsTruncated || !last) return result(null);
          if (now() - started >= searchBudgetMs) return result(last);
        }
      }),
    head: (target, key) =>
      wrap(target, async () => {
        const response = await client(target).send(new HeadObjectCommand({ Bucket: target.bucket, Key: key }));
        return { key, size: response.ContentLength ?? 0, content_type: response.ContentType, last_modified: response.LastModified?.toISOString() ?? null, etag: response.ETag, storage_class: response.StorageClass, metadata: response.Metadata ?? {} };
      }),
    presign: (target, key, disposition = "attachment") =>
      wrap(target, async () => {
        const filename = key.split("/").pop() ?? key;
        // A role session's URL stops working when the session ends: never promise longer.
        const expiration = target.credentials?.expiration;
        const wanted = disposition === "inline" ? viewTtlSeconds : downloadTtlSeconds;
        const ttl = expiration ? Math.max(1, Math.min(wanted, Math.floor((expiration.getTime() - now()) / 1000))) : wanted;
        // `inline` is always plain text: whatever the object's own type, HTML or SVG can never render in the bucket's origin.
        const headers =
          disposition === "inline"
            ? { ResponseContentDisposition: "inline", ResponseContentType: "text/plain; charset=utf-8" }
            : { ResponseContentDisposition: `attachment; filename="${filename.replace(/"/g, "")}"` };
        const url = await presign(client(target), new GetObjectCommand({ Bucket: target.bucket, Key: key, ...headers }), { expiresIn: ttl });
        return { key, url, expires_at: new Date(now() + ttl * 1000).toISOString() };
      }),
    exists: (target, key) =>
      wrap(target, async () => {
        // Keys sort byte-wise, so an object named exactly `key` is the first one under that prefix.
        const response = await client(target).send(new ListObjectsV2Command({ Bucket: target.bucket, Prefix: key, MaxKeys: 1 }));
        return response.Contents?.[0]?.Key === key;
      }),
    presignUpload: (target, key, size, contentType) =>
      wrap(target, async () => {
        // A role session's form stops working when the session ends: never promise longer.
        const expiration = target.credentials?.expiration;
        const ttl = expiration ? Math.max(1, Math.min(uploadTtlSeconds, Math.floor((expiration.getTime() - now()) / 1000))) : uploadTtlSeconds;
        // The policy pins the bucket and the key (the SDK adds both) and the size: the form uploads that one file.
        const { url, fields } = await presignPost(client(target), {
          Bucket: target.bucket,
          Key: key,
          Conditions: [["content-length-range", size, size]],
          ...(contentType ? { Fields: { "Content-Type": contentType } } : {}),
          Expires: ttl,
        });
        return { key, url, fields: Object.entries(fields).map(([name, value]) => ({ name, value })), expires_at: new Date(now() + ttl * 1000).toISOString() };
      }),
  };
}
