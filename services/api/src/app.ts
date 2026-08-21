import type { ModelProvider, TeacherBrief, DesignCard } from "./ai/provider";
import { ModelProviderError } from "./ai/provider";
import type { AssetStore, StoredAsset } from "./assets";
import {
  DEVICE_TOKEN_RECOVERY_DAYS,
  issueDeviceToken,
  networkHashFrom,
  ownerCredentialFrom,
  ownerHashFrom,
  randomSlug,
  refreshDeviceToken,
  sha256,
} from "./auth";
import type { StudioConfig } from "./env";
import {
  generateArtifact,
  InvalidModelOutputError,
  referencedAssetIds,
  reviseArtifact,
  validateHtmlOutput,
} from "./generation";
import {
  apiError,
  corsHeaders,
  HttpError,
  json,
  readBodyBytes,
  readJson,
  withCors,
} from "./http";
import {
  advisoryWarnings,
  inspectHtml,
  inspectTeacherBrief,
  inspectText,
  inspectUnknownText,
  type AdvisoryWarning,
} from "./moderation";
import { PROMPT_VERSION } from "./ai/prompts";
import { cleanupArtifactStorage, type SourceStore } from "./sourceStore";
import type {
  ArtifactRecord,
  ContentReportReason,
  PublicationRecord,
  RevisionRecord,
  StudioRepository,
} from "./storage/repository";
import {
  CURATED_SEED_OWNER,
  retrievalDescriptor,
} from "./storage/repository";
interface Deps {
  repository: StudioRepository;
  provider: ModelProvider;
  config: StudioConfig;
  sources: SourceStore;
  assets?: AssetStore;
  now?: () => Date;
  createId?: () => string;
  createSlug?: () => string;
}
const ID = /^[A-Za-z0-9_-]{1,100}$/,
  SLUG = /^[A-Za-z0-9_-]{16,64}$/,
  REASONS = new Set([
    "inappropriate",
    "personal-data",
    "copyright",
    "accessibility",
    "other",
  ]);
