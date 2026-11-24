// Client for the Wikimedia Commons and Wikidata APIs.
// Docs: https://commons.wikimedia.org/w/api.php and https://www.wikidata.org/w/api.php

import { clampInt, stripHtml, toBase64, ToolError, truncate } from "./util.ts";

export const COMMONS_API = "https://commons.wikimedia.org/w/api.php";
export const WIKIDATA_API = "https://www.wikidata.org/w/api.php";
// Commons serves originals from upload.wikimedia.org and some thumbnails from thumb.wikimedia.org.
const MEDIA_HOSTS = new Set(["upload.wikimedia.org", "thumb.wikimedia.org"]);

/** Drop the utm_* tracking parameters Commons now appends to media URLs. */
export function cleanMediaUrl(u: string | undefined): string | undefined {
  if (!u) return u;
  try {
    const url = new URL(u);
    for (const k of [...url.searchParams.keys()]) if (k.startsWith("utm_")) url.searchParams.delete(k);
    return url.toString();
  } catch {
    return u;
  }
}

export interface Deps {
  fetch: typeof fetch;
  userAgent: string;
}

export interface FileRecord {
  title: string;
  name: string;
  page_url: string;
  original_url: string;
  thumb_url?: string;
  thumb_width?: number;
  thumb_height?: number;
  width?: number;
  height?: number;
  mime?: string;
  size_bytes?: number;
  duration_seconds?: number;
  description?: string;
  author: string;
  license: string;
  license_url?: string;
  attribution_required: boolean;
  restrictions?: string;
  attribution: string;
  categories?: string[];
}

export const EXTMETADATA_FIELDS = [
  "ObjectName",
  "ImageDescription",
  "Artist",
  "Credit",
  "LicenseShortName",
  "LicenseUrl",
  "UsageTerms",
  "AttributionRequired",
  "Restrictions",
].join("|");

// ---------- HTTP ----------

function headers(deps: Deps): Record<string, string> {
  // Wikimedia's User-Agent policy asks every tool to identify itself with contact info.
  return { "User-Agent": deps.userAgent, "Api-User-Agent": deps.userAgent, Accept: "application/json" };
}

export async function apiGet(deps: Deps, base: string, params: Record<string, string>): Promise<any> {
  return (await apiRequest(deps, base, params, "json")) as any;
}

export async function apiText(deps: Deps, base: string, params: Record<string, string>): Promise<string> {
  return (await apiRequest(deps, base, params, "text")) as string;
}

async function apiRequest(deps: Deps, base: string, params: Record<string, string>, as: "json" | "text"): Promise<unknown> {
  const url = new URL(base);
  const all: Record<string, string> = as === "json" ? { format: "json", formatversion: "2", ...params } : { ...params };
  for (const [k, v] of Object.entries(all)) url.searchParams.set(k, v);
  const init = { headers: headers(deps), cf: { cacheTtl: 3600, cacheEverything: true } } as RequestInit;
  const res = await deps.fetch(url.toString(), init);
  if (!res.ok) throw new ToolError(`Wikimedia API returned HTTP ${res.status}`);
  if (as === "text") return await res.text();
  const data: any = await res.json();
  if (data && data.error) {
    throw new ToolError(`Wikimedia API error: ${data.error.code ?? "unknown"}: ${data.error.info ?? ""}`.trim());
  }
  return data;
}

/** Fetch media only from Wikimedia media hosts. Never fetch arbitrary hosts. */
export async function fetchUpload(deps: Deps, url: string, maxBytes: number): Promise<Response> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ToolError("Invalid media URL");
  }
  if (parsed.protocol !== "https:" || !MEDIA_HOSTS.has(parsed.hostname)) {
    throw new ToolError("Refusing to fetch media outside Wikimedia media hosts");
  }
  const init = { headers: { "User-Agent": deps.userAgent }, cf: { cacheTtl: 86400, cacheEverything: true } } as RequestInit;
  const res = await deps.fetch(parsed.toString(), init);
  if (!res.ok) throw new ToolError(`Media fetch returned HTTP ${res.status}`);
  const len = Number(res.headers.get("content-length") ?? "0");
  if (len > maxBytes) throw new ToolError(`Media is ${len} bytes, over the ${maxBytes} byte limit`);
  return res;
}

// ---------- Titles ----------

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    throw new ToolError("Malformed URL encoding");
  }
}

const ALLOWED_PAGE_HOSTS = /^(commons\.wikimedia\.org|commons\.m\.wikimedia\.org|[a-z-]+\.(m\.)?wikipedia\.org)$/i;

