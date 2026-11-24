// Mock Wikimedia responses shaped like the real API (formatversion=2).

export function imagePage(title: string, opts: { index?: number; mime?: string; license?: string; artist?: string; pd?: boolean; size?: number; missing?: boolean } = {}) {
  if (opts.missing) return { ns: 6, title, missing: true };
  const name = title.replace(/^File:/, "").replace(/ /g, "_");
  const mime = opts.mime ?? "image/jpeg";
  return {
    pageid: 1000 + (opts.index ?? 0),
    ns: 6,
    title,
    index: opts.index,
    imageinfo: [
      {
        size: opts.size ?? 123456,
        width: 1200,
        height: 900,
        mime,
        url: `https://upload.wikimedia.org/wikipedia/commons/a/ab/${name}`,
        descriptionurl: `https://commons.wikimedia.org/wiki/File:${encodeURIComponent(name)}`,
        thumburl: `https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/${name}/800px-${name}${mime === "image/svg+xml" ? ".png" : ""}`,
        thumbwidth: 800,
        thumbheight: 600,
        extmetadata: {
          ObjectName: { value: title.replace(/^File:/, "").replace(/\.[a-z]+$/i, "") },
          ImageDescription: { value: '<p>A <b>clinical</b> photo &amp; caption<br/>second line</p>' },
          Artist: { value: opts.artist ?? '<a href="//commons.wikimedia.org/wiki/User:Example">Dr. Example</a>' },
          LicenseShortName: { value: opts.pd ? "Public domain" : opts.license ?? "CC BY-SA 4.0" },
          LicenseUrl: opts.pd ? undefined : { value: "https://creativecommons.org/licenses/by-sa/4.0" },
          AttributionRequired: { value: opts.pd ? "false" : "true" },
        },
      },
    ],
  };
}

type Route = (url: URL) => { status?: number; body: unknown; headers?: Record<string, string> } | undefined;

export function mockFetch(routes: Route[]) {
  const calls: { url: URL; headers: Record<string, string> }[] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    for (const r of routes) {
      const hit = r(url);
      if (hit) {
        const body = hit.body instanceof Uint8Array || typeof hit.body === "string" ? hit.body : JSON.stringify(hit.body);
        return new Response(body as BodyInit, { status: hit.status ?? 200, headers: hit.headers ?? { "content-type": "application/json" } });
      }
    }
    return new Response("not mocked: " + url, { status: 599 });
  }) as typeof fetch;
  return { fetch: fn, calls };
}
