/**
 * A gRPC client for the FIT performer protocol, built on Connect (`@connectrpc/connect-node`).
 *
 * Connect rather than @grpc/grpc-js because it sits on the same `@bufbuild/protobuf` runtime as
 * the generated types in `src/fit/performance/generated/`, and takes their `PerformerService`
 * directly — no second protobuf stack and no extra codegen.
 *
 * Two settings matter for the performance driver, and are why this isn't just a bare
 * `createGrpcTransport` call:
 *
 * - **Flow control changes the measurement.** Node's default HTTP/2 window is 64KB, which at
 *   perf throughputs backpressures the performer and silently lowers the throughput being
 *   measured. Both the stream and session windows are opened up to {@link WINDOW_SIZE_BYTES}.
 *   Connect only exposes the stream window (via `http2.connect` options), so the session window
 *   is opened by {@link WideWindowSessionManager}.
 * - **No compression.** Connect advertises gzip and brotli by default. A performer that honoured
 *   that would spend CPU compressing results mid-run, so it's switched off.
 *
 * `@connectrpc/connect` and `connect-node` are pinned to exactly 2.2.0. In 2.3.0, `run-call.js`
 * races every read of a streaming response against a promise that only settles when the call
 * ends, adding one reaction to it per message, and each reaction keeps that message reachable.
 * Nothing a perf run receives is ever freed: an unbatched 111k results/sec stream grew by ~70MB/s
 * until a 32GB instance thrashed and stopped responding. Unary calls are too short to notice.
 * Before moving off 2.2.0, check a long `run` stream holds steady memory.
 *
 * Run on its own, against a performer that's already running:
 *   bun src/fit/performers/util/performer-grpc.ts [host] [port]
 */
import type http2 from "node:http2";
import { ConnectError, createClient, type Client } from "@connectrpc/connect";
import { createGrpcTransport, Http2SessionManager } from "@connectrpc/connect-node";
import { isMain, runCli } from "../../../util/non-fit/cli.js";
import { PerformerService } from "../../performance/generated/performer_pb.js";

/**
 * HTTP/2 flow-control window, per stream and for the session.
 *
 * 8MB is far more than the ~2MB/sec a busy run produces, so the performer never waits on a
 * WINDOW_UPDATE. The cost is only buffer headroom in this process.
 */
export const WINDOW_SIZE_BYTES = 8 * 1024 * 1024;

/** Node buffers up to this much (MB) per session; the default 10 is too tight for the window above. */
const MAX_SESSION_MEMORY_MB = 256;

/** How long a unary call may take before it's abandoned. Pass as the call's options. */
export const UNARY_CALL_OPTIONS = { timeoutMs: 60_000 } as const;

export type PerformerClient = Client<typeof PerformerService>;

/**
 * Opens each new HTTP/2 session's connection-level window, which `http2.connect` options can't.
 *
 * Done on the first request of a session, before any response data can arrive. A reconnect
 * gets a new session, which is caught the same way.
 */
class WideWindowSessionManager extends Http2SessionManager {
  private readonly widened = new WeakSet<http2.Http2Session>();

  override async request(
    method: string,
    path: string,
    headers: http2.OutgoingHttpHeaders,
    options: Omit<http2.ClientSessionRequestOptions, "signal">,
  ): Promise<http2.ClientHttp2Stream> {
    const stream = await super.request(method, path, headers, options);
    const session = stream.session;
    if (session && !this.widened.has(session)) {
      session.setLocalWindowSize(WINDOW_SIZE_BYTES);
      this.widened.add(session);
    }
    return stream;
  }
}

/** One HTTP/2 connection to a performer, over which several RPCs can be made. */
export interface PerformerConnection {
  client: PerformerClient;
  /** Close the connection, and with it any call still open on it. */
  close(): void;
}

/**
 * Connect to a performer on `host:port`.
 *
 * Always plaintext: the performer is on the same machine (or the same private network) as
 * fit-cli, and TLS would add cost to the very thing being measured.
 */
export function connectPerformer(host: string, port: number): PerformerConnection {
  const baseUrl = `http://${host}:${port}`;
  const sessionManager = new WideWindowSessionManager(baseUrl, {}, {
    settings: { initialWindowSize: WINDOW_SIZE_BYTES },
    maxSessionMemory: MAX_SESSION_MEMORY_MB,
  });
  const transport = createGrpcTransport({
    baseUrl,
    sessionManager,
    acceptCompression: [],
  });
  return {
    client: createClient(PerformerService, transport),
    close: () => sessionManager.abort(),
  };
}

/**
 * Whether an error is the performer itself answering with a non-OK gRPC status, as opposed to
 * not being reachable (yet). A booting performer refuses, resets or drops the connection; none
 * of that carries a `grpc-status`, and Connect only marks an error as from the wire when one
 * actually arrived (in the trailers, or "trailers-only" in the headers).
 */
export function isPerformerStatus(err: unknown): err is ConnectError {
  return err instanceof ConnectError && err.isWireError;
}

if (isMain(import.meta.url)) {
  runCli(async () => {
    const argv = process.argv.slice(2);
    if (argv.includes("--help") || argv.includes("-h")) {
      console.log(
        [
          "Call performerCapsFetch on an already-running performer, using the same gRPC client the",
          "perf engine and `fit caps` use.",
          "",
          "  bun src/fit/performers/util/performer-grpc.ts [host] [port]   (default localhost 8060)",
        ].join("\n"),
      );
      return { artifacts: [], details: [] };
    }
    const host = argv[0] ?? "localhost";
    const port = Number(argv[1] ?? 8060);
    const connection = connectPerformer(host, port);
    try {
      const caps = await connection.client.performerCapsFetch({}, UNARY_CALL_OPTIONS);
      console.log(`${host}:${port} is ${caps.performerUserAgent} ${caps.libraryVersion}`);
    } finally {
      connection.close();
    }
    return { artifacts: [], details: [] };
  });
}
