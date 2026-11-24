// Cloudflare Worker entry point. The MCP endpoint is POST /mcp.

import type { Deps } from "./commons.ts";
import { handleMessage, SERVER_NAME, SERVER_VERSION } from "./mcp.ts";

export interface Env {
  /** Contact info for the Wikimedia User-Agent header: a URL or email address. */
  CONTACT?: string;
}

const DEFAULT_CONTACT = "https://github.com/mark-esparza/wikimedia-commons-mcp";
const MAX_BODY_BYTES = 1_000_000;

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept, Authorization, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID",
  "Access-Control-Expose-Headers": "Mcp-Session-Id, Mcp-Protocol-Version",
  "Access-Control-Max-Age": "86400",
};

function respond(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  const isJson = body !== null && typeof body !== "string";
  return new Response(body === null ? null : isJson ? JSON.stringify(body) : (body as string), {
    status,
    headers: {
      ...CORS,
      ...(body === null ? {} : { "Content-Type": isJson ? "application/json" : "text/plain; charset=utf-8" }),
      ...extra,
    },
  });
}

export function createHandler(opts: { fetch: typeof fetch; contact?: string }) {
  const deps: Deps = {
    fetch: opts.fetch,
    userAgent: `WikimediaCommonsMCP/${SERVER_VERSION} (${opts.contact || DEFAULT_CONTACT})`,
  };

  return async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") return respond(null, 204);

    if (url.pathname === "/" && request.method === "GET") {
      return respond(`${SERVER_NAME} ${SERVER_VERSION}\nMCP endpoint: ${url.origin}/mcp\nUnofficial. Not affiliated with the Wikimedia Foundation.\n`);
    }

    if (url.pathname !== "/mcp") return respond("Not found", 404);

    // This server does not open server-to-client SSE streams or keep sessions.
    if (request.method === "GET" || request.method === "DELETE") return respond("Method Not Allowed", 405, { Allow: "POST" });
    if (request.method !== "POST") return respond("Method Not Allowed", 405, { Allow: "POST" });

    const declared = Number(request.headers.get("content-length") ?? "0");
    if (declared > MAX_BODY_BYTES) return respond({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Request too large" } }, 413);

    let text: string;
    try {
      text = await request.text();
    } catch {
      return respond({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Could not read body" } }, 400);
    }
    if (text.length > MAX_BODY_BYTES) return respond({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Request too large" } }, 413);

    let msg: unknown;
    try {
      msg = JSON.parse(text);
    } catch {
      return respond({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400);
    }

    try {
      if (Array.isArray(msg)) {
        // Batches were removed in protocol 2025-06-18 but older clients may still send them.
        if (msg.length === 0 || msg.length > 20) return respond({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid batch" } }, 400);
        const out = (await Promise.all(msg.map((m) => handleMessage(deps, m)))).filter((r) => r !== null);
        return out.length ? respond(out) : respond(null, 202);
      }
      const out = await handleMessage(deps, msg);
      return out ? respond(out) : respond(null, 202);
    } catch (e) {
      console.error("Unhandled error", e);
      return respond({ jsonrpc: "2.0", id: (msg as any)?.id ?? null, error: { code: -32603, message: "Internal error" } }, 500);
    }
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return createHandler({ fetch: (input, init) => fetch(input, init), contact: env.CONTACT })(request);
  },
};