function obj(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v))
    throw new HttpError(400, "INVALID_BODY", "Body must be a JSON object.");
  return v as Record<string, unknown>;
}
function str(v: unknown, n: string, max: number) {
  if (typeof v !== "string" || !v.trim() || v.trim().length > max)
    throw new HttpError(422, "INVALID_INPUT", `${n} is required or too long.`);
  return v.trim();
}
function optionalStr(v: unknown, n: string, max: number): string | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  return str(v, n, max);
}
function days(d: Date, n: number) {
  return new Date(d.getTime() + n * 86400000).toISOString();
}
function retrievalQuery(value: string): string | null {
  const terms = value
    .normalize("NFKC")
    .match(/[\p{L}\p{N}]+/gu)
    ?.slice(0, 12);
  return terms?.length
    ? terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR ")
    : null;
}
const ACTIVITY_FORMS = ["game", "quiz", "simulation", "practice"] as const;
type ActivityForm = (typeof ACTIVITY_FORMS)[number];
function optionalForm(value: unknown): ActivityForm | undefined {
  const raw = optionalStr(value, "Activity form", 20);
  if (!raw) return undefined;
  const form = raw.toLowerCase();
  if (!ACTIVITY_FORMS.includes(form as ActivityForm))
    throw new HttpError(
      422,
      "INVALID_INPUT",
      "Activity form must be game, quiz, simulation or practice.",
    );
  return form as ActivityForm;
}
function inferSubject(learnerContext: string): string {
  const text = learnerContext.toLowerCase();
  if (/\bmaths?\b|\bmathematics\b|\balgebra\b/.test(text)) return "mathematics";
  if (
    /\bsci(?:ence)?\b|\bphy(?:sics)?\b|\bchem(?:istry)?\b|\bbio(?:logy)?\b/.test(
      text,
    )
  )
    return "science";
  if (/\benglish\b|\blit(?:erature)?\b|\bliteracy\b|\bspelling\b/.test(text))
    return "english";
  if (/\bhumanities\b|\bgeog(?:raphy)?\b|\bhist(?:ory)?\b/.test(text))
    return "humanities";
  if (/\bcivics\b|\bcitizenship\b|\bsocial studies\b/.test(text)) return "civics";
  if (
    /\b(?:chinese|malay|tamil|mother tongue|mtl|higher chinese|higher malay|higher tamil)\b/.test(
      text,
    )
  )
    return "languages";
  return "other";
}
function generationRetrievalQuery(brief: TeacherBrief): string | null {
  return retrievalQuery(
    [brief.format, brief.learnerContext ?? `${brief.level} ${brief.subject}`, brief.learningObjective]
      .filter(Boolean)
      .join(" "),
  );
}
function stringList(value: unknown, name: string, maximum: number): string[] {
  if (!Array.isArray(value) || value.length > maximum)
    throw new HttpError(422, "INVALID_INPUT", `${name} must be a short list.`);
  return value.map((entry) => str(entry, name, 60));
}
interface GuidedGeneration {
  creationBrief: string;
  brief: TeacherBrief;
  preferredExampleRevisionId: string | null;
}
function brief(b: Record<string, unknown>): GuidedGeneration {
  const guided = obj(b.brief);
  const learnerContext = str(guided.learnerContext, "Learner context", 300);
  const format = optionalForm(guided.format);
  return {
    creationBrief: str(b.creationBrief, "Creation brief", 6000),
    preferredExampleRevisionId:
      b.preferredExampleRevisionId == null
        ? null
        : str(b.preferredExampleRevisionId, "Preferred example revision", 100),
    brief: {
      level: learnerContext,
      subject: inferSubject(learnerContext),
      learnerContext,
      learningObjective: str(
        guided.learningObjective,
        "Learning objective",
        600,
      ),
      studentAction: str(guided.studentAction, "Student action", 600),
      ...(optionalStr(guided.sourceContent, "Source content", 4000)
        ? {
            content: optionalStr(guided.sourceContent, "Source content", 4000),
            sourceContent: optionalStr(
              guided.sourceContent,
              "Source content",
              4000,
            ),
          }
        : {}),
      feedback: str(guided.feedback, "Feedback", 1000),
      classroomFit: str(guided.classroomFit, "Classroom fit", 1000),
      ...(format ? { format } : {}),
    },
  };
}
function remixBrief(source: ArtifactRecord): TeacherBrief {
  return {
    level: source.level ?? "General",
    subject: source.subject ?? "General",
    learnerContext: `${source.level ?? "General"} ${source.subject ?? "General"}`
      .trim()
      .slice(0, 300),
    learningObjective: (source.learningObjective ?? source.title).slice(
      0,
      600,
    ),
    studentAction: source.summary.slice(0, 600),
    feedback: "Ask the teacher for feedback on this remixed tapplet.",
    classroomFit: source.level ?? "Classroom use",
  };
}
async function digest(html: string) {
  return sha256(html);
}
function design(r: RevisionRecord): DesignCard | undefined {
  return r.designCard ? (JSON.parse(r.designCard) as DesignCard) : undefined;
}
function artifactResponse(artifact: ArtifactRecord) {
  return {
    id: artifact.id,
    title: artifact.title,
    summary: artifact.summary,
    subject: artifact.subject,
    level: artifact.level,
    locale: artifact.locale,
    learningObjective: artifact.learningObjective,
    tags: artifact.tags,
    creationBrief: artifact.creationBrief,
    headRevisionId: artifact.headRevisionId,
    remixedFromRevisionId: artifact.remixedFromRevisionId,
    createdAt: artifact.createdAt,
    updatedAt: artifact.updatedAt,
  };
}
function revisionResponse(revision: RevisionRecord, origin: string) {
  return {
    id: revision.id,
    artifactId: revision.artifactId,
    parentRevisionId: revision.parentRevisionId,
    sourceHash: revision.sourceHash,
    byteLength: revision.sourceBytes,
    kind: (
      {
        generation: "generate",
        revision: "revise",
        remix: "remix",
        import: "seed",
      } as const
    )[revision.kind],
    instruction: revision.instruction,
    designCard: revision.designCard,
    // Screenshots are private; the iPad must not receive a URL that AsyncImage
    // cannot authenticate. Upload success remains part of the wire contract.
    screenshotUrl: null,
    model: revision.modelVersion,
    promptVersion: revision.promptVersion,
    createdAt: revision.createdAt,
  };
}
function publication(p: PublicationRecord, origin: string) {
  return {
    slug: p.slug,
    url: `${origin}/${p.slug}`,
    artifactId: p.artifactId,
    revisionId: p.revisionId,
    title: p.title,
    createdAt: p.createdAt,
    expiresAt: p.expiresAt,
    revokedAt: p.revokedAt,
  };
}
function sourceResponse(html: string) {
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "private, no-store",
    },
  });
}
function image(a: StoredAsset) {
  const h = new Headers();
  a.object.writeHttpMetadata(h);
  h.set("etag", a.object.httpEtag);
  h.set("x-content-type-options", "nosniff");
  return new Response(a.object.body, { headers: h });
}
function assetResponse(asset: StoredAsset["record"]) {
  return {
    asset: {
      id: asset.id,
      kind: "image",
      mediaType: asset.contentType,
      width: asset.width,
      height: asset.height,
      byteLength: asset.byteLength,
      sha256: asset.sha256,
    },
    accessibility: {
      alternativeText: asset.alternativeText,
      decorative: asset.decorative,
    },
    ...(asset.warnings?.length ? { warnings: asset.warnings } : {}),
  };
}

function publicationReviewWarning(categories: string[]): AdvisoryWarning {
  const labels = [
    ...new Set(
      categories
        .filter((category): category is string => typeof category === "string")
        .flatMap(moderationCategoryLabel),
    ),
  ];
  return {
    source: "publication",
    code: "AI_CONTENT_REVIEW_FLAGGED",
    message: labels.length
      ? `AI review flagged possible ${labels.join(", ")}. Check the tapplet; you can keep sharing it or edit and publish again.`
      : "AI review flagged content that may need attention. Check the tapplet; you can keep sharing it or edit and publish again.",
    ...(labels.length ? { categories: labels } : {}),
  };
}

function moderationCategoryLabel(category: string): string[] {
  const value = category.toLowerCase().replaceAll("_", " ").replaceAll("-", " ");
  if (value.includes("personal") || value.includes("privacy"))
    return ["personal information"];
  if (value.includes("minor") || value.includes("child"))
    return ["content involving children"];
  if (value.includes("sexual") || value.includes("nudity"))
    return ["sexual content"];
  if (value.includes("self harm") || value.includes("suicide"))
    return ["self-harm content"];
  if (value.includes("violent") || value.includes("violence") || value.includes("harm"))
    return ["harmful or violent content"];
  if (value.includes("hate")) return ["hateful content"];
  if (value.includes("weapon") || value.includes("drug"))
    return ["weapons or illegal drugs"];
  return [];
}

