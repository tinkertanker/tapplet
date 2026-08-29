import {
  chromium,
  type Browser,
  type BrowserContext,
  type Locator,
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
  settleTimeMs?: number;
}

export interface BrowserViewportResult {
  viewport: EvaluationViewport;
  behavior: {
    passed: boolean;
    controlCount: number;
    exercisedControlCount: number;
    changedControlCount: number;
    interactionPassRate: number;
    interactionErrorCount: number;
    consoleErrorCount: number;
    pageErrorCount: number;
    scenarios: Array<{
      index: number;
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
  schemaVersion: "2.0";
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

interface BrowserRuntimeMetrics {
  consoleErrorCount: number;
  pageErrorCount: number;
  cspViolationCount: number;
  violatedDirectiveSet: Set<string>;
}

const DEFAULT_VIEWPORTS: EvaluationViewport[] = [
  { name: "phone", width: 390, height: 844 },
  { name: "ipad", width: 1024, height: 768 },
];
const DEFAULT_SETTLE_TIME_MS = 100;
const MIN_INTERACTION_PASS_RATE = 0.8;
const STATE_FINGERPRINT_FUNCTION = String.raw`() => {
  const controlState = [...document.querySelectorAll("input,select,textarea")]
    .map((element) => {
      if (element instanceof HTMLInputElement) {
        return [element.tagName, element.type, element.value, element.checked];
      }
      if (element instanceof HTMLSelectElement) {
        return [element.tagName, element.value, element.selectedIndex];
      }
      return [element.tagName, element.value];
    });
  const value = document.documentElement.outerHTML + "\n" + JSON.stringify(controlState);
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}`;

export async function evaluateHtmlInBrowser(
  html: string,
  options: BrowserEvaluationOptions = {},
): Promise<BrowserEvaluationResult> {
  const settleTimeMs = options.settleTimeMs ?? DEFAULT_SETTLE_TIME_MS;
  if (!Number.isFinite(settleTimeMs) || settleTimeMs < 0 || settleTimeMs > 5_000) {
    throw new RangeError("settleTimeMs must be between 0 and 5000.");
  }
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
        settleTimeMs,
      ));
    }
    return {
      schemaVersion: "2.0",
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
  settleTimeMs: number,
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
  const runtime: BrowserRuntimeMetrics = {
    consoleErrorCount: 0,
    pageErrorCount: 0,
    cspViolationCount: 0,
    violatedDirectiveSet: new Set<string>(),
  };

  try {
    const metricsPage = await createEvaluationPage(context, runtime);
    let dom: DomMetrics;
    try {
      await navigateToArtifact(metricsPage, settleTimeMs);
      dom = await collectDomMetrics(metricsPage);
    } finally {
      await metricsPage.close();
    }
    const scenarioResults = [];
    for (const [scenarioIndex, scenario] of scenarios.entries()) {
      const scenarioPage = await createEvaluationPage(context, runtime);
      try {
        await navigateToArtifact(scenarioPage, settleTimeMs);
        scenarioResults.push(await runScenario(
          scenarioPage,
          scenario,
          scenarioIndex,
          settleTimeMs,
        ));
      } finally {
        await scenarioPage.close();
      }
    }
    const interactions = await exerciseGenericInteractions(context, runtime, settleTimeMs);
    const violatedDirectives = [...runtime.violatedDirectiveSet].sort();
    const interactionPassRate = interactions.exercisedControlCount === 0
      ? (dom.controlCount === 0 ? 1 : 0)
      : interactions.changedControlCount / interactions.exercisedControlCount;
    const touchTargetPassRate = dom.controlCount === 0
      ? 1
      : (dom.controlCount - dom.undersizedTouchTargetCount) / dom.controlCount;
    const sandboxPassed = network.blockedRequestCount === 0
      && runtime.cspViolationCount === 0;
    const behaviorPassed = runtime.consoleErrorCount === 0
      && runtime.pageErrorCount === 0
      && interactions.interactionErrorCount === 0
      && interactionPassRate >= MIN_INTERACTION_PASS_RATE
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
        interactionPassRate,
        consoleErrorCount: runtime.consoleErrorCount,
        pageErrorCount: runtime.pageErrorCount,
        scenarios: scenarioResults,
      },
      sandbox: {
        passed: sandboxPassed,
        ...network,
        cspViolationCount: runtime.cspViolationCount,
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

async function navigateToArtifact(page: Page, settleTimeMs: number): Promise<void> {
  await page.goto(`${EVALUATION_ORIGIN}/`, { waitUntil: "load" });
  await page.waitForTimeout(settleTimeMs);
}

async function createEvaluationPage(
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
  scenarioIndex: number,
  settleTimeMs: number,
): Promise<{
  index: number;
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
    if (!await waitForAssertion(page, assertion, settleTimeMs)) failedAssertions += 1;
  }
  return {
    index: scenarioIndex,
    passed: !actionFailed && failedAssertions === 0,
    stateChanged: await stateFingerprint(page) !== before,
    failedAssertions,
  };
}

async function waitForAssertion(
  page: Page,
  assertion: BrowserAssertion,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    try {
      const locator = page.locator(assertion.selector).first();
      if (await locator.count() > 0) {
        const visible = assertion.visible === undefined
          || await locator.isVisible() === assertion.visible;
        const text = assertion.textIncludes === undefined
          || await locator.evaluate((root, expected) => {
            const renderedText: string[] = [];
            const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
            for (let node = walker.nextNode(); node; node = walker.nextNode()) {
              const textNode = node as Text;
              if (!(textNode.nodeValue ?? "").trim()) continue;
              const parent = textNode.parentElement;
              if (!parent || ["SCRIPT", "STYLE", "TEMPLATE", "NOSCRIPT"].includes(parent.tagName))
                continue;
              const range = document.createRange();
              range.selectNodeContents(textNode);
              const textRect = range.getBoundingClientRect();
              if (textRect.width <= 0 || textRect.height <= 0) continue;
              let left = textRect.left;
              let right = textRect.right;
              let top = textRect.top;
              let bottom = textRect.bottom;
              let rendered = true;
              for (let element: Element | null = parent; element; element = element.parentElement) {
                const style = getComputedStyle(element);
                const transparentColor = style.color === "transparent"
                  || /^rgba\([^)]*,\s*0(?:\.0+)?\s*\)$/.test(style.color)
                  || /\/\s*0(?:\.0+)?\s*\)$/.test(style.color);
                if (
                  style.display === "none"
                  || style.visibility === "hidden"
                  || style.visibility === "collapse"
                  || style.contentVisibility === "hidden"
                  || Number(style.opacity) <= 0
                  || transparentColor
                  || /opacity\(\s*0(?:\.0+)?\s*\)/.test(style.filter)
                ) {
                  rendered = false;
                  break;
                }
                const rect = element.getBoundingClientRect();
                if (["hidden", "clip"].includes(style.overflowX)) {
                  left = Math.max(left, rect.left);
                  right = Math.min(right, rect.right);
                }
                if (["hidden", "clip"].includes(style.overflowY)) {
                  top = Math.max(top, rect.top);
                  bottom = Math.min(bottom, rect.bottom);
                }
                if (right <= left || bottom <= top) {
                  rendered = false;
                  break;
                }
                if (element === root) break;
              }
              if (!rendered) continue;
              const pageLeft = left + scrollX;
              const pageRight = right + scrollX;
              const pageTop = top + scrollY;
              const pageBottom = bottom + scrollY;
              if (
                pageRight <= 0
                || pageBottom <= 0
                || pageLeft >= document.documentElement.scrollWidth
                || pageTop >= document.documentElement.scrollHeight
              ) continue;
              renderedText.push(textNode.nodeValue ?? "");
            }
            const actual = renderedText.join(" ")
              .toLocaleLowerCase()
              .replace(/\s+/g, " ")
              .trim();
            const wanted = expected
              .toLocaleLowerCase()
              .replace(/\s+/g, " ")
              .trim();
            return actual.includes(wanted);
          }, assertion.textIncludes);
        const attribute = assertion.attribute === undefined
          || await locator.getAttribute(assertion.attribute.name) === assertion.attribute.value;
        if (visible && text && attribute) return true;
      }
    } catch {
      // Retry until the bounded assertion deadline.
    }
    const remaining = deadline - performance.now();
    if (remaining <= 0) return false;
    await page.waitForTimeout(Math.min(20, remaining));
  }
}

