import type { BrowserContext, Page } from "playwright";

// The isolated page each tapplet is evaluated in, with production-like headers.

export const EVALUATION_ORIGIN = "https://tapplet-eval.invalid";
export const TRANSPARENT_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

export interface BrowserRuntimeMetrics {
  consoleErrorCount: number;
  pageErrorCount: number;
  cspViolationCount: number;
  violatedDirectiveSet: Set<string>;
}

export async function navigateToArtifact(page: Page, settleTimeMs: number): Promise<void> {
  await page.goto(`${EVALUATION_ORIGIN}/`, { waitUntil: "load" });
  await page.waitForTimeout(settleTimeMs);
}

export async function createEvaluationPage(
  context: BrowserContext,
  runtime: BrowserRuntimeMetrics,
): Promise<Page> {
  const page = await context.newPage();
  page.on("console", (message) => {
    if (message.type() === "error") runtime.consoleErrorCount += 1;
  });
  page.on("pageerror", () => {
    runtime.pageErrorCount += 1;
  });
  page.on("dialog", (dialog) => void dialog.dismiss());
  await page.exposeFunction("__tappletRecordCspViolation", (directive: unknown) => {
    runtime.cspViolationCount += 1;
    runtime.violatedDirectiveSet.add(
      typeof directive === "string" ? directive : "unknown",
    );
  });
  await page.addInitScript(`
    addEventListener('securitypolicyviolation', event => {
      void globalThis.__tappletRecordCspViolation(
        event.effectiveDirective || event.violatedDirective || 'unknown',
      );
    });
  `);
  return page;
}

export async function installEvaluationRoutes(
  context: BrowserContext,
  html: string,
  network: {
    blockedRequestCount: number;
    crossOriginRequestCount: number;
    sameOriginUnexpectedRequestCount: number;
  },
): Promise<void> {
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const isMainDocument = request.method() === "GET"
      && request.resourceType() === "document"
      && request.isNavigationRequest()
      && request.frame().parentFrame() === null;
    if (
      isMainDocument
      && url.origin === EVALUATION_ORIGIN
      && url.pathname === "/"
      && url.search === ""
    ) {
      await route.fulfill({
        status: 200,
        contentType: "text/html; charset=utf-8",
        headers: productionSecurityHeaders(),
        body: html,
      });
      return;
    }
    if (
      request.method() === "GET"
      && request.resourceType() === "image"
      && url.origin === EVALUATION_ORIGIN
      && url.search === ""
      && /^\/assets\/[A-Za-z0-9_-]+$/.test(url.pathname)
    ) {
      await route.fulfill({ status: 200, contentType: "image/png", body: TRANSPARENT_PNG });
      return;
    }
    network.blockedRequestCount += 1;
    if (url.origin === EVALUATION_ORIGIN) network.sameOriginUnexpectedRequestCount += 1;
    else network.crossOriginRequestCount += 1;
    await route.abort("blockedbyclient");
  });
}

function productionSecurityHeaders(): Record<string, string> {
  return {
    "content-security-policy": `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src ${EVALUATION_ORIGIN} data:; connect-src ${EVALUATION_ORIGIN}; base-uri ${EVALUATION_ORIGIN}; form-action 'none'; frame-ancestors 'none'; object-src 'none'; sandbox allow-scripts allow-modals`,
    "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  };
}
