import { createHash } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import { Readable } from "node:stream";
import { S3ServiceException } from "@aws-sdk/client-s3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeS3 } from "../testing/fake-s3.js";
import { IntegrityError, verifyingStream } from "./object-store.js";
import {
  S3_CONNECT_TIMEOUT_MS,
  S3_IDLE_TIMEOUT_MS,
  createS3ObjectStore,
  loadS3Settings,
  plainHttpEndpointWarning,
  s3RequestHandlerOptions,
} from "./s3.js";

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const text = async (r: Readable) => {
  const chunks: Buffer[] = [];
  for await (const c of r) chunks.push(Buffer.from(c as Uint8Array));
  return Buffer.concat(chunks).toString();
};

describe("loadS3Settings", () => {
  it("is off without a bucket and parses the chart's env", () => {
    expect(loadS3Settings({})).toBeUndefined();
    expect(
      loadS3Settings({
        KAIJU_S3_BUCKET: "kaiju",
        KAIJU_S3_ENDPOINT: "http://s3.kaiju-deps:8333",
        KAIJU_S3_FORCE_PATH_STYLE: "true",
        KAIJU_S3_ACCESS_KEY_ID: "id",
        KAIJU_S3_SECRET_ACCESS_KEY: "secret",
      }),
    ).toEqual({
      bucket: "kaiju",
      endpoint: "http://s3.kaiju-deps:8333",
      region: "us-east-1",
      forcePathStyle: true,
      prefix: "",
      credentials: { accessKeyId: "id", secretAccessKey: "secret" },
      connectTimeoutMs: S3_CONNECT_TIMEOUT_MS,
      idleTimeoutMs: S3_IDLE_TIMEOUT_MS,
    });
  });

  it("reads the client timeouts (KOBE-732)", () => {
    const s = loadS3Settings({
      KAIJU_S3_BUCKET: "b",
      KAIJU_S3_CONNECT_TIMEOUT_MS: "2000",
      KAIJU_S3_IDLE_TIMEOUT_MS: "90000",
    });
    expect(s).toMatchObject({ connectTimeoutMs: 2000, idleTimeoutMs: 90_000 });
    expect(s && s3RequestHandlerOptions(s)).toEqual({
      connectionTimeout: 2000,
      socketTimeout: 90_000,
    });
    expect(() => loadS3Settings({ KAIJU_S3_BUCKET: "b", KAIJU_S3_IDLE_TIMEOUT_MS: "0" })).toThrow(
      /KAIJU_S3_IDLE_TIMEOUT_MS/,
    );
  });

  it("refuses credentials in the endpoint and half-set keys, without echoing them", () => {
    const bad = () =>
      loadS3Settings({ KAIJU_S3_BUCKET: "b", KAIJU_S3_ENDPOINT: "http://user:hunter2@s3" });
    expect(bad).toThrow(/without credentials/);
    expect(bad).not.toThrow(/hunter2/);
    expect(() => loadS3Settings({ KAIJU_S3_BUCKET: "b", KAIJU_S3_ACCESS_KEY_ID: "x" })).toThrow(
      /set together/,
    );
    expect(() => loadS3Settings({ KAIJU_S3_BUCKET: "b", KAIJU_S3_PREFIX: "/abs/" })).toThrow();
  });
});

describe("plainHttpEndpointWarning (KOBE-743)", () => {
  const settings = (endpoint: string) =>
    loadS3Settings({ KAIJU_S3_BUCKET: "b", KAIJU_S3_ENDPOINT: endpoint });
  it("warns for a plain-HTTP endpoint, naming the host only", () => {
    const s = settings("http://s3.lan.example:9000");
    expect(s && plainHttpEndpointWarning(s)).toMatch(/plain http.*in clear/);
    expect(s && plainHttpEndpointWarning(s)).toContain("s3.lan.example:9000");
  });
  it("is quiet for https and for the SDK's default endpoint", () => {
    const https = settings("https://s3.example.com");
    expect(https && plainHttpEndpointWarning(https)).toBeUndefined();
    const aws = loadS3Settings({ KAIJU_S3_BUCKET: "b" });
    expect(aws && plainHttpEndpointWarning(aws)).toBeUndefined();
  });
});

