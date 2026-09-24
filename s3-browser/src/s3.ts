/**
 * S3 reads with the worker's own identity (IRSA in a cluster, the environment locally). One
 * client per region, one folder level per listing.
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

export interface Target {
  bucket: string;
  region?: string;
}

export interface ObjectStore {
  list(target: Target, prefix: string, token?: string, limit?: number): Promise<Listing>;
  head(target: Target, key: string): Promise<ObjectMeta>;
  presign(target: Target, key: string): Promise<Download>;
  remove(target: Target, key: string): Promise<{ key: string }>;
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
 */
export function defaultClientFactory(config: S3ClientConfig): S3Client {
  return new S3Client({ ...config, credentials: fromNodeProviderChain({ timeout: 1500, maxRetries: 0 }) });
}

export function createS3({ defaultRegion, downloadTtlSeconds = 900, clientFactory = defaultClientFactory, presign = getSignedUrl, now = Date.now }: Options = {}): ObjectStore {
  const clients = new Map<string, S3Client>();
  const client = (region?: string) => {
    const name = region || defaultRegion || "us-east-1";
    let existing = clients.get(name);
    if (!existing) {
      existing = clientFactory({ region: name });
      clients.set(name, existing);
    }
    return existing;
  };
  const wrap = async <T>(work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch (error) {
      if (error instanceof StoreError) throw error;
      const e = error as { name?: string; message?: string };
      throw new StoreError(`${e?.name ?? "S3Error"}: ${e?.message ?? String(error)}`, s3ErrorStatus(error), e?.name ?? "S3");
    }
  };

  return {
    list: (target, prefix, token, limit = 200) =>
      wrap(async () => {
        const response = await client(target.region).send(new ListObjectsV2Command({ Bucket: target.bucket, Prefix: prefix, Delimiter: "/", MaxKeys: limit, ContinuationToken: token }));
        const folders: Folder[] = (response.CommonPrefixes ?? []).flatMap((entry) => (entry.Prefix ? [{ prefix: entry.Prefix, name: nameOf(entry.Prefix, prefix) }] : []));
        const objects: S3Object[] = (response.Contents ?? [])
          .filter((entry) => entry.Key && entry.Key !== prefix)
          .map((entry) => ({ key: entry.Key!, name: nameOf(entry.Key!, prefix), size: entry.Size ?? 0, last_modified: entry.LastModified?.toISOString() ?? null, storage_class: entry.StorageClass, etag: entry.ETag }));
        return { bucket: target.bucket, region: target.region ?? defaultRegion ?? null, prefix, folders, objects, next_token: response.NextContinuationToken ?? null, truncated: Boolean(response.IsTruncated) };
      }),
    head: (target, key) =>
      wrap(async () => {
        const response = await client(target.region).send(new HeadObjectCommand({ Bucket: target.bucket, Key: key }));
        return { key, size: response.ContentLength ?? 0, content_type: response.ContentType, last_modified: response.LastModified?.toISOString() ?? null, etag: response.ETag, storage_class: response.StorageClass, metadata: response.Metadata ?? {} };
      }),
    presign: (target, key) =>
      wrap(async () => {
        const filename = key.split("/").pop() ?? key;
        const url = await presign(client(target.region), new GetObjectCommand({ Bucket: target.bucket, Key: key, ResponseContentDisposition: `attachment; filename="${filename.replace(/"/g, "")}"` }), { expiresIn: downloadTtlSeconds });
        return { key, url, expires_at: new Date(now() + downloadTtlSeconds * 1000).toISOString() };
      }),
    remove: (target, key) =>
      wrap(async () => {
        await client(target.region).send(new DeleteObjectCommand({ Bucket: target.bucket, Key: key }));
        return { key };
      }),
  };
}
