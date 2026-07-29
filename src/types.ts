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
export type ProjectTrendRow = Omit<MetricRow, "agent" | "period"> & { date: string; period?: string };
export type ProjectActivity = {
  date: string;
  provider: "anthropic" | "codex";
  projectId: string;
  projectName: string;
  tokens: number;
  cost: number;
  sessions: number;
  models: Array<{model:string;tokens:number;cost:number}>;
};
export type Session = MetricRow & { sessionId: string; cwd: string | null; pathTags: string[]; annotation: { tags: string[]; note: string } };
export type SessionDetail = {
  available: boolean;
  prompts: Array<{ text: string; timestamp: string | null }>;
  tools: Array<{ name: string; count: number }>;
  files: Array<{ path: string; status: "added" | "modified" | "deleted" }>;
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

/** One scope's provider-recorded reasoning-effort picture. `eligibleTokens` always comes from
 * the matching normalized ccusage scope so the app's existing token totals stay authoritative. */
export type EffortSummary = {
  coverageState: "unavailable" | "partial" | "complete";
  quality: "ok" | "stale" | "degraded";
  dominant: string | null;
  dominantBasis: "tokens" | "observations" | null;
  mixed: boolean;
  levels: Array<EffortLevelBucket & { tokenShare: number | null }>;
  observedObservations: number;
  unknownObservations: number;
  observationCoverage: number | null;
  eligibleTokens: number;
  attributedTokens: number;
  unknownTokens: number | null;
  tokenCoverage: number | null;
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

/** High-cardinality digest: one row per dashboard session.
 * Tuple order is (sessionId, dominant level index or -1, bit flags, token coverage per mille,
 * hexadecimal known-level bitmask).
 * Bit flags: 1 = mixed, 2 = has unknown activity, 4 = unjoinable to any transcript. */
export type EffortSessionDigest = {
  levels: string[];
  rows: Array<[string, number, number, number, string]>;
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
export type DashboardData = {
  collectedAt: string;
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
  projects: Array<{name:string;tokens:number;cost:number;sessions:number;models:string[];trend:ProjectTrendRow[]}>;
  models: Array<{model:string;tokens:number;cost:number;inputTokens:number;outputTokens:number;cacheReadTokens:number;cacheCreationTokens:number;agents:string[];priced:boolean}>;
  /** Models ccusage had no rate card for; their tokens are real but excluded from every cost total. */
  unpricedModels: string[];
  quotas: {available:boolean;usage?:{generatedAt:number;providers:QuotaProvider[]};resets?:QuotaResets;history?:QuotaHistory;status?:unknown;error?:string;collectedAt:string};
  rules: Array<{id:number;pattern:string;kind:"glob"|"regex";tag:string}>;
  settings: Record<string,string>;
  sources: Array<{name:string;status:string;detail:string;kind:string}>;
  refresh: {inProgress:boolean;lastError:string|null;stale:boolean};
};