describe("verifyingStream", () => {
  it("passes matching bytes and withholds the last chunk on a mismatch", async () => {
    const data = Buffer.from("hello workspace");
    await expect(
      text(Readable.from([data]).pipe(verifyingStream(sha(data), data.length))),
    ).resolves.toBe("hello workspace");
    const out: Buffer[] = [];
    const bad = Readable.from([Buffer.from("hello "), Buffer.from("tampered")]).pipe(
      verifyingStream(sha(data), 14),
    );
    bad.on("data", (c: Buffer) => out.push(c));
    await expect(new Promise((_, reject) => bad.on("error", reject))).rejects.toBeInstanceOf(
      IntegrityError,
    );
    expect(Buffer.concat(out).toString()).toBe("hello ");
  });

  it("errors as soon as more bytes than declared arrive", async () => {
    const s = Readable.from([Buffer.alloc(10)]).pipe(verifyingStream("0".repeat(64), 5));
    await expect(text(s)).rejects.toThrow(/size_mismatch/);
  });
});

describe("S3 object store (fake S3 over HTTP)", () => {
  const fake = new FakeS3("kaiju", "test-key");
  let store: ReturnType<typeof createS3ObjectStore>;

  beforeAll(async () => {
    const endpoint = await fake.start();
    store = createS3ObjectStore({
      bucket: "kaiju",
      endpoint,
      region: "us-east-1",
      forcePathStyle: true,
      prefix: "",
      credentials: { accessKeyId: "test-key", secretAccessKey: "test-secret" },
    });
  });
  afterAll(() => fake.stop());

  it("puts a stream, gets, copies and deletes", async () => {
    const data = Buffer.from("a".repeat(100_000));
    await store.put("teams/t/a", Readable.from([data]), data.length);
    expect(fake.objects.get("teams/t/a")?.equals(data)).toBe(true);
    const got = await store.get("teams/t/a");
    expect(got?.size).toBe(data.length);
    expect(await text(got?.body ?? Readable.from([]))).toBe(data.toString());
    await store.copy("teams/t/a", "teams/t/shared/b");
    expect(fake.objects.get("teams/t/shared/b")?.length).toBe(data.length);
    await store.delete(["teams/t/a", "teams/t/missing"]);
    expect(await store.get("teams/t/a")).toBeNull();
  });

  it("stores nothing when the verified upload fails", async () => {
    const good = Buffer.from("good content");
    const stream = Readable.from([Buffer.from("evil content")]).pipe(
      verifyingStream(sha(good), good.length),
    );
    await expect(store.put("teams/t/evil", stream, good.length)).rejects.toThrow();
    expect(fake.objects.has("teams/t/evil")).toBe(false);
  });

  it("streams a body of unknown length, and stores nothing when the body fails", async () => {
    await store.putStream("teams/t/stream", Readable.from([Buffer.from("ab"), Buffer.from("cd")]));
    expect(fake.objects.get("teams/t/stream")?.toString()).toBe("abcd");
    const failing = new Readable({
      read() {
        this.push(Buffer.from("partial"));
        this.destroy(new Error("client went away"));
      },
    });
    await expect(store.putStream("teams/t/broken", failing)).rejects.toThrow();
    expect(fake.objects.has("teams/t/broken")).toBe(false);
  });
});

