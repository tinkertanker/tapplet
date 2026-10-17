import { parse as parseJavaScript, type AnyNode } from "acorn";
import { parse as parseHtml, parseFragment, type DefaultTreeAdapterTypes } from "parse5";
import type { Issue } from "./generation";

// Static checks on generated HTML: managed-asset references, script parsing
// and URL policy. generation.ts runs them as part of inspecting a candidate.

// The value is matched in a lookahead so a value never hides a later name, as
// in `var action = href = "https://..."` or text such as `href="#` before a
// real attribute.
export const URL_ATTRIBUTE =
  /\b(src|href|action|formaction)(?=\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))/gis;
export const CSS_URL = /\burl\(\s*(?:"([^"]*)"|'([^']*)'|([^\s"')]+))\s*\)/gis;
export const MANAGED_ASSET = /^assets\/([A-Za-z0-9_-]+)$/;
const JAVASCRIPT_TYPES = new Set([
  "",
  "application/ecmascript",
  "application/javascript",
  "application/x-ecmascript",
  "application/x-javascript",
  "text/ecmascript",
  "text/javascript",
  "text/javascript1.0",
  "text/javascript1.1",
  "text/javascript1.2",
  "text/javascript1.3",
  "text/javascript1.4",
  "text/javascript1.5",
  "text/jscript",
  "text/livescript",
  "text/x-ecmascript",
  "text/x-javascript",
]);
export function attributeValue(match: RegExpMatchArray): string {
  return match[2] ?? match[3] ?? match[4] ?? "";
}

export function normalizeAssetUrl(value: string): string {
  return value.trim();
}

export function referencedAssetIds(html: string): string[] {
  const { markup, strings } = assetReferences(html);
  return [...markup, ...strings];
}

// Managed image URLs in markup, CSS and attribute writes such as
// setAttribute("src", "assets/<id>"), and the other script strings that are
// exactly a managed image URL. A script can show an image it keeps in a
// string, as in img.src = `assets/<id>` or an array of image paths; the
// published tapplet serves it only when it is recorded. Such a string need not
// name an image, as in "assets/images" in a lesson on folders.
export function assetReferences(html: string): { markup: string[]; strings: string[] } {
  const markup = new Set<string>(),
    strings = new Set<string>();
  const document = parseHtml(html, { sourceCodeLocationInfo: true }),
    scripts = scriptSources(document, html),
    values = [...urlValueRanges(document), ...scripts.urlValues];
  for (const match of html.matchAll(URL_ATTRIBUTE)) {
    if (within(values, match.index ?? 0)) continue;
    const asset = MANAGED_ASSET.exec(normalizeAssetUrl(attributeValue(match)));
    if (asset?.[1]) markup.add(asset[1]);
  }
  for (const { value } of scripts.attributeWrites) {
    const asset = MANAGED_ASSET.exec(normalizeAssetUrl(value));
    if (asset?.[1]) markup.add(asset[1]);
  }
  for (const match of html.matchAll(CSS_URL)) {
    const asset = MANAGED_ASSET.exec(normalizeAssetUrl(match[1] ?? match[2] ?? match[3] ?? ""));
    if (asset?.[1]) markup.add(asset[1]);
  }
  for (const { value } of scripts.strings) {
    const asset = MANAGED_ASSET.exec(normalizeAssetUrl(value));
    if (asset?.[1] && !markup.has(asset[1])) strings.add(asset[1]);
  }
  return { markup: [...markup], strings: [...strings] };
}

export function referencedImageAssetIdsFrom(
  document: DefaultTreeAdapterTypes.Document,
): Set<string> {
  const ids = new Set<string>();
  function visit(node: DefaultTreeAdapterTypes.Node) {
    if ("tagName" in node && node.tagName === "img") {
      const source = node.attrs.find((attribute) => attribute.name === "src")?.value,
        asset = source && MANAGED_ASSET.exec(normalizeAssetUrl(source));
      if (asset?.[1]) ids.add(asset[1]);
    }
    if ("childNodes" in node) node.childNodes.forEach(visit);
  }
  visit(document);
  return ids;
}

