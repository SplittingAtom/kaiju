import { ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import type { S3Settings } from "./config.js";
import type { ObjectLister, StoredObject } from "./objects.js";

/** Minimal surface of S3Client used here, so tests can pass a fake. */
export interface ListClient {
  send(command: ListObjectsV2Command): Promise<{
    Contents?: { Key?: string; Size?: number; ETag?: string }[];
    IsTruncated?: boolean;
    NextContinuationToken?: string;
  }>;
}

/**
 * Connection and socket-idle timeouts (KOBE-732, as the server's client): a store that accepts and
 * never answers fails the backup instead of hanging it. Idle, not total: a long listing is fine.
 */
export const S3_HANDLER_TIMEOUTS = { connectionTimeout: 5_000, socketTimeout: 60_000 } as const;

export function createS3Client(
  settings: S3Settings,
  timeouts: {
    readonly connectionTimeout: number;
    readonly socketTimeout: number;
  } = S3_HANDLER_TIMEOUTS,
): S3Client {
  return new S3Client({
    region: settings.region,
    forcePathStyle: settings.forcePathStyle,
    ...(settings.endpoint ? { endpoint: settings.endpoint } : {}),
    ...(settings.credentials ? { credentials: settings.credentials } : {}),
    requestHandler: { ...timeouts },
  });
}

/** Lists every object under the bucket/prefix (ListObjectsV2, paginated). */
export function s3Lister(
  settings: S3Settings,
  client: ListClient = createS3Client(settings),
): ObjectLister {
  return {
    location: { endpoint: settings.endpoint, bucket: settings.bucket, prefix: settings.prefix },
    async *list(): AsyncIterable<StoredObject> {
      let token: string | undefined;
      do {
        const page = await client.send(
          new ListObjectsV2Command({
            Bucket: settings.bucket,
            ...(settings.prefix ? { Prefix: settings.prefix } : {}),
            ...(token ? { ContinuationToken: token } : {}),
          }),
        );
        for (const o of page.Contents ?? []) {
          if (o.Key === undefined) continue;
          yield { key: o.Key, size: o.Size ?? 0, etag: o.ETag ?? "" };
        }
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
        if (page.IsTruncated && !token)
          throw new Error("S3 listing was truncated without a continuation token");
      } while (token);
    },
  };
}