/**
 * Accepts "File:X.jpg", "X.jpg", a Commons/Wikipedia file page URL, or an upload.wikimedia.org URL
 * (original or thumbnail) and returns the canonical "File:X.jpg" title.
 */
export function normalizeTitle(input: string): string {
  const raw = String(input ?? "").trim();
  if (!raw) throw new ToolError("A file title or URL is required");
  let name = raw;

  if (/^https?:\/\//i.test(raw)) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new ToolError("Invalid URL");
    }
    if (MEDIA_HOSTS.has(url.hostname)) {
      // /wikipedia/commons/a/ab/Name.jpg  or  /wikipedia/commons/thumb/a/ab/Name.jpg/800px-Name.jpg
      const parts = url.pathname.split("/").filter(Boolean);
      const thumbAt = parts.indexOf("thumb");
      const seg = parts[thumbAt >= 0 ? thumbAt + 3 : 4];
      if (!seg) throw new ToolError("Unrecognized upload.wikimedia.org URL");
      name = safeDecode(seg);
    } else if (ALLOWED_PAGE_HOSTS.test(url.hostname)) {
      const titleParam = url.searchParams.get("title");
      if (titleParam) name = titleParam;
      else if (url.pathname.startsWith("/wiki/")) name = safeDecode(url.pathname.slice("/wiki/".length));
      else throw new ToolError("Could not find a file title in that URL");
    } else {
      throw new ToolError("Only Wikimedia Commons, Wikipedia, and upload.wikimedia.org URLs are supported");
    }
  }

  name = name.replace(/_/g, " ").trim();
  const prefix = /^(file|image|datei|fichier|archivo):\s*/i;
  name = name.replace(prefix, "");
  if (!name || name.includes("|") || name.length > 255) throw new ToolError("Invalid file title");
  return "File:" + name.charAt(0).toUpperCase() + name.slice(1);
}

// ---------- Records and attribution ----------

function meta(em: any, key: string): string {
  return stripHtml(em?.[key]?.value);
}

export function toFileRecord(page: any): FileRecord | null {
  // videoinfo (TimedMediaHandler) is a superset of imageinfo used for audio and video files.
  const info = page?.imageinfo?.[0] ?? page?.videoinfo?.[0];
  if (!info || page.missing) return null;
  const em = info.extmetadata ?? {};
  const title: string = page.title;
  const name = title.replace(/^File:/, "");
  const author = meta(em, "Artist") || meta(em, "Credit") || "Unknown author";
  const license = meta(em, "LicenseShortName") || meta(em, "UsageTerms") || "See file page";
  const licenseUrl = meta(em, "LicenseUrl") || undefined;
  const attributionRequired = meta(em, "AttributionRequired").toLowerCase() !== "false";
  const pageUrl: string = info.descriptionurl ?? `https://commons.wikimedia.org/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`;
  const description = meta(em, "ImageDescription");
  const restrictions = meta(em, "Restrictions");

  const rec: FileRecord = {
    title,
    name,
    page_url: pageUrl,
    original_url: cleanMediaUrl(info.url) as string,
    thumb_url: cleanMediaUrl(info.thumburl),
    thumb_width: info.thumbwidth,
    thumb_height: info.thumbheight,
    width: info.width,
    height: info.height,
    mime: info.mime,
    size_bytes: info.size,
    duration_seconds: typeof info.duration === "number" ? Math.round(info.duration * 10) / 10 : undefined,
    description: description ? truncate(description, 400) : undefined,
    author: truncate(author, 200),
    license,
    license_url: licenseUrl,
    attribution_required: attributionRequired,
    restrictions: restrictions || undefined,
    attribution: "",
  };
  rec.attribution = formatAttribution(rec, "tasl");
  if (Array.isArray(page.categories)) {
    rec.categories = page.categories.map((c: any) => String(c.title).replace(/^Category:/, ""));
  }
  return rec;
}

export type AttributionStyle = "tasl" | "ama" | "html";

function displayName(rec: FileRecord): string {
  return rec.name.replace(/\.[a-z0-9]+$/i, "");
}

function isPublicDomain(rec: FileRecord): boolean {
  return /public domain|^pd\b|cc0/i.test(rec.license);
}

