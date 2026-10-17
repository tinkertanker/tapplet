import type { Page } from "playwright";

// Accessibility and layout measurements taken from the rendered page.

export interface DomMetrics {
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

export async function collectDomMetrics(page: Page): Promise<DomMetrics> {
  return page.evaluate(String.raw`(() => {
    // tabindex="-1" only makes a heading, region or message a focus target
    // for script; it is not something a student taps.
    const controlSelector = "button,input,select,textarea,a[href],[role='button'],[tabindex]:not([tabindex^='-'])";
    const isVisible = element => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none"
        && style.visibility !== "hidden"
        && Number(style.opacity) !== 0
        && rect.width > 0
        && rect.height > 0;
    };
    // Controls disabled directly or by a fieldset, or in an inert section, are locked.
    const controls = [...document.querySelectorAll(controlSelector)]
      .filter(isVisible)
      .filter((element) => !element.hasAttribute("disabled")
        && !element.matches(":disabled")
        && !element.closest("[inert]"));
    // Text or a labelled image inside a control names it only while screen
    // readers can reach it.
    const exposed = (child, control) => {
      for (let node = child; node && node !== control; node = node.parentElement) {
        if (node.getAttribute("aria-hidden") === "true"
          || getComputedStyle(node).display === "none") return false;
      }
      return getComputedStyle(child).visibility !== "hidden";
    };
    const exposedText = (control) => {
      const walker = document.createTreeWalker(control, NodeFilter.SHOW_TEXT);
      let text = "";
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (node.parentElement && exposed(node.parentElement, control)) text += node.textContent ?? "";
      }
      return text;
    };
    const accessibleName = element => {
      const labelledBy = element.getAttribute("aria-labelledby")
        ?.split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent ?? "")
        .join(" ")
        .trim();
      const formField = element instanceof HTMLInputElement
        || element instanceof HTMLSelectElement
        || element instanceof HTMLTextAreaElement;
      const labels = formField
        ? [...(element.labels ?? [])].map((label) => label.textContent ?? "").join(" ").trim()
        : "";
      // Option text and default textarea text are values, not names. Other
      // controls are named by their content, including a labelled image.
      const content = formField ? "" : [
        exposedText(element),
        ...[...element.querySelectorAll("img[alt],[aria-label]")]
          .filter((child) => exposed(child, element)).map((child) =>
          child.getAttribute("aria-label") ?? child.getAttribute("alt") ?? ""),
      ].join(" ").trim();
      return element.getAttribute("aria-label")?.trim()
        || labelledBy
        || labels
        || element.getAttribute("alt")?.trim()
        || content
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
      // Tapping a control's label activates it, so a labelled checkbox or
      // radio is as large a target as its biggest label. A slider is only
      // moved on its own track, so its label does not count.
      undersizedTouchTargetCount: controls.filter((element) => ![
        element,
        ...(element instanceof HTMLInputElement && element.type === "range" ? [] : element.labels ?? []),
      ]
        .map((target) => target.getBoundingClientRect())
        .some((rect) => rect.width >= 44 && rect.height >= 44)).length,
      overlappingControlPairCount: overlapCount,
      minimumTextSizePixels: textSizes.length ? Math.min(...textSizes) : null,
    };
  })()`) as Promise<DomMetrics>;
}
