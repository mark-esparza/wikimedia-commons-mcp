// Video support: search, playable sources, captions, embed code, and stills sampled from any timestamp.

import {
  type Deps,
  type FileRecord,
  apiGet,
  apiText,
  cleanMediaUrl,
  COMMONS_API,
  EXTMETADATA_FIELDS,
  fetchUpload,
  normalizeTitle,
  toFileRecord,
} from "./commons.ts";
import { clampInt, decodeEntities, toBase64, ToolError } from "./util.ts";

export interface VideoSource {
  label: string;
  format: "mp4" | "webm" | "ogg" | "original";
  mime: string;
  width?: number;
  height?: number;
  url: string;
}

export interface CaptionTrack {
  lang: string;
  label: string;
  url: string;
}

export interface VideoRecord extends FileRecord {
  poster_url?: string;
  sources: VideoSource[];
  phone_friendly_url?: string;
  captions: CaptionTrack[];
  embed_url: string;
  embed_html: string;
}

function videoInfoParams(thumbWidth: number): Record<string, string> {
  return {
    prop: "videoinfo",
    viprop: "url|size|mime|extmetadata|derivatives|timedtext",
    viextmetadatafilter: EXTMETADATA_FIELDS,
    viextmetadatalanguage: "en",
    viurlwidth: String(thumbWidth),
  };
}

