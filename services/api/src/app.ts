import { ModelProviderError } from "./ai/provider";
import { ClassAccessError } from "./ai/tkslopper";
import type { StudioConfig } from "./env";
import { InvalidModelOutputError } from "./generation";
import type { OperationalTraceContext } from "./operationalTrace";
import { apiError, corsHeaders, HttpError, json, withCors } from "./http";
import { seedImportRoute } from "./routes/seeds";
import { refreshDeviceRoute, registerDeviceRoute } from "./routes/devices";
import { generateRoute } from "./routes/generate";
import { artifactRoutes, listArtifactsRoute } from "./routes/artifacts";
import { searchExamplesRoute } from "./routes/examples";
import { assetRoutes } from "./routes/assets";
import { revisionRoutes } from "./routes/revisions";
import { publicationRoutes } from "./routes/publications";
import {
  createStudioContext,
  type Deps,
  type Route,
  type RouteRequest,
} from "./appContext";

// Tried in order; the first route that recognises the request answers it.
const ROUTES: readonly Route[] = [
  seedImportRoute,
  registerDeviceRoute,
  refreshDeviceRoute,
  generateRoute,
  listArtifactsRoute,
  searchExamplesRoute,
  assetRoutes,
  artifactRoutes,
  revisionRoutes,
  publicationRoutes,
];

export function createStudioApp(d: Deps) {
  const app = createStudioContext(d);
  async function handle(r: Request): Promise<Response> {
    const requestStarted = performance.now();
    const trace: OperationalTraceContext | undefined = d.traceSink
      ? { requestId: crypto.randomUUID(), sink: d.traceSink }
      : undefined;
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
    const incoming: RouteRequest = { r, u, s, trace, requestStarted };
    for (const route of ROUTES) {
      const response = await route(app, incoming);
      if (response) return response;
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
              : e instanceof ClassAccessError
                ? e.denial === "allowance"
                  ? apiError(
                      429,
                      "CLASS_AI_ALLOWANCE_REACHED",
                      "Your class has used its AI allowance. Ask your facilitator for more.",
                    )
                  : apiError(
                      403,
                      "CLASS_AI_UNAVAILABLE",
                      "AI is not available for your class right now. It may be paused or finished; ask your facilitator.",
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
