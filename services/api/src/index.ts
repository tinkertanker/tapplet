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
  // The report control lives in its own bar below the activity, so it never
  // covers an answer, and offers plain-language choices instead of code words.
  const reasons = [
    ["inappropriate", "It is unkind, scary or not right for school"],
    ["personal-data", "It shows someone's private information"],
    ["copyright", "It copies someone else's work"],
    ["accessibility", "I cannot see, hear or use it"],
    ["other", "Something else is wrong"],
  ]
    .map(([value, label]) => `<label><input type="radio" name="reason" value="${value}"> ${label}</label>`)
    .join("");
  const report = `<footer class="report-bar"><button type="button" id="report-open" aria-haspopup="dialog">Report this activity</button></footer><dialog id="report-dialog" aria-labelledby="report-title"><form method="dialog" id="report-form"><h2 id="report-title">Report this activity</h2><p>Tell the Tapplet team about a problem. Your name is not sent.</p><fieldset><legend>What is wrong?</legend>${reasons}</fieldset><p id="report-status" role="status"></p><div class="report-actions"><button type="button" id="report-cancel">Cancel</button><button type="submit" id="report-send" disabled>Send report</button></div></form></dialog><script ${PUBLIC_REPORT_MARKER}>(()=>{const o=document.getElementById('report-open'),d=document.getElementById('report-dialog'),f=document.getElementById('report-form'),s=document.getElementById('report-send'),c=document.getElementById('report-cancel'),t=document.getElementById('report-status'),choices=()=>f.querySelectorAll('input');let sent=false,busy=false,gone=false;const update=()=>{s.disabled=sent||busy||gone||!f.reason.value};o.onclick=()=>{if(!sent&&!busy&&!gone){t.textContent='';f.reset();update()}d.showModal()};c.onclick=()=>d.close();f.onchange=update;f.onsubmit=e=>{e.preventDefault();const reason=f.reason.value;if(!reason||sent||busy||gone)return;busy=true;update();t.textContent='Sending…';const a=new AbortController(),timer=setTimeout(()=>a.abort(),20000);fetch('/v1/publications/${slug}/reports',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({reason}),signal:a.signal}).then(r=>{if(r.ok){sent=true;choices().forEach(i=>i.disabled=true);t.textContent='Thank you. Your report was sent to the Tapplet team.';c.textContent='Close';o.textContent='Report sent';return}if(r.status===404||r.status===410){gone=true;choices().forEach(i=>i.disabled=true)}t.textContent=r.status===429?'Too many reports were sent from this network today. Please tell your teacher instead.':gone?'This activity is no longer shared, so it cannot be reported here. Please tell your teacher.':'The report was not sent. Please try again.'}).catch(()=>{t.textContent='The report was not sent. Check your internet connection and try again.'}).finally(()=>{clearTimeout(timer);busy=false;update()})}})()</script>`;
  const document = parseHtml(source, { sourceCodeLocationInfo: true });
  const root = document.childNodes.find(
    (node): node is DefaultTreeAdapterTypes.Element => "tagName" in node && node.tagName === "html",
  );
  const head = root?.childNodes.find(
    (node): node is DefaultTreeAdapterTypes.Element => "tagName" in node && node.tagName === "head",
  );
  const doctype = document.childNodes.find((node) => node.nodeName === "#documentType");
  // Content such as <style> before <head>, or <div> inside it, starts the
  // head or body without the written tag, which then has no location. The
  // base and policy still belong at the start of the head, which begins after
  // the html start tag or the doctype. Validation accepts a byte order mark or
  // other non-HTML white space before the doctype, which then starts the
  // document implicitly; inserted first, the base and policy still lead the
  // head.
  const headEnd =
    head?.sourceCodeLocation?.startTag?.endOffset ??
    root?.sourceCodeLocation?.startTag?.endOffset ??
    doctype?.sourceCodeLocation?.endOffset ??
    0;
  const title = head?.childNodes.find(
    (node): node is DefaultTreeAdapterTypes.Element => "tagName" in node && node.tagName === "title",
  );
  const titleText = title?.childNodes
    .filter((node): node is DefaultTreeAdapterTypes.TextNode => node.nodeName === "#text")
    .map((node) => node.value).join("") || "Tapplet";
  const language = root?.attrs.find((attribute) => attribute.name === "lang")?.value || "en";
  const escape = (value: string) => value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  // srcdoc resolves a fragment link such as href="#end" or "#/route" against
  // the base, not about:srcdoc, so following it would replace the activity
  // with a blocked page. Keep such links inside the document, as in Studio.
  // Like validation, read an SVG xlink:href and ignore surrounding white space.
  // The click path, unlike closest(), reaches a link inside an open shadow root.
  // Setting the hash the address already names does nothing, so scroll to
  // the target as a browser would: the element, else the top for "#top".
  // A handler such as a dialog's can stop the click before it reaches the
  // window, so a listener added last on each node of the path decides once
  // the click stops or reaches the window, after the tapplet could cancel it.
  const fragmentLinks = `<script>addEventListener("click",e=>{const p=e.composedPath(),a=p.find(n=>n instanceof Element&&n.matches("a[*|href],area[href]")),h=a?(a.getAttribute("href")??a.getAttributeNS("http://www.w3.org/1999/xlink","href")??"").trim():"";if(h[0]!=="#")return;const r=()=>p.forEach(n=>n.removeEventListener("click",k)),k=v=>{if(v!==e||!e.cancelBubble&&v.currentTarget!==window)return;r();if(e.defaultPrevented)return;e.preventDefault();const f=h.slice(1),o=location.hash;location.hash=f;if(location.hash!==o)return;let t=document.getElementById(f);try{t??=document.getElementById(decodeURIComponent(f))}catch{}t?t.scrollIntoView():/^(top)?$/i.test(f)&&scrollTo(0,0)};p.forEach(n=>n.addEventListener("click",k));setTimeout(r)},true)</script>`;
  const activity = `${source.slice(0, headEnd)}<base href="/${slug}/"><meta http-equiv="Content-Security-Policy" content="connect-src 'none'">${fragmentLinks}${source.slice(headEnd)}`;
  // An opaque top-level sandbox can still navigate itself. Keep untrusted HTML
  // in srcdoc: the parent's frame-src 'none' blocks its document navigations,
  // while sandbox prevents it from navigating or accessing the trusted parent.
  return `<!doctype html><html lang="${escape(language)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(titleText)}</title><link rel="icon" href="/favicon.svg" type="image/svg+xml"><style>html,body{margin:0;width:100%;height:100%}body{display:flex;flex-direction:column;font-family:system-ui,sans-serif}iframe{display:block;flex:1;min-height:0;width:100%;border:0}.report-bar{display:flex;justify-content:flex-end;padding:4px 8px;border-top:1px solid #ddd;background:#fafafa}.report-bar button{min-height:36px;padding:0 12px;font:inherit;font-size:14px;background:none;border:0;color:#444;text-decoration:underline}dialog{box-sizing:border-box;max-width:min(28rem,calc(100vw - 2rem));border:1px solid #ccc;border-radius:12px;padding:1.25rem}dialog h2{margin:0 0 .5rem;font-size:1.2rem}fieldset{border:0;padding:0;margin:0}legend{font-weight:600;margin-bottom:.5rem}fieldset label{display:flex;gap:.6rem;align-items:center;min-height:44px}.report-actions{display:flex;justify-content:flex-end;gap:.5rem}.report-actions button{min-height:44px;padding:0 1rem;font:inherit;border-radius:8px;border:1px solid #888;background:#fff}#report-send{background:#1d4ed8;border-color:#1d4ed8;color:#fff}#report-send:disabled{opacity:.5}#report-status:empty{display:none}</style></head><body><iframe title="Tapplet activity" sandbox="allow-scripts allow-modals" srcdoc="${escape(activity)}"></iframe>${report}</body></html>`;
}

async function servePublic(
  request: Request,
  env: StudioEnv,
): Promise<Response> {
  // Link previews and classroom platforms check a link with HEAD first.
  if (request.method !== "GET" && request.method !== "HEAD")
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
