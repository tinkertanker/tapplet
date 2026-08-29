import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from "playwright";

const EVALUATION_ORIGIN = "https://tapplet-eval.invalid";
const TRANSPARENT_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

export interface EvaluationViewport {
  name: string;
  width: number;
  height: number;
}

export type BrowserAction =
  | { type: "click"; selector: string }
  | { type: "fill"; selector: string; value: string }
  | { type: "select"; selector: string; value: string }
  | { type: "range"; selector: string; value: number }
  | { type: "press"; selector: string; key: string };

export interface BrowserAssertion {
  selector: string;
  visible?: boolean;
  textIncludes?: string;
  attribute?: { name: string; value: string };
}

export interface BrowserScenario {
  name: string;
  actions: BrowserAction[];
  assertions: BrowserAssertion[];
}

export interface BrowserEvaluationOptions {
  viewports?: EvaluationViewport[];
  scenarios?: BrowserScenario[];
  browser?: Browser;
}

export interface BrowserViewportResult {
  viewport: EvaluationViewport;
  behavior: {
    passed: boolean;
    controlCount: number;
    exercisedControlCount: number;
    changedControlCount: number;
    interactionErrorCount: number;
    consoleErrorCount: number;
    pageErrorCount: number;
    scenarios: Array<{
      name: string;
      passed: boolean;
      stateChanged: boolean;
      failedAssertions: number;
    }>;
  };
  sandbox: {
    passed: boolean;
    blockedRequestCount: number;
    crossOriginRequestCount: number;
    sameOriginUnexpectedRequestCount: number;
    cspViolationCount: number;
    violatedDirectives: string[];
  };
  viewportFit: {
    passed: boolean;
    horizontalOverflowPixels: number;
    documentHeight: number;
    controlsOutsideInitialViewport: number;
    clippedControlCount: number;
  };
  accessibilityBasic: {
    passed: boolean;
    unnamedControlCount: number;
    duplicateIdCount: number;
    imageMissingAltCount: number;
    headingLevelSkipCount: number;
    h1Count: number;
    focusFailureCount: number;
  };
  renderedQuality: {
    passed: boolean;
    undersizedTouchTargetCount: number;
    touchTargetPassRate: number;
    overlappingControlPairCount: number;
    minimumTextSizePixels: number | null;
  };
}

export interface BrowserEvaluationResult {
  schemaVersion: "1.0";
  passed: boolean;
  viewports: BrowserViewportResult[];
}

interface DomMetrics {
  controlCount: number;
  unnamedControlCount: number;
  duplicateIdCount: number;
  imageMissingAltCount: number;
  headingLevelSkipCount: number;
  h1Count: number;
  focusFailureCount: number;
  horizontalOverflowPixels: number;
  documentHeight: number;
  controlsOutsideInitialViewport: number;
  clippedControlCount: number;
  undersizedTouchTargetCount: number;
  overlappingControlPairCount: number;
  minimumTextSizePixels: number | null;
}

interface InteractionMetrics {
  exercisedControlCount: number;
  changedControlCount: number;
  interactionErrorCount: number;
}

const DEFAULT_VIEWPORTS: EvaluationViewport[] = [
  { name: "phone", width: 390, height: 844 },
  { name: "ipad", width: 1024, height: 768 },
];

export async function evaluateHtmlInBrowser(
  html: string,
  options: BrowserEvaluationOptions = {},
): Promise<BrowserEvaluationResult> {
  const browser = options.browser ?? await chromium.launch({
    headless: true,
    args: ["--disable-background-networking"],
  });
  const ownsBrowser = !options.browser;
  try {
    const results: BrowserViewportResult[] = [];
    for (const viewport of options.viewports ?? DEFAULT_VIEWPORTS) {
      results.push(await evaluateViewport(
        browser,
        html,
        viewport,
        options.scenarios ?? [],
      ));
    }
    return {
      schemaVersion: "1.0",
      passed: results.every((result) =>
        result.behavior.passed
        && result.sandbox.passed
        && result.viewportFit.passed
        && result.accessibilityBasic.passed
        && result.renderedQuality.passed
      ),
      viewports: results,
    };
  } finally {
    if (ownsBrowser) await browser.close();
  }
}

