# wikimedia-commons-mcp

A remote [MCP](https://modelcontextprotocol.io) server that lets Claude (or any MCP client) search, view and credit freely licensed images and videos on [Wikimedia Commons](https://commons.wikimedia.org), with Wikidata lookups for drug structures and concept images.

It runs as a single Cloudflare Worker with no runtime dependencies and no login. It only reads public data.

> Unofficial project. Wikimedia Commons and Wikidata are trademarks of the Wikimedia Foundation. This project is not endorsed by or affiliated with the Wikimedia Foundation.

## Tools

| Tool | What it does |
| --- | --- |
| `search_images` | Search Commons. Filter by photo, diagram (SVG) or video, and optionally exclude share-alike licenses. Every result includes license, author and a ready attribution line. |
| `get_file_info` | Full details for one file from a title, file page URL or `upload.wikimedia.org` URL: sizes, URLs, description, categories, license. |
| `view_image` | Returns a thumbnail as an actual image so the model can check it shows what it should before using it. |
| `wikidata_image` | Name or Q-ID in, linked Commons images out. `prefer: "structure"` gives the chemical structure diagram (P117) for drugs; `"image"` gives the main image (P18). |
| `search_videos` | Search Commons videos. Returns duration, resolution, poster still, a phone-friendly playback URL, caption languages and credit. Can skip videos over a length limit. |
| `get_video` | Every playable copy of a video (MP4 for iPhone and Safari, WebM sizes, original), caption tracks, an embed iframe and a ready `<video>` tag with credit line. Optional plain-text transcript from the captions. |
| `view_video_frames` | Still frames from evenly spaced or chosen timestamps, returned as images so the model can see what the clip shows. |
| `find_labeled_svgs` | Finds SVG diagrams whose labels are real text, ranks them by label count and lists the labels. Good sources for image occlusion cards. |
| `attributions` | Credit lines for up to 50 files at once in TASL, AMA or HTML style. |

## Deploy to Cloudflare

You need a free Cloudflare account.

### Option A: from the dashboard (no local tools)

1. In the Cloudflare dashboard go to **Workers & Pages > Create > Import a repository**.
2. Connect GitHub and pick this repository.
3. Leave the build command empty. The deploy command is `npx wrangler deploy`.
4. Deploy. Your server will be at `https://wikimedia-commons-mcp.<your-subdomain>.workers.dev/mcp`.

Every push to `main` redeploys automatically.

### Option B: from your computer

```sh
npm install
npx wrangler login
npm run deploy
```

### Contact info

Wikimedia's [User-Agent policy](https://foundation.wikimedia.org/wiki/Policy:Wikimedia_Foundation_User-Agent_Policy) asks tools to identify themselves with a way to reach the operator. Set `CONTACT` in `wrangler.jsonc` (or as a variable in the dashboard) to a URL or an email you check.

## Add it to Claude

1. On claude.ai, open **Settings > Connectors** and choose **Add custom connector**.
2. Name it `Wikimedia Commons` and paste your Worker URL ending in `/mcp`.
3. In a chat, turn the connector on from the tools menu.

Once added on claude.ai it is also available in the Claude mobile and desktop apps.

Try: *"Find a Commons photo of a Kayser-Fleischer ring, check it with view_image, and give me the credit line."*

## Develop and test

Requires Node 22.18 or newer (tests run TypeScript directly).

```sh
npm test                 # unit and protocol tests with mocked Wikimedia responses
npm run typecheck
npm run dev              # local server at http://localhost:8787/mcp
npm run smoke -- https://<your-worker>.workers.dev/mcp   # live check after deploying
```

## How it works

- Transport: MCP Streamable HTTP, stateless. `POST /mcp` takes JSON-RPC and answers with JSON. `GET /mcp` returns 405 because the server never pushes messages.
- Commons: MediaWiki Action API (`generator=search` plus `prop=imageinfo` with `extmetadata` for license and author).
- Videos: `prop=videoinfo` with `derivatives` (transcoded copies) and `timedtext` (captions); stills come from Commons thumbnails with a `seek=` timestamp; transcripts from `action=timedtext`.
- Wikidata: `wbsearchentities` and `wbgetentities`, reading properties P117 and P18.
- Safety: media downloads are limited to `upload.wikimedia.org`, URL inputs are limited to Wikimedia hosts, sizes and counts are capped, and Wikimedia responses are cached at Cloudflare's edge for an hour to keep load low.

## Licensing

The code is MIT licensed. Media from Commons keeps its own license, which this server reports for every file. Most files require attribution, and share-alike licenses also require derivatives to use the same license.

## Ideas for later

- Label coordinates from SVGs, for automatic occlusion boxes
- Export straight to Anki through AnkiConnect
- Open-i and other open medical image sources alongside Commons
