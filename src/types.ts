export type MetricRow = {
  agent: string;
  period: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalTokens: number;
  totalCost: number;
  modelsUsed: string[];
  agents?: Array<MetricRow & { modelBreakdowns: ModelBreakdown[] }>;
  modelBreakdowns: ModelBreakdown[];
  metadata?: { lastActivity?: string; [key: string]: unknown };
};
export type ModelBreakdown = { modelName: string; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number; cost: number };
export type ProjectTrendRow = Omit<MetricRow, "agent" | "period"> & { date: string; period?: string; warpCredits?: number };
export type ProjectActivity = {
  date: string;
  provider: "anthropic" | "codex" | "warp";
  projectId: string;
  projectName: string;
  tokens: number;
  cost: number;
  sessions: number;
  warpCredits?: number;
  models: Array<{model:string;tokens:number;cost:number}>;
};
/** `verdict` is the user's own rating of the session. It is never inferred and is null until
 * they record one. */
export type SessionVerdict = "good" | "mixed" | "bad";
export type SessionAnnotation = { tags: string[]; note: string; verdict: SessionVerdict | null; updatedAt?: string };
export type WarpSessionStats = {
  conversationId: string;
  credits: number;
  lastTurnCredits: number | null;
  contextWindowUsage: number | null;
  wasSummarized: boolean;
  status: string;
  turns: number;
  tasks: number;
  blockCount: number;
  failedCommands: number;
  filesChanged: number;
  linesAdded: number;
  linesRemoved: number;
  commandsExecuted: number;
  toolUsage: Record<string, number>;
  tokensBySource: {
    total: number;
    warp: number;
    byok: number;
    customEndpoint: number;
  };
  tokensByCategory: Record<string, number>;
};
export type Session = MetricRow & {
  sessionId: string;
  cwd: string | null;
  pathTags: string[];
  annotation: SessionAnnotation;
  source?: "ccusage" | "warp";
  warp?: WarpSessionStats;
};
export type SessionDetail = {
  available: boolean;
  prompts: Array<{ text: string; timestamp: string | null }>;
  outputs: Array<{ text: string; timestamp: string | null; truncated: boolean }>;
  tools: Array<{ name: string; count: number }>;
  files: Array<{
    path: string;
    status: "added" | "modified" | "deleted";
    additions: number | null;
    deletions: number | null;
  }>;
  additions: number;
  deletions: number;
  eventsRead: number;
  /** Null when transcript-derived indexing is disabled or this session has no derived rows. */
  effort?: EffortSummary | null;
};
/** Orthogonal status fields. One enum must not try to represent combinations such as
 * "indexing with partial coverage and stale rows". */
export type EffortIndexStatus = {
  enabled: boolean;
  phase: "disabled" | "indexing" | "ready" | "error";
  quality: "ok" | "stale" | "degraded";
  parserVersion: number;
  indexVersion: number;
  indexedAt: string | null;
  error: string | null;
  progress: {
    indexedSessions: number;
    pendingSessions: number;
    indexedBytes: number;
    pendingBytes: number;
  } | null;
  parseErrors: number;
  contextGaps: number;
  skippedBytes: number;
};

export type EffortLevelBucket = {
  effort: string;
  observations: number;
  tokens: number;
};

/** Exactly the fields `EffortCoverage` renders. Combo responses carry these without pretending
 * their buckets are the effort-only `EffortSummary.levels`. */
export type EffortCoverageFields = {
  observedObservations: number;
  unknownObservations: number;
  observationCoverage: number | null;
  eligibleTokens: number;
  attributedTokens: number;
  unknownTokens: number | null;
  tokenCoverage: number | null;
};

/** One scope's provider-recorded reasoning-effort picture. `eligibleTokens` always comes from
 * the matching normalized ccusage scope so the app's existing token totals stay authoritative. */
export type EffortSummary = EffortCoverageFields & {
  coverageState: "unavailable" | "partial" | "complete";
  quality: "ok" | "stale" | "degraded";
  dominant: string | null;
  dominantBasis: "tokens" | "observations" | null;
  mixed: boolean;
  levels: Array<EffortLevelBucket & { tokenShare: number | null }>;
  reconciliationDeltaTokens: number;
};

export type EffortGroup = "total" | "day" | "project" | "model" | "provider";

export type EffortGroupRow = { key: string; label: string; summary: EffortSummary };

export type EffortAggregate = {
  group: EffortGroup;
  rows: EffortGroupRow[];
  total: EffortSummary;
  status: EffortIndexStatus;
};

/** One family × effort bucket. Tokens and observations are combo-attributable; session cost,
 * efficiency findings, and verdict are not, and never appear here. */
export type EffortComboBucket = {
  family: string;
  effort: string;
  kind: "interactive" | "automated" | "synthetic" | "unknown";
  observations: number;
  tokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  reasoningReportedEvents: number;
  /** Null when the provider reported no reasoning at all. A reported zero stays zero. */
  reasoningShare: number | null;
};

