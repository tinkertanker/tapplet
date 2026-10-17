import { type ModelProvider, ModelProviderError } from "./ai/provider";
import type { AssetRecord, AssetStore } from "./assets";
import { networkHashFrom, ownerHashFrom, randomSlug, sha256 } from "./auth";
import type { ClassInference } from "./classInference";
import type { StudioConfig } from "./env";
import { assetReferences, type GenerationOptions } from "./generation";
import type { OperationalTraceContext, OperationalTraceSink } from "./operationalTrace";
import { HttpError } from "./http";
import type { SourceStore } from "./sourceStore";
import type { ArtifactRecord, PublicationRecord, RevisionRecord, StudioRepository } from "./storage/repository";
import { artifactResponse, publication, revisionResponse, storageLimitReached } from "./appResponses";

export interface Deps {
  repository: StudioRepository;
  provider: ModelProvider;
  /** Model access from the device's class, or null for the global provider. */
  classInference?: (ownerHash: string) => Promise<ClassInference | null>;
  config: StudioConfig;
  sources: SourceStore;
  assets?: AssetStore;
  now?: () => Date;
  createId?: () => string;
  createSlug?: () => string;
  traceSink?: OperationalTraceSink;
  generationPolicy?: Pick<GenerationOptions, "maxModelRepairs">;
}

/** The request as every route sees it. */
export interface RouteRequest {
  r: Request;
  u: URL;
  s: string[];
  trace: OperationalTraceContext | undefined;
  requestStarted: number;
}

