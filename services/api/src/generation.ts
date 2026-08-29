import { parse as parseJavaScript } from "acorn";
import { parse as parseHtml, type DefaultTreeAdapterTypes } from "parse5";
import type {
  DesignCard,
  Exemplar,
  GeneratedArtifact,
  ModelProvider,
  RepairContext,
  TeacherBrief,
} from "./ai/provider";
import type {
  ArtifactOperation,
  OperationalTraceContext,
} from "./operationalTrace";
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
export const DEFAULT_MAX_MODEL_REPAIRS = 2;
const URL_ATTRIBUTE =
  /\b(src|href|action)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gis;
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
}

function attributeValue(match: RegExpMatchArray): string {
  return match[2] ?? match[3] ?? match[4] ?? "";
}

export function referencedAssetIds(html: string): string[] {
  const ids: string[] = [];
  for (const match of html.matchAll(URL_ATTRIBUTE)) {
    const asset = MANAGED_ASSET.exec(attributeValue(match));
    if (asset?.[1]) ids.push(asset[1]);
  }
  for (const match of html.matchAll(CSS_URL)) {
    const asset = MANAGED_ASSET.exec(match[1] ?? match[2] ?? match[3] ?? "");
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
        asset = source && MANAGED_ASSET.exec(source);
      if (asset?.[1]) ids.add(asset[1]);
    }
    if ("childNodes" in node) node.childNodes.forEach(visit);
  }
  visit(document);
  return ids;
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
  if (keys.some((k) => k !== "html" && k !== "designCard"))
    issues.push({
      kind: "shape",
      message: "Only html and designCard are allowed.",
    });
  const html = Reflect.get(candidate, "html");
  const card = Reflect.get(candidate, "designCard");
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
    if (/\b(?:srcset|poster)\s*=/i.test(html) || /<meta\b[^>]*http-equiv\s*=\s*["']?refresh/i.test(html))
      issues.push({
        kind: "policy",
        message: "Redirecting and multi-source URLs are not allowed.",
      });
    for (const match of html.matchAll(URL_ATTRIBUTE)) {
      const attribute = (match[1] ?? "").toLowerCase(),
        value = attributeValue(match).trim();
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
    for (const match of html.matchAll(CSS_URL)) {
      const value = (match[1] ?? match[2] ?? match[3] ?? "").trim();
      if (!MANAGED_ASSET.test(value) && !/^data:image\//i.test(value))
        issues.push({
          kind: "policy",
          message: "Unsupported CSS URL.",
        });
    }
    if (
      /@import\b/i.test(html) ||
      /\b(?:import\s*(?:\(|[^;]*?from\s*)|require\s*\()["']/i.test(html)
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
      /\b(?:localStorage|sessionStorage|indexedDB|caches)\b|document\.cookie/i.test(
        html,
      )
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
    if (card === null || typeof card !== "object" || Array.isArray(card))
      issues.push({ kind: "shape", message: "designCard must be an object." });
    else {
      const value = card as Record<string, unknown>;
      if (
        value.title !== undefined &&
        (typeof value.title !== "string" ||
          !value.title.trim() ||
          value.title.length > 200)
      )
        issues.push({
          kind: "shape",
          message:
            "designCard.title must be a nonempty string up to 200 characters.",
        });
      if (
        value.description !== undefined &&
        (typeof value.description !== "string" ||
          value.description.length > 1000)
      )
        issues.push({
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
        issues.push({
          kind: "shape",
          message: "designCard.tags must contain up to 20 short strings.",
        });
    }
  }
  if (issues.length) return rejected(candidate, issues, parsed);
  if (!parsed) return rejected(candidate, [{ kind: "shape", message: "html must be nonempty." }]);
  return {
    status: "accepted",
    artifact: {
      html: parsed.html,
      ...(parsed.designCard === undefined ? {} : { designCard: parsed.designCard }),
    },
  };
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
    options.trace?.sink.emit({
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
    if (inspection.status === "accepted") return inspection.artifact;
    if (repairs === maxRepairs)
      throw new InvalidModelOutputError(inspection.issues);
    const issues = [...new Set(inspection.issues.map((issue) => issue.message))];
    const context = repairContext(intent, repairs === maxRepairs - 1);
    current = options.trace
      ? await provider.repair(
          inspection.candidate,
          issues,
          context,
          options.trace,
        )
      : await provider.repair(inspection.candidate, issues, context);
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
  return accept(
    provider,
    await provider.generate(brief, exemplars.slice(0, 2), options.trace),
    { action: "generate", brief },
    [],
    options,
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
  return accept(
    provider,
    await provider.revise(html, card, instruction, brief, options.trace),
    { action: "revise", brief, instruction },
    requiredAssets,
    options,
  );
}
