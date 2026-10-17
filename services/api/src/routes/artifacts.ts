import type { TeacherBrief } from "../ai/provider";
import { reviseArtifact, validateHtmlOutput } from "../generation";
import { emitOperationalTrace } from "../operationalTrace";
import { apiError, HttpError, json, readJson } from "../http";
import { advisoryWarnings, inspectHtml, inspectText, inspectUnknownText } from "../moderation";
import { PROMPT_VERSION } from "../ai/prompts";
import { cleanupArtifactStorage } from "../sourceStore";
import { type RevisionRecord, retrievalDescriptor } from "../storage/repository";
import { days, ID, obj, optionalStr, str } from "../appInput";
import { artifactResponse, design, headRevisionConflict, moderationUnavailableWarning, publication, publicationReviewWarning, revisionResponse } from "../appResponses";
import type { RouteRequest, StudioContext } from "../appContext";

export async function listArtifactsRoute(
  app: StudioContext,
  incoming: RouteRequest,
): Promise<Response | undefined> {
  const { d, owner } = app;
  const { r, u } = incoming;
  if (r.method === "GET" && u.pathname === "/v1/artifacts") {
    const ownerHash = await owner(r);
    const [artifacts, publications] = await Promise.all([
      d.repository.listArtifacts(ownerHash),
      d.repository.listActivePublicationsForOwner(ownerHash),
    ]);
    const activeByArtifact = new Map(
      publications.map((entry) => [entry.artifactId, entry]),
    );
    return json({
      artifacts: artifacts.map((artifact) => {
        const active = activeByArtifact.get(artifact.id);
        return {
          ...artifactResponse(artifact),
          publication: active
            ? publication(active, d.config.publicPlayerOrigin)
            : null,
          publicationStale:
            !!active && active.revisionId !== artifact.headRevisionId,
        };
      }),
    });
  }
  return undefined;
}