function moderationUnavailableWarning(): AdvisoryWarning {
  return {
    source: "publication",
    code: "AI_CONTENT_REVIEW_UNAVAILABLE",
    message:
      "AI review was unavailable. Check the tapplet before sharing; you can continue or edit and publish again.",
  };
}
export function createStudioApp(d: Deps) {
  const now = d.now ?? (() => new Date()),
    id = d.createId ?? (() => crypto.randomUUID()),
    slug = d.createSlug ?? randomSlug;
  async function owner(r: Request) {
    return ownerHashFrom(
      r,
      d.config.deviceTokenSigningSecret,
      now().getTime(),
      d.repository,
    );
  }
  async function quota(
    r: Request,
    o: string,
    kind: "generation" | "artifact" | "safety",
  ) {
    const date = now().toISOString().slice(0, 10),
      limit =
        kind === "generation"
          ? d.config.dailyGenerationLimit
          : kind === "artifact"
            ? d.config.dailyDraftCreationLimit
            : d.config.dailySafetyReviewLimit,
      networkLimit =
        kind === "generation"
          ? d.config.dailyNetworkGenerationLimit
          : kind === "artifact"
            ? d.config.dailyNetworkDraftCreationLimit
            : d.config.dailyNetworkSafetyReviewLimit;
    if (!(await d.repository.consumeGeneration(`${kind}:${o}`, date, limit)))
      throw new HttpError(429, "LIMIT_REACHED", "Daily limit reached.");
    if (
      !(await d.repository.consumeGeneration(
        `network-${kind}:${await networkHashFrom(r)}`,
        date,
        networkLimit,
      ))
    )
      throw new HttpError(
        429,
        "NETWORK_LIMIT_REACHED",
        "Network safety limit reached.",
      );
  }
  async function validateAssetReferences(
    ids: string[],
    o: string,
    allowReferenced = false,
  ) {
    if (ids.length && !d.assets)
      throw new HttpError(
        503,
        "ASSET_STORE_UNAVAILABLE",
        "Images unavailable.",
      );
    for (const x of ids) {
      const a = await d.assets!.get(x);
      if (
        !a ||
        (a.record.ownerHash !== o &&
          !allowReferenced &&
          !(await d.repository.ownerReferencesAsset(o, x)))
      )
        throw new HttpError(
          422,
          "INVALID_ARTIFACT_ASSET",
          `Asset ${x} is not owned by this device.`,
        );
    }
  }
  async function assets(html: string, o: string, allowReferenced = false) {
    const ids = referencedAssetIds(html);
    await validateAssetReferences(ids, o, allowReferenced);
    return ids;
  }
  async function projectResponse(
    a: ArtifactRecord,
    o: string,
    origin: string,
    rv?: RevisionRecord,
  ) {
    const head = rv ?? (await d.repository.getRevision(a.headRevisionId));
    const html = head ? await d.sources.getSource(head.sourceHash) : null;
    const p = await d.repository.getActivePublicationForArtifact(a.id, o);
    return {
      artifact: {
        ...artifactResponse(a),
        publication: p ? publication(p, d.config.publicPlayerOrigin) : null,
        publicationStale: !!p && p.revisionId !== a.headRevisionId,
      },
      headRevision: head ? revisionResponse(head, origin) : null,
      html,
    };
  }
  async function persist(html: string) {
    const h = await digest(html);
    await d.sources.putSource(h, html);
    return h;
  }
  async function reserveArtifactCreation(r: Request, ownerHash: string) {
    if (
      (await d.repository.countArtifacts(ownerHash)) >=
      d.config.maximumDraftsPerOwner
    )
      throw new HttpError(
        429,
        "ARTIFACT_STORAGE_LIMIT_REACHED",
        "Saved tapplet limit reached.",
      );
    await quota(r, ownerHash, "artifact");
  }
  async function handle(r: Request): Promise<Response> {
    const u = new URL(r.url),
      s = u.pathname.split("/").filter(Boolean);
    if (r.method === "OPTIONS") {
      const h = corsHeaders(r, d.config);
      return Object.keys(h).length
        ? new Response(null, { status: 204, headers: h })
        : apiError(403, "ORIGIN_NOT_ALLOWED", "Origin denied.");
    }
    if (r.method === "GET" && u.pathname === "/health")
      return json({ ok: true, service: "classroom-widgets-studio-api" });
    if (r.method === "POST" && u.pathname === "/v1/seeds") {
      if (
        !d.config.seedImportToken ||
        r.headers.get("authorization") !== `Bearer ${d.config.seedImportToken}`
      )
        throw new HttpError(
          401,
          "SEED_IMPORT_UNAUTHORIZED",
          "Seed import is not authorised.",
        );
      const b = obj(await readJson(r, 220_000)),
        seedId = str(b.seedId, "Seed ID", 80);
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(seedId))
        throw new HttpError(422, "INVALID_INPUT", "Seed ID is invalid.");
      const suppliedArtifact = obj(b.artifact),
        suppliedMetadata = obj(b.metadata),
        html = suppliedArtifact.html,
        designCard = suppliedArtifact.designCard;
      if (typeof html !== "string")
        throw new HttpError(422, "INVALID_INPUT", "Seed HTML is required.");
      const title = str(b.title, "Title", 200),
        summary = str(b.summary, "Summary", 1000),
        subject = str(suppliedMetadata.subject, "Subject", 100),
        level = str(suppliedMetadata.level, "Level", 100),
        locale = str(suppliedMetadata.locale, "Locale", 30),
        learningObjective = str(
          suppliedMetadata.learningObjective,
          "Learning objective",
          600,
        ),
        interactionPattern = str(
          suppliedMetadata.interactionPattern,
          "Interaction pattern",
          100,
        ),
        descriptor = str(suppliedMetadata.descriptor, "Descriptor", 1000),
        tags = stringList(suppliedMetadata.tags, "Tag", 20),
        card = {
          ...(designCard &&
          typeof designCard === "object" &&
          !Array.isArray(designCard)
            ? designCard
            : {}),
          title,
          description: summary,
          tags,
          interactionPattern,
        };
      validateHtmlOutput({ html, designCard: card });
      if (referencedAssetIds(html).length)
        throw new HttpError(
          422,
          "INVALID_SEED_ASSET",
          "Curated seeds must be self-contained.",
        );
      const timestamp = now().toISOString(),
        revisionId = `${seedId}-seed`,
        sourceHash = await persist(html),
        generationBrief: TeacherBrief = {
          level,
          subject,
          learnerContext: `${level} ${subject}`,
          learningObjective,
          studentAction: summary,
        },
        revision: RevisionRecord = {
          id: revisionId,
          artifactId: seedId,
          parentRevisionId: null,
          sourceHash,
          sourceBytes: new TextEncoder().encode(html).byteLength,
          kind: "import",
          instruction: null,
          designCard: JSON.stringify(card),
          exemplars: [],
          modelVersion: "curated",
          promptVersion: "seed-v1",
          screenshotKey: null,
          createdAt: timestamp,
        },
        artifact: ArtifactRecord = {
          id: seedId,
          ownerHash: CURATED_SEED_OWNER,
          title,
          summary,
          subject,
          level,
          locale,
          learningObjective,
          tags,
          creationBrief: `${learningObjective}\n\n${summary}`,
          generationBrief: JSON.stringify(generationBrief),
          headRevisionId: revisionId,
          remixedFromRevisionId: null,
          createdAt: timestamp,
          updatedAt: timestamp,
        };
      await d.repository.upsertCuratedSeed({
        artifact,
        revision,
        assetIds: [],
        descriptor: `${descriptor}\nSubject: ${subject}\nLevel: ${level}\nInteraction: ${interactionPattern}\nTags: ${tags.join(", ")}`,
      });
      return json(
        {
          artifactId: artifact.id,
          revisionId: revision.id,
          sourceHash,
        },
        { status: 201 },
      );
    }
    if (r.method === "POST" && u.pathname === "/v1/devices/register") {
      const b = obj(await readJson(r, 1000)),
        code = str(b.accessCode, "Class code", 80)
          .toUpperCase()
          .replaceAll("-", "");
      if (!/^\d{4}[A-Z]{8}$/.test(code))
        throw new HttpError(
          403,
          "INVALID_ACCESS_CODE",
          "This class code is invalid or expired.",
        );
      const timestamp = now(),
        date = timestamp.toISOString().slice(0, 10),
        classCodeHash = await sha256(`class-code:${code}`),
        networkHash = await networkHashFrom(r),
        registration = await d.repository.consumeRegistration(
          classCodeHash,
          timestamp.toISOString(),
          `registration:${networkHash}`,
          date,
          d.config.dailyNetworkRegistrationLimit,
        );
      if (registration === "network-limit")
        throw new HttpError(
          403,
          "ACCESS_CODE_UNAVAILABLE",
          "This class code cannot be used. Check it or ask your facilitator for help.",
        );
      if (registration === "invalid-class-code") {
        if (
          !(await d.repository.consumeGeneration(
            `class-code-fail-network:${networkHash}`,
            date,
            d.config.dailyNetworkClassCodeFailureLimit,
          ))
        )
          throw new HttpError(
            429,
            "CLASS_CODE_NETWORK_LOCKED",
            "This network has had too many unsuccessful class-code attempts today. Ask your facilitator for help.",
          );
        if (
          !(await d.repository.consumeGeneration(
            `class-code-fail:${classCodeHash}`,
            date,
            d.config.classCodeFailureLockout,
          ))
        )
          throw new HttpError(
            429,
            "CLASS_CODE_LOCKED",
            "This class code has had too many failed attempts today. Try again tomorrow or ask your facilitator for help.",
          );
        throw new HttpError(
          403,
          "ACCESS_CODE_UNAVAILABLE",
          "This class code cannot be used. Check it or ask your facilitator for help.",
        );
      }
      return json(
        await issueDeviceToken(d.config.deviceTokenSigningSecret, timestamp),
        { status: 201 },
      );
    }
    if (r.method === "POST" && u.pathname === "/v1/devices/refresh")
      return json(
        await refreshDeviceToken(
          r,
          d.config.deviceTokenSigningSecret,
          now(),
          undefined,
          d.repository,
        ),
      );
    if (r.method === "POST" && u.pathname === "/v1/artifacts/generate") {
      const o = await owner(r),
        request = brief(obj(await readJson(r, 16000))),
        b = request.brief,
        warnings = advisoryWarnings("prompt", [
          ...inspectTeacherBrief(b),
          ...inspectText(request.creationBrief),
        ]);
      await reserveArtifactCreation(r, o);
      await quota(r, o, "generation");
      const query = generationRetrievalQuery(b);
      const preferred = request.preferredExampleRevisionId
        ? await d.repository.getRevision(request.preferredExampleRevisionId)
        : null;
      const preferredAllowed =
        preferred &&
        ((await d.repository.getArtifact(preferred.artifactId, o)) ||
          (await d.repository.isRevisionRetrievable(
            preferred.id,
            now().toISOString(),
          )));
      const found = request.preferredExampleRevisionId
        ? preferredAllowed
          ? [{ revisionId: preferred.id, descriptor: "Teacher-selected example" }]
          : []
        : query
          ? await d.repository.searchRetrieval(query, 2, now().toISOString())
          : [];
      const ex = [];
      for (const e of found) {
        const rv = await d.repository.getRevision(e.revisionId),
          html = rv && (await d.sources.getSource(rv.sourceHash));
        if (rv && html)
          ex.push({
            revisionId: rv.id,
            html,
            designCard: design(rv),
            descriptor: e.descriptor,
          });
      }
      const out = await generateArtifact(d.provider, b, ex);
      warnings.push(
        ...advisoryWarnings("generated_content", [
          ...inspectHtml(out.html),
          ...inspectUnknownText(out.designCard),
        ]),
      );
      const aid = id(),
        rid = id(),
        timestamp = now().toISOString(),
        assetIds = await assets(out.html, o),
        hash = await persist(out.html);
      const rv: RevisionRecord = {
        id: rid,
        artifactId: aid,
        parentRevisionId: null,
        sourceHash: hash,
        sourceBytes: new TextEncoder().encode(out.html).byteLength,
        kind: "generation",
        instruction: null,
        designCard: out.designCard ? JSON.stringify(out.designCard) : null,
        exemplars: ex.map((x) => x.revisionId),
        modelVersion: d.provider.name,
        promptVersion: PROMPT_VERSION,
        screenshotKey: null,
        createdAt: timestamp,
      };
      const a: ArtifactRecord = {
        id: aid,
        ownerHash: o,
        title: out.designCard?.title ?? b.learningObjective,
        summary: out.designCard?.description ?? b.studentAction,
        subject: b.subject === "other" ? null : b.subject,
        level: b.learnerContext ?? b.level,
        locale: "en-SG",
        learningObjective: b.learningObjective,
        tags: out.designCard?.tags ?? [],
        creationBrief: request.creationBrief,
        generationBrief: JSON.stringify(b),
        headRevisionId: rid,
        remixedFromRevisionId: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      await d.repository.createArtifact({
        artifact: a,
        revision: rv,
        assetIds,
      });
      return json(
        {
          ...(await projectResponse(a, o, u.origin, rv)),
          ...(warnings.length ? { warnings } : {}),
        },
        { status: 201 },
      );
    }
    if (r.method === "GET" && u.pathname === "/v1/artifacts") {
      const ownerHash = await owner(r);
      const artifacts = await d.repository.listArtifacts(ownerHash);
      return json({
        artifacts: await Promise.all(
          artifacts.map(async (artifact) => {
            const active = await d.repository.getActivePublicationForArtifact(
              artifact.id,
              ownerHash,
            );
            return {
              ...artifactResponse(artifact),
              publication: active
                ? publication(active, d.config.publicPlayerOrigin)
                : null,
              publicationStale:
                !!active && active.revisionId !== artifact.headRevisionId,
            };
          }),
        ),
      });
    }
    if (r.method === "GET" && u.pathname === "/v1/examples/search") {
      await owner(r);
      const q = retrievalQuery(str(u.searchParams.get("q"), "Query", 200));
      const requestedLimit = Number.parseInt(
        u.searchParams.get("limit") ?? "",
        10,
      );
      const limit = Number.isInteger(requestedLimit)
        ? Math.min(20, Math.max(1, requestedLimit))
        : 10;
      const entries = q
        ? await d.repository.searchRetrieval(q, limit, now().toISOString())
        : [];
      return json({ examples: entries.map(({ html: _, ...e }) => e) });
    }
    if (s[0] === "v1" && s[1] === "assets") {
      if (!d.assets)
        throw new HttpError(
          503,
          "ASSET_STORE_UNAVAILABLE",
          "Images unavailable.",
        );
      const o = await owner(r);
      if (s.length === 2 && r.method === "POST") {
        const a = await d.assets.put(r, {
          ownerHash: o,
          networkHash: await networkHashFrom(r),
          now: now().toISOString(),
          maximumNetworkCount: d.config.dailyNetworkUploadLimit,
          maximumNetworkBytes: d.config.dailyNetworkUploadBytes,
        });
        return json(assetResponse(a), { status: 201 });
      }
      if (s.length === 3) {
        const a = await d.assets.get(s[2]!);
        if (
          !a ||
          (a.record.ownerHash !== o &&
            !(await d.repository.ownerReferencesAsset(o, s[2]!)))
        )
          return apiError(404, "ASSET_NOT_FOUND", "Image unavailable.");
        if (r.method === "GET") return image(a);
        if (r.method === "DELETE") {
          const x = await d.assets.deleteOwned(s[2]!, o);
          return x === "deleted"
            ? new Response(null, { status: 204 })
            : apiError(
                x === "in-use" ? 409 : 404,
                x === "in-use" ? "ASSET_IN_USE" : "ASSET_NOT_FOUND",
                "Image unavailable.",
              );
        }
      }
    }
    if (s[0] === "v1" && s[1] === "artifacts" && s[2] && ID.test(s[2])) {
      const o = await owner(r),
        a = await d.repository.getArtifact(s[2], o);
      if (!a)
        throw new HttpError(404, "ARTIFACT_NOT_FOUND", "Artifact unavailable.");
      if (s.length === 3 && r.method === "GET")
        return json(await projectResponse(a, o, u.origin));
      if (s.length === 3 && r.method === "DELETE") {
        const references = await d.repository.getArtifactStorageReferences(
          a.id,
          o,
        );
        if (!(await d.repository.deleteArtifact(a.id, o)))
          return apiError(404, "ARTIFACT_NOT_FOUND", "Unavailable");
        if (references)
          await cleanupArtifactStorage(d.sources, references);
        return new Response(null, { status: 204 });
      }
      if (s.length === 3 && r.method === "PATCH") {
        const b = obj(await readJson(r, 10000));
        if (typeof b.title === "string" && b.headRevisionId === undefined) {
          const metadata = {
            title: str(b.title, "Title", 200),
            summary: str(b.summary, "Summary", 1000),
            subject: optionalStr(b.subject, "Subject", 100) ?? null,
            level: optionalStr(b.level, "Level", 100) ?? null,
            locale: optionalStr(b.locale, "Locale", 30) ?? null,
            learningObjective:
              optionalStr(b.learningObjective, "Learning objective", 600) ??
              null,
            tags: Array.isArray(b.tags)
              ? b.tags.map((x) => str(x, "Tag", 60)).slice(0, 20)
              : [],
            creationBrief: str(b.creationBrief, "Creation brief", 6000),
          };
          const warnings = advisoryWarnings(
            "prompt",
            inspectText(
              [
                metadata.title,
                metadata.summary,
                metadata.learningObjective ?? "",
                metadata.creationBrief,
                ...metadata.tags,
                ...(metadata.subject ? [metadata.subject] : []),
                ...(metadata.level ? [metadata.level] : []),
                ...(metadata.locale ? [metadata.locale] : []),
              ].join("\n"),
            ),
          );
          return json({
            artifact: await d.repository
              .updateArtifactMetadata(a.id, o, metadata, now().toISOString())
              .then(async (value) =>
                value
                  ? (await projectResponse(value, o, u.origin)).artifact
                  : null,
              ),
            ...(warnings.length ? { warnings } : {}),
          });
        }
        const head = str(b.headRevisionId, "headRevisionId", 100),
          expected = str(
            b.expectedHeadRevisionId,
            "expectedHeadRevisionId",
            100,
          );
        if (
          !(await d.repository.moveHead(
            a.id,
            o,
            head,
            expected,
            now().toISOString(),
          ))
        )
          throw new HttpError(
            409,
            "HEAD_REVISION_CONFLICT",
            "Artifact head changed.",
          );
        return json(
          await d.repository
            .getArtifact(a.id, o)
            .then((value) => projectResponse(value!, o, u.origin)),
        );
      }
      if (s[3] === "revisions" && s.length === 4 && r.method === "GET")
        return json({
          revisions: (await d.repository.listRevisions(a.id, o)).map(
            (revision) => revisionResponse(revision, u.origin),
          ),
        });
      if (s[3] === "revisions" && s.length === 4 && r.method === "POST") {
        const b = obj(await readJson(r, 16000)),
          instruction = str(b.instruction, "Instruction", 2000),
          requiredAssetId = optionalStr(
            b.requiredAssetId,
            "Required asset ID",
            100,
          ),
          expected = str(
            b.expectedHeadRevisionId,
            "expectedHeadRevisionId",
            100,
          );
        if (requiredAssetId && !ID.test(requiredAssetId))
          throw new HttpError(
            422,
            "INVALID_INPUT",
            "Required asset ID is invalid.",
          );
        if (a.headRevisionId !== expected)
          throw new HttpError(
            409,
            "HEAD_REVISION_CONFLICT",
            "Artifact head changed.",
          );
        if (requiredAssetId)
          await validateAssetReferences([requiredAssetId], o);
        const warnings = advisoryWarnings("prompt", inspectText(instruction));
        await quota(r, o, "generation");
        const current = await d.repository.getRevision(expected),
          html = current && (await d.sources.getSource(current.sourceHash));
        if (!current || current.artifactId !== a.id || !html)
          throw new HttpError(
            404,
            "REVISION_NOT_FOUND",
            "Revision unavailable.",
          );
        const out = await reviseArtifact(
            d.provider,
            html,
            design(current),
            instruction,
            JSON.parse(a.generationBrief) as TeacherBrief,
            requiredAssetId ? [requiredAssetId] : [],
          ),
          rid = id(),
          hash = await persist(out.html),
          timestamp = now().toISOString(),
          rv: RevisionRecord = {
            id: rid,
            artifactId: a.id,
            parentRevisionId: expected,
            sourceHash: hash,
            sourceBytes: new TextEncoder().encode(out.html).byteLength,
            kind: "revision",
            instruction,
            designCard: out.designCard ? JSON.stringify(out.designCard) : null,
            exemplars: [],
            modelVersion: d.provider.name,
            promptVersion: PROMPT_VERSION,
            screenshotKey: null,
            createdAt: timestamp,
          };
        warnings.push(
          ...advisoryWarnings("generated_content", [
            ...inspectHtml(out.html),
            ...inspectUnknownText(out.designCard),
          ]),
        );
        if (
          !(await d.repository.createRevision(
            rv,
            o,
            expected,
            await assets(out.html, o),
          ))
        )
          throw new HttpError(
            409,
            "HEAD_REVISION_CONFLICT",
            "Artifact head changed.",
          );
        return json(
          {
            ...(await projectResponse(
              (await d.repository.getArtifact(a.id, o))!,
              o,
              u.origin,
            )),
            ...(warnings.length ? { warnings } : {}),
          },
          { status: 201 },
        );
      }
      if (s[3] === "publish" && r.method === "POST") {
        const b = obj(await readJson(r, 1000)),
          expected = str(
            b.expectedHeadRevisionId,
            "expectedHeadRevisionId",
            100,
          );
        if (a.headRevisionId !== expected)
          throw new HttpError(
            409,
            "HEAD_REVISION_CONFLICT",
            "Artifact head changed.",
          );
        const rv = await d.repository.getRevision(expected),
          html = rv && (await d.sources.getSource(rv.sourceHash));
        if (!rv || !html)
          throw new HttpError(
            404,
            "REVISION_NOT_FOUND",
            "Revision unavailable.",
          );
        validateHtmlOutput({
          html,
          ...(design(rv) ? { designCard: design(rv) } : {}),
        });
        const warnings = advisoryWarnings(
          "generated_content",
          [...inspectHtml(html), ...inspectUnknownText(design(rv))],
        );
        await assets(html, o);
        await quota(r, o, "safety");
        try {
          const m = await d.provider.moderate(html);
          if (!m.safe) warnings.push(publicationReviewWarning(m.categories));
        } catch (error) {
          const diagnostic = error instanceof Error
            ? `${error.name}: ${error.message}`
            : String(error);
          console.error(`Publication moderation failed: ${diagnostic}`);
          warnings.push(moderationUnavailableWarning());
        }
        const p = await d.repository.publish(
          slug(),
          a,
          rv,
          days(now(), d.config.publicationTtlDays),
          now().toISOString(),
          retrievalDescriptor(a, rv.designCard),
        );
        if (!p)
          throw new HttpError(
            409,
            "HEAD_REVISION_CONFLICT",
            "Artifact changed during review.",
          );
        return json(
          {
            publication: publication(p, d.config.publicPlayerOrigin),
            ...(warnings.length ? { warnings } : {}),
          },
          { status: 201 },
        );
      }
    }
    if (s[0] === "v1" && s[1] === "revisions" && s[2] && ID.test(s[2])) {
      const o = await owner(r),
        rv = await d.repository.getRevision(s[2]),
        ownedArtifact =
          rv && (await d.repository.getArtifact(rv.artifactId, o));
      if (!rv)
        throw new HttpError(404, "REVISION_NOT_FOUND", "Revision unavailable.");
      if (s[3] === "source" && r.method === "GET") {
        if (!ownedArtifact)
          throw new HttpError(
            404,
            "REVISION_NOT_FOUND",
            "Revision unavailable.",
          );
        const h = await d.sources.getSource(rv.sourceHash);
        return h
          ? sourceResponse(h)
          : apiError(404, "SOURCE_NOT_FOUND", "Source unavailable.");
      }
      if (s[3] === "screenshot" && r.method === "POST") {
        if (!ownedArtifact)
          throw new HttpError(
            404,
            "REVISION_NOT_FOUND",
            "Revision unavailable.",
          );
        if (
          (r.headers.get("content-type") ?? "").split(";")[0] !== "image/jpeg"
        )
          throw new HttpError(415, "INVALID_SCREENSHOT", "Upload JPEG.");
        const bytes = await readBodyBytes(
          r,
          5_000_000,
          () =>
            new HttpError(413, "SCREENSHOT_TOO_LARGE", "Screenshot too large."),
        );
        if (
          bytes[0] !== 0xff ||
          bytes[1] !== 0xd8 ||
          bytes.at(-2) !== 0xff ||
          bytes.at(-1) !== 0xd9
        )
          throw new HttpError(422, "INVALID_SCREENSHOT", "Invalid JPEG.");
        const key = await d.sources.putScreenshot(rv.id, bytes);
        await d.repository.setScreenshot(rv.id, o, key);
        return json({ screenshotKey: key }, { status: 201 });
      }
      if (s[3] === "remix" && r.method === "POST") {
        const sourceArtifact =
          ownedArtifact ??
          ((await d.repository.isRevisionRetrievable(
            rv.id,
            now().toISOString(),
          ))
            ? await d.repository.getArtifactPublic(rv.artifactId)
            : null);
        if (!sourceArtifact)
          throw new HttpError(
            404,
            "REVISION_NOT_FOUND",
            "Revision unavailable.",
          );
        const b = obj(await readJson(r, 2000)),
          suppliedTitle =
            typeof b.title === "string" ? str(b.title, "Title", 200) : null,
          title = suppliedTitle ?? sourceArtifact.title;
        const warnings = advisoryWarnings(
          "prompt",
          suppliedTitle ? inspectText(suppliedTitle) : [],
        );
        const html = await d.sources.getSource(rv.sourceHash);
        if (!html)
          throw new HttpError(404, "SOURCE_NOT_FOUND", "Source unavailable.");
        const keepBriefs =
          !!ownedArtifact || sourceArtifact.ownerHash === CURATED_SEED_OWNER;
        await reserveArtifactCreation(r, o);
        const aid = id(),
          rid = id(),
          timestamp = now().toISOString(),
          hash = await persist(html),
          copy = {
            ...rv,
            id: rid,
            artifactId: aid,
            parentRevisionId: null,
            kind: "remix" as const,
            instruction: "Remix",
            createdAt: timestamp,
            screenshotKey: null,
          },
          artifact: ArtifactRecord = {
            id: aid,
            ownerHash: o,
            title,
            summary: sourceArtifact.summary,
            subject: sourceArtifact.subject,
            level: sourceArtifact.level,
            locale: sourceArtifact.locale,
            learningObjective: sourceArtifact.learningObjective,
            tags: sourceArtifact.tags,
            creationBrief: keepBriefs
              ? sourceArtifact.creationBrief
              : `${sourceArtifact.title}\n\n${sourceArtifact.summary}`.slice(
                  0,
                  6000,
                ),
            generationBrief: keepBriefs
              ? sourceArtifact.generationBrief
              : JSON.stringify(remixBrief(sourceArtifact)),
            headRevisionId: rid,
            remixedFromRevisionId: rv.id,
            createdAt: timestamp,
            updatedAt: timestamp,
          };
        await d.repository.createArtifact({
          artifact,
          revision: copy,
          assetIds: await assets(html, o, !ownedArtifact),
        });
        return json(
          {
            ...(await projectResponse(artifact, o, u.origin, copy)),
            ...(warnings.length ? { warnings } : {}),
          },
          { status: 201 },
        );
      }
    }
    if (s[0] === "v1" && s[1] === "publications" && s[2] && SLUG.test(s[2])) {
      const p = await d.repository.getPublication(s[2]);
      if (s[3] === "reports" && r.method === "POST") {
        if (!p || p.revokedAt || Date.parse(p.expiresAt) <= now().getTime())
          throw new HttpError(404, "PUBLICATION_NOT_FOUND", "Unavailable.");
        const reason = obj(await readJson(r, 1000)).reason;
        if (typeof reason !== "string" || !REASONS.has(reason))
          throw new HttpError(
            422,
            "INVALID_REPORT_REASON",
            "Choose a valid reason.",
          );
        const timestamp = now(),
          date = timestamp.toISOString().slice(0, 10);
        if (
          !(await d.repository.consumeGeneration(
            `network-report:${await networkHashFrom(r)}`,
            date,
            20,
          ))
        )
          throw new HttpError(
            429,
            "REPORT_RATE_LIMIT_REACHED",
            "This network has sent enough reports for today.",
          );
        if (
          !(await d.repository.createContentReport({
            id: crypto.randomUUID(),
            publicationSlug: p.slug,
            reason: reason as ContentReportReason,
            now: timestamp.toISOString(),
            maximumPerPublication: 100,
          }))
        )
          throw new HttpError(
            429,
            "REPORT_LIMIT_REACHED",
            "Report limit reached.",
          );
        return new Response(null, { status: 204 });
      }
      const c = await ownerCredentialFrom(
        r,
        d.config.deviceTokenSigningSecret,
        now().getTime(),
        d.repository,
      );
      if (r.method === "DELETE")
        return (await d.repository.revokePublication(
          s[2],
          c.ownerHash,
          now().toISOString(),
        ))
          ? new Response(null, { status: 204 })
          : apiError(404, "PUBLICATION_NOT_FOUND", "Unavailable");
      if (r.method === "PATCH") {
        const b = obj(await readJson(r, 1000));
        if (
          b.days !== undefined &&
          (!Number.isInteger(b.days) ||
            (b.days as number) < 1 ||
            (b.days as number) > 365)
        )
          throw new HttpError(
            422,
            "INVALID_EXPIRY",
            "Extension days must be a whole number from 1 to 365.",
          );
        const n = (b.days as number | undefined) ?? d.config.publicationTtlDays,
          max = new Date(
            c.expiresAt + DEVICE_TOKEN_RECOVERY_DAYS * 86400000,
          ).toISOString(),
          x = await d.repository.extendPublication(
            s[2],
            c.ownerHash,
            now().toISOString(),
            n,
            max,
          );
        if (x.status !== "extended")
          throw new HttpError(
            x.status === "not-found" ? 404 : 422,
            x.status === "not-found"
              ? "PUBLICATION_NOT_FOUND"
              : "PUBLICATION_EXPIRY_LIMIT_REACHED",
            "Cannot extend publication.",
          );
        return json({
          publication: publication(x.publication, d.config.publicPlayerOrigin),
        });
      }
    }
    return apiError(404, "NOT_FOUND", "Endpoint not found.");
  }
  return {
    async fetch(r: Request) {
      try {
        return finish(await handle(r), r, d.config);
      } catch (e) {
        const x =
          e instanceof HttpError
            ? apiError(e.status, e.code, e.message, e.details)
            : e instanceof InvalidModelOutputError
              ? apiError(
                  422,
                  "INVALID_MODEL_OUTPUT",
                  "Generated HTML was invalid.",
                  e.issues,
                )
              : e instanceof ModelProviderError
                ? apiError(
                    e.retryable ? 503 : 502,
                    "MODEL_PROVIDER_ERROR",
                    "Generator unavailable.",
                  )
                : apiError(500, "INTERNAL_ERROR", "Something went wrong.");
        return finish(x, r, d.config);
      }
    },
  };
}
function finish(response: Response, request: Request, config: StudioConfig) {
  if (new URL(request.url).pathname.startsWith("/v1/")) {
    const h = new Headers(response.headers);
    h.set("cache-control", "private, no-store");
    h.set("x-robots-tag", "noindex, nofollow, noarchive");
    response = new Response(response.body, {
      status: response.status,
      headers: h,
    });
  }
  return withCors(response, request, config);
}
