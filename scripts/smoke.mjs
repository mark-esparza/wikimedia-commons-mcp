#!/usr/bin/env node
// Live check of a deployed server: node scripts/smoke.mjs https://<your-worker>.workers.dev/mcp
// Calls initialize, tools/list and one real search, then prints what came back.

const endpoint = process.argv[2];
if (!endpoint) {
  console.error("Usage: node scripts/smoke.mjs https://<your-worker>.workers.dev/mcp");
  process.exit(2);
}

let id = 0;
async function rpc(method, params) {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
  });
  const body = await res.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "1" } });
console.log("Server:", init.serverInfo.name, init.serverInfo.version, "protocol", init.protocolVersion);

const { tools } = await rpc("tools/list", {});
console.log("Tools:", tools.map((t) => t.name).join(", "));

const query = process.argv[3] ?? "Kayser-Fleischer ring";
const search = await rpc("tools/call", { name: "search_images", arguments: { query, limit: 3 } });
if (search.isError) throw new Error(search.content[0].text);
const data = JSON.parse(search.content[0].text);
console.log(`\nTop results for "${query}":`);
for (const r of data.results) console.log(`- ${r.title}\n  ${r.license}\n  ${r.attribution}`);

const drug = await rpc("tools/call", { name: "wikidata_image", arguments: { entity: "metoprolol", prefer: "structure" } });
const d = JSON.parse(drug.content[0].text);
console.log(`\nWikidata: ${d.entity.label} (${d.entity.id}) -> ${d.files[0]?.title ?? "no structure image"}`);
console.log("\nSmoke test passed.");
