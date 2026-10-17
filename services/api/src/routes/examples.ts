import { json } from "../http";
import { retrievalQuery, str } from "../appInput";
import type { RouteRequest, StudioContext } from "../appContext";

export async function searchExamplesRoute(
  app: StudioContext,
  incoming: RouteRequest,
): Promise<Response | undefined> {
  const { d, now, owner } = app;
  const { r, u } = incoming;
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
  return undefined;
}