export function hasMultiSourceAttribute(node: DefaultTreeAdapterTypes.Node): boolean {
  if (
    "tagName" in node &&
    node.attrs.some((attribute) => attribute.name === "srcset" || attribute.name === "poster")
  )
    return true;
  if ("childNodes" in node && node.childNodes.some(hasMultiSourceAttribute)) return true;
  return "content" in node && hasMultiSourceAttribute(node.content);
}

// Source ranges of text in elements other than scripts and styles that holds
// no markup, such as a textarea's, which a script could insert as HTML; it runs
// no code and loads nothing.
// The source must hold no tag either: text a table moves out of itself joins
// the text before the table, whose range then spans the table's markup. In a
// select, nor may the source since the tag or node before the text: the parser
// drops tags there, such as <style>, that browsers keep, leaving their CSS as
// text.
export function proseRanges(
  node: DefaultTreeAdapterTypes.Node,
  html: string,
): Array<readonly [number, number]> {
  const ranges: Array<readonly [number, number]> = [];
  function visit(current: DefaultTreeAdapterTypes.Node, selected = false) {
    const inSelect = selected || ("tagName" in current && current.tagName === "select");
    if ("tagName" in current && current.tagName !== "script" && current.tagName !== "style")
      current.childNodes.forEach((child, index) => {
        const location = child.sourceCodeLocation,
          start = !inSelect
            ? location?.startOffset
            : index === 0
              ? current.sourceCodeLocation?.startTag?.endOffset
              : current.childNodes[index - 1]?.sourceCodeLocation?.endOffset;
        if (
          child.nodeName === "#text" &&
          "value" in child &&
          !child.value.includes("<") &&
          location &&
          start !== undefined &&
          start <= location.startOffset &&
          !html.slice(start, location.endOffset).includes("<")
        )
          ranges.push([location.startOffset, location.endOffset]);
      });
    if ("childNodes" in current) current.childNodes.forEach((child) => visit(child, inSelect));
    if ("content" in current) visit(current.content, inSelect);
  }
  visit(node);
  return ranges;
}

// Source offsets of the src, href, action and formaction names in real attributes,
// including prefixed names such as xlink:href.
export function urlAttributeOffsets(node: DefaultTreeAdapterTypes.Node): Set<number> {
  const offsets = new Set<number>();
  function visit(current: DefaultTreeAdapterTypes.Node) {
    if ("tagName" in current) {
      for (const attribute of current.attrs) {
        const qualified = attribute.prefix
            ? `${attribute.prefix}:${attribute.name}`
            : attribute.name,
          name = /(?:^|:)(src|href|action|formaction)$/.exec(qualified)?.[1],
          start = current.sourceCodeLocation?.attrs?.[qualified]?.startOffset;
        if (name && start !== undefined)
          offsets.add(start + qualified.length - name.length);
      }
    }
    if ("childNodes" in current) current.childNodes.forEach(visit);
    if ("content" in current) visit(current.content);
  }
  visit(node);
  return offsets;
}

