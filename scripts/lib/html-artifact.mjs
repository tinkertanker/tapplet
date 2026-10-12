import { parse as parseJavaScript, tokenizer, tokTypes } from 'acorn';
import { parse as parseHtml } from 'parse5';

export const MAX_HTML_BYTES = 200_000;

// formaction is checked here as well as src, href and action. The value is
// matched in a lookahead so a value never hides a later name, as in
// `var action = href = "https://..."`.
const URL_ATTRIBUTE = /\b(src|href|action|formaction)(?=\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))/gis;
const MANAGED_ASSET = /^assets\/[A-Za-z0-9_-]+$/;

const JAVASCRIPT_TYPES = new Set([
  '', 'application/ecmascript', 'application/javascript',
  'application/x-ecmascript', 'application/x-javascript',
  'text/ecmascript', 'text/javascript', 'text/javascript1.0',
  'text/javascript1.1', 'text/javascript1.2', 'text/javascript1.3',
  'text/javascript1.4', 'text/javascript1.5', 'text/jscript',
  'text/livescript', 'text/x-ecmascript', 'text/x-javascript',
]);

const REQUIRED_MANIFEST_FIELDS = [
  'id',
  'filename',
  'title',
  'summary',
  'subject',
  'level',
  'locale',
  'learningObjective',
  'tags',
  'interactionPattern',
  'descriptor',
  'designCard',
];

