import { UnavailableModelProvider } from "./ai/createProvider";
import type { ModelProvider } from "./ai/provider";
import {
  inferenceTransport,
  readTkslopperClassConfig,
  TkslopperImageSafetyInspector,
  TkslopperModelProvider,
} from "./ai/tkslopper";
import { decryptClassKey } from "./admin";
import type { StudioEnv } from "./env";
import type { ImageSafetyInspector, ImageSafetyReview } from "./imageSafety";
import type { ClassInferenceKey } from "./storage/repository";

/** Model access for a device whose class carries a tkslopper group key. */
export interface ClassInference {
  provider: ModelProvider;
  imageSafety: ImageSafetyInspector;
}

/**
 * Builds the class's model access. Any failure is unavailable rather than a
 * fallback to the global configuration, so a class never spends fleet budget
 * or escapes its own pause.
 */
export async function createClassInference(
  env: StudioEnv,
  row: ClassInferenceKey,
): Promise<ClassInference> {
  const transport = inferenceTransport(env);
  // Unknown transports are the fleet kill switch and also stop class access.
  if (transport !== "direct" && transport !== "tkslopper")
    return unavailable(`Unsupported inference transport: ${transport}`);
  const secret = env.ADMIN_ENCRYPTION_KEY;
  if (!secret || secret.length < 32)
    return unavailable("Class AI keys need ADMIN_ENCRYPTION_KEY.");
  let key: string;
  try {
    key = await decryptClassKey(row.ciphertext, row.iv, secret, row.classCodeHash);
  } catch {
    return unavailable("Class AI key decryption failed.");
  }
  const result = readTkslopperClassConfig(env, key);
  if (!result.ok) return unavailable(result.reason);
  return {
    provider: new TkslopperModelProvider(result.config),
    imageSafety: new TkslopperImageSafetyInspector(result.config),
  };
}

function unavailable(reason: string): ClassInference {
  return {
    provider: new UnavailableModelProvider(reason),
    imageSafety: {
      async inspect(): Promise<ImageSafetyReview> {
        console.error(`Image safety review unavailable: ${reason}`);
        return { status: "unavailable" };
      },
    },
  };
}
