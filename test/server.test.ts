import { test } from "node:test";
import assert from "node:assert/strict";
import { createHandler } from "../src/index.ts";
import { imagePage, mockFetch } from "./fixtures.ts";

const BASE = "https://mcp.example.workers.dev";

function rpc(handler: (r: Request) => Promise<Response>, body: unknown, headers: Record<string, string> = {}) {
  return handler(
    new Request(`${BASE}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

async function call(handler: (r: Request) => Promise<Response>, name: string, args: unknown) {
  const res = await rpc(handler, { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name, arguments: args } });
  assert.equal(res.status, 200);
  const body: any = await res.json();
  return body.result;
}

const isCommons = (u: URL) => u.hostname === "commons.wikimedia.org" && u.pathname === "/w/api.php";
const isWikidata = (u: URL) => u.hostname === "www.wikidata.org" && u.pathname === "/w/api.php";

// ---------- protocol ----------

test("initialize negotiates protocol version and reports tools capability", async () => {
  const h = createHandler({ fetch: mockFetch([]).fetch });
  const res = await rpc(h, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/json");
  const body: any = await res.json();
  assert.equal(body.id, 1);
  assert.equal(body.result.protocolVersion, "2025-06-18");
  assert.deepEqual(body.result.capabilities, { tools: { listChanged: false } });
  assert.equal(body.result.serverInfo.name, "wikimedia-commons-mcp");

  const res2 = await rpc(h, { jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "1999-01-01" } });
  assert.equal(((await res2.json()) as any).result.protocolVersion, "2025-11-25");
});

test("notifications get 202 with no body", async () => {
  const h = createHandler({ fetch: mockFetch([]).fetch });
  const res = await rpc(h, { jsonrpc: "2.0", method: "notifications/initialized" });
  assert.equal(res.status, 202);
  assert.equal(await res.text(), "");
});

test("tools/list returns all six tools with schemas", async () => {
  const h = createHandler({ fetch: mockFetch([]).fetch });
  const body: any = await (await rpc(h, { jsonrpc: "2.0", id: 3, method: "tools/list" })).json();
  const names = body.result.tools.map((t: any) => t.name);
  assert.deepEqual(names, ["search_images", "get_file_info", "view_image", "wikidata_image", "find_labeled_svgs", "attributions"]);
  for (const t of body.result.tools) {
    assert.equal(t.inputSchema.type, "object");
    assert.equal(t.annotations.readOnlyHint, true);
    assert.equal(t.run, undefined);
  }
});

test("errors: parse error, unknown method, unknown tool, bad args", async () => {
  const h = createHandler({ fetch: mockFetch([]).fetch });
  const parse = await rpc(h, "{not json");
  assert.equal(parse.status, 400);
  assert.equal(((await parse.json()) as any).error.code, -32700);

  const unknown: any = await (await rpc(h, { jsonrpc: "2.0", id: 4, method: "resources/list" })).json();
  assert.equal(unknown.error.code, -32601);

  const tool: any = await (await rpc(h, { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "nope", arguments: {} } })).json();
  assert.equal(tool.error.code, -32602);

  const args: any = await (await rpc(h, { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "search_images", arguments: [1] } })).json();
  assert.equal(args.error.code, -32602);

  const invalid: any = await (await rpc(h, { id: 9, method: "ping" })).json();
  assert.equal(invalid.error.code, -32600);
});

test("HTTP routing: GET /mcp is 405, OPTIONS has CORS, root shows info, ping works, batches work", async () => {
  const h = createHandler({ fetch: mockFetch([]).fetch });
  const get = await h(new Request(`${BASE}/mcp`));
  assert.equal(get.status, 405);
  assert.equal(get.headers.get("allow"), "POST");
  const opt = await h(new Request(`${BASE}/mcp`, { method: "OPTIONS" }));
  assert.equal(opt.status, 204);
  assert.equal(opt.headers.get("access-control-allow-origin"), "*");
  assert.match(await (await h(new Request(`${BASE}/`))).text(), /Not affiliated with the Wikimedia Foundation/);
  assert.equal((await h(new Request(`${BASE}/other`))).status, 404);
  const ping: any = await (await rpc(h, { jsonrpc: "2.0", id: "p", method: "ping" })).json();
  assert.deepEqual(ping, { jsonrpc: "2.0", id: "p", result: {} });
  const batch: any = await (await rpc(h, [{ jsonrpc: "2.0", id: 1, method: "ping" }, { jsonrpc: "2.0", method: "notifications/initialized" }])).json();
  assert.equal(batch.length, 1);
});

// ---------- tools ----------

test("search_images sends User-Agent, filters non-images and share-alike, keeps rank order", async () => {
  const m = mockFetch([
    (u) =>
      isCommons(u) && u.searchParams.get("generator") === "search"
        ? {
            body: {
              query: {
                pages: [
                  imagePage("File:Second.jpg", { index: 2, license: "CC BY 4.0" }),
                  imagePage("File:First.jpg", { index: 1 }),
                  imagePage("File:Paper.pdf", { index: 3, mime: "application/pdf" }),
                  imagePage("File:Third.png", { index: 4, mime: "image/png", pd: true }),
                ],
              },
            },
          }
        : undefined,
  ]);
  const h = createHandler({ fetch: m.fetch, contact: "me@example.org" });

  const r = await call(h, "search_images", { query: "Kayser-Fleischer ring", limit: 5 });
  const data = JSON.parse(r.content[0].text);
  assert.deepEqual(data.results.map((x: any) => x.title), ["File:First.jpg", "File:Second.jpg", "File:Third.png"]);
  const sent = m.calls[0];
  assert.equal(sent.url.searchParams.get("gsrnamespace"), "6");
  assert.equal(sent.url.searchParams.get("formatversion"), "2");
  assert.equal(sent.url.searchParams.get("gsrsearch"), "Kayser-Fleischer ring");
  assert.match(sent.headers["User-Agent"], /^WikimediaCommonsMCP\/0\.1\.0 \(me@example\.org\)$/);

  const r2 = await call(h, "search_images", { query: "x", allow_share_alike: false, media: "photo" });
  const d2 = JSON.parse(r2.content[0].text);
  assert.deepEqual(d2.results.map((x: any) => x.title), ["File:Second.jpg", "File:Third.png"]);
  assert.equal(m.calls[1].url.searchParams.get("gsrsearch"), "x filetype:bitmap");
});

test("search_images reports empty query and upstream failures as tool errors", async () => {
  const h = createHandler({ fetch: mockFetch([(u) => (isCommons(u) ? { status: 503, body: "down" } : undefined)]).fetch });
  const empty = await call(h, "search_images", { query: "   " });
  assert.equal(empty.isError, true);
  assert.match(empty.content[0].text, /query is required/);
  const down = await call(h, "search_images", { query: "heart" });
  assert.equal(down.isError, true);
  assert.match(down.content[0].text, /HTTP 503/);

  const h2 = createHandler({ fetch: mockFetch([(u) => (isCommons(u) ? { body: { error: { code: "badvalue", info: "Bad" } } } : undefined)]).fetch });
  const apiErr = await call(h2, "search_images", { query: "heart" });
  assert.match(apiErr.content[0].text, /badvalue/);
});

test("get_file_info accepts a URL and returns categories", async () => {
  const m = mockFetch([
    (u) =>
      isCommons(u) && u.searchParams.get("titles") === "File:Brachial plexus 2.svg"
        ? { body: { query: { pages: [{ ...imagePage("File:Brachial plexus 2.svg", { mime: "image/svg+xml" }), categories: [{ ns: 14, title: "Category:Brachial plexus" }] }] } } }
        : undefined,
  ]);
  const h = createHandler({ fetch: m.fetch });
  const r = await call(h, "get_file_info", { file: "https://commons.wikimedia.org/wiki/File:Brachial_plexus_2.svg" });
  const data = JSON.parse(r.content[0].text);
  assert.equal(data.title, "File:Brachial plexus 2.svg");
  assert.deepEqual(data.categories, ["Brachial plexus"]);
  assert.equal(m.calls[0].url.searchParams.get("clshow"), "!hidden");
  assert.equal(m.calls[0].url.searchParams.get("prop"), "imageinfo|categories");

  const evil = await call(h, "get_file_info", { file: "https://evil.example/wiki/File:X.jpg" });
  assert.equal(evil.isError, true);
  assert.equal(m.calls.length, 1, "no request made for a disallowed host");
});

test("get_file_info reports missing files", async () => {
  const h = createHandler({ fetch: mockFetch([(u) => (isCommons(u) ? { body: { query: { pages: [{ ns: 6, title: "File:Nope.jpg", missing: true }] } } } : undefined)]).fetch });
  const r = await call(h, "get_file_info", { file: "Nope.jpg" });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /No file named "File:Nope.jpg"/);
});

test("view_image returns base64 image content plus attribution", async () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  const m = mockFetch([
    (u) => (isCommons(u) ? { body: { query: { pages: [imagePage("File:Eye.jpg")] } } } : undefined),
    (u) => (u.hostname === "upload.wikimedia.org" ? { body: png, headers: { "content-type": "image/jpeg", "content-length": String(png.length) } } : undefined),
  ]);
  const h = createHandler({ fetch: m.fetch });
  const r = await call(h, "view_image", { file: "Eye.jpg", width: 400 });
  assert.equal(r.content[0].type, "image");
  assert.equal(r.content[0].mimeType, "image/jpeg");
  assert.equal(r.content[0].data, Buffer.from(png).toString("base64"));
  assert.match(JSON.parse(r.content[1].text).attribution, /Dr\. Example/);
  assert.equal(m.calls[0].url.searchParams.get("iiurlwidth"), "400");
});

test("view_image refuses non-image previews", async () => {
  const m = mockFetch([
    (u) => (isCommons(u) ? { body: { query: { pages: [imagePage("File:Eye.jpg")] } } } : undefined),
    (u) => (u.hostname === "upload.wikimedia.org" ? { body: "<html>", headers: { "content-type": "text/html" } } : undefined),
  ]);
  const r = await call(createHandler({ fetch: m.fetch }), "view_image", { file: "Eye.jpg" });
  assert.equal(r.isError, true);
});

test("wikidata_image skips duplicate items without images, prefers structure, skips deprecated claims", async () => {
  const m = mockFetch([
    (u) =>
      isWikidata(u) && u.searchParams.get("action") === "wbsearchentities"
        ? { body: { search: [{ id: "Q111", label: "Metoprolol", description: "chemical compound" }, { id: "Q222", label: "metoprolol", description: "chemical compound" }] } }
        : undefined,
    (u) =>
      isWikidata(u) && u.searchParams.get("action") === "wbgetentities"
        ? {
            body: {
              entities: Object.fromEntries(
                (u.searchParams.get("ids") ?? "").split("|").map((id) => [
                  id,
                  id === "Q111"
                    ? { id, labels: { en: { value: "Metoprolol" } }, claims: {} }
                    : {
                        id,
                        labels: { en: { value: "metoprolol" } },
                        descriptions: { en: { value: "chemical compound" } },
                        claims: {
                          P117: [
                            { rank: "deprecated", mainsnak: { datavalue: { value: "Old structure.png" } } },
                            { rank: "normal", mainsnak: { datavalue: { value: "Metoprolol.svg" } } },
                          ],
                          P18: [{ rank: "normal", mainsnak: { datavalue: { value: "Metoprolol tablets.jpg" } } }],
                        },
                      },
                ]),
              ),
            },
          }
        : undefined,
    (u) =>
      isCommons(u)
        ? { body: { query: { pages: (u.searchParams.get("titles") ?? "").split("|").map((t) => imagePage(t, { mime: t.endsWith(".svg") ? "image/svg+xml" : "image/jpeg", pd: true })) } } }
        : undefined,
  ]);
  const h = createHandler({ fetch: m.fetch });
  const r = await call(h, "wikidata_image", { entity: "metoprolol" });
  const d = JSON.parse(r.content[0].text);
  assert.equal(d.entity.id, "Q222");
  assert.deepEqual(d.other_matches.map((x: any) => x.id), ["Q111"]);
  assert.deepEqual(d.files.map((f: any) => [f.property, f.title]), [["P117", "File:Metoprolol.svg"], ["P18", "File:Metoprolol tablets.jpg"]]);
  assert.equal(m.calls[1].url.searchParams.get("ids"), "Q111|Q222");

  const only = JSON.parse((await call(h, "wikidata_image", { entity: "q222", prefer: "image" })).content[0].text);
  assert.deepEqual(only.files.map((f: any) => f.property), ["P18"]);
  assert.deepEqual(only.other_matches, []);

  const none = JSON.parse((await call(h, "wikidata_image", { entity: "Q111" })).content[0].text);
  assert.equal(none.files.length, 0);
  assert.match(none.note, /no linked image/);
});

test("view_image works with thumb.wikimedia.org thumbnails and URLs drop utm params", async () => {
  const jpg = new Uint8Array([0xff, 0xd8, 0xff, 9]);
  const page = imagePage("File:KF ring 1.jpg");
  page.imageinfo[0].thumburl = "https://thumb.wikimedia.org/wikipedia/commons/thumb/6/6c/KF_ring_1.jpg/400px-KF_ring_1.jpg?utm_source=commons.wikimedia.org&utm_campaign=imageinfo&utm_content=thumbnail";
  page.imageinfo[0].url = "https://upload.wikimedia.org/wikipedia/commons/6/6c/KF_ring_1.jpg?utm_source=x";
  const m = mockFetch([
    (u) => (isCommons(u) ? { body: { query: { pages: [page] } } } : undefined),
    (u) => (u.hostname === "thumb.wikimedia.org" ? { body: jpg, headers: { "content-type": "image/jpeg" } } : undefined),
  ]);
  const h = createHandler({ fetch: m.fetch });
  const r = await call(h, "view_image", { file: "KF ring 1.jpg" });
  assert.equal(r.content[0].type, "image");
  const meta = JSON.parse(r.content[1].text);
  assert.equal(meta.thumb_url, "https://thumb.wikimedia.org/wikipedia/commons/thumb/6/6c/KF_ring_1.jpg/400px-KF_ring_1.jpg");
  assert.equal(m.calls[1].url.hostname, "thumb.wikimedia.org");
  assert.equal(m.calls[1].url.search, "");

  const info = JSON.parse((await call(h, "get_file_info", { file: "KF ring 1.jpg" })).content[0].text);
  assert.equal(info.original_url, "https://upload.wikimedia.org/wikipedia/commons/6/6c/KF_ring_1.jpg");
});

test("find_labeled_svgs ranks by label count and only fetches upload.wikimedia.org", async () => {
  const svgA = "<svg><text>Heart</text><text>Aorta</text><text>Left atrium</text><text>Right atrium</text></svg>";
  const svgB = "<svg><text>A</text><text>B</text><text>C</text></svg>";
  const svgC = "<svg><path d='M0'/></svg>";
  const m = mockFetch([
    (u) =>
      isCommons(u)
        ? {
            body: {
              query: {
                pages: [
                  imagePage("File:B.svg", { index: 1, mime: "image/svg+xml" }),
                  imagePage("File:A.svg", { index: 2, mime: "image/svg+xml" }),
                  imagePage("File:C.svg", { index: 3, mime: "image/svg+xml" }),
                  imagePage("File:Huge.svg", { index: 4, mime: "image/svg+xml", size: 9_000_000 }),
                ],
              },
            },
          }
        : undefined,
    (u) => {
      if (u.hostname !== "upload.wikimedia.org") return undefined;
      const body = u.pathname.endsWith("/A.svg") ? svgA : u.pathname.endsWith("/B.svg") ? svgB : svgC;
      return { body, headers: { "content-type": "image/svg+xml" } };
    },
  ]);
  const r = await call(createHandler({ fetch: m.fetch }), "find_labeled_svgs", { topic: "heart" });
  const d = JSON.parse(r.content[0].text);
  assert.deepEqual(d.results.map((x: any) => [x.title, x.label_count]), [["File:A.svg", 4], ["File:B.svg", 3]]);
  assert.equal(m.calls[0].url.searchParams.get("gsrsearch"), "heart filemime:image/svg+xml");
  assert.ok(!m.calls.some((c) => c.url.pathname.endsWith("Huge.svg")), "oversized SVG not downloaded");
});

test("attributions handles mixed inputs, missing files and styles", async () => {
  const m = mockFetch([
    (u) =>
      isCommons(u)
        ? {
            body: {
              query: {
                normalized: [{ from: "File:lower.jpg", to: "File:Lower.jpg" }],
                pages: (u.searchParams.get("titles") ?? "").split("|").map((t) => (t === "File:Gone.jpg" ? { ns: 6, title: t, missing: true } : imagePage(t))),
              },
            },
          }
        : undefined,
  ]);
  const h = createHandler({ fetch: m.fetch });
  const r = await call(h, "attributions", { files: ["A.jpg", "https://upload.wikimedia.org/wikipedia/commons/a/ab/B.jpg", "Gone.jpg", "https://bad.example/x", "A.jpg"], style: "ama" });
  const d = JSON.parse(r.content[0].text);
  assert.equal(d.credits.length, 2);
  assert.match(d.credits[0].credit, /^Dr\. Example\. A\. Wikimedia Commons\. Accessed /);
  assert.deepEqual(d.not_found, ["File:Gone.jpg"]);
  assert.equal(d.invalid.length, 1);
  assert.equal(m.calls[0].url.searchParams.get("titles"), "File:A.jpg|File:B.jpg|File:Gone.jpg");

  const tooMany = await call(h, "attributions", { files: Array.from({ length: 51 }, (_, i) => `F${i}.jpg`) });
  assert.equal(tooMany.isError, true);
});