export async function artifactRoutes(
  app: StudioContext,
  incoming: RouteRequest,
): Promise<Response | undefined> {
  const { d, now, id, slug, owner, inference, quota, chargedUnlessNoCandidate, validateAssetReferences, assets, projectResponse, persist } = app;
  const { r, s, trace, requestStarted } = incoming;
  if (s[0] === "v1" && s[1] === "artifacts" && s[2] && ID.test(s[2])) {
    const o = await owner(r),
      a = await d.repository.getArtifact(s[2], o);
    if (!a)
      throw new HttpError(404, "ARTIFACT_NOT_FOUND", "Artifact unavailable.");
    if (s.length === 3 && r.method === "GET")
      return json(await projectResponse(a, o));
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
      // Room for every field at its character limit in three-byte UTF-8.
      const b = obj(await readJson(r, 40_000));
      if (typeof b.title === "string" && b.headRevisionId === undefined) {
        // Accept everything creation stores: a generated title can fall back
        // to the learning objective and the level is the learner context.
        const metadata = {
          title: str(b.title, "Title", 600),
          summary: str(b.summary, "Summary", 1000),
          subject: optionalStr(b.subject, "Subject", 100) ?? null,
          level: optionalStr(b.level, "Level", 300) ?? null,
          locale: optionalStr(b.locale, "Locale", 30) ?? null,
          learningObjective:
            optionalStr(b.learningObjective, "Learning objective", 600) ??
            null,
          tags: Array.isArray(b.tags)
            ? b.tags.map((x) => str(x, "Tag", 60)).slice(0, 20)
            : [],
          creationBrief: str(b.creationBrief, "Creation brief", 8000),
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
                ? (await projectResponse(value, o)).artifact
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
        throw headRevisionConflict();
      return json(
        await d.repository
          .getArtifact(a.id, o)
          .then((value) => projectResponse(value!, o)),
      );
    }
    if (s[3] === "revisions" && s.length === 4 && r.method === "GET")
      return json({
        revisions: (await d.repository.listRevisions(a.id, o)).map(
          revisionResponse,
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
        throw headRevisionConflict();
      const requiredAssets = requiredAssetId
        ? await validateAssetReferences([requiredAssetId], o)
        : [];
      const warnings = advisoryWarnings("prompt", inspectText(instruction));
      const refundGeneration = await quota(r, o, "generation");
      const current = await d.repository.getRevision(expected),
        html = current && (await d.sources.getSource(current.sourceHash));
      if (!current || current.artifactId !== a.id || !html)
        throw new HttpError(
          404,
          "REVISION_NOT_FOUND",
          "Revision unavailable.",
        );
      const { provider } = await inference(o);
      const out = await chargedUnlessNoCandidate(
          [refundGeneration],
          (onCandidate) =>
            reviseArtifact(
              provider,
              html,
              design(current),
              instruction,
              JSON.parse(a.generationBrief) as TeacherBrief,
              requiredAssets.map((asset) => ({
                id: asset.id,
                alternativeText: asset.alternativeText,
                decorative: asset.decorative,
              })),
              {
                ...d.generationPolicy,
                ...(trace ? { trace } : {}),
                sessionId: a.id,
                onCandidate,
              },
            ),
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
          comment: out.comment ?? null,
          exemplars: [],
          modelVersion: provider.name,
          promptVersion: PROMPT_VERSION,
          screenshotKey: null,
          createdAt: timestamp,
        };
      warnings.push(
        ...advisoryWarnings("generated_content", [
          ...inspectHtml(out.html),
          ...inspectUnknownText(out.designCard),
          ...inspectText(out.comment ?? ""),
        ]),
      );
      const assetIds = await assets(out.html, o);
      if (!(await d.repository.createRevision(rv, o, expected, assetIds)))
        throw headRevisionConflict();
      if (trace) {
        emitOperationalTrace(trace.sink, {
          kind: "artifact_commit",
          requestId: trace.requestId,
          operation: "revise",
          artifactId: a.id,
          revisionId: rid,
          sourceHash: hash,
          outputBytes: rv.sourceBytes,
          exemplarRevisionIds: [],
          durationMs: Math.round(performance.now() - requestStarted),
        });
      }
      // Details may have been saved during the model call; return them
      // rather than the metadata read before it.
      const latest = await d.repository.getArtifact(a.id, o);
      return json(
        {
          ...(await projectResponse(
            latest
              ? { ...latest, headRevisionId: rid }
              : { ...a, headRevisionId: rid, updatedAt: timestamp },
            o,
            { revision: rv, html: out.html },
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
        throw headRevisionConflict();
      const rv = await d.repository.getRevision(expected),
        html = rv && (await d.sources.getSource(rv.sourceHash));
      if (!rv || !html)
        throw new HttpError(
          404,
          "REVISION_NOT_FOUND",
          "Revision unavailable.",
        );
      const designCard = design(rv);
      validateHtmlOutput({
        html,
        ...(designCard ? { designCard } : {}),
      });
      const warnings = advisoryWarnings(
        "generated_content",
        [...inspectHtml(html), ...inspectUnknownText(designCard)],
      );
      await assets(html, o);
      await quota(r, o, "safety");
      try {
        const { provider } = await inference(o);
        const m = await provider.moderate(html, trace, a.id);
        if (!m.safe) warnings.push(publicationReviewWarning(m.categories));
      } catch (error) {
        const diagnostic = error instanceof Error
          ? `${error.name}: ${error.message}`
          : String(error);
        console.error(`Publication moderation failed: ${diagnostic}`);
        warnings.push(moderationUnavailableWarning());
      }
      // Details may have been saved during the review; publish those.
      const current = (await d.repository.getArtifact(a.id, o)) ?? a;
      const p = await d.repository.publish(
        slug(),
        current,
        rv,
        days(now(), d.config.publicationTtlDays),
        now().toISOString(),
        retrievalDescriptor(current, rv.designCard),
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
  return undefined;
}
