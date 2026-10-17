import { classCodeAttemptNetworkHashFrom, issueDeviceToken, networkHashFrom, newDeviceOwnerId, ownerHashForId, refreshDeviceToken, sha256 } from "../auth";
import { HttpError, json, readJson } from "../http";
import { obj, str } from "../appInput";
import type { RouteRequest, StudioContext } from "../appContext";

export async function registerDeviceRoute(
  app: StudioContext,
  incoming: RouteRequest,
): Promise<Response | undefined> {
  const { d, now } = app;
  const { r, u } = incoming;
  if (r.method === "POST" && u.pathname === "/v1/devices/register") {
    const b = obj(await readJson(r, 1000)),
      code = str(b.accessCode, "Class code", 80)
        .toUpperCase()
        .replaceAll("-", "");
    if (!/^(?:\d{6}|[A-Z]{6}|\d{4}[A-Z]{8})$/.test(code))
      throw new HttpError(
        403,
        "INVALID_ACCESS_CODE",
        "This class code is invalid or expired.",
      );
    const timestamp = now(),
      date = timestamp.toISOString().slice(0, 10),
      ownerId = newDeviceOwnerId(),
      classCodeHash = await sha256(`class-code:${code}`),
      networkHash = await networkHashFrom(r);
    // Reserve every attempt before testing the credential: a successful guess
    // must not bypass a network that has already exhausted its search budget.
    if (
      !(await d.repository.consumeGeneration(
        `class-code-fail-network:${await classCodeAttemptNetworkHashFrom(r)}`,
        date,
        d.config.dailyNetworkClassCodeFailureLimit,
      ))
    )
      throw new HttpError(
        429,
        "CLASS_CODE_NETWORK_LOCKED",
        "This network has had too many class-code attempts today. Ask your facilitator for help.",
      );
    const registration = await d.repository.consumeRegistration(
        classCodeHash,
        timestamp.toISOString(),
        `registration:${networkHash}`,
        date,
        d.config.dailyNetworkRegistrationLimit,
        await ownerHashForId(ownerId),
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
      await issueDeviceToken(
        d.config.deviceTokenSigningSecret,
        timestamp,
        undefined,
        undefined,
        ownerId,
      ),
      { status: 201 },
    );
  }
  return undefined;
}

export async function refreshDeviceRoute(
  app: StudioContext,
  incoming: RouteRequest,
): Promise<Response | undefined> {
  const { d, now } = app;
  const { r, u } = incoming;
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
  return undefined;
}
