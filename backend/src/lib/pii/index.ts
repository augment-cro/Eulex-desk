/**
 * Public surface of the PII Shield client library.
 *
 * Re-exports everything backend code should ever need to integrate
 * with the sidecar. Import only from this module so internal helpers
 * remain free to move without churn.
 */

export {
    piiClient,
    PII_OPEN,
    PII_CLOSE,
    PII_SENTINEL_OPEN,
    containsPlaceholder,
} from "./client";
export type {
    PiiMode,
    PiiEntity,
    AnonymizeResult,
    DeanonymizeResult,
    MergeDocumentResult,
    ApplyOverridesResult,
    SessionMeta,
    Result as PiiResult,
    AnonymizeArgs,
} from "./client";

export {
    DEFAULT_USER_PII_PREFS,
    effectiveMode,
    piiActive,
    isStrict,
    requiresUserReview,
} from "./gate";
export type { EffectiveMode, UserPiiPrefs } from "./gate";

export {
    PII_PREFIX,
    PII_PLACEHOLDER_RE,
    buildPlaceholder,
    parsePlaceholder,
    extractPlaceholders,
    replacePlaceholders,
    findHallucinatedPlaceholders,
    safeTextForDrip,
} from "./placeholders";

export { redactJsonDeep, collectPlaceholdersDeep } from "./redactJsonDeep";

export {
    getChatSessionId,
    getDocumentAnalysisCache,
    getChatPiiMode,
} from "./session";
export type { PiiDocumentAnalysisCache } from "./session";

export { schedulePrewarm } from "./prewarm";

export {
    TOOL_PII_POLICIES,
    MCP_SERVER_PII_POLICIES,
    getToolPiiPolicy,
    isMcpTool,
    extractMcpSlug,
    getMcpServerPolicy,
    shouldBlockInStrict,
} from "./toolPolicy";
export type { ToolPiiPolicy } from "./toolPolicy";

export { piiSystemPromptAddendum } from "./prompt";
