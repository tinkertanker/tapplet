import { chromium, type Browser } from "playwright";
import { createEvaluationPage, installEvaluationRoutes, navigateToArtifact } from "./page";
import type { BrowserRuntimeMetrics } from "./page";
import { collectDomMetrics } from "./domMetrics";
import type { DomMetrics } from "./domMetrics";
import { exerciseGenericInteractions, runScenario } from "./interactions";

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

const DEFAULT_VIEWPORTS: EvaluationViewport[] = [
  { name: "phone", width: 390, height: 844 },
  { name: "ipad", width: 1024, height: 768 },
];
const DEFAULT_SETTLE_TIME_MS = 100;
const MIN_INTERACTION_PASS_RATE = 0.8;
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