async function stateFingerprint(page: Page): Promise<number> {
  return page.evaluate(`(${STATE_FINGERPRINT_FUNCTION})()`) as Promise<number>;
}

async function exerciseGenericInteractions(
  context: BrowserContext,
  runtime: BrowserRuntimeMetrics,
  settleTimeMs: number,
): Promise<InteractionMetrics> {
  const controlSelector = "button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[role='button']:not([aria-disabled='true'])";
  const countPage = await createEvaluationPage(context, runtime);
  let exercisedControlCount: number;
  try {
    await navigateToArtifact(countPage, settleTimeMs);
    exercisedControlCount = Math.min(
      await countPage.locator(controlSelector).filter({ visible: true }).count(),
      12,
    );
  } finally {
    await countPage.close();
  }
  let changedControlCount = 0;
  let interactionErrorCount = 0;
  for (let index = 0; index < exercisedControlCount; index += 1) {
    const page = await createEvaluationPage(context, runtime);
    try {
      await navigateToArtifact(page, settleTimeMs);
      const control = page.locator(controlSelector).filter({ visible: true }).nth(index);
      const before = await stateFingerprint(page);
      await exerciseGenericControl(control, settleTimeMs);
      await page.waitForTimeout(settleTimeMs);
      if (await stateFingerprint(page) !== before) changedControlCount += 1;
    } catch {
      interactionErrorCount += 1;
    } finally {
      await page.close();
    }
  }
  return {
    exercisedControlCount,
    changedControlCount,
    interactionErrorCount,
  };
}