export type EffortComboDayRow = {
  key: string;
  buckets: EffortComboBucket[];
  coverage: EffortCoverageFields;
  /** Derived combo tokens exceeded the authoritative day total, so this day draws nothing. */
  suppressed: boolean;
};

export type EffortComboDays = {
  rows: EffortComboDayRow[];
  total: EffortCoverageFields;
  coverageState: EffortSummary["coverageState"];
  status: EffortIndexStatus;
};

/** Sessions a combo uniquely led before an outcome statistic may be shown for it. */
export const LED_SESSION_FLOOR = 5;
/** Ratings a combo's led cohort needs before a good-rate may be shown. Separate from the led
 * floor: five led sessions do not make one rating a credible "100% good". */
export const RATED_SESSION_FLOOR = 5;

/** One combo's scoreboard row.
 *
 * Tokens, observations, appearances, and reasoning share are combo-attributable. Every
 * `*PerLedSession` figure, `flagRate`, and `verdict` is a *whole-session* statistic over sessions
 * this combo uniquely led: observational, never causal, and never a recommendation. */
export type EffortComboBoardRow = {
  family: string;
  effort: string;
  kind: EffortComboBucket["kind"];
  tokens: number;
  observations: number;
  /** Distinct scoped sessions containing this combo at all. */
  sessionsAppeared: number;
  /** Sessions where this combo is the unique largest by attributed tokens. */
  sessionsLed: number;
  /** Sessions this combo appeared in that had no unique leader, so entered no outcome cohort. */
  tiesExcluded: number;
  reasoningShare: number | null;
  medianTokensPerLedSession: number | null;
  medianCostPerLedSession: number | null;
  flagRate: number | null;
  verdict: { rated: number; good: number; mixed: number; bad: number; goodRate: number | null };
  projects: Array<{ projectId: string; tokens: number }>;
};

/** One observational deviation of a project × combo cohort from that project's own baseline.
 *
 * It is recorded evidence, never a recommendation: nothing here controls for task difficulty, and
 * the copy that renders it must not say "best", "better", or "use". */
export type EffortComboContrast = {
  projectId: string;
  family: string;
  effort: string;
  metric: "cost" | "flagRate";
  /** Cost: the cohort median as a multiple of the project median. Flag rate: a signed
   * percentage-point delta — never a ratio, since a zero baseline flag rate is legitimate. */
  value: number;
  cohortValue: number;
  baselineValue: number;
  cohortSessions: number;
  baselineSessions: number;
};

export type EffortComboBoard = {
  rows: EffortComboBoardRow[];
  contrasts: EffortComboContrast[];
  sessionsScoped: number;
  /** Scoped sessions with no unique leading combo. They contribute volume, never outcomes. */
  tiedSessions: number;
  coverage: EffortCoverageFields;
  coverageState: EffortSummary["coverageState"];
  status: EffortIndexStatus;
};

/** High-cardinality digest: one row per dashboard session.
 *
 * Model family is carried as its own index rather than folded into the effort index: an
 * effort-only tuple cannot render, sort, search, or filter by a dominant combo.
 *
 * Row tuple order is (sessionId, dominant combo index or -1, bit flags, token coverage per mille,
 * hexadecimal recorded-combo bitmask indexed into `combos`).
 * Bit flags: 1 = two or more distinct efforts, 2 = has unknown activity,
 * 4 = unjoinable to any transcript, 8 = two or more distinct combos. */
export type EffortSessionDigest = {
  version: 2;
  families: string[];
  efforts: string[];
  combos: Array<[familyIndex: number, effortIndex: number, kind: EffortComboBucket["kind"]]>;
  rows: Array<[sessionId: string, dominantComboIndex: number, flags: number, coveragePerMille: number, comboMaskHex: string]>;
};
export type QuotaWindow = { usedPercent: number; resetsAt: number | null };
export type BankedResetCredit = {
  id: string;
  title: string;
  status: string;
  expiresAt: string | null;
};
/** Spend-based "usage credits" allowance reported live over provider OAuth.
 * All monetary amounts are major currency units (dollars) — never re-divide. */
export type UsageCredits = {
  enabled: boolean;
  spentAmount: number;
  limitAmount: number | null;
  currency: string;
  resetsAt: number | null;
};
/** OpenAI/Codex account credits. These are provider-defined units, not money. */
export type CodexCredits = {
  hasCredits: boolean;
  unlimited: boolean;
  balance: number | null;
};
/** Claude Web-only prepaid/promotion snapshot. Claude Code OAuth cannot read
 * these endpoints, so this is a user-imported observation with its own
 * timestamps and provenance — never presented as live provider data.
 * All monetary amounts are major currency units (dollars). Date-only expiries
 * ship a canonical `*ExpiresOn` (YYYY-MM-DD, UTC) string to render verbatim;
 * the `*ExpiresAt` epoch companions are UTC-midnight and are for countdown math. */