export function formatAttribution(rec: FileRecord, style: AttributionStyle, now: Date = new Date()): string {
  const name = displayName(rec);
  const lic = rec.license_url ? `${rec.license} (${rec.license_url})` : rec.license;
  if (style === "ama") {
    const accessed = now.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
    return `${rec.author}. ${name}. Wikimedia Commons. Accessed ${accessed}. ${rec.page_url}. License: ${rec.license}.`;
  }
  if (style === "html") {
    const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    const licHtml = rec.license_url ? `<a href="${esc(rec.license_url)}">${esc(rec.license)}</a>` : esc(rec.license);
    return `<a href="${esc(rec.page_url)}">${esc(name)}</a> by ${esc(rec.author)}, ${licHtml}, via Wikimedia Commons`;
  }
  if (isPublicDomain(rec) && !rec.attribution_required) {
    return `"${name}" (${rec.license}), via Wikimedia Commons: ${rec.page_url}`;
  }
  return `"${name}" by ${rec.author}, licensed under ${lic}, via Wikimedia Commons: ${rec.page_url}`;
}

function isShareAlike(license: string): boolean {
  return /\bSA\b|share.?alike|GFDL|GPL/i.test(license);
}

// ---------- Operations ----------

function imageInfoParams(thumbWidth: number): Record<string, string> {
  return {
    prop: "imageinfo",
    iiprop: "url|size|mime|extmetadata",
    iiextmetadatafilter: EXTMETADATA_FIELDS,
    iiextmetadatalanguage: "en",
    iiurlwidth: String(thumbWidth),
  };
}

export type MediaKind = "image" | "photo" | "diagram" | "video" | "any";

export interface SearchOptions {
  query: string;
  limit?: number;
  media?: MediaKind;
  allowShareAlike?: boolean;
  thumbWidth?: number;
}

export async function searchFiles(deps: Deps, opts: SearchOptions, extraQuery = ""): Promise<FileRecord[]> {
  const query = String(opts.query ?? "").trim();
  if (!query) throw new ToolError("query is required");
  if (query.length > 300) throw new ToolError("query is too long (300 characters max)");
  const limit = clampInt(opts.limit, 1, 20, 5);
  const media: MediaKind = opts.media ?? "image";
  const thumbWidth = clampInt(opts.thumbWidth, 64, 2000, 800);
  const filter = media === "photo" ? " filetype:bitmap" : media === "diagram" ? " filetype:drawing" : media === "video" ? " filetype:video" : "";
  const overfetch = Math.min(50, limit * 3);

  const data = await apiGet(deps, COMMONS_API, {
    action: "query",
    generator: "search",
    gsrsearch: query + filter + extraQuery,
    gsrnamespace: "6",
    gsrlimit: String(overfetch),
    ...imageInfoParams(thumbWidth),
  });

  const pages: any[] = data?.query?.pages ?? [];
  pages.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  const out: FileRecord[] = [];
  for (const p of pages) {
    const rec = toFileRecord(p);
    if (!rec) continue;
    const mime = rec.mime ?? "";
    if (media === "image" && !mime.startsWith("image/")) continue;
    if (media === "video" && !mime.startsWith("video/") && !mime.includes("ogg") && !mime.includes("webm")) continue;
    if (opts.allowShareAlike === false && isShareAlike(rec.license)) continue;
    out.push(rec);
    if (out.length >= limit) break;
  }
  return out;
}

export async function getFiles(deps: Deps, titles: string[], thumbWidth = 800, withCategories = false): Promise<{ found: FileRecord[]; missing: string[] }> {
  if (titles.length === 0) return { found: [], missing: [] };
  if (titles.length > 50) throw new ToolError("At most 50 files per request");
  const params: Record<string, string> = {
    action: "query",
    titles: titles.join("|"),
    ...imageInfoParams(clampInt(thumbWidth, 64, 2000, 800)),
  };
  if (withCategories) {
    params.prop += "|categories";
    params.clshow = "!hidden";
    params.cllimit = "max";
  }
  const data = await apiGet(deps, COMMONS_API, params);
  const pages: any[] = data?.query?.pages ?? [];
  // Map normalized titles back so results keep the caller's order.
  const norm = new Map<string, string>();
  for (const n of data?.query?.normalized ?? []) norm.set(n.from, n.to);
  const byTitle = new Map<string, any>();
  for (const p of pages) byTitle.set(p.title, p);
  const found: FileRecord[] = [];
  const missing: string[] = [];
  for (const t of titles) {
    const page = byTitle.get(norm.get(t) ?? t);
    const rec = page ? toFileRecord(page) : null;
    if (rec) found.push(rec);
    else missing.push(t);
  }
  return { found, missing };
}

export async function getFile(deps: Deps, input: string, thumbWidth = 800, withCategories = true): Promise<FileRecord> {
  const title = normalizeTitle(input);
  const { found } = await getFiles(deps, [title], thumbWidth, withCategories);
  if (!found[0]) throw new ToolError(`No file named "${title}" on Wikimedia Commons`);
  return found[0];
}