async function evaluateViewport(
  browser: Browser,
  html: string,
  viewport: EvaluationViewport,
  scenarios: BrowserScenario[],
): Promise<BrowserViewportResult> {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
  });
  const network = {
    blockedRequestCount: 0,
    crossOriginRequestCount: 0,
    sameOriginUnexpectedRequestCount: 0,
  };
  await installEvaluationRoutes(context, html, network);
  const page = await context.newPage();
  let consoleErrorCount = 0;
  let pageErrorCount = 0;
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrorCount += 1;
  });
  page.on("pageerror", () => {
    pageErrorCount += 1;
  });
  page.on("dialog", (dialog) => void dialog.dismiss());
  await page.addInitScript(`
    globalThis.__tappletCspViolations = [];
    addEventListener('securitypolicyviolation', event => {
      globalThis.__tappletCspViolations.push(event.effectiveDirective || event.violatedDirective || 'unknown');
    });
  `);

  try {
    await page.goto(`${EVALUATION_ORIGIN}/`, { waitUntil: "load" });
    await page.waitForTimeout(50);
    const dom = await collectDomMetrics(page);
    const scenarioResults = [];
    for (const scenario of scenarios) {
      scenarioResults.push(await runScenario(page, scenario));
    }
    const interactions = await exerciseGenericInteractions(page);
    await page.waitForTimeout(25);
    const violatedDirectives = await page.evaluate(
      "[...new Set(globalThis.__tappletCspViolations || [])]",
    ) as string[];
    const cspViolationCount = await page.evaluate(
      "(globalThis.__tappletCspViolations || []).length",
    ) as number;
    const touchTargetPassRate = dom.controlCount === 0
      ? 1
      : (dom.controlCount - dom.undersizedTouchTargetCount) / dom.controlCount;
    const sandboxPassed = network.blockedRequestCount === 0 && cspViolationCount === 0;
    const behaviorPassed = consoleErrorCount === 0
      && pageErrorCount === 0
      && interactions.interactionErrorCount === 0
      && (dom.controlCount === 0 || interactions.exercisedControlCount > 0)
      && scenarioResults.every((scenario) => scenario.passed);
    const accessibilityPassed = dom.unnamedControlCount === 0
      && dom.duplicateIdCount === 0
      && dom.imageMissingAltCount === 0
      && dom.headingLevelSkipCount === 0
      && dom.h1Count === 1
      && dom.focusFailureCount === 0;
    const viewportPassed = dom.horizontalOverflowPixels === 0
      && dom.clippedControlCount === 0;
    const renderedQualityPassed = touchTargetPassRate >= 0.8
      && dom.overlappingControlPairCount === 0
      && (dom.minimumTextSizePixels === null || dom.minimumTextSizePixels >= 12);
    return {
      viewport,
      behavior: {
        passed: behaviorPassed,
        controlCount: dom.controlCount,
        ...interactions,
        consoleErrorCount,
        pageErrorCount,
        scenarios: scenarioResults,
      },
      sandbox: {
        passed: sandboxPassed,
        ...network,
        cspViolationCount,
        violatedDirectives,
      },
      viewportFit: {
        passed: viewportPassed,
        horizontalOverflowPixels: dom.horizontalOverflowPixels,
        documentHeight: dom.documentHeight,
        controlsOutsideInitialViewport: dom.controlsOutsideInitialViewport,
        clippedControlCount: dom.clippedControlCount,
      },
      accessibilityBasic: {
        passed: accessibilityPassed,
        unnamedControlCount: dom.unnamedControlCount,
        duplicateIdCount: dom.duplicateIdCount,
        imageMissingAltCount: dom.imageMissingAltCount,
        headingLevelSkipCount: dom.headingLevelSkipCount,
        h1Count: dom.h1Count,
        focusFailureCount: dom.focusFailureCount,
      },
      renderedQuality: {
        passed: renderedQualityPassed,
        undersizedTouchTargetCount: dom.undersizedTouchTargetCount,
        touchTargetPassRate,
        overlappingControlPairCount: dom.overlappingControlPairCount,
        minimumTextSizePixels: dom.minimumTextSizePixels,
      },
    };
  } finally {
    await context.close();
  }
}

