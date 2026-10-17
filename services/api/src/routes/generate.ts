import { generateArtifact } from "../generation";
import { emitOperationalTrace } from "../operationalTrace";
import { json, readJson } from "../http";
import { advisoryWarnings, inspectHtml, inspectTeacherBrief, inspectText, inspectUnknownText } from "../moderation";
import { PROMPT_VERSION } from "../ai/prompts";
import type { ArtifactRecord, RevisionRecord } from "../storage/repository";
import { brief, generationRetrievalQuery, obj } from "../appInput";
import { design, storageLimitReached } from "../appResponses";
import type { RouteRequest, StudioContext } from "../appContext";

export async function generateRoute(
  app: StudioContext,
  incoming: RouteRequest,
): Promise<Response | undefined> {
  const { d, now, id, owner, inference, quota, chargedUnlessNoCandidate, assets, usableAssets, projectResponse, persist, reserveArtifactCreation } = app;
  const { r, u, trace, requestStarted } = incoming;
  if (r.method === "POST" && u.pathname === "/v1/artifacts/generate") {
    const o = await owner(r),
      // Field limits count characters; Chinese or Tamil text takes three
      // UTF-8 bytes each, and the creation brief repeats the answers.
      request = brief(obj(await readJson(r, 64_000))),
      b = request.brief,
      warnings = advisoryWarnings("prompt", [
        ...inspectTeacherBrief(b),
        ...inspectText(request.creationBrief),
      ]);
    const refundArtifact = await reserveArtifactCreation(r, o);
    const refundGeneration = await quota(r, o, "generation").catch(
      async (error: unknown) => {
        await refundArtifact();
        throw error;
      },
    );
    const retrievalStarted = performance.now();
    const query = generationRetrievalQuery(b);
    const preferred = request.preferredExampleRevisionId
      ? await d.repository.getRevision(request.preferredExampleRevisionId)
      : null;
    const [ownedPreferred, retrievablePreferred] = preferred
      ? await Promise.all([
          d.repository.getArtifact(preferred.artifactId, o),
          d.repository.isRevisionRetrievable(
            preferred.id,
            now().toISOString(),
          ),
        ])
      : [null, false];
    const usePreferred = !!(preferred && (ownedPreferred || retrievablePreferred));
    // An unavailable teacher choice falls back to automatic retrieval.
    if (request.preferredExampleRevisionId && !usePreferred)
      warnings.push({
        source: "prompt",
        code: "PREFERRED_EXAMPLE_UNAVAILABLE",
        message:
          "The example you chose was unavailable, so it was not used. Tapplet Studio looked for similar examples instead.",
      });
    const found = usePreferred && preferred
      ? [{ revisionId: preferred.id, descriptor: "Teacher-selected example" }]
      : query
        ? await d.repository.searchRetrieval(query, 2, now().toISOString())
        : [];
    const ex = (
      await Promise.all(
        found.map(async (e) => {
          const rv = await d.repository.getRevision(e.revisionId),
            html = rv && (await d.sources.getSource(rv.sourceHash));
          // A model may copy an exemplar's images, which this device could
          // not save; offer only exemplars whose images it can use.
          return rv && html && (await usableAssets(html, o))
            ? {
                revisionId: rv.id,
                html,
                designCard: design(rv),
                descriptor: e.descriptor,
              }
            : null;
        }),
      )
    ).filter((entry): entry is NonNullable<typeof entry> => entry !== null);
    if (trace) {
      emitOperationalTrace(trace.sink, {
        kind: "retrieval",
        requestId: trace.requestId,
        mode: usePreferred
          ? "preferred"
          : query
            ? "automatic"
            : "none",
        entries: found.map((entry, index) => ({
          revisionId: entry.revisionId,
          rank: index + 1,
          ...(entry.revisionId === preferred?.id
            ? { curated: preferred.modelVersion === "curated" }
            : "curated" in entry
              ? { curated: entry.curated }
              : {}),
        })),
        durationMs: Math.round(performance.now() - retrievalStarted),
      });
    }
    const aid = id();
    const { provider } = await inference(o);
    const out = await chargedUnlessNoCandidate(
      [refundArtifact, refundGeneration],
      (onCandidate) =>
        generateArtifact(provider, b, ex, {
          ...d.generationPolicy,
          ...(trace ? { trace } : {}),
          sessionId: aid,
          onCandidate,
        }),
    );
    warnings.push(
      ...advisoryWarnings("generated_content", [
        ...inspectHtml(out.html),
        ...inspectUnknownText(out.designCard),
        ...inspectText(out.comment ?? ""),
      ]),
    );
    const rid = id(),
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
      comment: out.comment ?? null,
      exemplars: ex.map((x) => x.revisionId),
      modelVersion: provider.name,
      promptVersion: PROMPT_VERSION,
      screenshotKey: null,
      createdAt: timestamp,
    };
    const a: ArtifactRecord = {
      id: aid,
      ownerHash: o,
      title: out.designCard?.title ?? b.learningObjective,
      // A blank card description would store a summary Save details rejects.
      summary: out.designCard?.description?.trim() || b.studentAction,
      subject: b.subject === "other" ? null : b.subject,
      level: b.learnerContext ?? b.level,
      locale: b.locale ?? "en-SG",
      learningObjective: b.learningObjective,
      tags: out.designCard?.tags ?? [],
      creationBrief: request.creationBrief,
      generationBrief: JSON.stringify(b),
      headRevisionId: rid,
      remixedFromRevisionId: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    if (
      !(await d.repository.createArtifact(
        {
          artifact: a,
          revision: rv,
          assetIds,
        },
        d.config.maximumDraftsPerOwner,
      ))
    )
      throw storageLimitReached();
    if (trace) {
      emitOperationalTrace(trace.sink, {
        kind: "artifact_commit",
        requestId: trace.requestId,
        operation: "generate",
        artifactId: aid,
        revisionId: rid,
        sourceHash: hash,
        outputBytes: rv.sourceBytes,
        exemplarRevisionIds: rv.exemplars,
        durationMs: Math.round(performance.now() - requestStarted),
      });
    }
    return json(
      {
        ...(await projectResponse(a, o, {
          revision: rv,
          html: out.html,
          publication: null,
          revisions: [rv],
        })),
        ...(warnings.length ? { warnings } : {}),
      },
      { status: 201 },
    );
  }
  return undefined;
}
