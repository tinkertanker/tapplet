import { parse as parseJavaScript, tokenizer, tokTypes, type AnyNode } from "acorn";
import { parse as parseHtml, type DefaultTreeAdapterTypes } from "parse5";
import type {
  DesignCard,
  Exemplar,
  GeneratedArtifact,
  ModelProvider,
  RepairContext,
  TeacherBrief,
} from "./ai/provider";
import { MODEL_CALL_TIMEOUT_MS, ModelProviderError } from "./ai/provider";
import type {
  ArtifactOperation,
  OperationalTraceContext,
} from "./operationalTrace";
import { emitOperationalTrace } from "./operationalTrace";
export const PUBLIC_REPORT_MARKER = "data-studio-report";
export type Issue =
  | { kind: "shape"; message: string }
  | { kind: "structure"; message: string }
  | { kind: "policy"; message: string }
  | { kind: "syntax"; message: string }
  | { kind: "asset"; message: string; assetId: string };
export type Issues = readonly [Issue, ...Issue[]];
export class InvalidModelOutputError extends Error {
  readonly issues: string[];
  constructor(readonly diagnosed: Issues) {
    super("Invalid generated HTML");
    this.issues = [...new Set(diagnosed.map((issue) => issue.message))];
  }
}
export interface RequiredManagedAsset {
  id: string;
  alternativeText: string | null;
  decorative: boolean;
}
const MAX_HTML_BYTES = 200_000;
const MAX_COMMENT_CHARACTERS = 600;
export const DEFAULT_MAX_MODEL_REPAIRS = 2;
// The iPad waits 150 seconds. Start a repair only if a full model call still
// fits in this budget, leaving time for retrieval, moderation and storage.
export const MODEL_WORK_BUDGET_MS = 135_000;
const URL_ATTRIBUTE =
  /\b(src|href|action|formaction)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gis;
const CSS_URL = /\burl\(\s*(?:"([^"]*)"|'([^']*)'|([^\s"')]+))\s*\)/gis;
const MANAGED_ASSET = /^assets\/([A-Za-z0-9_-]+)$/;
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

type ParsedHtml = {
  html: string;
  designCard?: DesignCard;
  comment?: string;
  referencedImages: ReadonlySet<string>;
  bodyEnd?: number;
};

type Inspection =
  | { status: "accepted"; artifact: GeneratedArtifact }
  | {
      status: "rejected";
      candidate: unknown;
      issues: Issues;
      parsed?: ParsedHtml;
    };

type RepairIntent =
  | { action: "generate"; brief: TeacherBrief }
  | { action: "revise"; brief: TeacherBrief; instruction: string };

export interface GenerationOptions {
  maxModelRepairs?: number;
  trace?: OperationalTraceContext;
  sessionId?: string;
  startedAt?: number;
}

function attributeValue(match: RegExpMatchArray): string {
  return match[2] ?? match[3] ?? match[4] ?? "";
}

function normalizeAssetUrl(value: string): string {
  return value.trim();
}

export function referencedAssetIds(html: string): string[] {
  const ids: string[] = [];
  for (const match of html.matchAll(URL_ATTRIBUTE)) {
    const asset = MANAGED_ASSET.exec(normalizeAssetUrl(attributeValue(match)));
    if (asset?.[1]) ids.push(asset[1]);
  }
  for (const match of html.matchAll(CSS_URL)) {
    const asset = MANAGED_ASSET.exec(normalizeAssetUrl(match[1] ?? match[2] ?? match[3] ?? ""));
    if (asset?.[1]) ids.push(asset[1]);
  }
  return [...new Set(ids)];
}

