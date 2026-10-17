import type { TeacherBrief } from "../ai/provider";
import { assetReferences, validateHtmlOutput } from "../generation";
import { HttpError, json, readJson } from "../http";
import { type ArtifactRecord, type RevisionRecord, CURATED_SEED_OWNER } from "../storage/repository";
import { obj, str, stringList } from "../appInput";
import type { RouteRequest, StudioContext } from "../appContext";

export async function seedImportRoute(
  app: StudioContext,
  incoming: RouteRequest,
): Promise<Response | undefined> {
  const { d, now, persist } = app;
  const { r, u } = incoming;
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
    if (assetReferences(html).markup.length)
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
  return undefined;
}
