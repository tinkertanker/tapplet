import { networkHashFrom } from "../auth";
import { apiError, HttpError, json } from "../http";
import { assetResponse, image } from "../appResponses";
import type { RouteRequest, StudioContext } from "../appContext";

export async function assetRoutes(
  app: StudioContext,
  incoming: RouteRequest,
): Promise<Response | undefined> {
  const { d, now, owner, inference } = app;
  const { r, s } = incoming;
  if (s[0] === "v1" && s[1] === "assets") {
    if (!d.assets)
      throw new HttpError(
        503,
        "ASSET_STORE_UNAVAILABLE",
        "Images unavailable.",
      );
    const o = await owner(r);
    if (s.length === 2 && r.method === "POST") {
      const { imageSafety } = await inference(o);
      const a = await d.assets.put(r, {
        ownerHash: o,
        ...(imageSafety ? { imageSafety } : {}),
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
  return undefined;
}
