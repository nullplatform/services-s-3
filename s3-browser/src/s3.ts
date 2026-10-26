/**
 * S3 reads with the worker's own identity (IRSA in a cluster, the environment locally), or with
 * static credentials a target carries (link mode: the link's own IAM keys). One cached client
 * per region for the worker's identity; a fresh, uncached client per request for static
 * credentials, so the two never share a client. One folder level per listing.
 */
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, S3Client, type S3ClientConfig } from "@aws-sdk/client-s3";
import { fromNodeProviderChain } from "@aws-sdk/credential-providers";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

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

export interface ObjectText {
  key: string;
  /** The first bytes read, decoded as UTF-8. */
  text: string;
  /** The object is larger than what was read. */
  truncated: boolean;
  content_type?: string;
  /** The object's total size in bytes. */
  size: number;
}

/** Static credentials for one target (a link's IAM user); never logged, never returned. */
export interface StaticCredentials {
  accessKeyId: string;
  secretAccessKey: string;
}

export interface Target {
  bucket: string;
  region?: string;
  /** When present, S3 is opened with these keys instead of the worker's identity. */
  credentials?: StaticCredentials;
}

export interface ObjectStore {
  list(target: Target, prefix: string, token?: string, limit?: number): Promise<Listing>;
  head(target: Target, key: string): Promise<ObjectMeta>;
  presign(target: Target, key: string): Promise<Download>;
  remove(target: Target, key: string): Promise<{ key: string }>;
  read(target: Target, key: string, maxBytes: number): Promise<ObjectText>;
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
  clientFactory?: (config: S3ClientConfig) => S3Client;
  presign?: typeof getSignedUrl;
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

/**
 * The default credential chain, bounded: without credentials (a misconfigured worker) the SDK
 * would otherwise probe the instance metadata endpoint for minutes, past the caller's timeout.
 * IRSA / container credentials / env vars are found immediately; only the IMDS leg is capped.
 * Credentials passed in the config (a link's static keys) are used as they are: the chain is
 * only the fallback, never a replacement for them.
 */
export function defaultClientFactory(config: S3ClientConfig): S3Client {
  if (config.credentials) return new S3Client(config);
  return new S3Client({ ...config, credentials: fromNodeProviderChain({ timeout: 1500, maxRetries: 0 }) });
}

/** Replaces every occurrence of the secrets in a message; empty secrets are ignored. */
export function redact(message: string, secrets: Array<string | undefined>): string {
  let out = message;
  for (const secret of secrets) if (secret) out = out.split(secret).join("[redacted]");
  return out;
}

/** `bytes 0-99/1234` → 1234; undefined when absent or unknown (`*`). */
export function totalFromContentRange(value: string | undefined): number | undefined {
  const match = /\/(\d+)\s*$/.exec(value ?? "");
  return match ? Number(match[1]) : undefined;
}

export function createS3({ defaultRegion, downloadTtlSeconds = 900, clientFactory = defaultClientFactory, presign = getSignedUrl, now = Date.now }: Options = {}): ObjectStore {
  const clients = new Map<string, S3Client>();
  const client = (target: Target) => {
    const region = target.region || defaultRegion || "us-east-1";
    const credentials = target.credentials;
    // Static credentials (a link's keys) get a fresh client per request, never cached: a client
    // built with one link's keys can never serve another request, nor the worker's identity.
    if (credentials) return clientFactory({ region, credentials: { accessKeyId: credentials.accessKeyId, secretAccessKey: credentials.secretAccessKey } });
    let existing = clients.get(region);
    if (!existing) {
      existing = clientFactory({ region });
      clients.set(region, existing);
    }
    return existing;
  };
  const wrap = async <T>(target: Target, work: () => Promise<T>): Promise<T> => {
    const secrets = [target.credentials?.accessKeyId, target.credentials?.secretAccessKey];
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
    head: (target, key) =>
      wrap(target, async () => {
        const response = await client(target).send(new HeadObjectCommand({ Bucket: target.bucket, Key: key }));
        return { key, size: response.ContentLength ?? 0, content_type: response.ContentType, last_modified: response.LastModified?.toISOString() ?? null, etag: response.ETag, storage_class: response.StorageClass, metadata: response.Metadata ?? {} };
      }),
    presign: (target, key) =>
      wrap(target, async () => {
        const filename = key.split("/").pop() ?? key;
        const url = await presign(client(target), new GetObjectCommand({ Bucket: target.bucket, Key: key, ResponseContentDisposition: `attachment; filename="${filename.replace(/"/g, "")}"` }), { expiresIn: downloadTtlSeconds });
        return { key, url, expires_at: new Date(now() + downloadTtlSeconds * 1000).toISOString() };
      }),
    remove: (target, key) =>
      wrap(target, async () => {
        await client(target).send(new DeleteObjectCommand({ Bucket: target.bucket, Key: key }));
        return { key };
      }),
    read: (target, key, maxBytes) =>
      wrap(target, async () => {
        const s3 = client(target);
        let response;
        try {
          response = await s3.send(new GetObjectCommand({ Bucket: target.bucket, Key: key, Range: `bytes=0-${maxBytes - 1}` }));
        } catch (error) {
          // A range on an empty object is a 416: answer it as the empty text it is.
          const e = error as { name?: string; $metadata?: { httpStatusCode?: number } };
          if (e?.name !== "InvalidRange" && e?.$metadata?.httpStatusCode !== 416) throw error;
          const head = await s3.send(new HeadObjectCommand({ Bucket: target.bucket, Key: key }));
          if ((head.ContentLength ?? 0) !== 0) throw error;
          return { key, text: "", truncated: false, content_type: head.ContentType, size: 0 };
        }
        const body = response.Body as { transformToByteArray?: () => Promise<Uint8Array> } | undefined;
        const all = body?.transformToByteArray ? await body.transformToByteArray() : new Uint8Array();
        // Never hand back more than asked for, even if the range was ignored.
        const bytes = all.length > maxBytes ? all.subarray(0, maxBytes) : all;
        const total = totalFromContentRange(response.ContentRange) ?? (response.ContentRange ? undefined : response.ContentLength) ?? all.length;
        const size = Math.max(total, all.length);
        const truncated = size > bytes.length;
        // `stream: true` holds back a multibyte character cut by the range instead of
        // decoding it as a replacement character.
        const text = new TextDecoder("utf-8").decode(bytes, { stream: truncated });
        return { key, text, truncated, content_type: response.ContentType, size };
      }),
  };
}
