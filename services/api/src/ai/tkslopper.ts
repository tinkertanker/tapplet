// tkslopper is Tinkertanker's managed inference boundary. The client is split
// across ./tkslopper/; this module keeps the public surface in one place.
export { GROUP_KEY_PATTERN, inferenceTransport, portableEffort, readTkslopperConfig, readTkslopperClassConfig } from "./tkslopper/config";
export type { PortableEffort, TkslopperArtifactEndpoint, TkslopperOperation, TkslopperTarget, TkslopperRouteConfig, TkslopperConfig, TkslopperClassConfig, TkslopperClientConfig, TkslopperConfigResult, TkslopperClassConfigResult } from "./tkslopper/config";
export { TkslopperGrantCache, TkslopperError, ClassAccessError, TkslopperClient } from "./tkslopper/client";
export type { TkslopperGatewayResult, ManagedModelMetadata, TkslopperClientOptions } from "./tkslopper/client";
export { responsesOutcome, chatOutcome } from "./tkslopper/outcome";
export { TkslopperModelProvider, createTkslopperModelProvider } from "./tkslopper/provider";
export type { TkslopperModelProviderOptions } from "./tkslopper/provider";
export { TkslopperImageSafetyInspector, createTkslopperImageSafetyInspector } from "./tkslopper/safety";