function formatOf(mime: string, key: string | null | undefined): VideoSource["format"] {
  const k = `${key ?? ""} ${mime}`;
  if (/mpeg4|mp4|quicktime/i.test(k)) return "mp4";
  if (/webm/i.test(k)) return "webm";
  if (/ogg|ogv/i.test(k)) return "ogg";
  return "original";
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function toVideoRecord(page: any): VideoRecord | null {
  const base = toFileRecord(page);
  const info = page?.videoinfo?.[0];
  if (!base || !info) return null;

  const sources: VideoSource[] = [];
  for (const d of info.derivatives ?? []) {
    const url = cleanMediaUrl(d.src);
    if (!url) continue;
    const mime = String(d.type ?? "").split(";")[0].trim();
    const format = formatOf(mime, d.transcodekey);
    const label = d.transcodekey ? String(d.transcodekey) : "original";
    sources.push({ label, format, mime, width: d.width, height: d.height, url });
  }
  if (!sources.some((s) => s.label === "original")) {
    const mime = base.mime ?? "";
    sources.push({ label: "original", format: formatOf(mime, null), mime, width: base.width, height: base.height, url: base.original_url });
  }
  const rank = (s: VideoSource) => (s.format === "mp4" ? 0 : s.format === "webm" ? 1 : s.format === "ogg" ? 2 : 3);
  sources.sort((a, b) => rank(a) - rank(b) || (a.height ?? 0) - (b.height ?? 0));

  const captions: CaptionTrack[] = (info.timedtext ?? [])
    .filter((t: any) => t?.src && t?.srclang)
    .map((t: any) => ({ lang: String(t.srclang), label: String(t.label ?? t.srclang).replace(/[‪-‮]/g, ""), url: String(t.src).replace(/&origin=[^&]*/, "") }));

  // MPEG-4 copies play in Safari and on iPhone; the smallest WebM is the fallback.
  const phone = sources.find((s) => s.format === "mp4") ?? sources.find((s) => s.format === "webm") ?? sources[0];
  const poster = base.thumb_url;
  const embedUrl = `${base.page_url}?embedplayer=yes`;
  const w = Math.min(base.width ?? 640, 640);
  const h = base.width && base.height ? Math.round((w * base.height) / base.width) : 360;
  const videoTags = [
    `<video controls preload="metadata" width="${w}"${poster ? ` poster="${esc(poster)}"` : ""}>`,
    ...sources.filter((s) => s.label !== "original" || sources.length === 1).map((s) => `  <source src="${esc(s.url)}" type="${esc(s.mime)}">`),
    ...captions.filter((c) => c.lang === "en").map((c) => `  <track kind="subtitles" srclang="en" label="English" src="${esc(c.url)}">`),
    `</video>`,
    `<p><small>${esc(base.attribution)}</small></p>`,
  ];

  return {
    ...base,
    poster_url: poster,
    sources,
    phone_friendly_url: phone?.url,
    captions,
    embed_url: embedUrl,
    embed_html: [
      `<iframe src="${esc(embedUrl)}" width="${w}" height="${h}" frameborder="0" allowfullscreen></iframe>`,
      `<!-- or, self-hosted player: -->`,
      ...videoTags,
    ].join("\n"),
  };
}

export async function searchVideos(deps: Deps, query: string, limit: unknown, maxDuration: unknown): Promise<VideoRecord[]> {
  const q = String(query ?? "").trim();
  if (!q) throw new ToolError("query is required");
  if (q.length > 300) throw new ToolError("query is too long (300 characters max)");
  const n = clampInt(limit, 1, 20, 5);
  const maxDur = typeof maxDuration === "number" && maxDuration > 0 ? maxDuration : Infinity;
  const data = await apiGet(deps, COMMONS_API, {
    action: "query",
    generator: "search",
    gsrsearch: `${q} filetype:video`,
    gsrnamespace: "6",
    gsrlimit: String(Math.min(50, n * 3)),
    ...videoInfoParams(640),
  });
  const pages: any[] = data?.query?.pages ?? [];
  pages.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  const out: VideoRecord[] = [];
  for (const p of pages) {
    const v = toVideoRecord(p);
    if (!v) continue;
    if ((v.duration_seconds ?? 0) > maxDur) continue;
    out.push(v);
    if (out.length >= n) break;
  }
  return out;
}

export async function getVideo(deps: Deps, input: string): Promise<VideoRecord> {
  const title = normalizeTitle(input);
  const data = await apiGet(deps, COMMONS_API, { action: "query", titles: title, ...videoInfoParams(640) });
  const page = data?.query?.pages?.[0];
  if (!page || page.missing) throw new ToolError(`No file named "${title}" on Wikimedia Commons`);
  const v = toVideoRecord(page);
  if (!v) throw new ToolError(`Could not read "${title}"`);
  if (!v.duration_seconds) throw new ToolError(`"${title}" is not a video. Use get_file_info for images.`);
  return v;
}

/** Fetch a caption track through the Commons API and return plain text (timings dropped). */
export async function getTranscript(deps: Deps, title: string, lang: string, maxChars = 12000): Promise<string> {
  if (!/^[a-z]{2,3}(-[a-z0-9]+)?$/i.test(lang)) throw new ToolError("Invalid language code");
  const vtt = await apiText(deps, COMMONS_API, { action: "timedtext", title, lang, trackformat: "vtt" });
  const lines = vtt
    .split(/\r?\n/)
    .filter((l) => l.trim() && !/^WEBVTT/.test(l) && !/-->/.test(l) && !/^\d+$/.test(l.trim()) && !/^(NOTE|STYLE)\b/.test(l));
  const text = decodeEntities(lines.join(" ").replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();
  return text.length > maxChars ? text.slice(0, maxChars) + "…" : text;
}

/** Thumbnail URL for a given second. Commons thumbnails accept a seek= prefix: 480px-seek=12.5-Name.webm.jpg */
export function seekThumbUrl(thumbUrl: string, seconds: number): string {
  const url = new URL(thumbUrl);
  const parts = url.pathname.split("/");
  const last = parts[parts.length - 1];
  // Work on the raw (already percent-encoded) segment so the file name keeps Commons' own encoding.
  const m = /^(\d+)px-(?:seek(?:=|%3D)[\d.]+)?-(.+)$/i.exec(last);
  if (!m) throw new ToolError("This video's preview cannot be seeked");
  parts[parts.length - 1] = `${m[1]}px-seek=${seconds}-${m[2]}`;
  url.pathname = parts.join("/");
  url.search = "";
  return url.toString();
}

export function frameTimes(duration: number, count: number, times?: number[]): number[] {
  // Commons ignores fractional seek values (it silently returns the default frame), so use whole seconds.
  const last = Math.max(0, Math.floor(duration - 0.3));
  const raw =
    times && times.length
      ? times.filter((t) => typeof t === "number" && Number.isFinite(t) && t >= 0)
      : // Evenly spaced, skipping the very first and last moments (often black or a title card).
        Array.from({ length: count }, (_, i) => (duration * (i + 1)) / (count + 1));
  return [...new Set(raw.map((t) => Math.min(Math.round(t), last)))].slice(0, 8);
}

export async function videoFrames(deps: Deps, input: string, count: unknown, times: unknown, width: unknown) {
  const title = normalizeTitle(input);
  const w = clampInt(width, 120, 800, 480);
  const data = await apiGet(deps, COMMONS_API, { action: "query", titles: title, ...videoInfoParams(w) });
  const page = data?.query?.pages?.[0];
  if (!page || page.missing) throw new ToolError(`No file named "${title}" on Wikimedia Commons`);
  const rec = toVideoRecord(page);
  if (!rec?.duration_seconds || !rec.thumb_url) throw new ToolError(`"${title}" is not a video with a preview`);

  const list = frameTimes(rec.duration_seconds, clampInt(count, 1, 8, 4), Array.isArray(times) ? (times as number[]) : undefined);
  const frames = await Promise.all(
    list.map(async (t) => {
      const res = await fetchUpload(deps, seekThumbUrl(rec.thumb_url!, t), 1_000_000);
      const mimeType = (res.headers.get("content-type") ?? "").split(";")[0].trim();
      if (!/^image\/(jpeg|png|webp)$/.test(mimeType)) throw new ToolError(`Frame at ${t}s came back as ${mimeType || "unknown type"}`);
      return { t, mimeType, data: toBase64(await res.arrayBuffer()) };
    }),
  );
  return { rec, frames };
}
