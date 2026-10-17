import type { BrowserContext, Locator, Page } from "playwright";
import { EVALUATION_ORIGIN, TRANSPARENT_PNG, createEvaluationPage, navigateToArtifact } from "./page";
import type { BrowserRuntimeMetrics } from "./page";
import type { BrowserAssertion, BrowserScenario } from "./evaluate";

// Scripted scenarios and generic control exercise for an evaluated page.

interface InteractionMetrics {
  exercisedControlCount: number;
  changedControlCount: number;
  interactionErrorCount: number;
}

const TYPED_INPUT_VALUES: Partial<Record<string, readonly [string, string]>> = {
  number: ["1", "2"],
  date: ["2026-08-29", "2026-08-30"],
  time: ["08:30", "09:30"],
  "datetime-local": ["2026-08-29T08:30", "2026-08-30T08:30"],
  month: ["2026-08", "2026-09"],
  week: ["2026-W35", "2026-W36"],
  color: ["#000000", "#ffffff"],
};
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

export async function runScenario(
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

export async function exerciseGenericInteractions(
  context: BrowserContext,
  runtime: BrowserRuntimeMetrics,
  settleTimeMs: number,
): Promise<InteractionMetrics> {
  // Match each fresh page's random question/shuffle sequence as well as its
  // clock. Install only for generic checks, after real-time scenarios finish.
  await context.addInitScript(`(() => {
    let state = 0x5eed;
    Math.random = () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 4294967296;
    };
  })()`);
  // Read-only fields show a result; they cannot be typed into.
  const controlSelector = ":is(button,input,select,textarea,[role='button']):not(:disabled,[disabled],[aria-disabled='true'],[inert],[inert] *,:is(input:not([type=checkbox],[type=radio],[type=button],[type=submit],[type=reset]),textarea)[readonly])";
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
  // The Playwright clock is context-wide. Install it only after metrics and
  // declarative scenarios have finished, so their real-time assertions stay intact.
  // Paired pages start at the same paused time; runFor fires every due callback
  // in both, rather than attributing an unrelated timer tick to the interaction.
  const clockTime = new Date("2026-01-01T00:00:00Z");
  await context.clock.install({ time: clockTime });
  await context.clock.pauseAt(new Date(clockTime.getTime() + 1_000));
  let changedControlCount = 0;
  let interactionErrorCount = 0;
  for (let index = 0; index < exercisedControlCount; index += 1) {
    const page = await createEvaluationPage(context, runtime);
    const baseline = await createEvaluationPage(context, runtime);
    try {
      await Promise.all([page, baseline].map((candidate) =>
        candidate.goto(`${EVALUATION_ORIGIN}/`, { waitUntil: "load" })
      ));
      await context.clock.runFor(settleTimeMs);
      const control = page.locator(controlSelector).filter({ visible: true }).nth(index);
      const before = await stateFingerprint(page);
      const baselineBefore = await stateFingerprint(baseline);
      await exerciseGenericControl(control, settleTimeMs);
      await context.clock.runFor(settleTimeMs);
      const after = await stateFingerprint(page);
      const baselineAfter = await stateFingerprint(baseline);
      // Fail closed if initial states still differ: divergent finals alone
      // would not then establish cause.
      if (before === baselineBefore && after !== before && after !== baselineAfter) {
        changedControlCount += 1;
      }
    } catch {
      interactionErrorCount += 1;
    } finally {
      await Promise.all([page.close(), baseline.close()]);
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
  const descriptor = await control.evaluate((element) => {
    // A range snaps to its bounds and step, and fill rejects a value the
    // input does not keep, so ask a detached copy which ends it can reach.
    // A file input throws when script sets its value.
    const [minimum = "", maximum = ""] = ["-1e308", "1e308"].map((extreme) => {
      if (!(element instanceof HTMLInputElement) || element.type !== "range") return "";
      const probe = element.cloneNode() as HTMLInputElement;
      probe.value = extreme;
      return probe.value;
    });
    return {
      tag: element.tagName.toLocaleLowerCase(),
      type: element instanceof HTMLInputElement ? element.type.toLocaleLowerCase() : "",
      value: element instanceof HTMLInputElement
        || element instanceof HTMLSelectElement
        || element instanceof HTMLTextAreaElement
        ? element.value
        : "",
      minimum,
      maximum,
      selectedIndex: element instanceof HTMLSelectElement ? element.selectedIndex : -1,
      optionCount: element instanceof HTMLSelectElement ? element.options.length : 0,
    };
  });
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
      const { minimum, maximum } = descriptor;
      await control.fill(descriptor.value === maximum ? minimum : maximum, { timeout });
      return;
    }
    // A file input cannot be filled; choose a small image as a student would.
    if (descriptor.type === "file") {
      await control.setInputFiles(
        { name: "evaluation.png", mimeType: "image/png", buffer: TRANSPARENT_PNG },
        { timeout },
      );
      return;
    }
    // Typed inputs discard text that is not in their format, and fill
    // rejects a value the input does not keep.
    const [first, second] = TYPED_INPUT_VALUES[descriptor.type]
      ?? ["Evaluation input", "Alternate evaluation input"];
    await control.fill(descriptor.value === first ? second : first, { timeout });
    return;
  }
  await control.click({ timeout });
}