export async function fetchThumbnail(deps: Deps, rec: FileRecord): Promise<{ data: string; mimeType: string; bytes: number }> {
  const url = rec.thumb_url ?? rec.original_url;
  const res = await fetchUpload(deps, url, 1_500_000);
  const mimeType = (res.headers.get("content-type") ?? "").split(";")[0].trim();
  if (!/^image\/(png|jpeg|gif|webp)$/.test(mimeType)) {
    throw new ToolError(`Preview is ${mimeType || "an unknown type"}, not a viewable image`);
  }
  const buf = await res.arrayBuffer();
  if (buf.byteLength > 1_500_000) throw new ToolError("Preview image is too large; try a smaller width");
  return { data: toBase64(buf), mimeType, bytes: buf.byteLength };
}

// ---------- Wikidata ----------

export const WIKIDATA_PROPS = {
  structure: { id: "P117", label: "chemical structure" },
  image: { id: "P18", label: "image" },
} as const;

export interface WikidataResult {
  entity: { id: string; label?: string; description?: string; url: string };
  other_matches: { id: string; label?: string; description?: string }[];
  files: { property: string; property_label: string; file: FileRecord }[];
  note?: string;
}

export async function wikidataImages(deps: Deps, entity: string, prefer: "auto" | "structure" | "image", thumbWidth = 800): Promise<WikidataResult> {
  const q = String(entity ?? "").trim();
  if (!q) throw new ToolError("entity is required");
  if (q.length > 200) throw new ToolError("entity is too long");

  const order = prefer === "structure" ? ["structure"] : prefer === "image" ? ["image"] : ["structure", "image"];

  let ids: string[];
  let hits: any[] = [];
  if (/^Q\d+$/i.test(q)) {
    ids = [q.toUpperCase()];
  } else {
    const s = await apiGet(deps, WIKIDATA_API, { action: "wbsearchentities", search: q, language: "en", uselang: "en", type: "item", limit: "5" });
    hits = s?.search ?? [];
    if (hits.length === 0) throw new ToolError(`No Wikidata item matches "${q}"`);
    ids = hits.map((h) => String(h.id));
  }

  const e = await apiGet(deps, WIKIDATA_API, { action: "wbgetentities", ids: ids.join("|"), props: "claims|labels|descriptions", languages: "en" });
  const wantedFor = (item: any) => {
    const wanted: { property: string; property_label: string; title: string }[] = [];
    for (const key of order) {
      const prop = WIKIDATA_PROPS[key as keyof typeof WIKIDATA_PROPS];
      const claims: any[] = item?.claims?.[prop.id] ?? [];
      // Prefer claims ranked "preferred", then "normal"; skip "deprecated".
      const ranked = claims
        .filter((c) => c.rank !== "deprecated")
        .sort((a, b) => (a.rank === "preferred" ? -1 : 0) - (b.rank === "preferred" ? -1 : 0));
      for (const c of ranked.slice(0, 3)) {
        const v = c?.mainsnak?.datavalue?.value;
        if (typeof v === "string") wanted.push({ property: prop.id, property_label: prop.label, title: "File:" + v });
      }
    }
    return wanted;
  };

  // Search often returns duplicate or minor items first; take the first match (in search order) that has an image.
  const present = ids.filter((i) => e?.entities?.[i] && e.entities[i].missing === undefined);
  if (present.length === 0) throw new ToolError(`Wikidata item ${ids[0]} not found`);
  const id = present.find((i) => wantedFor(e.entities[i]).length > 0) ?? present[0];
  const item = e.entities[id];
  const wanted = wantedFor(item);
  const others: WikidataResult["other_matches"] = hits
    .filter((h) => h.id !== id)
    .map((h) => ({ id: h.id, label: h.label, description: h.description }));

  const { found } = await getFiles(deps, [...new Set(wanted.map((w) => w.title))], thumbWidth);
  const byTitle = new Map(found.map((f) => [f.title, f]));
  const files = wanted
    .map((w) => ({ property: w.property, property_label: w.property_label, file: byTitle.get(w.title.replace(/_/g, " ")) }))
    .filter((x): x is { property: string; property_label: string; file: FileRecord } => Boolean(x.file));

  const result: WikidataResult = {
    entity: {
      id,
      label: item.labels?.en?.value,
      description: item.descriptions?.en?.value,
      url: `https://www.wikidata.org/wiki/${id}`,
    },
    other_matches: others,
    files,
  };
  if (files.length === 0) result.note = "This item has no linked image on Wikidata. Try search_images instead.";
  return result;
}