export type AnthropicWebCredits = {
  source: "claude_web_manual";
  capturedAt: number;
  updatedAt: number;
  currentBalance: number | null;
  /** @deprecated No distinct source in Claude's current UI — read currentBalance.
   * Retained for backward compatibility; do not drive display from it. */
  balanceCredits: number | null;
  currency: string;
  autoReloadEnabled: boolean | null;
  nextExpiresAt: number | null;
  nextExpiresOn: string | null;
  promotionalTranches: Array<{
    remainingAmount: number;
    grantedAmount: number | null;
    expiresAt: number | null;
    expiresOn: string | null;
  }>;
  campaign: {
    id: string;
    granted: boolean | null;
    amount: number | null;
    expiresAt: number | null;
    expiresOn: string | null;
  } | null;
  purchases: {
    purchasedThisMonthAmount: number | null;
    monthlyCapAmount: number | null;
    resetsAt: number | null;
    maxDiscountPercent: number | null;
  } | null;
};
export type WindowQuotaSnapshot = {
  kind: "window";
  fiveHour: QuotaWindow | null;
  weekly: QuotaWindow | null;
  modelWindows?: Record<string, QuotaWindow>;
  usageCredits?: UsageCredits | null;
  codexCredits?: CodexCredits | null;
  extra?: { bankedResetCreditsAvailable?: number; rawLimits?: unknown[] | null };
};
export type QuotaManualEntry = {
  provider: string;
  field: string;
  value: string;
  note: string | null;
  updatedAt: number;
};
export type PoolQuotaSnapshot = {
  kind: "pool";
  pool: { used: number; limit: number; usedPercent: number; refreshesAt: number | null; cadence?: string };
};
export type QuotaProvider = {
  provider: "anthropic" | "codex" | "warp";
  status: "ok" | "stale" | "unavailable" | "unknown";
  source: string | null;
  snapshot: WindowQuotaSnapshot | PoolQuotaSnapshot | null;
  error?: string;
  /** How old the underlying provider data is (ms). Optional for tolerance of
   * older quota-service builds that omit it. */
  dataAgeMs?: number | null;
  capturedAt?: number | null;
  manualEntries?: QuotaManualEntry[];
  /** Present only for Anthropic once a Claude Web credit snapshot is imported. */
  anthropicWebCredits?: AnthropicWebCredits | null;
};
export type QuotaResets = {
  codexBankedResetCredits?: {
    availableCount: number;
    totalEarnedCount: number;
    credits: BankedResetCredit[];
    status: string;
  };
};
export type QuotaHistory = {
  available: boolean;
  trackingSince: number | null;
  windows: Array<{provider:"codex"|"anthropic";window:"fiveHour"|"weekly";reachedCount:number;lastReachedAt:number|null;reachedAt:number[]}>;
  series?: Array<{provider:"codex"|"anthropic";window:"fiveHour"|"weekly";capturedAt:number;usedPercent:number;resetsAt:number|null;cycleId:string}>;
  codexBankedResets: {usedCount:number;used:Array<{id:string;title:string;usedAt:number}>};
};
export type WarpDailyUsage = {
  date: string;
  sessions: number;
  credits: number;
  tokens: number;
};
export type WarpData = {
  available: boolean;
  sourceFile: string | null;
  observedAt: string;
  sessionCount: number;
  queryCount: number;
  linkedQueryCount: number;
  queryCoverage: number;
  totals: { sessions: number; credits: number; tokens: number };
  daily: WarpDailyUsage[];
  schema: { required: string[]; missing: string[] };
  error?: string;
};
export type DashboardData = {
  collectedAt: string;
  /** IANA timezone used by ccusage and every AIUO calendar boundary in this snapshot. */
  timeZone: string;
  ccusageVersion: string;
  costMethodology: string;
  blockScope: string;
  daily: MetricRow[];
  weekly: MetricRow[];
  monthly: MetricRow[];
  totals: Omit<MetricRow, "agent" | "period" | "modelsUsed" | "modelBreakdowns">;
  sessions: Session[];
  projectActivity: ProjectActivity[];
  blocks: Array<{id:string;startTime:string;endTime:string;actualEndTime?:string|null;isActive:boolean;totalTokens:number;costUSD:number;burnRate?:{tokensPerMinute?:number;costPerHour?:number}|null;projection?:{totalTokens?:number;totalCost?:number}|null;models:string[];entries:number}>;
  projects: Array<{name:string;tokens:number;cost:number;sessions:number;models:string[];trend:ProjectTrendRow[];warpCredits?:number}>;
  models: Array<{model:string;tokens:number;cost:number;inputTokens:number;outputTokens:number;cacheReadTokens:number;cacheCreationTokens:number;agents:string[];priced:boolean;warpCredits?:number}>;
  /** Models ccusage had no rate card for; their tokens are real but excluded from every cost total. */
  unpricedModels: string[];
  quotas: {available:boolean;usage?:{generatedAt:number;providers:QuotaProvider[]};resets?:QuotaResets;history?:QuotaHistory;status?:unknown;error?:string;collectedAt:string};
  warp: WarpData;
  rules: Array<{id:number;pattern:string;kind:"glob"|"regex";tag:string}>;
  settings: Record<string,string>;
  sources: Array<{name:string;status:string;detail:string;kind:string}>;
  refresh: {inProgress:boolean;lastError:string|null;stale:boolean};
};
