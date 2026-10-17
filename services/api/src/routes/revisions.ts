import { apiError, HttpError, json, readBodyBytes, readJson } from "../http";
import { advisoryWarnings, inspectText } from "../moderation";
import { type ArtifactRecord, CURATED_SEED_OWNER } from "../storage/repository";
import { ID, obj, remixBrief, str } from "../appInput";
import { sourceResponse, storageLimitReached } from "../appResponses";
import type { RouteRequest, StudioContext } from "../appContext";

export async function revisionRoutes(
  app: StudioContext,
  incoming: RouteRequest,
): Promise<Response | undefined> {
  const { d, now, id, owner, assets, projectResponse, persist, reserveArtifactCreation } = app;
  const { r, s } = incoming;
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
      await persist(html);
      const aid = id(),
        rid = id(),
        timestamp = now().toISOString(),
        copy = {
          ...rv,
          id: rid,
          artifactId: aid,
          parentRevisionId: null,
          kind: "remix" as const,
          instruction: "Remix",
          // Comments address the source revision's teacher; never copy them.
          comment: null,
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
      if (
        !(await d.repository.createArtifact(
          {
            artifact,
            revision: copy,
            assetIds: await assets(html, o, sourceArtifact.ownerHash),
          },
          d.config.maximumDraftsPerOwner,
        ))
      )
        throw storageLimitReached();
      return json(
        {
          ...(await projectResponse(artifact, o, {
            revision: copy,
            html,
            publication: null,
            revisions: [copy],
          })),
          ...(warnings.length ? { warnings } : {}),
        },
        { status: 201 },
      );
    }
  }
  return undefined;
}
