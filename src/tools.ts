// MCP tool definitions and handlers.

import {
  type AttributionStyle,
  type Deps,
  type FileRecord,
  type MediaKind,
  fetchThumbnail,
  fetchUpload,
  formatAttribution,
  getFile,
  getFiles,
  normalizeTitle,
  searchFiles,
  wikidataImages,
} from "./commons.ts";
import { extractSvgLabels } from "./svg.ts";
import { clampInt, ToolError } from "./util.ts";

export interface ToolContent {
  type: "text" | "image";
  text?: string;
  data?: string;
  mimeType?: string;
}

export interface ToolResult {
  content: ToolContent[];
  isError?: boolean;
}

interface ToolDef {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: Record<string, unknown>;
  run: (deps: Deps, args: Record<string, any>) => Promise<ToolResult>;
}

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

function json(value: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

/** Trim a record to what a model needs for choosing among search results. */
function brief(rec: FileRecord) {
  return {
    title: rec.title,
    description: rec.description,
    mime: rec.mime,
    width: rec.width,
    height: rec.height,
    thumb_url: rec.thumb_url,
    page_url: rec.page_url,
    license: rec.license,
    author: rec.author,
    attribution: rec.attribution,
  };
}

const MEDIA_KINDS: MediaKind[] = ["image", "photo", "diagram", "video", "any"];

export const TOOLS: ToolDef[] = [
  {
    name: "search_images",
    title: "Search Wikimedia Commons",
    description:
      "Search Wikimedia Commons for freely licensed media. Returns titles, thumbnail URLs, license, author and a ready-made attribution line for each result. " +
      "Use plain descriptive queries (for example 'Kayser-Fleischer ring' or 'brachial plexus diagram'). " +
      "Use media='diagram' for SVG drawings and 'photo' for photographs.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to search for", maxLength: 300 },
        limit: { type: "integer", minimum: 1, maximum: 20, default: 5 },
        media: { type: "string", enum: MEDIA_KINDS, default: "image", description: "image = any still image; photo = bitmaps; diagram = SVG drawings; video; any" },
        allow_share_alike: { type: "boolean", default: true, description: "Set false to exclude CC BY-SA, GFDL and other share-alike licenses" },
        thumb_width: { type: "integer", minimum: 64, maximum: 2000, default: 800 },
      },
      required: ["query"],
      additionalProperties: false,
    },
    annotations: READ_ONLY,
    async run(deps, a) {
      const media = MEDIA_KINDS.includes(a.media) ? (a.media as MediaKind) : "image";
      const results = await searchFiles(deps, {
        query: a.query,
        limit: a.limit,
        media,
        allowShareAlike: a.allow_share_alike !== false,
        thumbWidth: a.thumb_width,
      });
      return json({ query: a.query, count: results.length, results: results.map(brief) });
    },
  },
  {
    name: "get_file_info",
    title: "Get Commons file details",
    description:
      "Full details for one Commons file: sizes, original and thumbnail URLs, description, author, license, categories and attribution. " +
      "Accepts 'File:Name.jpg', 'Name.jpg', a Commons or Wikipedia file page URL, or an upload.wikimedia.org URL.",
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string", description: "File title or URL" },
        thumb_width: { type: "integer", minimum: 64, maximum: 2000, default: 800 },
      },
      required: ["file"],
      additionalProperties: false,
    },
    annotations: READ_ONLY,
    async run(deps, a) {
      return json(await getFile(deps, a.file, clampInt(a.thumb_width, 64, 2000, 800), true));
    },
  },
  {
    name: "view_image",
    title: "View a Commons image",
    description:
      "Download a thumbnail of a Commons file and return it as an image so you can look at it. " +
      "Use this to confirm an image really shows what you need before presenting it (for example as a board question exhibit). SVGs and videos return a rendered still.",
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string", description: "File title or URL" },
        width: { type: "integer", minimum: 64, maximum: 1200, default: 600 },
      },
      required: ["file"],
      additionalProperties: false,
    },
    annotations: READ_ONLY,
    async run(deps, a) {
      const rec = await getFile(deps, a.file, clampInt(a.width, 64, 1200, 600), false);
      const img = await fetchThumbnail(deps, rec);
      return {
        content: [
          { type: "image", data: img.data, mimeType: img.mimeType },
          { type: "text", text: JSON.stringify({ title: rec.title, thumb_url: rec.thumb_url, page_url: rec.page_url, license: rec.license, attribution: rec.attribution }, null, 2) },
        ],
      };
    },
  },
  {
    name: "wikidata_image",
    title: "Image for a Wikidata concept",
    description:
      "Look up a concept on Wikidata (a drug, disease, organism, anatomical structure, person or place) and return its linked Commons images. " +
      "For drugs and chemicals prefer='structure' returns the chemical structure diagram (P117). prefer='image' returns the main image (P18). " +
      "Accepts a name like 'metoprolol' or a Wikidata Q-ID. A name search picks the first match that has an image; check entity.description and other_matches to make sure the right item was used.",
    inputSchema: {
      type: "object",
      properties: {
        entity: { type: "string", description: "Name or Wikidata Q-ID" },
        prefer: { type: "string", enum: ["auto", "structure", "image"], default: "auto" },
        thumb_width: { type: "integer", minimum: 64, maximum: 2000, default: 800 },
      },
      required: ["entity"],
      additionalProperties: false,
    },
    annotations: READ_ONLY,
    async run(deps, a) {
      const prefer = a.prefer === "structure" || a.prefer === "image" ? a.prefer : "auto";
      const r = await wikidataImages(deps, a.entity, prefer, clampInt(a.thumb_width, 64, 2000, 800));
      return json({ ...r, files: r.files.map((f) => ({ property: f.property, property_label: f.property_label, ...brief(f.file) })) });
    },
  },
  {
    name: "find_labeled_svgs",
    title: "Find labeled SVG diagrams",
    description:
      "Search Commons for SVG diagrams whose labels are real text (not outlines), ranked by how many labels they contain. Results can include translated versions of a diagram, so check the labels' language. " +
      "These are good sources for image occlusion flashcards because each label can be hidden and quizzed. Returns the labels found in each file.",
    inputSchema: {
      type: "object",
      properties: {
        topic: { type: "string", description: "Anatomy or concept, for example 'brachial plexus'", maxLength: 300 },
        limit: { type: "integer", minimum: 1, maximum: 10, default: 5 },
        min_labels: { type: "integer", minimum: 1, maximum: 100, default: 3 },
      },
      required: ["topic"],
      additionalProperties: false,
    },
    annotations: READ_ONLY,
    async run(deps, a) {
      const limit = clampInt(a.limit, 1, 10, 5);
      const minLabels = clampInt(a.min_labels, 1, 100, 3);
      const candidates = await searchFiles(deps, { query: a.topic, limit: Math.min(20, limit * 3), media: "any", thumbWidth: 800 }, " filemime:image/svg+xml");
      const svgs = candidates.filter((c) => c.mime === "image/svg+xml" && (c.size_bytes ?? 0) <= 3_000_000);

      const scored: any[] = [];
      const skipped: string[] = [];
      // Small concurrency to stay polite to upload.wikimedia.org.
      for (let i = 0; i < svgs.length; i += 4) {
        const batch = svgs.slice(i, i + 4);
        const results = await Promise.all(
          batch.map(async (rec) => {
            try {
              const res = await fetchUpload(deps, rec.original_url, 3_000_000);
              const labels = extractSvgLabels(await res.text());
              return { rec, labels };
            } catch {
              skipped.push(rec.title);
              return null;
            }
          }),
        );
        for (const r of results) {
          if (!r || r.labels.label_count < minLabels) continue;
          scored.push({ ...brief(r.rec), png_preview_url: r.rec.thumb_url, ...r.labels });
        }
      }
      scored.sort((x, y) => y.label_count - x.label_count);
      return json({ topic: a.topic, count: Math.min(limit, scored.length), results: scored.slice(0, limit), skipped: skipped.length ? skipped : undefined });
    },
  },
  {
    name: "attributions",
    title: "Credit lines for Commons files",
    description:
      "Build credit lines for up to 50 Commons files at once, for slides, posters, manuscripts or web pages. " +
      "style='tasl' gives Title, Author, Source, License (the Creative Commons recommended form); 'ama' gives an AMA-style figure credit; 'html' gives linked HTML.",
    inputSchema: {
      type: "object",
      properties: {
        files: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 50, description: "File titles or URLs" },
        style: { type: "string", enum: ["tasl", "ama", "html"], default: "tasl" },
      },
      required: ["files"],
      additionalProperties: false,
    },
    annotations: READ_ONLY,
    async run(deps, a) {
      if (!Array.isArray(a.files) || a.files.length === 0) throw new ToolError("files must be a non-empty list");
      if (a.files.length > 50) throw new ToolError("At most 50 files per request");
      const style: AttributionStyle = a.style === "ama" || a.style === "html" ? a.style : "tasl";
      const invalid: { input: string; error: string }[] = [];
      const titles: string[] = [];
      for (const f of a.files) {
        try {
          titles.push(normalizeTitle(String(f)));
        } catch (e) {
          invalid.push({ input: String(f), error: (e as Error).message });
        }
      }
      const { found, missing } = await getFiles(deps, [...new Set(titles)], 320);
      return json({
        style,
        credits: found.map((r) => ({ title: r.title, license: r.license, credit: formatAttribution(r, style) })),
        not_found: missing.length ? missing : undefined,
        invalid: invalid.length ? invalid : undefined,
      });
    },
  },
];

export function listTools() {
  return TOOLS.map(({ run, ...def }) => def);
}

export async function callTool(deps: Deps, name: string, args: Record<string, any>): Promise<ToolResult | null> {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return null;
  try {
    return await tool.run(deps, args ?? {});
  } catch (e) {
    if (!(e instanceof ToolError)) console.error(`Tool ${name} failed`, e);
    const message = e instanceof ToolError ? e.message : "Unexpected error while contacting Wikimedia. Try again shortly.";
    return { content: [{ type: "text", text: message }], isError: true };
  }
}
