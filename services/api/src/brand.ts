// The Pressed Applet brand mark for Tapplet-owned web surfaces (favicon and
// publication error pages). Geometry and colours follow docs/APP_ICON.md:
// the slightly rectangular coral tile with its dark-coral lip may tilt in
// any direction, and press ticks keep their fixed proportional sizes
// (22 stroke / 20 length per 250-wide face; here scaled 1.096).

const MARK_BODY = `<g transform="rotate(-9 256 269)"><rect x="132" y="191" width="248" height="187" rx="55" fill="#BD3A34"/><rect x="119" y="160" width="274" height="202" rx="59" fill="#F05D57"/><g stroke="#BD3A34" stroke-width="24" stroke-linecap="round" fill="none" opacity="0.45"><path d="M153 120.5 L137.4 104.9"/><path d="M256 116 L256 94"/><path d="M359 120.5 L374.6 104.9"/></g><g stroke="#BD3A34" stroke-width="24" stroke-linecap="round" fill="none" opacity="0.3"><path d="M153 410 L137.4 425.6"/><path d="M256 414 L256 436"/><path d="M359 410 L374.6 425.6"/></g></g>`;

export const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">${MARK_BODY}</svg>`;

export function renderPublicationErrorPage(
  title: string,
  message: string,
): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="icon" href="/favicon.svg" type="image/svg+xml"><title>${title} — Tapplet</title><style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#F8F6F1;color:#171718;font-family:system-ui,-apple-system,sans-serif;text-align:center}main{padding:32px;max-width:26rem}svg{width:96px;height:96px}h1{font-size:1.4rem;margin:20px 0 8px}p{margin:0;color:#6F6D67;line-height:1.5}</style></head><body><main><svg viewBox="0 0 512 512" role="img" aria-hidden="true">${MARK_BODY}</svg><h1>${title}</h1><p>${message}</p></main></body></html>`;
}

export function publicationErrorResponse(
  status: number,
  title: string,
  message: string,
): Response {
  return new Response(renderPublicationErrorPage(title, message), {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy":
        "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "cache-control": "no-store",
    },
  });
}
