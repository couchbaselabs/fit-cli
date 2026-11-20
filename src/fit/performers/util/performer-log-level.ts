/** The `LOG_LEVEL` values a performer container accepts. */
export const PERFORMER_LOG_LEVELS = ["trace", "debug", "info", "warn", "error"] as const;
export type PerformerLogLevel = (typeof PERFORMER_LOG_LEVELS)[number];

/** The level applied when a definition doesn't specify one. */
export const DEFAULT_PERFORMER_LOG_LEVEL: PerformerLogLevel = "debug";
