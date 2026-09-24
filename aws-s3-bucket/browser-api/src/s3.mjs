/**
 * S3 reads on behalf of a dashboard user, with this backend's own credentials (IRSA in the
 * cluster, a profile locally). The bucket comes from the service, never from the request.
 */
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export const DEFAULT_PAGE = 100;
export const MAX_PAGE = 1000;

export function createS3({ defaultRegion = process.env.AWS_REGION || 'us-east-1', clientFactory = (region) => new S3Client({ region }), presign = getSignedUrl, downloadTtlSeconds = 900 } = {}) {
  const clients = new Map();
  const client = (region) => {
    const key = region || defaultRegion;
    if (!clients.has(key)) clients.set(key, clientFactory(key));
    return clients.get(key);
  };
  const nameOf = (key, prefix) => key.slice(prefix.length).replace(/\/$/, '');

  return {
    /** One directory level: folders (common prefixes) and objects directly under `prefix`. */
    async list({ bucket, region, prefix = '', token, limit = DEFAULT_PAGE }) {
      const size = Math.min(Math.max(1, Number(limit) || DEFAULT_PAGE), MAX_PAGE);
      const out = await client(region).send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, Delimiter: '/', ContinuationToken: token || undefined, MaxKeys: size }));
      return {
        bucket,
        prefix,
        folders: (out.CommonPrefixes ?? []).map((item) => ({ prefix: item.Prefix, name: nameOf(item.Prefix, prefix) })),
        objects: (out.Contents ?? [])
          .filter((item) => item.Key !== prefix) // the "folder marker" object of the prefix itself
          .map((item) => ({ key: item.Key, name: nameOf(item.Key, prefix), size: item.Size ?? 0, last_modified: item.LastModified?.toISOString(), storage_class: item.StorageClass, etag: item.ETag })),
        next_token: out.IsTruncated ? out.NextContinuationToken : null,
        truncated: Boolean(out.IsTruncated),
      };
    },
    async head({ bucket, region, key }) {
      const out = await client(region).send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      return { key, size: out.ContentLength ?? 0, content_type: out.ContentType, last_modified: out.LastModified?.toISOString(), etag: out.ETag, storage_class: out.StorageClass, metadata: out.Metadata ?? {} };
    },
    /** A presigned GET the browser can open directly; nothing else ever leaves this backend. */
    async downloadUrl({ bucket, region, key }) {
      const filename = key.split('/').pop() || 'download';
      const command = new GetObjectCommand({ Bucket: bucket, Key: key, ResponseContentDisposition: `attachment; filename="${filename.replace(/"/g, '')}"` });
      const url = await presign(client(region), command, { expiresIn: downloadTtlSeconds });
      return { key, url, expires_at: new Date(Date.now() + downloadTtlSeconds * 1000).toISOString() };
    },
    async put({ bucket, region, key, body, contentType }) {
      await client(region).send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }));
      return { key, size: body.length };
    },
    async remove({ bucket, region, key }) {
      await client(region).send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
      return { key };
    },
  };
}

/** AWS SDK errors carry an HTTP status; map the ones a user can act on. */
export function s3ErrorStatus(error) {
  const name = error?.name ?? '';
  if (name === 'NoSuchKey' || name === 'NotFound') return 404;
  if (name === 'NoSuchBucket') return 404;
  if (name === 'AccessDenied' || name === 'InvalidAccessKeyId' || name === 'SignatureDoesNotMatch' || error?.$metadata?.httpStatusCode === 403) return 403;
  return 502;
}
