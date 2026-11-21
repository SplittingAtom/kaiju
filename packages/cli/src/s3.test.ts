import { createServer, type Socket } from "node:net";
import type { ListObjectsV2Command } from "@aws-sdk/client-s3";
import { describe, expect, it } from "vitest";
import type { S3Settings } from "./config.js";
import { collect } from "./objects.js";
import { createS3Client, s3Lister, type ListClient } from "./s3.js";

const settings: S3Settings = {
  endpoint: "https://s3.example.com",
  region: "us-east-1",
  bucket: "kobe",
  prefix: "data/",
  forcePathStyle: true,
  credentials: { accessKeyId: "a", secretAccessKey: "b" },
};

describe("s3Lister", () => {
  it("follows continuation tokens and passes bucket and prefix", async () => {
    const seen: ListObjectsV2Command["input"][] = [];
    const client: ListClient = {
      send: (cmd: ListObjectsV2Command) => {
        seen.push(cmd.input);
        return Promise.resolve(
          cmd.input.ContinuationToken
            ? { Contents: [{ Key: "data/b", Size: 2, ETag: '"b"' }], IsTruncated: false }
            : {
                Contents: [{ Key: "data/a", Size: 1, ETag: '"a"' }],
                IsTruncated: true,
                NextContinuationToken: "t1",
              },
        );
      },
    };
    const lister = s3Lister(settings, client);
    expect(await collect(lister)).toEqual([
      { key: "data/a", size: 1, etag: '"a"' },
      { key: "data/b", size: 2, etag: '"b"' },
    ]);
    expect(seen).toEqual([
      { Bucket: "kobe", Prefix: "data/" },
      { Bucket: "kobe", Prefix: "data/", ContinuationToken: "t1" },
    ]);
    expect(lister.location).toEqual({
      endpoint: "https://s3.example.com",
      bucket: "kobe",
      prefix: "data/",
    });
  });

  it("fails rather than returning a partial listing", async () => {
    const client: ListClient = {
      send: () => Promise.resolve({ Contents: [], IsTruncated: true }),
    };
    await expect(collect(s3Lister(settings, client))).rejects.toThrow(/truncated/);
  });
});

describe("createS3Client timeouts (KOBE-732)", () => {
  it("gives up on a store that accepts and never answers", async () => {
    const sockets: Socket[] = [];
    const server = createServer((s) => {
      sockets.push(s);
      s.on("error", () => undefined);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("no port");
    const silent = { ...settings, endpoint: `http://127.0.0.1:${address.port}` };
    try {
      const client = createS3Client(silent, { connectionTimeout: 1_000, socketTimeout: 300 });
      await expect(collect(s3Lister(silent, client))).rejects.toThrow(/timed out/);
    } finally {
      for (const s of sockets) s.destroy();
      await new Promise((resolve) => server.close(resolve));
    }
  }, 20_000);
});
