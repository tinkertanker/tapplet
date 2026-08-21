import { parse as parseJavaScript } from "acorn";
import { parse as parseHtml, type DefaultTreeAdapterTypes } from "parse5";
import type {
  DesignCard,
  Exemplar,
  GeneratedArtifact,
  ModelProvider,
  TeacherBrief,
} from "./ai/provider";
export const PUBLIC_REPORT_MARKER = "data-studio-report";
export class InvalidModelOutputError extends Error {
  constructor(readonly issues: string[]) {
    super("Invalid generated HTML");
  }
}
const MAX_HTML_BYTES = 200_000;
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

function validateScripts(html: string, issues: string[]) {
  const document = parseHtml(html, { sourceCodeLocationInfo: true });
  function validateJavaScript(source: string, sourceType: "script" | "module") {
    try {
      parseJavaScript(source, { ecmaVersion: "latest", sourceType });
    } catch {
      issues.push("Inline JavaScript must use valid syntax.");
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
          issues.push("External scripts are not allowed.");
        } else if (!node.sourceCodeLocation?.endTag) {
          issues.push("Script elements must have a closing tag.");
        } else {
          const type = (attributes.get("type") ?? "").trim().toLowerCase();
          if (type === "importmap" || type === "speculationrules") {
            issues.push("Import maps and speculation rules are not allowed.");
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

export function validateHtmlOutput(value: unknown): GeneratedArtifact {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new InvalidModelOutputError([
      "Output must be exactly a JSON object.",
    ]);
  const keys = Object.keys(value);
  if (keys.some((k) => k !== "html" && k !== "designCard"))
    throw new InvalidModelOutputError([
      "Only html and designCard are allowed.",
    ]);
  const html = Reflect.get(value, "html");
  const card = Reflect.get(value, "designCard");
  const issues: string[] = [];
  if (typeof html !== "string" || !html.trim())
    issues.push("html must be nonempty.");
  else {
    if (new TextEncoder().encode(html).byteLength > MAX_HTML_BYTES)
      issues.push("HTML exceeds 200KB.");
    if (
      !/^\s*<!doctype html>/i.test(html) ||
      !/<html[\s>]/i.test(html) ||
      !/<head[\s>][\s\S]*?<\/head>/i.test(html) ||
      !/<body[\s>][\s\S]*?<\/body>/i.test(html) ||
      !/<\/html>\s*$/i.test(html)
    )
      issues.push("HTML must be a complete document with head and body elements.");
    if (/<(?:base|iframe|object|embed)\b/i.test(html))
      issues.push("Embedded documents and base URLs are not allowed.");
    if (/\b(?:srcset|poster)\s*=/i.test(html) || /<meta\b[^>]*http-equiv\s*=\s*["']?refresh/i.test(html))
      issues.push("Redirecting and multi-source URLs are not allowed.");
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
      if (!allowed) issues.push(`Unsupported ${attribute} URL.`);
      if (/^javascript:/i.test(value))
        issues.push("JavaScript URLs are not allowed.");
    }
    for (const match of html.matchAll(CSS_URL)) {
      const value = (match[1] ?? match[2] ?? match[3] ?? "").trim();
      if (!MANAGED_ASSET.test(value) && !/^data:image\//i.test(value))
        issues.push("Unsupported CSS URL.");
    }
    if (
      /@import\b/i.test(html) ||
      /\b(?:import\s*(?:\(|[^;]*?from\s*)|require\s*\()["']/i.test(html)
    )
      issues.push("External packages and imports are not allowed.");
    if (
      /\b(?:fetch\s*\(|XMLHttpRequest\b|WebSocket\s*\(|EventSource\s*\(|sendBeacon\s*\(|import\s*\(|serviceWorker\b)/i.test(
        html,
      )
    )
      issues.push("Network APIs are not allowed.");
    if (
      /\b(?:localStorage|sessionStorage|indexedDB|caches)\b|document\.cookie/i.test(
        html,
      )
    )
      issues.push(
        "Storage APIs are not allowed; applets must keep all state in memory.",
      );
    validateScripts(html, issues);
    if (new RegExp(PUBLIC_REPORT_MARKER, "i").test(html))
      issues.push("Reserved server report marker is not allowed.");
  }
  if (card !== undefined) {
    if (card === null || typeof card !== "object" || Array.isArray(card))
      issues.push("designCard must be an object.");
    else {
      const value = card as Record<string, unknown>;
      if (
        value.title !== undefined &&
        (typeof value.title !== "string" ||
          !value.title.trim() ||
          value.title.length > 200)
      )
        issues.push(
          "designCard.title must be a nonempty string up to 200 characters.",
        );
      if (
        value.description !== undefined &&
        (typeof value.description !== "string" ||
          value.description.length > 1000)
      )
        issues.push(
          "designCard.description must be a string up to 1000 characters.",
        );
      if (
        value.tags !== undefined &&
        (!Array.isArray(value.tags) ||
          value.tags.length > 20 ||
          value.tags.some(
            (tag) => typeof tag !== "string" || !tag.trim() || tag.length > 50,
          ))
      )
        issues.push("designCard.tags must contain up to 20 short strings.");
    }
  }
  if (issues.length) throw new InvalidModelOutputError(issues);
  return {
    html,
    ...(card === undefined ? {} : { designCard: card as DesignCard }),
  };
}
function validateCandidate(
  candidate: unknown,
  requiredAssetIds: string[],
): GeneratedArtifact {
  const artifact = validateHtmlOutput(candidate),
    referenced = new Set(referencedAssetIds(artifact.html)),
    missing = [...new Set(requiredAssetIds)].filter((id) => !referenced.has(id));
  if (missing.length)
    throw new InvalidModelOutputError(
      missing.map(
        (id) =>
          `HTML must reference the required managed image URL assets/${id} in src, href or CSS url().`,
      ),
    );
  return artifact;
}

async function oneRepair(
  provider: ModelProvider,
  candidate: unknown,
  requiredAssetIds: string[] = [],
): Promise<GeneratedArtifact> {
  try {
    return validateCandidate(candidate, requiredAssetIds);
  } catch (error) {
    if (!(error instanceof InvalidModelOutputError)) throw error;
    return validateCandidate(
      await provider.repair(candidate, error.issues),
      requiredAssetIds,
    );
  }
}
export async function generateArtifact(
  provider: ModelProvider,
  brief: TeacherBrief,
  exemplars: Exemplar[] = [],
) {
  return oneRepair(
    provider,
    await provider.generate(brief, exemplars.slice(0, 2)),
  );
}
export async function reviseArtifact(
  provider: ModelProvider,
  html: string,
  card: DesignCard | undefined,
  instruction: string,
  brief: TeacherBrief,
  requiredAssetIds: string[] = [],
) {
  return oneRepair(
    provider,
    await provider.revise(html, card, instruction, brief),
    requiredAssetIds,
  );
}