function referencedImageAssetIdsFrom(
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

function hasMultiSourceAttribute(node: DefaultTreeAdapterTypes.Node): boolean {
  if (
    "tagName" in node &&
    node.attrs.some((attribute) => attribute.name === "srcset" || attribute.name === "poster")
  )
    return true;
  if ("childNodes" in node && node.childNodes.some(hasMultiSourceAttribute)) return true;
  return "content" in node && hasMultiSourceAttribute(node.content);
}

// Source offsets of the src, href, action and formaction names in real attributes,
// including prefixed names such as xlink:href.
function urlAttributeOffsets(node: DefaultTreeAdapterTypes.Node): Set<number> {
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
// and the source offsets of script variables named like URL attributes.
function scriptSources(
  node: DefaultTreeAdapterTypes.Node,
  html: string,
): {
  ranges: Array<readonly [number, number]>;
  strings: string[];
  declarations: Set<number>;
} {
  const ranges: Array<readonly [number, number]> = [];
  const strings: string[] = [];
  const declarations = new Set<number>();
  // offset is where source starts in html when html holds it verbatim.
  function collect(
    source: string,
    sourceType: "script" | "module",
    offset?: number,
    handler = false,
  ) {
    try {
      for (const token of tokenizer(source, { ecmaVersion: "latest", sourceType })) {
        const value: unknown = Reflect.get(token, "value");
        if (
          (token.type === tokTypes.string || token.type === tokTypes.template) &&
          typeof value === "string"
        )
          strings.push(value);
      }
    } catch {
      // Invalid syntax is reported by validateScripts.
    }
    if (offset === undefined) return;
    let program: unknown;
    try {
      program = parseJavaScript(source, { ecmaVersion: "latest", sourceType });
    } catch {
      return;
    }
    // A script variable loads nothing, but in an event handler or a with
    // statement a bare name such as src can assign the element's property.
    const found: number[] = [];
    let usesWith = false;
    visitJavaScript(program, (current) => {
      if (current.type === "WithStatement") usesWith = true;
      const name =
        current.type === "VariableDeclarator"
          ? current.id
          : current.type === "AssignmentExpression" && !handler
            ? current.left
            : undefined;
      if (name?.type === "Identifier" && /^(?:src|href|action|formaction|srcset|poster)$/i.test(name.name))
        found.push(offset + name.start);
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
          else collect(`${EVENT_HANDLER_PREFIX}${attribute.value}\n}`, "script");
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
      }
    }
    if ("childNodes" in current) current.childNodes.forEach(visit);
    if ("content" in current) visit(current.content);
  }
  visit(node);
  return { ranges, strings, declarations };
}

function checkUrl(attribute: string, value: string, issues: Issue[]) {
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

function rejected(
  candidate: unknown,
  issues: Issue[],
  parsed?: ParsedHtml,
): Inspection {
  const first = issues[0];
  if (first === undefined) {
    throw new Error("Rejected inspection needs at least one issue.");
  }
  return {
    status: "rejected",
    candidate,
    issues: [first, ...issues.slice(1)],
    parsed,
  };
}

function validateScripts(
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

function inspect(
  candidate: unknown,
  requiredAssets: readonly RequiredManagedAsset[],
): Inspection {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate))
    return rejected(candidate, [
      { kind: "shape", message: "Output must be exactly a JSON object." },
    ]);
  const keys = Object.keys(candidate);
  const issues: Issue[] = [];
  if (keys.some((k) => k !== "html" && k !== "designCard" && k !== "comment"))
    issues.push({
      kind: "shape",
      message: "Only html, designCard and comment are allowed.",
    });
  const html = Reflect.get(candidate, "html");
  const card = Reflect.get(candidate, "designCard");
  const comment = teacherComment(Reflect.get(candidate, "comment"));
  let parsed: ParsedHtml | undefined;
  if (typeof html !== "string" || !html.trim())
    issues.push({ kind: "shape", message: "html must be nonempty." });
  else {
    let bodyEnd: number | undefined;
    const document = parseHtml(html, { sourceCodeLocationInfo: true });
    function findBodyEnd(node: DefaultTreeAdapterTypes.Node) {
      if ("tagName" in node && node.tagName === "body")
        bodyEnd = node.sourceCodeLocation?.endTag?.startOffset;
      if ("childNodes" in node) node.childNodes.forEach(findBodyEnd);
    }
    findBodyEnd(document);
    const parsedHtml: ParsedHtml = {
      html,
      referencedImages: referencedImageAssetIdsFrom(document),
      bodyEnd,
      ...(card !== undefined &&
      card !== null &&
      typeof card === "object" &&
      !Array.isArray(card)
        ? { designCard: card as DesignCard }
        : {}),
      ...(comment ? { comment } : {}),
    };
    parsed = parsedHtml;
    if (new TextEncoder().encode(html).byteLength > MAX_HTML_BYTES)
      issues.push({ kind: "structure", message: "HTML exceeds 200KB." });
    if (
      !/^\s*<!doctype html>/i.test(html) ||
      !/<html[\s>]/i.test(html) ||
      !/<head[\s>][\s\S]*?<\/head>/i.test(html) ||
      !/<body[\s>][\s\S]*?<\/body>/i.test(html) ||
      !/<\/html>\s*$/i.test(html)
    )
      issues.push({
        kind: "structure",
        message: "HTML must be a complete document with head and body elements.",
      });
    if (/<(?:base|iframe|object|embed)\b/i.test(html))
      issues.push({
        kind: "policy",
        message: "Embedded documents and base URLs are not allowed.",
      });
    const scripts = scriptSources(document, html);
    // Check real attributes, markup in script strings, stored markup such as
    // data attributes and property writes; a script variable named poster (for
    // a poster-design activity) loads nothing.
    if (
      hasMultiSourceAttribute(document) ||
      scripts.strings.some((value) => /(?<![\w-])(?:srcset|poster)\s*=/i.test(value)) ||
      [...html.matchAll(/(?<![\w-])(?:srcset|poster)\s*=(?![=>])/gi)].some(
        (match) => !scripts.declarations.has(match.index ?? 0),
      ) ||
      /\.\s*(?:srcset|poster)\s*=(?!=)|setAttribute\s*\(\s*["'](?:srcset|poster)["']/i.test(html)
    )
      issues.push({
        kind: "policy",
        message: "Redirecting and multi-source URLs are not allowed.",
      });
    const urlAttributes = urlAttributeOffsets(document);
    for (const match of html.matchAll(URL_ATTRIBUTE)) {
      const index = match.index ?? 0;
      // data-action, data-src and similar custom attributes load nothing.
      if (html[index - 1] === "-") continue;
      const attribute = (match[1] ?? "").toLowerCase(),
        value = normalizeAssetUrl(attributeValue(match));
      // A script variable named src, href, action or formaction loads nothing.
      // Markup in script strings, other text and property writes are checked.
      if (!urlAttributes.has(index) && scripts.declarations.has(index)) continue;
      checkUrl(attribute, value, issues);
    }
    // Markup in script strings can start a line or follow punctuation, so check
    // its URL attributes regardless of the variable heuristic above.
    for (const string of scripts.strings)
      for (const match of string.matchAll(URL_ATTRIBUTE))
        if (string[(match.index ?? 0) - 1] !== "-")
          checkUrl(
            (match[1] ?? "").toLowerCase(),
            normalizeAssetUrl(attributeValue(match)),
            issues,
          );
    for (const match of html.matchAll(CSS_URL)) {
      const value = normalizeAssetUrl(match[1] ?? match[2] ?? match[3] ?? "");
      if (!MANAGED_ASSET.test(value) && !/^data:image\//i.test(value))
        issues.push({
          kind: "policy",
          message: "Unsupported CSS URL.",
        });
    }
    if (
      /@import\b/i.test(html) ||
      /\b(?:import\b\s*(?:\(|[^;]*?from\s*)|require\s*\()["']/i.test(html)
    )
      issues.push({
        kind: "policy",
        message: "External packages and imports are not allowed.",
      });
    if (
      /\b(?:fetch\s*\(|XMLHttpRequest\b|WebSocket\s*\(|EventSource\s*\(|sendBeacon\s*\(|import\s*\(|serviceWorker\b)/i.test(
        html,
      )
    )
      issues.push({
        kind: "policy",
        message: "Network APIs are not allowed.",
      });
    if (
      /\b(?:localStorage|sessionStorage|indexedDB)\b|\bcaches\.(?:open|match|matchAll|has|keys|delete)\b|document\.cookie/i.test(
        html,
      ) ||
      // "caches" is also an ordinary word in visible text, but any reference
      // in a script or event handler can reach the Cache API.
      scripts.ranges.some(([start, end]) => /\bcaches\b/i.test(html.slice(start, end)))
    )
      issues.push({
        kind: "policy",
        message:
          "Storage APIs are not allowed; applets must keep all state in memory.",
      });
    validateScripts(document, issues);
    if (new RegExp(PUBLIC_REPORT_MARKER, "i").test(html))
      issues.push({
        kind: "policy",
        message: "Reserved server report marker is not allowed.",
      });
    const missing = [...new Set(requiredAssets.map((asset) => asset.id))].filter(
      (id) => !parsedHtml.referencedImages.has(id),
    );
    for (const id of missing)
      issues.push({
        kind: "asset",
        assetId: id,
        message: `HTML must include an img with the required managed image URL assets/${id}.`,
      });
  }
  if (card !== undefined) {
    const cardIssues: Issue[] = [];
    if (card === null || typeof card !== "object" || Array.isArray(card))
      cardIssues.push({ kind: "shape", message: "designCard must be an object." });
    else {
      const value = card as Record<string, unknown>;
      if (
        value.title !== undefined &&
        (typeof value.title !== "string" ||
          !value.title.trim() ||
          value.title.length > 200)
      )
        cardIssues.push({
          kind: "shape",
          message:
            "designCard.title must be a nonempty string up to 200 characters.",
        });
      if (
        value.description !== undefined &&
        (typeof value.description !== "string" ||
          value.description.length > 1000)
      )
        cardIssues.push({
          kind: "shape",
          message:
            "designCard.description must be a string up to 1000 characters.",
        });
      if (
        value.tags !== undefined &&
        (!Array.isArray(value.tags) ||
          value.tags.length > 20 ||
          value.tags.some(
            (tag) => typeof tag !== "string" || !tag.trim() || tag.length > 50,
          ))
      )
        cardIssues.push({
          kind: "shape",
          message: "designCard.tags must contain up to 20 short strings.",
        });
    }
    // Optional metadata must never discard valid HTML or spend a model repair.
    if (cardIssues.length && parsed) delete parsed.designCard;
  }
  if (issues.length) return rejected(candidate, issues, parsed);
  if (!parsed) return rejected(candidate, [{ kind: "shape", message: "html must be nonempty." }]);
  return {
    status: "accepted",
    artifact: {
      html: parsed.html,
      ...(parsed.designCard === undefined ? {} : { designCard: parsed.designCard }),
      ...(parsed.comment === undefined ? {} : { comment: parsed.comment }),
    },
  };
}

// The teacher-facing note is optional: a missing, blank or oversized comment is
// dropped rather than discarding valid HTML or spending a model repair.
function teacherComment(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= MAX_COMMENT_CHARACTERS ? trimmed : undefined;
}

function escapeHtmlAttribute(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character]!,
  );
}

function missingRequiredAssets(
  issues: readonly Issue[],
  requiredAssets: readonly RequiredManagedAsset[],
): RequiredManagedAsset[] {
  const byId = new Map(requiredAssets.map((asset) => [asset.id, asset]));
  const seen = new Set<string>();
  const missing: RequiredManagedAsset[] = [];
  for (const issue of issues) {
    if (issue.kind !== "asset" || seen.has(issue.assetId)) continue;
    seen.add(issue.assetId);
    const asset = byId.get(issue.assetId);
    if (asset) missing.push(asset);
  }
  return missing;
}

function envelopeAfterInsert(html: string, candidate: unknown) {
  const next: Record<string, unknown> = { html };
  if (
    candidate &&
    typeof candidate === "object" &&
    !Array.isArray(candidate) &&
    "designCard" in candidate
  )
    next.designCard = Reflect.get(candidate, "designCard");
  if (
    candidate &&
    typeof candidate === "object" &&
    !Array.isArray(candidate) &&
    "comment" in candidate
  )
    next.comment = Reflect.get(candidate, "comment");
  return next;
}

function applyHostInsert(
  inspection: Inspection,
  requiredAssets: readonly RequiredManagedAsset[],
): Inspection {
  if (inspection.status === "accepted") return inspection;
  const parsed = inspection.parsed;
  if (parsed?.bodyEnd === undefined) return inspection;
  const missing = missingRequiredAssets(inspection.issues, requiredAssets);
  if (!missing.length) return inspection;
  const markup = missing
    .map((asset) => {
      const alt = asset.decorative
        ? ""
        : escapeHtmlAttribute(asset.alternativeText ?? "");
      return `<figure data-tapplet-managed-image="${asset.id}" style="margin:1rem auto;text-align:center"><img src="assets/${asset.id}" alt="${alt}"${asset.decorative ? ' role="presentation" aria-hidden="true"' : ""} style="max-width:100%;height:auto"></figure>`;
    })
    .join("\n");
  return inspect(
    envelopeAfterInsert(
      `${parsed.html.slice(0, parsed.bodyEnd)}\n${markup}\n${parsed.html.slice(parsed.bodyEnd)}`,
      inspection.candidate,
    ),
    requiredAssets,
  );
}

function repairContext(intent: RepairIntent, final: boolean): RepairContext {
  return {
    brief: intent.brief,
    ...(intent.action === "revise" ? { instruction: intent.instruction } : {}),
    ...(final ? { final: true } : {}),
  };
}

async function accept(
  provider: ModelProvider,
  candidate: unknown,
  intent: RepairIntent,
  requiredAssets: readonly RequiredManagedAsset[] = [],
  options: GenerationOptions = {},
): Promise<GeneratedArtifact> {
  let current = candidate;
  const maxRepairs = options.maxModelRepairs ?? DEFAULT_MAX_MODEL_REPAIRS;
  if (!Number.isInteger(maxRepairs) || maxRepairs < 0 || maxRepairs > 2)
    throw new RangeError("maxModelRepairs must be a whole number from 0 to 2.");
  for (let repairs = 0; ; repairs += 1) {
    const initialInspection = inspect(current, requiredAssets);
    const insertedAssetCount = initialInspection.status === "rejected"
      ? missingRequiredAssets(initialInspection.issues, requiredAssets).length
      : 0;
    const inspection = applyHostInsert(
      initialInspection,
      requiredAssets,
    );
    if (options.trace) {
      emitOperationalTrace(options.trace.sink, {
        kind: "artifact_validation",
        requestId: options.trace.requestId,
        operation: intent.action satisfies ArtifactOperation,
        attempt: repairs,
        maxRepairs,
        status: inspection.status,
        issueKinds: inspection.status === "rejected"
          ? [...new Set(inspection.issues.map((issue) => issue.kind))]
          : [],
        issueCount: inspection.status === "rejected" ? inspection.issues.length : 0,
        ...(inspection.status === "accepted"
          ? { outputBytes: new TextEncoder().encode(inspection.artifact.html).byteLength }
          : {}),
        hostInsertedAssetCount: insertedAssetCount,
      });
    }
    if (inspection.status === "accepted") return inspection.artifact;
    if (repairs === maxRepairs)
      throw new InvalidModelOutputError(inspection.issues);
    if (
      options.startedAt !== undefined &&
      Date.now() - options.startedAt + MODEL_CALL_TIMEOUT_MS > MODEL_WORK_BUDGET_MS
    )
      throw new ModelProviderError("No time left to repair the model output.", true);
    const issues = [...new Set(inspection.issues.map((issue) => issue.message))];
    const context = repairContext(intent, repairs === maxRepairs - 1);
    current = await provider.repair(
      inspection.candidate,
      issues,
      context,
      options.trace,
      options.sessionId,
    );
  }
}

export function validateHtmlOutput(value: unknown): GeneratedArtifact {
  const inspection = inspect(value, []);
  if (inspection.status === "accepted") return inspection.artifact;
  throw new InvalidModelOutputError(inspection.issues);
}

export async function generateArtifact(
  provider: ModelProvider,
  brief: TeacherBrief,
  exemplars: Exemplar[] = [],
  options: GenerationOptions = {},
) {
  const sessionId = options.sessionId ?? crypto.randomUUID();
  const startedAt = Date.now();
  return accept(
    provider,
    await provider.generate(brief, exemplars.slice(0, 2), options.trace, sessionId),
    { action: "generate", brief },
    [],
    { ...options, sessionId, startedAt },
  );
}

export async function reviseArtifact(
  provider: ModelProvider,
  html: string,
  card: DesignCard | undefined,
  instruction: string,
  brief: TeacherBrief,
  requiredAssets: RequiredManagedAsset[] = [],
  options: GenerationOptions = {},
) {
  const sessionId = options.sessionId ?? crypto.randomUUID();
  const startedAt = Date.now();
  return accept(
    provider,
    await provider.revise(html, card, instruction, brief, options.trace, sessionId),
    { action: "revise", brief, instruction },
    requiredAssets,
    { ...options, sessionId, startedAt },
  );
}
