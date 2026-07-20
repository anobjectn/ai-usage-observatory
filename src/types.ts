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
  prompts: string[];
  tools: Array<{ name: string; count: number }>;
  files: Array<{ path: string; status: "added" | "modified" | "deleted" }>;
  additions: number;
  deletions: number;
  eventsRead: number;
};
export type QuotaWindow = { usedPercent: number; resetsAt: number | null };
export type BankedResetCredit = {
  id: string;
  title: string;
  status: string;
  expiresAt: string | null;
};
export type WindowQuotaSnapshot = {
  kind: "window";
  fiveHour: QuotaWindow | null;
  weekly: QuotaWindow | null;
  modelWindows?: Record<string, QuotaWindow>;
  extra?: { bankedResetCreditsAvailable?: number };
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
  codexBankedResets: {usedCount:number};
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
  models: Array<{model:string;tokens:number;cost:number;inputTokens:number;outputTokens:number;cacheReadTokens:number;agents:string[]}>;
  quotas: {available:boolean;usage?:{generatedAt:number;providers:QuotaProvider[]};resets?:QuotaResets;history?:QuotaHistory;status?:unknown;error?:string;collectedAt:string};
  rules: Array<{id:number;pattern:string;kind:"glob"|"regex";tag:string}>;
  settings: Record<string,string>;
  sources: Array<{name:string;status:string;detail:string;kind:string}>;
  refresh: {inProgress:boolean;lastError:string|null;stale:boolean};
};
