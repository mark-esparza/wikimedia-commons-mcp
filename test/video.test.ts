import { test } from "node:test";
import assert from "node:assert/strict";
import { createHandler } from "../src/index.ts";
import { frameTimes, seekThumbUrl } from "../src/video.ts";
import { imagePage, mockFetch, videoPage } from "./fixtures.ts";

const BASE = "https://mcp.example.workers.dev";
const isCommons = (u: URL) => u.hostname === "commons.wikimedia.org" && u.pathname === "/w/api.php";

async function call(handler: (r: Request) => Promise<Response>, name: string, args: unknown) {
  const res = await handler(
    new Request(`${BASE}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) }),
  );
  return ((await res.json()) as any).result;
}

test("seekThumbUrl inserts the timestamp and keeps Commons' encoding", () => {
  const base = "https://thumb.wikimedia.org/wikipedia/commons/thumb/d/dc/Nistagmo_%28olho%29.webm/500px--Nistagmo_%28olho%29.webm.jpg?utm_source=x";
  assert.equal(seekThumbUrl(base, 12.5), "https://thumb.wikimedia.org/wikipedia/commons/thumb/d/dc/Nistagmo_%28olho%29.webm/500px-seek=12.5-Nistagmo_%28olho%29.webm.jpg");
  const seeked = "https://upload.wikimedia.org/wikipedia/commons/thumb/d/dc/A.ogv/320px-seek=3-A.ogv.jpg";
  assert.equal(seekThumbUrl(seeked, 8), "https://upload.wikimedia.org/wikipedia/commons/thumb/d/dc/A.ogv/320px-seek=8-A.ogv.jpg");
  assert.throws(() => seekThumbUrl("https://upload.wikimedia.org/wikipedia/commons/d/dc/A.ogv", 1));
});

test("frameTimes spaces frames evenly and clamps requested times", () => {
  assert.deepEqual(frameTimes(36, 4), [7.2, 14.4, 21.6, 28.8]);
  assert.deepEqual(frameTimes(10, 1), [5]);
  assert.deepEqual(frameTimes(10, 4, [0, 3.33, 3.33, 99, -1]), [0, 3.3, 9.5]);
});

test("search_videos returns duration, phone-friendly MP4, captions, and filters by length", async () => {
  const m = mockFetch([
    (u) =>
      isCommons(u)
        ? { body: { query: { pages: [videoPage("File:Long.webm", { index: 2, duration: 600 }), videoPage("File:Nistagmo.webm", { index: 1, captions: ["en", "pt"] }), videoPage("File:NoMp4.webm", { index: 3, mp4: false })] } } }
        : undefined,
  ]);
  const h = createHandler({ fetch: m.fetch });
  const r = await call(h, "search_videos", { query: "nystagmus", max_duration_seconds: 120 });
  const d = JSON.parse(r.content[0].text);
  assert.deepEqual(d.results.map((x: any) => x.title), ["File:Nistagmo.webm", "File:NoMp4.webm"]);
  const first = d.results[0];
  assert.equal(first.duration_seconds, 36.3);
  assert.match(first.phone_friendly_url, /360p\.mpeg4\.mov$/);
  assert.deepEqual(first.caption_languages, ["en", "pt"]);
  assert.ok(!first.poster_url.includes("utm_"));
  assert.match(d.results[1].phone_friendly_url, /240p\.vp9\.webm$/, "falls back to the smallest WebM");
  const sent = m.calls[0].url;
  assert.equal(sent.searchParams.get("gsrsearch"), "nystagmus filetype:video");
  assert.equal(sent.searchParams.get("prop"), "videoinfo");
  assert.match(sent.searchParams.get("viprop")!, /derivatives/);
});

test("get_video lists sources in order, builds embed code, and returns a transcript", async () => {
  const vtt = "WEBVTT\n\n1\n00:00:00.000 --> 00:00:02.000\nThe eyes drift <i>slowly</i>\n\n2\n00:00:02.000 --> 00:00:04.000\nthen beat back &amp; repeat\n";
  const m = mockFetch([
    (u) => (isCommons(u) && u.searchParams.get("action") === "timedtext" ? { body: vtt, headers: { "content-type": "text/vtt" } } : undefined),
    (u) => (isCommons(u) ? { body: { query: { pages: [videoPage("File:Nistagmo.webm", { captions: ["en"] })] } } } : undefined),
  ]);
  const h = createHandler({ fetch: m.fetch });
  const r = await call(h, "get_video", { file: "https://commons.wikimedia.org/wiki/File:Nistagmo.webm", transcript_lang: "en" });
  const d = JSON.parse(r.content[0].text);
  assert.deepEqual(d.sources.map((s: any) => s.label), ["360p.mpeg4.mov", "240p.vp9.webm", "480p.vp9.webm", "original"]);
  assert.equal(d.sources[0].format, "mp4");
  assert.ok(d.sources.every((s: any) => !s.url.includes("utm_")));
  assert.equal(d.captions[0].label, "Lang (en)");
  assert.ok(!d.captions[0].url.includes("origin="));
  assert.equal(d.embed_url, "https://commons.wikimedia.org/wiki/File:Nistagmo.webm?embedplayer=yes");
  assert.match(d.embed_html, /<iframe src="https:\/\/commons\.wikimedia\.org\/wiki\/File:Nistagmo\.webm\?embedplayer=yes" width="640" height="360"/);
  assert.match(d.embed_html, /<source src="[^"]+360p\.mpeg4\.mov" type="video\/quicktime">/);
  assert.match(d.embed_html, /<track kind="subtitles" srclang="en"/);
  assert.match(d.embed_html, /Bernardino F, et al\./);
  assert.equal(d.transcript, "The eyes drift slowly then beat back & repeat");
  const tt = m.calls.find((c) => c.url.searchParams.get("action") === "timedtext")!.url;
  assert.equal(tt.searchParams.get("lang"), "en");
  assert.equal(tt.searchParams.get("format"), null, "no json format param on the VTT request");

  const missing = JSON.parse((await call(h, "get_video", { file: "Nistagmo.webm", transcript_lang: "fr" })).content[0].text);
  assert.equal(missing.transcript, "No fr captions. Available: en");
});

test("get_video rejects images and bad language codes", async () => {
  const h = createHandler({ fetch: mockFetch([(u) => (isCommons(u) ? { body: { query: { pages: [imagePage("File:Eye.jpg")] } } } : undefined)]).fetch });
  const r = await call(h, "get_video", { file: "Eye.jpg" });
  assert.equal(r.isError, true);

  const h2 = createHandler({ fetch: mockFetch([(u) => (isCommons(u) ? { body: { query: { pages: [videoPage("File:V.webm", { captions: ["en"] })] } } } : undefined)]).fetch });
  const bad = JSON.parse((await call(h2, "get_video", { file: "V.webm", transcript_lang: "en&x=1" })).content[0].text);
  assert.match(bad.transcript, /^No en&x=1 captions/);
});

test("view_video_frames returns one image per timestamp from seeked thumbnails", async () => {
  const jpg = new Uint8Array([0xff, 0xd8, 0xff, 1]);
  const m = mockFetch([
    (u) => (isCommons(u) ? { body: { query: { pages: [videoPage("File:Nistagmo.webm", { duration: 20 })] } } } : undefined),
    (u) => (u.hostname === "thumb.wikimedia.org" ? { body: jpg, headers: { "content-type": "image/jpeg" } } : undefined),
  ]);
  const h = createHandler({ fetch: m.fetch });
  const r = await call(h, "view_video_frames", { file: "Nistagmo.webm", count: 3, width: 320 });
  const images = r.content.filter((c: any) => c.type === "image");
  assert.equal(images.length, 3);
  assert.deepEqual(r.content.filter((c: any) => c.type === "text" && c.text.startsWith("Frame")).map((c: any) => c.text), ["Frame at 5s", "Frame at 10s", "Frame at 15s"]);
  const frameUrls = m.calls.filter((c) => c.url.hostname === "thumb.wikimedia.org").map((c) => c.url.pathname.split("/").pop());
  assert.deepEqual(frameUrls, ["500px-seek=5-Nistagmo.webm.jpg", "500px-seek=10-Nistagmo.webm.jpg", "500px-seek=15-Nistagmo.webm.jpg"]);
  assert.equal(m.calls[0].url.searchParams.get("viurlwidth"), "320");

  const picked = await call(h, "view_video_frames", { file: "Nistagmo.webm", times: [2, 50] });
  assert.deepEqual(picked.content.filter((c: any) => c.type === "text" && c.text.startsWith("Frame")).map((c: any) => c.text), ["Frame at 2s", "Frame at 19.5s"]);
});