/** Dependencies and per-app helpers the routes share. */
export function createStudioContext(d: Deps) {
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
  async function inference(o: string) {
    const scoped = await d.classInference?.(o);
    return scoped ?? { provider: d.provider, imageSafety: undefined };
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
    const subject = `${kind}:${o}`,
      networkSubject = `network-${kind}:${await networkHashFrom(r)}`;
    if (!(await d.repository.consumeGeneration(subject, date, limit)))
      throw new HttpError(429, "LIMIT_REACHED", "Daily limit reached.");
    if (
      !(await d.repository.consumeGeneration(
        networkSubject,
        date,
        networkLimit,
      ))
    ) {
      await d.repository.refundGeneration(subject, date);
      throw new HttpError(
        429,
        "NETWORK_LIMIT_REACHED",
        "Network safety limit reached.",
      );
    }
    return async (): Promise<void> => {
      await Promise.allSettled(
        [subject, networkSubject].map((usage) =>
          d.repository.refundGeneration(usage, date),
        ),
      );
    };
  }
  // A provider failure before any candidate exists returns the reserved units;
  // once a candidate arrives, the request and its repairs stay charged.
  async function chargedUnlessNoCandidate<T>(
    refunds: Array<() => Promise<void>>,
    run: (onCandidate: () => void) => Promise<T>,
  ): Promise<T> {
    let candidate = false;
    try {
      return await run(() => {
        candidate = true;
      });
    } catch (error) {
      if (!candidate && error instanceof ModelProviderError)
        await Promise.all(refunds.map((refund) => refund()));
      throw error;
    }
  }
  async function assetRecord(id: string): Promise<AssetRecord | null> {
    if (d.assets?.getRecord) return d.assets.getRecord(id);
    return (await d.assets!.get(id))?.record ?? null;
  }
  // A device may use an image it owns or one a tapplet of its own already
  // uses. A remix may also use the images its source's owner could use, as the
  // source revision recorded only those.
  async function mayUseAsset(
    record: AssetRecord,
    x: string,
    o: string,
    sourceOwner?: string,
  ): Promise<boolean> {
    for (const owner of sourceOwner && sourceOwner !== o ? [o, sourceOwner] : [o])
      if (
        record.ownerHash === owner ||
        (await d.repository.ownerReferencesAsset(owner, x))
      )
        return true;
    return false;
  }
  async function validateAssetReferences(
    ids: string[],
    o: string,
    sourceOwner?: string,
  ) {
    const unique = [...new Set(ids)];
    if (unique.length && !d.assets)
      throw new HttpError(
        503,
        "ASSET_STORE_UNAVAILABLE",
        "Images unavailable.",
      );
    return Promise.all(
      unique.map(async (x) => {
        const record = await assetRecord(x);
        if (!record || !(await mayUseAsset(record, x, o, sourceOwner)))
          throw new HttpError(
            422,
            "INVALID_ARTIFACT_ASSET",
            `Asset ${x} is not owned by this device.`,
          );
        return record;
      }),
    );
  }
  // The images html uses that this device may use, and whether a script string
  // names a stored image it may not use, which is left unrecorded.
  async function assetUse(html: string, o: string, sourceOwner?: string) {
    const { markup, strings } = assetReferences(html);
    await validateAssetReferences(markup, o, sourceOwner);
    // A script string such as "assets/images" need not name an image: record
    // one only when it names an image this device may use, as before such
    // strings were recorded, rather than refusing the tapplet.
    const usable = await Promise.all(
      strings.map(async (x) => {
        const record = d.assets ? await assetRecord(x) : null;
        return record
          ? { id: x, usable: await mayUseAsset(record, x, o, sourceOwner) }
          : null;
      }),
    );
    return {
      ids: [
        ...markup,
        ...usable.flatMap((x) => (x?.usable ? [x.id] : [])),
      ],
      foreign: usable.some((x) => x && !x.usable),
    };
  }
  async function assets(html: string, o: string, sourceOwner?: string) {
    return (await assetUse(html, o, sourceOwner)).ids;
  }
  // A model may copy an exemplar's images, including those its script keeps in
  // strings, which this device could neither save nor show.
  async function usableAssets(html: string, o: string): Promise<boolean> {
    try {
      return !(await assetUse(html, o)).foreign;
    } catch (error) {
      if (error instanceof HttpError) return false;
      throw error;
    }
  }
  async function projectResponse(
    a: ArtifactRecord,
    o: string,
    extras: {
      revision?: RevisionRecord;
      html?: string | null;
      publication?: PublicationRecord | null;
      revisions?: RevisionRecord[];
    } = {},
  ) {
    const [head, p, revisionRecords] = await Promise.all([
      extras.revision ?? d.repository.getRevision(a.headRevisionId),
      extras.publication !== undefined
        ? extras.publication
        : d.repository.getActivePublicationForArtifact(a.id, o),
      extras.revisions ?? d.repository.listRevisions(a.id, o),
    ]);
    const html =
      extras.html !== undefined
        ? extras.html
        : head
          ? await d.sources.getSource(head.sourceHash)
          : null;
    return {
      artifact: {
        ...artifactResponse(a),
        publication: p ? publication(p, d.config.publicPlayerOrigin) : null,
        publicationStale: !!p && p.revisionId !== a.headRevisionId,
      },
      headRevision: head ? revisionResponse(head) : null,
      html,
      revisions: revisionRecords.map(revisionResponse),
    };
  }
  async function persist(html: string) {
    const h = await sha256(html);
    await d.sources.putSource(h, html);
    return h;
  }
  async function reserveArtifactCreation(r: Request, ownerHash: string) {
    if (
      (await d.repository.countArtifacts(ownerHash)) >=
      d.config.maximumDraftsPerOwner
    )
      throw storageLimitReached();
    return quota(r, ownerHash, "artifact");
  }
  return {
    d,
    now,
    id,
    slug,
    owner,
    inference,
    quota,
    chargedUnlessNoCandidate,
    assetRecord,
    mayUseAsset,
    validateAssetReferences,
    assetUse,
    assets,
    usableAssets,
    projectResponse,
    persist,
    reserveArtifactCreation,
  };
}

export type StudioContext = ReturnType<typeof createStudioContext>;

/** Answers a request it recognises and returns undefined for any other. */
export type Route = (
  app: StudioContext,
  incoming: RouteRequest,
) => Promise<Response | undefined>;