export function validateHtmlArtifact(html, options = {}) {
  const issues = [];
  const bytes = Buffer.byteLength(html, 'utf8');
  const add = (code, message) => issues.push({ code, message });

  if (bytes > (options.maxBytes ?? MAX_HTML_BYTES)) add('size', `HTML is ${bytes} bytes; maximum is ${options.maxBytes ?? MAX_HTML_BYTES}.`);
  if (!/^\s*<!doctype html>/i.test(html)) add('doctype', 'A complete HTML document must begin with <!doctype html>.');
  if (!/<html\b[^>]*>[\s\S]*<\/html>\s*$/i.test(html)) add('document', 'A complete <html> document is required.');
  if (!/<head\b[^>]*>[\s\S]*<\/head>/i.test(html) || !/<body\b[^>]*>[\s\S]*<\/body>/i.test(html)) {
    add('document', 'Both <head> and <body> are required.');
  }
  if (!/<html\b[^>]*\blang=["'][^"']+["']/i.test(html)) add('locale', 'The <html> element needs a lang attribute.');
  if (!/<meta\b[^>]*name=["']viewport["']/i.test(html)) add('viewport', 'A viewport meta tag is required for touch devices.');
  if (!/<title\b[^>]*>[^<]+<\/title>/i.test(html)) add('title', 'A non-empty document title is required.');
  if (!/<style\b[^>]*>[\s\S]*<\/style>/i.test(html)) add('inline-css', 'Include readable inline CSS.');
  if (!/<script\b[^>]*>[\s\S]*<\/script>/i.test(html)) add('inline-js', 'Include inline JavaScript for the interaction.');

  const forbidden = [
    [/<link\b[^>]*(?<![\w-])rel=["']?(?:stylesheet|modulepreload|preload)/i, 'external-resource', 'External styles and preload links are not allowed.'],
    [/@import\b|\bimport\b\s*(?:\(|[^;]*?from\s*)["']|\brequire\s*\(["']/i, 'package-import', 'Package and stylesheet imports are not allowed.'],
    [/\b(?:fetch\s*\(|XMLHttpRequest\b|WebSocket\s*\(|EventSource\s*\(|sendBeacon\s*\(|import\s*\(|serviceWorker\b)/i, 'network', 'Network APIs are not allowed.'],
  ];
  forbidden.forEach(([pattern, code, message]) => {
    if (pattern.test(html)) add(code, message);
  });

  // URL rules match the API's validateHtmlOutput so evaluations and live
  // checks accept and reject the same tapplets production does.
  const document = parseHtml(html, { sourceCodeLocationInfo: true });
  if (/<(?:base|iframe|object|embed)\b/i.test(html)) add('external-resource', 'Embedded documents and base URLs are not allowed.');
  const scripts = scriptSources(document, html);
  if (scripts.imports) add('package-import', 'Package and stylesheet imports are not allowed.');
  // Check real attributes, markup in script strings, stored markup such as
  // data attributes and property writes; a script variable named poster (for
  // a poster-design activity) loads nothing.
  if (
    hasMultiSourceAttribute(document)
    || scripts.strings.some((value) => /(?<![\w-])(?:srcset|poster)\s*=/i.test(value))
    || [...html.matchAll(/(?<![\w-])(?:srcset|poster)\s*=(?![=>])/gi)].some((match) => !scripts.declarations.has(match.index ?? 0))
    || /\.\s*(?:srcset|poster)\s*=(?!=)|setAttribute\s*\(\s*["'](?:srcset|poster)["']/i.test(html)
  ) add('external-resource', 'Redirecting and multi-source URLs are not allowed.');
  const checkUrl = (attribute, value) => {
    const allowed = MANAGED_ASSET.test(value)
      || (attribute === 'href' && value.startsWith('#'))
      || (attribute === 'src' && /^data:image\/(?:png|jpeg|gif|webp);base64,[a-z0-9+/=\s]+$/i.test(value));
    if (!allowed) add('external-resource', `External resource reference is not allowed: ${attribute}="${value}".`);
  };
  const attributeOffsets = urlAttributeOffsets(document);
  for (const match of html.matchAll(URL_ATTRIBUTE)) {
    const index = match.index ?? 0;
    // data-action, data-src and similar custom attributes load nothing.
    if (html[index - 1] === '-') continue;
    // A script variable named src, href, action or formaction loads nothing.
    // Markup in script strings, other text and property writes are checked.
    if (!attributeOffsets.has(index) && scripts.declarations.has(index)) continue;
    checkUrl(match[1].toLowerCase(), attributeValue(match).trim());
  }
  for (const { attribute, value } of scripts.attributeWrites) checkUrl(attribute, value.trim());
  for (const string of scripts.strings) {
    for (const match of string.matchAll(URL_ATTRIBUTE)) {
      if (string[(match.index ?? 0) - 1] !== '-') checkUrl(match[1].toLowerCase(), attributeValue(match).trim());
    }
  }
  if (
    /\b(?:localStorage|sessionStorage|indexedDB)\b|\bcaches\.(?:open|match|matchAll|has|keys|delete)\b|document\.cookie/i.test(html)
    // "caches" is also an ordinary word in visible text, but any reference
    // in a script or event handler can reach the Cache API.
    || scripts.ranges.some(([start, end]) => /\bcaches\b/i.test(html.slice(start, end)))
  ) add('storage', 'Storage APIs are not allowed; tapplets must keep all state in memory.');
  for (const match of html.matchAll(/\burl\(\s*(?:"([^"]*)"|'([^']*)'|([^\s"')]+))\s*\)/gis)) {
    const value = (match[1] ?? match[2] ?? match[3] ?? '').trim();
    if (!MANAGED_ASSET.test(value) && !/^data:image\//i.test(value)) add('external-resource', `External CSS resource is not allowed: ${value}.`);
  }

  function validateJavaScript(source, sourceType) {
    try {
      parseJavaScript(source, { ecmaVersion: 'latest', sourceType });
    } catch (error) {
      add('javascript-syntax', `Inline JavaScript does not parse: ${error.message}`);
    }
  }
  function visit(node) {
    if ('tagName' in node) {
      const attributes = new Map(node.attrs.map(({ name, value }) => [name, value]));
      if (node.tagName === 'meta' && attributes.get('http-equiv')?.trim().toLowerCase() === 'refresh') {
        add('external-resource', 'Redirecting URLs are not allowed.');
      }
      for (const [name, value] of attributes) {
        if (/^on[a-z]+$/.test(name)) validateJavaScript(`function eventHandler(event) {\n${value}\n}`, 'script');
      }
      if (node.tagName === 'script') {
        const type = (attributes.get('type') ?? '').trim().toLowerCase();
        if (attributes.has('src')) add('external-script', 'External script sources are not allowed.');
        else if (!node.sourceCodeLocation?.endTag) add('document', 'Script elements must have a closing tag.');
        else if (type === 'importmap' || type === 'speculationrules') add('external-resource', 'Import maps and speculation rules are not allowed.');
        else if (type === 'module' || JAVASCRIPT_TYPES.has(type)) {
          const source = node.childNodes.filter((child) => child.nodeName === '#text').map((child) => child.value).join('');
          validateJavaScript(source, type === 'module' ? 'module' : 'script');
        }
      }
    }
    if ('childNodes' in node) node.childNodes.forEach(visit);
    if ('content' in node) visit(node.content);
  }
  visit(document);

  return { valid: issues.length === 0, bytes, issues };
}

function attributeValue(match) {
  return match[2] ?? match[3] ?? match[4] ?? '';
}

// Source offsets of the src, href and action names in real attributes,
// including prefixed names such as xlink:href.
function urlAttributeOffsets(root) {
  const offsets = new Set();
  function visit(node) {
    if ('tagName' in node) {
      for (const attribute of node.attrs) {
        const qualified = attribute.prefix ? `${attribute.prefix}:${attribute.name}` : attribute.name;
        const name = /(?:^|:)(src|href|action|formaction)$/.exec(qualified)?.[1];
        const start = node.sourceCodeLocation?.attrs?.[qualified]?.startOffset;
        if (name && start !== undefined) offsets.add(start + qualified.length - name.length);
      }
    }
    if ('childNodes' in node) node.childNodes.forEach(visit);
    if ('content' in node) visit(node.content);
  }
  visit(root);
  return offsets;
}

function hasMultiSourceAttribute(node) {
  if ('tagName' in node && node.attrs.some(({ name }) => name === 'srcset' || name === 'poster')) return true;
  if ('childNodes' in node && node.childNodes.some(hasMultiSourceAttribute)) return true;
  return 'content' in node && hasMultiSourceAttribute(node.content);
}

const EVENT_HANDLER_PREFIX = 'function eventHandler(event) {\n';

function visitJavaScript(value, visit) {
  if (Array.isArray(value)) value.forEach((item) => visitJavaScript(item, visit));
  else if (value && typeof value === 'object' && typeof value.type === 'string') {
    visit(value);
    Object.values(value).forEach((item) => visitJavaScript(item, visit));
  }
}

function literalText(node) {
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) return node.quasis[0]?.value.cooked ?? undefined;
  return undefined;
}

// Source ranges of inline scripts and event handlers, their cooked string and
// template literal text, where markup such as innerHTML can still load URLs,
// the source offsets of script variables named like URL attributes, the
// literal URLs scripts pass to setAttribute, and whether any script imports or
// re-exports another module.
function scriptSources(root, html) {
  const ranges = [];
  const strings = [];
  const declarations = new Set();
  const attributeWrites = [];
  let imports = false;
  // offset is where source starts in html when html holds it verbatim.
  function collect(source, sourceType, offset, handler = false) {
    try {
      for (const token of tokenizer(source, { ecmaVersion: 'latest', sourceType })) {
        if ((token.type === tokTypes.string || token.type === tokTypes.template) && typeof token.value === 'string') strings.push(token.value);
      }
    } catch {
      // Invalid syntax is reported separately.
    }
    let program;
    try {
      program = parseJavaScript(source, { ecmaVersion: 'latest', sourceType });
    } catch {
      // Invalid syntax, including a module statement in a classic script, is
      // reported separately.
      return;
    }
    // setAttribute("src", "https://...") and setAttributeNS(ns, "href", ...).
    visitJavaScript(program, (current) => {
      // import "https://...", export * from "https://...", import(url).
      if (
        current.type === 'ImportDeclaration'
        || current.type === 'ImportExpression'
        || current.type === 'ExportAllDeclaration'
        || (current.type === 'ExportNamedDeclaration' && current.source)
      ) imports = true;
      if (
        current.type !== 'CallExpression'
        || current.callee.type !== 'MemberExpression'
        || current.callee.property.type !== 'Identifier'
        || !/^setAttribute(?:NS)?$/.test(current.callee.property.name)
      ) return;
      const [name, value] = current.callee.property.name === 'setAttributeNS' ? current.arguments.slice(1) : current.arguments;
      const attribute = name && literalText(name);
      const url = value && literalText(value);
      const match = attribute && /^(?:[\w-]+:)?(src|href|action|formaction)$/i.exec(attribute);
      if (match?.[1] && url !== undefined) attributeWrites.push({ attribute: match[1].toLowerCase(), value: url });
    });
    if (offset === undefined) return;
    // A script variable loads nothing, but in an event handler or a with
    // statement a bare name such as src can assign the element's property.
    const found = [];
    let usesWith = false;
    // Names bound through destructuring and defaults count; a member target
    // such as img.src is still checked.
    function bind(target) {
      if (target?.type === 'Identifier') {
        if (/^(?:src|href|action|formaction|srcset|poster)$/i.test(target.name)) found.push(offset + target.start);
      } else if (target?.type === 'ObjectPattern') {
        target.properties.forEach((property) => bind(property.type === 'Property' ? property.value : property));
      } else if (target?.type === 'ArrayPattern') target.elements.forEach(bind);
      else if (target?.type === 'AssignmentPattern') bind(target.left);
      else if (target?.type === 'RestElement') bind(target.argument);
    }
    visitJavaScript(program, (current) => {
      if (current.type === 'WithStatement') usesWith = true;
      if (current.type === 'VariableDeclarator') bind(current.id);
      else if (current.type === 'AssignmentExpression' && !handler) bind(current.left);
      else if (['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(current.type)) current.params.forEach(bind);
      else if (current.type === 'CatchClause') bind(current.param);
      // A class field defines its own property and runs no element setter.
      else if (current.type === 'PropertyDefinition' && !current.computed) bind(current.key);
    });
    if (!usesWith) for (const start of found) declarations.add(start);
  }
  // The html text from start to end when it is exactly the parsed value.
  function verbatim(start, end, value) {
    const source = html.slice(start, end);
    return source.replace(/\r\n?/g, '\n') === value ? source : undefined;
  }
  function visit(node) {
    if ('tagName' in node) {
      for (const attribute of node.attrs) {
        if (/^on[a-z]+$/.test(attribute.name)) {
          const location = node.sourceCodeLocation?.attrs?.[attribute.name];
          const prefix = location ? /^[^=]*=\s*(["']?)/.exec(html.slice(location.startOffset, location.endOffset)) : null;
          const start = location && prefix ? location.startOffset + prefix[0].length : undefined;
          const source = start !== undefined ? verbatim(start, location.endOffset - (prefix[1] ? 1 : 0), attribute.value) : undefined;
          if (location) ranges.push([location.startOffset, location.endOffset]);
          if (source !== undefined) collect(`${EVENT_HANDLER_PREFIX}${source}\n}`, 'script', start - EVENT_HANDLER_PREFIX.length, true);
          else collect(`${EVENT_HANDLER_PREFIX}${attribute.value}\n}`, 'script');
        }
      }
      const type = (node.attrs.find(({ name }) => name === 'type')?.value ?? '').trim().toLowerCase();
      if (node.tagName === 'script' && (type === 'module' || JAVASCRIPT_TYPES.has(type))) {
        const text = node.childNodes.filter((child) => child.nodeName === '#text');
        for (const child of text) {
          if (child.sourceCodeLocation) ranges.push([child.sourceCodeLocation.startOffset, child.sourceCodeLocation.endOffset]);
        }
        const sourceType = type === 'module' ? 'module' : 'script';
        const location = text.length === 1 ? text[0].sourceCodeLocation : undefined;
        const source = location ? verbatim(location.startOffset, location.endOffset, text[0].value) : undefined;
        if (source !== undefined) collect(source, sourceType, location.startOffset);
        else collect(text.map((child) => child.value).join(''), sourceType);
      }
    }
    if ('childNodes' in node) node.childNodes.forEach(visit);
    if ('content' in node) visit(node.content);
  }
  visit(root);
  return { ranges, strings, declarations, attributeWrites, imports };
}

export function validateSeedManifest(manifest, options = {}) {
  const issues = [];
  if (!manifest || typeof manifest !== 'object' || !Array.isArray(manifest.seeds)) {
    return [{ code: 'manifest', message: 'Manifest must contain a seeds array.' }];
  }
  if (manifest.schemaVersion !== '1.0') issues.push({ code: 'schema-version', message: 'Manifest schemaVersion must be "1.0".' });
  if (options.expectedCount !== undefined && manifest.seeds.length !== options.expectedCount) {
    issues.push({ code: 'seed-count', message: `Manifest must contain exactly ${options.expectedCount} seeds; found ${manifest.seeds.length}.` });
  }
  const ids = new Set();
  const filenames = new Set();
  const titles = new Set();
  manifest.seeds.forEach((seed, index) => {
    const label = `Seed ${index + 1}`;
    if (!seed || typeof seed !== 'object') {
      issues.push({ code: 'manifest', message: `${label} must be an object.` });
      return;
    }
    REQUIRED_MANIFEST_FIELDS.filter((field) => !['tags', 'designCard'].includes(field)).forEach((field) => {
      if (typeof seed[field] !== 'string' || seed[field].trim() === '') issues.push({ code: 'manifest-field', message: `${label} needs a non-empty string ${field}.` });
    });
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(typeof seed.id === 'string' ? seed.id : '')) issues.push({ code: 'seed-id', message: `${label} has an unstable ID.` });
    if (!/^[a-z0-9-]+\.html$/.test(typeof seed.filename === 'string' ? seed.filename : '')) issues.push({ code: 'filename', message: `${label} has an invalid HTML filename.` });
    if (!Array.isArray(seed.tags) || seed.tags.length < 3 || seed.tags.length > 20 || !seed.tags.every((tag) => typeof tag === 'string' && tag.trim() && tag.length <= 50)) issues.push({ code: 'tags', message: `${label} needs 3–20 non-empty string tags of at most 50 characters.` });
    if (!seed.designCard || typeof seed.designCard !== 'object' || Array.isArray(seed.designCard)) issues.push({ code: 'design-card', message: `${label} needs an object designCard.` });
    for (const [value, set, name] of [[seed.id, ids, 'ID'], [seed.filename, filenames, 'filename'], [seed.title, titles, 'title']]) {
      if (set.has(value)) issues.push({ code: 'duplicate', message: `${label} duplicates ${name} ${value}.` });
      set.add(value);
    }
  });
  return issues;
}

export function seedApiRecord(seed, html) {
  return {
    seedId: seed.id,
    title: seed.title,
    summary: seed.summary,
    artifact: { html, designCard: seed.designCard },
    metadata: {
      subject: seed.subject,
      level: seed.level,
      locale: seed.locale,
      learningObjective: seed.learningObjective,
      tags: seed.tags,
      interactionPattern: seed.interactionPattern,
      descriptor: seed.descriptor,
    },
  };
}

export function serializeSeedFixtures(records) {
  const catalogue = {
    schemaVersion: '1.0',
    generatedFrom: 'apps/ipad/Resources/Examples/manifest.json',
    seeds: records,
  };
  return {
    catalogue: `${JSON.stringify(catalogue)}\n`,
    ndjson: `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
  };
}

export function productionSeedParityIssues(expectedRows, remoteRows) {
  const issues = [];
  const expected = new Map(expectedRows.map((row) => [row.artifact_id, row]));
  const remote = new Map();
  for (const row of remoteRows) {
    if (remote.has(row.artifact_id)) {
      issues.push(`Remote curated seed ${row.artifact_id} appears more than once.`);
    }
    remote.set(row.artifact_id, row);
  }
  for (const [id, row] of expected) {
    const actual = remote.get(id);
    if (!actual) {
      issues.push(`Missing remote curated seed ${id}.`);
      continue;
    }
    if (actual.revision_id !== row.revision_id) {
      issues.push(`Remote curated seed ${id} points to revision ${actual.revision_id}, expected ${row.revision_id}.`);
    }
    if (actual.source_hash !== row.source_hash) {
      issues.push(`Remote curated seed ${id} has a different source hash.`);
    }
  }
  for (const id of remote.keys()) {
    if (!expected.has(id)) issues.push(`Stale remote curated seed ${id}.`);
  }
  return issues;
}