async function exerciseGenericControl(
  control: Locator,
  settleTimeMs: number,
): Promise<void> {
  const timeout = Math.max(500, settleTimeMs * 5);
  await control.scrollIntoViewIfNeeded({ timeout });
  const descriptor = await control.evaluate((element) => ({
    tag: element.tagName.toLocaleLowerCase(),
    type: element instanceof HTMLInputElement ? element.type.toLocaleLowerCase() : "",
    value: element instanceof HTMLInputElement
      || element instanceof HTMLSelectElement
      || element instanceof HTMLTextAreaElement
      ? element.value
      : "",
    minimum: element instanceof HTMLInputElement ? element.min : "",
    maximum: element instanceof HTMLInputElement ? element.max : "",
    selectedIndex: element instanceof HTMLSelectElement ? element.selectedIndex : -1,
    optionCount: element instanceof HTMLSelectElement ? element.options.length : 0,
  }));
  if (descriptor.tag === "select") {
    if (descriptor.optionCount > 1) {
      const index = descriptor.selectedIndex === 0 ? 1 : 0;
      await control.selectOption({ index }, { timeout });
    }
    return;
  }
  if (descriptor.tag === "textarea") {
    await control.fill(
      descriptor.value === "Evaluation input" ? "Alternate evaluation input" : "Evaluation input",
      { timeout },
    );
    return;
  }
  if (descriptor.tag === "input") {
    if (["checkbox", "radio", "button", "submit", "reset"].includes(descriptor.type)) {
      await control.click({ timeout });
      return;
    }
    if (descriptor.type === "range") {
      const minimum = descriptor.minimum || "0";
      const maximum = descriptor.maximum || "100";
      await control.fill(descriptor.value === maximum ? minimum : maximum, { timeout });
      return;
    }
    const value = descriptor.type === "number"
      ? (descriptor.value === "1" ? "2" : "1")
      : descriptor.type === "date"
        ? (descriptor.value === "2026-08-29" ? "2026-08-30" : "2026-08-29")
        : descriptor.value === "Evaluation input"
          ? "Alternate evaluation input"
          : "Evaluation input";
    await control.fill(value, { timeout });
    return;
  }
  await control.click({ timeout });
}
