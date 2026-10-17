import type { DesignCard } from "./ai/provider";
import type { StoredAsset } from "./assets";
import { HttpError } from "./http";
import type { AdvisoryWarning } from "./moderation";
import type { ArtifactRecord, PublicationRecord, RevisionRecord } from "./storage/repository";

// Wire shapes, errors and advisory warnings the studio API routes return.
export const headRevisionConflict = () =>
  new HttpError(409, "HEAD_REVISION_CONFLICT", "Artifact head changed.");
export const storageLimitReached = () =>
  new HttpError(429, "ARTIFACT_STORAGE_LIMIT_REACHED", "Saved tapplet limit reached.");
export function design(r: RevisionRecord): DesignCard | undefined {
  return r.designCard ? (JSON.parse(r.designCard) as DesignCard) : undefined;
}
export function artifactResponse(artifact: ArtifactRecord) {
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
export function revisionResponse(revision: RevisionRecord) {
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
    comment: revision.comment ?? null,
    // Screenshots are private; the iPad must not receive a URL that AsyncImage
    // cannot authenticate. Upload success remains part of the wire contract.
    screenshotUrl: null,
    model: revision.modelVersion,
    promptVersion: revision.promptVersion,
    createdAt: revision.createdAt,
  };
}
export function publication(p: PublicationRecord, origin: string) {
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
export function sourceResponse(html: string) {
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "private, no-store",
    },
  });
}
export function image(a: StoredAsset) {
  const h = new Headers();
  a.object.writeHttpMetadata(h);
  h.set("etag", a.object.httpEtag);
  h.set("x-content-type-options", "nosniff");
  return new Response(a.object.body, { headers: h });
}
export function assetResponse(asset: StoredAsset["record"]) {
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

export function publicationReviewWarning(categories: string[]): AdvisoryWarning {
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

export function moderationUnavailableWarning(): AdvisoryWarning {
  return {
    source: "publication",
    code: "AI_CONTENT_REVIEW_UNAVAILABLE",
    message:
      "AI review was unavailable. Check the tapplet before sharing; you can continue or edit and publish again.",
  };
}
