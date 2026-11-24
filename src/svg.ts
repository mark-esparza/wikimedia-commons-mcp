// Finds real text labels inside an SVG, which is what makes a diagram usable for image occlusion.
// Labels that were converted to outlines (paths) cannot be detected and are reported as zero.

import { decodeEntities } from "./util.ts";

export interface SvgLabels {
  label_count: number;
  labels: string[];
  multilingual: boolean;
  languages: string[];
}

function textOf(inner: string): string {
  return decodeEntities(inner.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

function langOf(attrs: string): string | null {
  const m = /systemLanguage\s*=\s*["']([^"']*)["']/i.exec(attrs);
  return m ? m[1].trim().toLowerCase() : null;
}

export function extractSvgLabels(svg: string, maxLabels = 40): SvgLabels {
  const entries: { text: string; lang: string | null }[] = [];

  const textRe = /<text\b([^>]*)>([\s\S]*?)<\/text>/gi;
  for (let m; (m = textRe.exec(svg)); ) {
    const attrs = m[1];
    const inner = m[2];
    // Multilingual Commons SVGs put systemLanguage on <text> or on its <tspan>s.
    const tspanLangs = [...inner.matchAll(/<tspan\b([^>]*)>([\s\S]*?)<\/tspan>/gi)].filter((t) => langOf(t[1]) !== null);
    if (tspanLangs.length > 0) {
      for (const t of tspanLangs) entries.push({ text: textOf(t[2]), lang: langOf(t[1]) });
    } else {
      entries.push({ text: textOf(inner), lang: langOf(attrs) });
    }
  }
  // Inkscape flowed text.
  const flowRe = /<flowPara\b[^>]*>([\s\S]*?)<\/flowPara>/gi;
  for (let m; (m = flowRe.exec(svg)); ) entries.push({ text: textOf(m[1]), lang: null });

  const langs = new Set<string>();
  for (const e of entries) if (e.lang) for (const l of e.lang.split(",")) langs.add(l.trim());
  const multilingual = langs.size > 0;

  // For multilingual files keep English plus untagged fallbacks (usually English too).
  const kept = multilingual
    ? entries.filter((e) => e.lang === null || e.lang.split(",").some((l) => l.trim() === "en" || l.trim().startsWith("en-")))
    : entries;

  const seen = new Set<string>();
  const labels: string[] = [];
  for (const e of kept) {
    if (!e.text || e.text.length > 120) continue;
    const key = e.text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    labels.push(e.text);
  }

  return {
    label_count: labels.length,
    labels: labels.slice(0, maxLabels),
    multilingual,
    languages: [...langs].sort(),
  };
}
