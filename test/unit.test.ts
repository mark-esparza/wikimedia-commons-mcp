import { test } from "node:test";
import assert from "node:assert/strict";
import { formatAttribution, normalizeTitle, toFileRecord } from "../src/commons.ts";
import { extractSvgLabels } from "../src/svg.ts";
import { stripHtml, decodeEntities, ToolError } from "../src/util.ts";
import { imagePage } from "./fixtures.ts";

test("stripHtml removes tags and decodes entities", () => {
  assert.equal(stripHtml('<p>A <b>bold</b> &amp; <i>x</i><br/>y &#39;z&#x27;</p>'), "A bold & x y 'z'");
  assert.equal(stripHtml(undefined), "");
  assert.equal(decodeEntities("&bogus; &#0;"), "&bogus; &#0;");
});

test("normalizeTitle accepts titles, page URLs and upload URLs", () => {
  assert.equal(normalizeTitle("Kayser-Fleischer_ring.jpg"), "File:Kayser-Fleischer ring.jpg");
  assert.equal(normalizeTitle("file:foo.png"), "File:Foo.png");
  assert.equal(normalizeTitle("Image:Bar.svg"), "File:Bar.svg");
  assert.equal(normalizeTitle("https://commons.wikimedia.org/wiki/File:Brachial_plexus_2.svg"), "File:Brachial plexus 2.svg");
  assert.equal(normalizeTitle("https://en.wikipedia.org/wiki/File:Caf%C3%A9.jpg"), "File:Café.jpg");
  assert.equal(normalizeTitle("https://commons.wikimedia.org/w/index.php?title=File:X_y.png&oldid=1"), "File:X y.png");
  assert.equal(normalizeTitle("https://upload.wikimedia.org/wikipedia/commons/a/ab/Some_file.jpg"), "File:Some file.jpg");
  assert.equal(normalizeTitle("https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Some_file.svg/800px-Some_file.svg.png"), "File:Some file.svg");
});

test("normalizeTitle rejects other hosts and bad input", () => {
  assert.throws(() => normalizeTitle("https://evil.example.com/wiki/File:X.jpg"), ToolError);
  assert.throws(() => normalizeTitle("http://169.254.169.254/latest"), ToolError);
  assert.throws(() => normalizeTitle(""), ToolError);
  assert.throws(() => normalizeTitle("A.jpg|File:B.jpg"), ToolError);
  assert.throws(() => normalizeTitle("https://commons.wikimedia.org/wiki/File:%E0%A4%A"), ToolError);
});

test("toFileRecord builds a clean record and TASL credit", () => {
  const rec = toFileRecord(imagePage("File:Kayser-Fleischer ring.jpg"))!;
  assert.equal(rec.author, "Dr. Example");
  assert.equal(rec.license, "CC BY-SA 4.0");
  assert.equal(rec.description, "A clinical photo & caption second line");
  assert.equal(rec.attribution_required, true);
  assert.equal(
    rec.attribution,
    '"Kayser-Fleischer ring" by Dr. Example, licensed under CC BY-SA 4.0 (https://creativecommons.org/licenses/by-sa/4.0), via Wikimedia Commons: https://commons.wikimedia.org/wiki/File:Kayser-Fleischer_ring.jpg',
  );
  assert.equal(toFileRecord({ title: "File:Nope.jpg", missing: true }), null);
});

test("public domain credit and AMA/HTML styles", () => {
  const pd = toFileRecord(imagePage("File:Old plate.jpg", { pd: true }))!;
  assert.match(pd.attribution, /^"Old plate" \(Public domain\), via Wikimedia Commons: /);
  const rec = toFileRecord(imagePage("File:A <b>.jpg", { artist: 'Smith & "Co"' }))!;
  const ama = formatAttribution(rec, "ama", new Date("2026-11-24T12:00:00Z"));
  assert.match(ama, /^Smith & "Co"\. A <b>\. Wikimedia Commons\. Accessed November 24, 2026\. https:\/\/commons/);
  const html = formatAttribution(rec, "html");
  assert.ok(html.includes("A &lt;b&gt;</a> by Smith &amp; &quot;Co&quot;"), html);
  assert.ok(!html.includes("<b>"));
});

test("extractSvgLabels finds text, tspans and flowed text", () => {
  const svg = `<svg><text x="1">Median nerve</text><text><tspan>Ulnar</tspan> <tspan>nerve</tspan></text>
    <text>Median nerve</text><flowRoot><flowPara>Radial &amp; axillary</flowPara></flowRoot><path d="M0"/></svg>`;
  const r = extractSvgLabels(svg);
  assert.deepEqual(r.labels, ["Median nerve", "Ulnar nerve", "Radial & axillary"]);
  assert.equal(r.multilingual, false);
});

test("extractSvgLabels keeps English in multilingual SVGs", () => {
  const svg = `<svg><switch>
    <text systemLanguage="de">Herz</text><text systemLanguage="en">Heart</text><text>Heart</text>
  </switch><switch><text><tspan systemLanguage="fr">Poumon</tspan><tspan systemLanguage="en-GB">Lung</tspan></text></switch></svg>`;
  const r = extractSvgLabels(svg);
  assert.deepEqual(r.labels, ["Heart", "Lung"]);
  assert.equal(r.multilingual, true);
  assert.deepEqual(r.languages, ["de", "en", "en-gb", "fr"]);
});

test("extractSvgLabels reports zero for outlined text", () => {
  assert.equal(extractSvgLabels("<svg><path d='M0 0L1 1'/></svg>").label_count, 0);
});