async function installEvaluationRoutes(
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
    if (url.origin === EVALUATION_ORIGIN && url.pathname === "/") {
      await route.fulfill({
        status: 200,
        contentType: "text/html; charset=utf-8",
        headers: productionSecurityHeaders(),
        body: html,
      });
      return;
    }
    if (
      url.origin === EVALUATION_ORIGIN
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

async function collectDomMetrics(page: Page): Promise<DomMetrics> {
  return page.evaluate(String.raw`(() => {
    const controlSelector = "button,input,select,textarea,a[href],[role='button'],[tabindex]";
    const isVisible = element => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none"
        && style.visibility !== "hidden"
        && Number(style.opacity) !== 0
        && rect.width > 0
        && rect.height > 0;
    };
    const controls = [...document.querySelectorAll(controlSelector)]
      .filter(isVisible)
      .filter((element) => !element.hasAttribute("disabled"));
    const accessibleName = element => {
      const labelledBy = element.getAttribute("aria-labelledby")
        ?.split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent ?? "")
        .join(" ")
        .trim();
      const labels = element instanceof HTMLInputElement
        || element instanceof HTMLSelectElement
        || element instanceof HTMLTextAreaElement
        ? [...(element.labels ?? [])].map((label) => label.textContent ?? "").join(" ").trim()
        : "";
      return element.getAttribute("aria-label")?.trim()
        || labelledBy
        || labels
        || element.getAttribute("alt")?.trim()
        || element.textContent?.trim()
        || element.getAttribute("title")?.trim()
        || (element instanceof HTMLInputElement
          && ["button", "submit", "reset"].includes(element.type)
          ? element.value.trim()
          : "");
    };
    const idCounts = new Map();
    document.querySelectorAll("[id]").forEach((element) => {
      idCounts.set(element.id, (idCounts.get(element.id) ?? 0) + 1);
    });
    const headings = [...document.querySelectorAll("h1,h2,h3,h4,h5,h6")]
      .filter(isVisible)
      .map((heading) => Number(heading.tagName.slice(1)));
    let headingLevelSkipCount = 0;
    for (let index = 1; index < headings.length; index += 1) {
      if (headings[index] > headings[index - 1] + 1) headingLevelSkipCount += 1;
    }
    const rectangles = controls.map((element) => element.getBoundingClientRect());
    let overlapCount = 0;
    for (let left = 0; left < rectangles.length; left += 1) {
      for (let right = left + 1; right < rectangles.length; right += 1) {
        const a = rectangles[left];
        const b = rectangles[right];
        const width = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
        const height = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
        const overlap = width * height;
        const smaller = Math.min(a.width * a.height, b.width * b.height);
        if (smaller > 0 && overlap / smaller > 0.2) overlapCount += 1;
      }
    }
    const textSizes = [...document.querySelectorAll("body *")]
      .filter(isVisible)
      .filter((element) => (element.textContent ?? "").trim().length > 0)
      .map((element) => Number.parseFloat(getComputedStyle(element).fontSize))
      .filter(Number.isFinite);
    let focusFailureCount = 0;
    controls.forEach((element) => {
      if (element.tabIndex < 0) return;
      element.focus();
      if (document.activeElement !== element) focusFailureCount += 1;
    });
    const clippedControlCount = rectangles.filter((rect) =>
      rect.left < 0 || rect.right > innerWidth || rect.width > innerWidth
    ).length;
    return {
      controlCount: controls.length,
      unnamedControlCount: controls.filter((element) => !accessibleName(element)).length,
      duplicateIdCount: [...idCounts.values()].filter((count) => count > 1).length,
      imageMissingAltCount: [...document.querySelectorAll("img")]
        .filter((image) => !image.hasAttribute("alt")).length,
      headingLevelSkipCount,
      h1Count: headings.filter((level) => level === 1).length,
      focusFailureCount,
      horizontalOverflowPixels: Math.max(0, document.documentElement.scrollWidth - innerWidth),
      documentHeight: document.documentElement.scrollHeight,
      controlsOutsideInitialViewport: rectangles.filter((rect) =>
        rect.bottom <= 0 || rect.top >= innerHeight || rect.right <= 0 || rect.left >= innerWidth
      ).length,
      clippedControlCount,
      undersizedTouchTargetCount: rectangles.filter((rect) => rect.width < 44 || rect.height < 44).length,
      overlappingControlPairCount: overlapCount,
      minimumTextSizePixels: textSizes.length ? Math.min(...textSizes) : null,
    };
  })()`) as Promise<DomMetrics>;
}

async function runScenario(
  page: Page,
  scenario: BrowserScenario,
): Promise<{
  name: string;
  passed: boolean;
  stateChanged: boolean;
  failedAssertions: number;
}> {
  const before = await stateFingerprint(page);
  let actionFailed = false;
  for (const action of scenario.actions) {
    try {
      const locator = page.locator(action.selector).first();
      if (action.type === "click") await locator.click();
      else if (action.type === "fill") await locator.fill(action.value);
      else if (action.type === "select") await locator.selectOption(action.value);
      else if (action.type === "press") await locator.press(action.key);
      else {
        await locator.fill(String(action.value));
        await locator.dispatchEvent("input");
        await locator.dispatchEvent("change");
      }
    } catch {
      actionFailed = true;
    }
  }
  let failedAssertions = 0;
  for (const assertion of scenario.assertions) {
    try {
      const locator = page.locator(assertion.selector).first();
      if (await locator.count() === 0) {
        failedAssertions += 1;
        continue;
      }
      if (assertion.visible !== undefined
        && await locator.isVisible() !== assertion.visible) failedAssertions += 1;
      if (assertion.textIncludes !== undefined
        && !(await locator.textContent() ?? "").includes(assertion.textIncludes)) {
        failedAssertions += 1;
      }
      if (assertion.attribute !== undefined
        && await locator.getAttribute(assertion.attribute.name) !== assertion.attribute.value) {
        failedAssertions += 1;
      }
    } catch {
      failedAssertions += 1;
    }
  }
  return {
    name: scenario.name,
    passed: !actionFailed && failedAssertions === 0,
    stateChanged: await stateFingerprint(page) !== before,
    failedAssertions,
  };
}

async function stateFingerprint(page: Page): Promise<number> {
  return page.evaluate(String.raw`(() => {
    const value = document.body.innerHTML;
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  })()`) as Promise<number>;
}

async function exerciseGenericInteractions(page: Page): Promise<InteractionMetrics> {
  return page.evaluate(String.raw`(async () => {
    const visible = element => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0
        && rect.height > 0
        && style.display !== "none"
        && style.visibility !== "hidden"
        && !element.hasAttribute("disabled");
    };
    const fingerprint = () => {
      const value = document.body.innerHTML;
      let hash = 2_166_136_261;
      for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 16_777_619);
      }
      return hash >>> 0;
    };
    const controls = [...document.querySelectorAll(
      "button,input,select,textarea,[role='button']",
    )].filter(visible).slice(0, 12);
    let changedControlCount = 0;
    let interactionErrorCount = 0;
    for (const element of controls) {
      const before = fingerprint();
      try {
        if (element instanceof HTMLInputElement && element.type === "range") {
          element.value = element.max || "100";
          element.dispatchEvent(new Event("input", { bubbles: true }));
          element.dispatchEvent(new Event("change", { bubbles: true }));
        } else if (
          element instanceof HTMLInputElement
          && ["checkbox", "radio"].includes(element.type)
        ) {
          element.click();
        } else if (element instanceof HTMLSelectElement && element.options.length > 1) {
          element.selectedIndex = 1;
          element.dispatchEvent(new Event("change", { bubbles: true }));
        } else if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
          element.value = "Evaluation input";
          element.dispatchEvent(new Event("input", { bubbles: true }));
          element.dispatchEvent(new Event("change", { bubbles: true }));
        } else if (typeof element.click === "function") {
          element.click();
        } else {
          element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
        if (fingerprint() !== before) changedControlCount += 1;
      } catch {
        interactionErrorCount += 1;
      }
    }
    return {
      exercisedControlCount: controls.length,
      changedControlCount,
      interactionErrorCount,
    };
  })()`) as Promise<InteractionMetrics>;
}
