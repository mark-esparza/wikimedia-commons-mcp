// Minimal MCP server over Streamable HTTP (stateless, JSON responses, no sessions).
// Spec: https://modelcontextprotocol.io/specification/2025-06-18/basic/transports

import type { Deps } from "./commons.ts";
import { callTool, listTools } from "./tools.ts";

export const SERVER_NAME = "wikimedia-commons-mcp";
export const SERVER_VERSION = "0.1.0";
export const SUPPORTED_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

const INSTRUCTIONS = [
  "Tools for finding and crediting freely licensed media on Wikimedia Commons.",
  "Most Commons files require attribution: when you show or embed an image, include its attribution line.",
  "Before presenting an image as evidence or as a question exhibit, call view_image to confirm it shows what you claim.",
  "For drug and chemical structures, wikidata_image with prefer='structure' is usually the fastest route.",
].join(" ");

interface RpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: any;
}

function ok(id: RpcRequest["id"], result: unknown) {
  return { jsonrpc: "2.0", id, result };
}

function err(id: RpcRequest["id"] | null, code: number, message: string) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

/** Handle one JSON-RPC message. Returns null for notifications (no response body). */
export async function handleMessage(deps: Deps, msg: any): Promise<object | null> {
  if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    // Responses from the client (to server requests) are ignored; we never send requests.
    if (msg && typeof msg === "object" && ("result" in msg || "error" in msg)) return null;
    return err(msg?.id ?? null, -32600, "Invalid Request");
  }
  const req = msg as RpcRequest;
  const isNotification = req.id === undefined;
  if (isNotification) return null;

  switch (req.method) {
    case "initialize": {
      const requested = req.params?.protocolVersion;
      const version = SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[0];
      return ok(req.id, {
        protocolVersion: version,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, title: "Wikimedia Commons", version: SERVER_VERSION },
        instructions: INSTRUCTIONS,
      });
    }
    case "ping":
      return ok(req.id, {});
    case "tools/list":
      return ok(req.id, { tools: listTools() });
    case "tools/call": {
      const name = req.params?.name;
      if (typeof name !== "string") return err(req.id, -32602, "Missing tool name");
      const args = req.params?.arguments;
      if (args !== undefined && (typeof args !== "object" || args === null || Array.isArray(args))) {
        return err(req.id, -32602, "arguments must be an object");
      }
      const result = await callTool(deps, name, args ?? {});
      if (!result) return err(req.id, -32602, `Unknown tool: ${name}`);
      return ok(req.id, result);
    }
    default:
      return err(req.id, -32601, `Method not found: ${req.method}`);
  }
}
