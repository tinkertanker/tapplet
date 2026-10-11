import {
  belongsToAdminHostSite,
  createConfiguredModelProvider,
  handleAdminRequest,
} from "./admin";
import { createStudioApp } from "./app";
import { FAVICON_SVG, publicationErrorResponse } from "./brand";
import { CloudflareAssetStore } from "./assets";
import { createClassInference } from "./classInference";
import { readConfig, type StudioEnv } from "./env";
import type { ImageSafetyInspector } from "./imageSafety";
import { OpenCodeGoImageSafetyInspector } from "./imageSafety";
import {
  createTkslopperImageSafetyInspector,
  inferenceTransport,
} from "./ai/tkslopper";
import { CloudflareImageNormalizer } from "./imageNormalizer";
import { consoleOperationalTraceSink } from "./operationalTrace";
import { D1StudioRepository } from "./storage/d1Repository";
import { cleanupArtifactStorage, R2SourceStore } from "./sourceStore";
import { PUBLIC_REPORT_MARKER } from "./generation";
import { parse as parseHtml, type DefaultTreeAdapterTypes } from "parse5";

export default {
  async fetch(request: Request, env: StudioEnv): Promise<Response> {
    const url = new URL(request.url);
    const pathname = url.pathname;
    const adminResponse = await handleAdminRequest(request, env);
    if (adminResponse) return adminResponse;
    // A subrequest to the routed host reaches its custom domain (the site).
    if (belongsToAdminHostSite(request, env)) return fetch(request);
    if (!pathname.startsWith("/v1/") && pathname !== "/health") {
      if (
        pathname.length > 1 &&
        pathname.endsWith("/") &&
        pathname.split("/").filter(Boolean).length === 1
      ) {
        url.pathname = pathname.slice(0, -1);
        return Response.redirect(url.toString(), 308);
      }
      return servePublic(request, env);
    }

    const repository = new D1StudioRepository(env.DB);
    return createStudioApp({
      repository,
      provider: createConfiguredModelProvider(env),
      classInference: async (ownerHash) => {
        const key = await repository.getClassInferenceKey(ownerHash);
        return key ? createClassInference(env, key) : null;
      },
      config: readConfig(env),
      sources: new R2SourceStore(env.MEDIA),
      assets: new CloudflareAssetStore(
        env.DB,
        env.MEDIA,
        new CloudflareImageNormalizer(env.IMAGES),
        createImageSafetyInspector(env),
      ),
      traceSink: consoleOperationalTraceSink,
    }).fetch(request);
  },
  async scheduled(
    _controller: ScheduledController,
    env: StudioEnv,
  ): Promise<void> {
    const now = new Date();
    const repository = new D1StudioRepository(env.DB);
    const draftBefore = new Date(
      now.getTime() - 180 * 86_400_000,
    ).toISOString();
    const sourceStore = new R2SourceStore(env.MEDIA);
    const expired = await repository.deleteExpiredArtifacts(
      draftBefore,
      now.toISOString(),
      100,
    );
    for (const references of expired)
      await cleanupArtifactStorage(sourceStore, references);
    const before = new Date(now.getTime() - 7 * 86_400_000).toISOString();
    const assetStore = new CloudflareAssetStore(env.DB, env.MEDIA);
    await assetStore.cleanupOrphans(before, now.toISOString(), 100);
    const usageBefore = new Date(now.getTime() - 14 * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const reportsBefore = new Date(
      now.getTime() - 180 * 86_400_000,
    ).toISOString();
    await Promise.all([
      repository.purgeUsage(usageBefore),
      assetStore.cleanupUsage(usageBefore),
      repository.deleteContentReports(reportsBefore),
    ]);
  },
} satisfies ExportedHandler<StudioEnv>;

export function createImageSafetyInspector(
  env: StudioEnv,
): ImageSafetyInspector | undefined {
  const transport = inferenceTransport(env);
  // A misconfigured or unknown transport leaves review unavailable rather than
  // silently falling back to the direct provider.
  if (transport === "tkslopper") return createTkslopperImageSafetyInspector(env);
  if (transport !== "direct") return undefined;
  return env.OPENCODE_API_KEY
    ? new OpenCodeGoImageSafetyInspector({
        apiKey: env.OPENCODE_API_KEY,
        model: env.IMAGE_SAFETY_MODEL,
      })
    : undefined;
}

export function injectPublicHtml(source: string, slug: string): string {
  const report = `<script ${PUBLIC_REPORT_MARKER}>window.addEventListener('DOMContentLoaded',()=>{const b=document.createElement('button');b.textContent='Report this activity';b.setAttribute('aria-label','Report this activity');Object.assign(b.style,{position:'fixed',right:'12px',bottom:'12px',zIndex:'2147483647'});b.onclick=()=>{const reasons=['inappropriate','personal-data','copyright','accessibility','other'];const reason=prompt('Reason: inappropriate, personal-data, copyright, accessibility, or other','other');if(!reason||!reasons.includes(reason))return;fetch('/v1/publications/${slug}/reports',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({reason})}).then(response=>{if(!response.ok)throw new Error();b.textContent='Report sent'}).catch(()=>{b.textContent='Report failed — try again'})};document.body.append(b)})</script>`;
  const document = parseHtml(source, { sourceCodeLocationInfo: true });
  const root = document.childNodes.find(
    (node): node is DefaultTreeAdapterTypes.Element => "tagName" in node && node.tagName === "html",
  );
  const head = root?.childNodes.find(
    (node): node is DefaultTreeAdapterTypes.Element => "tagName" in node && node.tagName === "head",
  );
  const body = root?.childNodes.find(
    (node): node is DefaultTreeAdapterTypes.Element => "tagName" in node && node.tagName === "body",
  );
  const headEnd = head?.sourceCodeLocation?.startTag?.endOffset;
  if (headEnd === undefined || body?.sourceCodeLocation?.endTag === undefined)
    throw new Error("Stored tapplet source is not a complete HTML document.");
  const title = head?.childNodes.find(
    (node): node is DefaultTreeAdapterTypes.Element => "tagName" in node && node.tagName === "title",
  );
  const titleText = title?.childNodes
    .filter((node): node is DefaultTreeAdapterTypes.TextNode => node.nodeName === "#text")
    .map((node) => node.value).join("") || "Tapplet";
  const language = root?.attrs.find((attribute) => attribute.name === "lang")?.value || "en";
  const escape = (value: string) => value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const activity = `${source.slice(0, headEnd)}<base href="/${slug}/"><meta http-equiv="Content-Security-Policy" content="connect-src 'none'">${source.slice(headEnd)}`;
  // An opaque top-level sandbox can still navigate itself. Keep untrusted HTML
  // in srcdoc: the parent's frame-src 'none' blocks its document navigations,
  // while sandbox prevents it from navigating or accessing the trusted parent.
  return `<!doctype html><html lang="${escape(language)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(titleText)}</title><link rel="icon" href="/favicon.svg" type="image/svg+xml"><style>html,body{margin:0;width:100%;height:100%}iframe{display:block;width:100%;height:100%;border:0}</style></head><body><iframe title="Tapplet activity" sandbox="allow-scripts allow-modals" srcdoc="${escape(activity)}"></iframe>${report}</body></html>`;
}

async function servePublic(
  request: Request,
  env: StudioEnv,
): Promise<Response> {
  if (request.method !== "GET")
    return new Response("Not found.", { status: 404 });
  const pathname = new URL(request.url).pathname;
  if (pathname === "/favicon.svg" || pathname === "/favicon.ico")
    return new Response(FAVICON_SVG, {
      headers: {
        "content-type": "image/svg+xml",
        "cache-control": "public, max-age=86400",
        "x-content-type-options": "nosniff",
      },
    });
  const parts = pathname.split("/").filter(Boolean);
  const repository = new D1StudioRepository(env.DB);
  const publication = parts[0]
    ? await repository.getPublication(parts[0])
    : null;
  if (!publication)
    return publicationErrorResponse(
      404,
      "No tapplet lives here",
      "Check the link with your teacher — this address does not match a shared tapplet.",
    );
  if (publication.revokedAt)
    return publicationErrorResponse(
      410,
      "This tapplet was unpublished",
      "Your teacher has taken this tapplet down. Ask them for a fresh link if you still need it.",
    );
  if (Date.parse(publication.expiresAt) <= Date.now())
    return publicationErrorResponse(
      410,
      "This tapplet link expired",
      "Shared links only last a while. Ask your teacher to share the tapplet again.",
    );
  if (parts[1] === "assets" && parts[2]) {
    if (
      !(await repository.publicationReferencesAsset(publication.slug, parts[2]))
    )
      return new Response("Image not found.", { status: 404 });
    const asset = await new CloudflareAssetStore(env.DB, env.MEDIA).get(
      parts[2],
    );
    if (!asset) return new Response("Image not found.", { status: 404 });
    const headers = new Headers();
    asset.object.writeHttpMetadata(headers);
    headers.set("etag", asset.object.httpEtag);
    headers.set("cache-control", "public, max-age=31536000, immutable");
    headers.set("x-content-type-options", "nosniff");
    return new Response(asset.object.body, { headers });
  }
  if (parts.length !== 1) return new Response("Not found.", { status: 404 });
  const source = await new R2SourceStore(env.MEDIA).getSource(
    publication.sourceHash,
  );
  if (!source)
    return publicationErrorResponse(
      503,
      "This tapplet is taking a break",
      "Tapplet could not fetch it right now. Try again in a moment.",
    );
  const html = injectPublicHtml(source, publication.slug);
  const headers = new Headers({ "content-type": "text/html; charset=utf-8" });
  const playerOrigin = new URL(env.PUBLIC_PLAYER_ORIGIN).origin;
  headers.set(
    "content-security-policy",
    // srcdoc inherits this policy, but not same-origin privilege. Only the
    // trusted parent can submit reports; the activity adds connect-src 'none'.
    `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src ${playerOrigin} data:; connect-src ${playerOrigin}; base-uri ${playerOrigin}; form-action 'none'; frame-src 'none'; frame-ancestors 'none'; object-src 'none'`,
  );
  headers.set(
    "permissions-policy",
    "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  );
  headers.set("referrer-policy", "no-referrer");
  headers.set("x-content-type-options", "nosniff");
  headers.set("x-frame-options", "DENY");
  headers.set("cross-origin-opener-policy", "same-origin");
  headers.set("cross-origin-resource-policy", "same-origin");
  headers.set("x-robots-tag", "noindex, nofollow, noarchive");

  headers.set("cache-control", "no-cache, no-store, must-revalidate");
  return new Response(html, { headers });
}