describe("get: only NoSuchKey is a missing object (KOBE-475)", () => {
  const fake = new FakeS3("kaiju", "test-key");
  let endpoint: string;
  const storeFor = (bucket: string) =>
    createS3ObjectStore({
      bucket,
      endpoint,
      region: "us-east-1",
      forcePathStyle: true,
      prefix: "",
      credentials: { accessKeyId: "test-key", secretAccessKey: "test-secret" },
    });

  beforeAll(async () => {
    endpoint = await fake.start();
  });
  afterAll(() => fake.stop());

  it("answers null for NoSuchKey and throws for a wrong bucket", async () => {
    expect(await storeFor("kaiju").get("teams/t/none")).toBeNull();
    await expect(storeFor("not-there").get("teams/t/none")).rejects.toThrow();
  });

  it("throws for a bare 404 and other service errors", async () => {
    const failing = (name: string, status: number) =>
      createS3ObjectStore(
        {
          bucket: "b",
          endpoint: undefined,
          region: "r",
          forcePathStyle: true,
          prefix: "",
          credentials: null,
        },
        {
          send: () =>
            Promise.reject(
              new S3ServiceException({
                name,
                $fault: "client",
                $metadata: { httpStatusCode: status },
              }),
            ),
        } as never,
      );
    await expect(failing("NotFound", 404).get("k")).rejects.toThrow();
    await expect(failing("NoSuchBucket", 404).get("k")).rejects.toThrow();
    await expect(failing("AccessDenied", 403).get("k")).rejects.toThrow();
    expect(await failing("NoSuchKey", 404).get("k")).toBeNull();
  });
});

describe("list", () => {
  it("maps ListObjectsV2 pages, prefixes and the continuation token", async () => {
    const sent: unknown[] = [];
    const client = {
      send: (cmd: { input: unknown }) => {
        sent.push(cmd.input);
        return Promise.resolve({
          Contents: [{ Key: "p/a", LastModified: new Date(1000) }, { LastModified: new Date() }],
          CommonPrefixes: [{ Prefix: "p/d/" }],
          IsTruncated: true,
          NextContinuationToken: "tok",
        });
      },
    };
    const store = createS3ObjectStore(
      {
        bucket: "b",
        endpoint: undefined,
        region: "r",
        forcePathStyle: true,
        prefix: "",
        credentials: null,
      },
      client as never,
    );
    const page = await store.list("p/", { limit: 5, cursor: "c", delimiter: "/" });
    expect(page).toEqual({
      objects: [{ key: "p/a", lastModified: new Date(1000) }],
      prefixes: ["p/d/"],
      next: "tok",
    });
    expect(sent).toEqual([
      { Bucket: "b", Prefix: "p/", MaxKeys: 5, ContinuationToken: "c", Delimiter: "/" },
    ]);
  });
});

describe("S3 client timeouts (KOBE-732)", () => {
  // Accepts every connection and never answers: a half-open object store.
  const sockets: Socket[] = [];
  let server: Server;
  let endpoint = "";

  beforeAll(async () => {
    server = createServer((socket) => {
      sockets.push(socket);
      socket.on("error", () => undefined);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("no port");
    endpoint = `http://127.0.0.1:${address.port}`;
  });
  afterAll(async () => {
    for (const s of sockets) s.destroy();
    await new Promise((resolve) => server.close(resolve));
  });

  const silentStore = () =>
    createS3ObjectStore({
      bucket: "kaiju",
      endpoint,
      region: "us-east-1",
      forcePathStyle: true,
      prefix: "",
      credentials: { accessKeyId: "k", secretAccessKey: "s" },
      connectTimeoutMs: 1_000,
      idleTimeoutMs: 300,
    });

  it("gives up on a store that accepts and never answers", async () => {
    const store = silentStore();
    const started = Date.now();
    await expect(store.get("teams/t/a")).rejects.toThrow(/timed out/);
    await expect(store.delete(["teams/t/a"])).rejects.toThrow(/timed out/);
    await expect(store.put("teams/t/a", Readable.from([Buffer.from("x")]), 1)).rejects.toThrow(
      /timed out/,
    );
    // Three calls, each with the SDK's retries: seconds, not forever.
    expect(Date.now() - started).toBeLessThan(20_000);
  }, 30_000);

  it("honours a caller's abort signal on put and copy", async () => {
    const store = silentStore();
    await expect(
      store.copy("teams/t/a", "teams/t/b", { signal: AbortSignal.timeout(100) }),
    ).rejects.toThrow();
    await expect(
      store.put("teams/t/a", Readable.from([Buffer.from("x")]), 1, {
        signal: AbortSignal.timeout(100),
      }),
    ).rejects.toThrow();
  });
});