// Source ranges of the values of real attributes named like URL attributes,
// such as href="#action=go" or data-href="#/route?src=x", that hold no markup.
// A name inside such a value loads nothing; the value itself is checked. A
// value with a name at its start or after white space, a slash, a quote or a
// substitution is not skipped: markup built around it, or preceding markup
// that leaves a value open, could make that name a real attribute.
export function urlValueRanges(
  node: DefaultTreeAdapterTypes.Node,
  offset = 0,
): Array<readonly [number, number]> {
  const ranges: Array<readonly [number, number]> = [];
  function visit(current: DefaultTreeAdapterTypes.Node) {
    if ("tagName" in current) {
      for (const attribute of current.attrs) {
        const qualified = attribute.prefix
            ? `${attribute.prefix}:${attribute.name}`
            : attribute.name,
          location = current.sourceCodeLocation?.attrs?.[qualified];
        if (
          location &&
          /(?:^|[:-])(?:src|href|action|formaction)$/.test(qualified) &&
          !attribute.value.includes("<") &&
          !/(?:^|[\s/"'\0\uFFFD])(?:src|href|action|formaction)\s*=/i.test(attribute.value)
        )
          ranges.push([offset + location.startOffset + qualified.length, offset + location.endOffset]);
      }
    }
    if ("childNodes" in current) current.childNodes.forEach(visit);
    if ("content" in current) visit(current.content);
  }
  visit(node);
  return ranges;
}

// The ranges less each position, from index from of text on, that follows
// white space, a slash, a quote or a NUL standing for a template substitution:
// once markup is built around the text, a name there could start a real
// attribute.
function separatedRanges(
  ranges: ReadonlyArray<readonly [number, number]>,
  text: string,
  offset: number,
  from: number,
): Array<readonly [number, number]> {
  return ranges.flatMap(([start, end]) => {
    const parts: Array<readonly [number, number]> = [];
    let part = start;
    for (let index = Math.max(start, offset + from); index < end; index++)
      if (/[\s/"'\0]/.test(text[index - offset - 1] ?? "")) {
        if (index > part) parts.push([part, index]);
        part = index + 1;
      }
    if (end > part) parts.push([part, end]);
    return parts;
  });
}

// The same ranges in markup a script string holds, such as
// '<a href="#action=go">'. A substitution could end a value, so it hides no
// name that could start an attribute after it.
function markupValueRanges(text: string, offset = 0): Array<readonly [number, number]> {
  if (!text.includes("<") || !/\b(?:src|href|action|formaction)\s*=/i.test(text)) return [];
  const ranges = urlValueRanges(parseFragment(text, { sourceCodeLocationInfo: true }), offset),
    substitution = text.indexOf("\0");
  return substitution < 0 ? ranges : separatedRanges(ranges, text, offset, substitution + 1);
}

export function within(ranges: ReadonlyArray<readonly [number, number]>, index: number): boolean {
  return ranges.some(([start, end]) => index >= start && index < end);
}

const EVENT_HANDLER_PREFIX = "function eventHandler(event) {\n";

function visitJavaScript(value: unknown, visit: (node: AnyNode) => void) {
  if (Array.isArray(value)) value.forEach((item) => visitJavaScript(item, visit));
  else if (value && typeof value === "object" && typeof Reflect.get(value, "type") === "string") {
    visit(value as AnyNode);
    Object.values(value).forEach((item) => visitJavaScript(item, visit));
  }
}

// Source ranges of inline scripts and event handlers, their cooked string and
// template literal text, where markup such as innerHTML can still load URLs,
// with the ranges of URL values inside that text, the same URL value ranges in
// the html, the source offsets of script variables named like URL attributes,
// the literal URLs scripts pass to setAttribute, and whether any script
// imports or re-exports another module.
export function scriptSources(
  node: DefaultTreeAdapterTypes.Node,
  html: string,
): {
  ranges: Array<readonly [number, number]>;
  strings: Array<{ value: string; urlValues: Array<readonly [number, number]> }>;
  urlValues: Array<readonly [number, number]>;
  declarations: Set<number>;
  attributeWrites: Array<{ attribute: string; value: string }>;
  imports: boolean;
} {
  const ranges: Array<readonly [number, number]> = [];
  const strings: Array<{ value: string; urlValues: Array<readonly [number, number]> }> = [];
  const urlValues: Array<readonly [number, number]> = [];
  const declarations = new Set<number>();
  const attributeWrites: Array<{ attribute: string; value: string }> = [];
  let imports = false;
  // offset is where source starts in html when html holds it verbatim.
  function collect(
    source: string,
    sourceType: "script" | "module",
    offset?: number,
    handler = false,
  ) {
    let program: unknown;
    try {
      program = parseJavaScript(source, { ecmaVersion: "latest", sourceType });
    } catch {
      // Invalid syntax, including a module statement in a classic script, is
      // rejected by validateScripts.
      return;
    }
    const fragmentLinks = new Set<AnyNode>();
    visitJavaScript(program, (current) => {
      // import "https://...", export * from "https://...", import(url).
      if (
        current.type === "ImportDeclaration" ||
        current.type === "ImportExpression" ||
        current.type === "ExportAllDeclaration" ||
        (current.type === "ExportNamedDeclaration" && current.source)
      )
        imports = true;
      // A fragment link such as "#action=go" given to an href loads nothing,
      // whatever names it holds.
      const [target, assigned] =
          current.type === "AssignmentExpression" && current.operator === "="
            ? [current.left, current.right]
            : current.type === "VariableDeclarator"
              ? [current.id, current.init]
              : current.type === "AssignmentPattern"
                ? [current.left, current.right]
                : current.type === "PropertyDefinition" && !current.computed
                  ? [current.key, current.value]
                  : [],
        targetName =
          target?.type === "Identifier" || target?.type === "PrivateIdentifier"
            ? target.name
            : target?.type === "MemberExpression" &&
                !target.computed &&
                target.property.type === "Identifier"
              ? target.property.name
              : undefined,
        link = assigned ? literalText(assigned) : undefined;
      if (
        assigned &&
        targetName &&
        /^href$/i.test(targetName) &&
        link?.startsWith("#") &&
        !link.includes("<")
      )
        fragmentLinks.add(assigned);
      // String and template text, with each substitution as one NUL; in the
      // html the source text with substitutions blanked keeps its offsets.
      if (
        (current.type === "Literal" && typeof current.value === "string") ||
        current.type === "TemplateLiteral"
      ) {
        const quasis = current.type === "TemplateLiteral" ? current.quasis : [];
        const value =
            current.type === "Literal"
              ? String(current.value)
              : quasis.map((quasi) => quasi.value.cooked ?? quasi.value.raw).join("\0"),
          start = current.start + 1,
          raw =
            current.type === "Literal"
              ? source.slice(start, current.end - 1)
              : quasis
                  .map((quasi, index) =>
                    source.slice(quasi.start, quasi.end) +
                    "\0".repeat((quasis[index + 1]?.start ?? quasi.end) - quasi.end),
                  )
                  .join("");
        if (fragmentLinks.has(current)) {
          strings.push({ value, urlValues: separatedRanges([[0, value.length]], value, 0, 0) });
          if (offset !== undefined)
            urlValues.push(
              ...separatedRanges([[offset + start, offset + start + raw.length]], raw, offset + start, 0),
            );
        } else {
          strings.push({ value, urlValues: markupValueRanges(value) });
          if (offset !== undefined) urlValues.push(...markupValueRanges(raw, offset + start));
        }
      }
      // img.src = `https://...` and, in an event handler, src = `https://...`:
      // the URL scan reads no template literal as an attribute value.
      if (current.type === "AssignmentExpression" && current.operator === "=") {
        const { left } = current,
          property =
            left.type === "MemberExpression" &&
            !left.computed &&
            left.property.type === "Identifier" &&
            !datasetMember(left)
              ? left.property.name
              : handler && left.type === "Identifier"
                ? left.name
                : undefined,
          written = property && /^(src|href|action|formaction)$/i.exec(property),
          url = absoluteStart(current.right);
        if (written?.[1] && url !== undefined)
          attributeWrites.push({ attribute: written[1].toLowerCase(), value: url });
      }
      // setAttribute("src", "https://...") and setAttributeNS(ns, "href", ...).
      if (
        current.type !== "CallExpression" ||
        current.callee.type !== "MemberExpression" ||
        current.callee.property.type !== "Identifier" ||
        !/^setAttribute(?:NS)?$/.test(current.callee.property.name)
      )
        return;
      const [name, value] = current.callee.property.name === "setAttributeNS"
          ? current.arguments.slice(1)
          : current.arguments,
        attribute = name && literalText(name),
        url = value && (literalText(value) ?? absoluteStart(value)),
        match = attribute && /^(?:[\w-]+:)?(src|href|action|formaction)$/i.exec(attribute);
      if (match?.[1] && url !== undefined)
        attributeWrites.push({ attribute: match[1].toLowerCase(), value: url });
    });
    if (offset === undefined) return;
    const base = offset;
    // A script variable loads nothing, but in an event handler or a with
    // statement a bare name such as src can assign the element's property.
    const found: number[] = [];
    let usesWith = false;
    // Names bound through destructuring and defaults count; a member target
    // such as img.src is still checked.
    function bind(target: AnyNode | null | undefined) {
      if (target?.type === "Identifier") {
        if (/^(?:src|href|action|formaction|srcset|poster)$/i.test(target.name))
          found.push(base + target.start);
      } else if (target?.type === "ObjectPattern")
        target.properties.forEach((property) =>
          bind(property.type === "Property" ? property.value : property),
        );
      else if (target?.type === "ArrayPattern") target.elements.forEach(bind);
      else if (target?.type === "AssignmentPattern") bind(target.left);
      else if (target?.type === "RestElement") bind(target.argument);
    }
    visitJavaScript(program, (current) => {
      if (current.type === "WithStatement") usesWith = true;
      // el.dataset.action = "check" sets a data-action attribute.
      if (
        current.type === "AssignmentExpression" &&
        current.left.type === "MemberExpression" &&
        datasetMember(current.left)
      )
        found.push(base + current.left.property.start);
      if (current.type === "VariableDeclarator") bind(current.id);
      else if (current.type === "AssignmentExpression" && !handler) bind(current.left);
      else if (
        current.type === "FunctionDeclaration" ||
        current.type === "FunctionExpression" ||
        current.type === "ArrowFunctionExpression"
      )
        current.params.forEach(bind);
      else if (current.type === "CatchClause") bind(current.param);
      // A class field defines its own property and runs no element setter.
      else if (current.type === "PropertyDefinition" && !current.computed) bind(current.key);
    });
    if (!usesWith) for (const start of found) declarations.add(start);
  }
  // The html text from start to end when it is exactly the parsed value.
  function verbatim(start: number, end: number, value: string): string | undefined {
    const source = html.slice(start, end);
    return source.replace(/\r\n?/g, "\n") === value ? source : undefined;
  }
  function visit(current: DefaultTreeAdapterTypes.Node) {
    if ("tagName" in current) {
      for (const attribute of current.attrs)
        if (/^on[a-z]+$/.test(attribute.name)) {
          const location = current.sourceCodeLocation?.attrs?.[attribute.name];
          const prefix = location
            ? /^[^=]*=\s*(["']?)/.exec(html.slice(location.startOffset, location.endOffset))
            : null;
          const start = location && prefix ? location.startOffset + prefix[0].length : undefined;
          const source =
            location && start !== undefined
              ? verbatim(start, location.endOffset - (prefix?.[1] ? 1 : 0), attribute.value)
              : undefined;
          if (location) ranges.push([location.startOffset, location.endOffset]);
          if (source !== undefined && start !== undefined)
            collect(
              `${EVENT_HANDLER_PREFIX}${source}\n}`,
              "script",
              start - EVENT_HANDLER_PREFIX.length,
              true,
            );
          else collect(`${EVENT_HANDLER_PREFIX}${attribute.value}\n}`, "script", undefined, true);
        }
      const type = (
        current.attrs.find((attribute) => attribute.name === "type")?.value ?? ""
      ).trim().toLowerCase();
      if (current.tagName === "script" && (type === "module" || JAVASCRIPT_TYPES.has(type))) {
        const text = current.childNodes.filter(
          (child): child is DefaultTreeAdapterTypes.TextNode =>
            child.nodeName === "#text",
        );
        for (const child of text)
          if (child.sourceCodeLocation)
            ranges.push([child.sourceCodeLocation.startOffset, child.sourceCodeLocation.endOffset]);
        const sourceType = type === "module" ? "module" : "script",
          location = text.length === 1 ? text[0]?.sourceCodeLocation : undefined,
          source =
            location && text[0]
              ? verbatim(location.startOffset, location.endOffset, text[0].value)
              : undefined;
        if (location && source !== undefined) collect(source, sourceType, location.startOffset);
        else collect(text.map((child) => child.value).join(""), sourceType);
      } else if (current.tagName === "script")
        // A data block such as <script type="text/template"> holds markup.
        for (const child of current.childNodes)
          if (child.nodeName === "#text" && child.sourceCodeLocation) {
            const { startOffset, endOffset } = child.sourceCodeLocation;
            urlValues.push(...markupValueRanges(html.slice(startOffset, endOffset), startOffset));
          }
    }
    if ("childNodes" in current) current.childNodes.forEach(visit);
    if ("content" in current) visit(current.content);
  }
  visit(node);
  return { ranges, strings, urlValues, declarations, attributeWrites, imports };
}

// The start of a template literal that already makes it an absolute URL, as
// in `https://example.com/${name}.png`; data URLs are checked elsewhere. Like
// a browser, ignore tabs, newlines and leading control characters, and read a
// backslash as a slash.
function absoluteStart(node: AnyNode): string | undefined {
  const start = node.type === "TemplateLiteral" ? (node.quasis[0]?.value.cooked ?? "") : "";
  return /^[\s\0-\x1f]*(?:(?!data:)[a-z][a-z\d+.-]*:|[\\/]{2})/i.test(start.replace(/[\t\n\r]/g, ""))
    ? start
    : undefined;
}

// A property such as el.dataset.src names a data-* attribute, which loads
// nothing.
function datasetMember(node: AnyNode): boolean {
  return (
    node.type === "MemberExpression" &&
    !node.computed &&
    node.object.type === "MemberExpression" &&
    !node.object.computed &&
    node.object.property.type === "Identifier" &&
    node.object.property.name === "dataset"
  );
}

function literalText(node: AnyNode): string | undefined {
  if (node.type === "Literal" && typeof node.value === "string") return node.value;
  if (node.type === "TemplateLiteral" && node.expressions.length === 0)
    return node.quasis[0]?.value.cooked ?? undefined;
  return undefined;
}

export function checkUrl(attribute: string, value: string, issues: Issue[]) {
  const allowed =
    MANAGED_ASSET.test(value) ||
    (attribute === "href" && value.startsWith("#")) ||
    (attribute === "src" &&
      /^data:image\/(?:png|jpeg|gif|webp);base64,[a-z0-9+/=\s]+$/i.test(
        value,
      ));
  if (!allowed)
    issues.push({
      kind: "policy",
      message: `Unsupported ${attribute} URL.`,
    });
  if (/^javascript:/i.test(value))
    issues.push({
      kind: "policy",
      message: "JavaScript URLs are not allowed.",
    });
}

export function validateScripts(
  document: DefaultTreeAdapterTypes.Document,
  issues: Issue[],
) {
  function validateJavaScript(source: string, sourceType: "script" | "module") {
    try {
      parseJavaScript(source, { ecmaVersion: "latest", sourceType });
    } catch {
      issues.push({
        kind: "syntax",
        message: "Inline JavaScript must use valid syntax.",
      });
    }
  }
  function visit(node: DefaultTreeAdapterTypes.Node) {
    if ("tagName" in node) {
      const attributes = new Map(
        node.attrs.map((attribute) => [attribute.name, attribute.value]),
      );
      if (node.tagName === "meta" && attributes.get("http-equiv")?.trim().toLowerCase() === "refresh") {
        issues.push({ kind: "policy", message: "Redirecting URLs are not allowed." });
      }
      for (const [name, value] of attributes) {
        if (/^on[a-z]+$/.test(name))
          validateJavaScript(`function eventHandler(event) {\n${value}\n}`, "script");
      }
      if (node.tagName === "script") {
        if (attributes.has("src")) {
          issues.push({
            kind: "policy",
            message: "External scripts are not allowed.",
          });
        } else if (!node.sourceCodeLocation?.endTag) {
          issues.push({
            kind: "structure",
            message: "Script elements must have a closing tag.",
          });
        } else {
          const type = (attributes.get("type") ?? "").trim().toLowerCase();
          if (type === "importmap" || type === "speculationrules") {
            issues.push({
              kind: "policy",
              message: "Import maps and speculation rules are not allowed.",
            });
          } else if (type === "module" || JAVASCRIPT_TYPES.has(type)) {
            const source = node.childNodes
              .filter(
                (child): child is DefaultTreeAdapterTypes.TextNode =>
                  child.nodeName === "#text",
              )
              .map((child) => child.value)
              .join("");
            validateJavaScript(source, type === "module" ? "module" : "script");
          }
        }
      }
    }
    if ("childNodes" in node) node.childNodes.forEach(visit);
    if ("content" in node) visit(node.content);
  }
  visit(document);
}
