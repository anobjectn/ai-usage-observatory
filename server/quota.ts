import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const baseUrl = process.env.QUOTA_SERVICE_URL ?? "http://127.0.0.1:8787";
const defaultHistoryDbPath = join(homedir(), ".quota-service", "quota.db");

type SnapshotHistoryRow = { provider: string; capturedAt: number; snapshotJson: string | null };
type ResetHistoryRow = { capturedAt: number; creditsJson: string | null };
type ResetCreditHistory = { id?: string; status?: string | null; expiresAt?: string | null };

export function summarizeQuotaHistory(snapshotRows: SnapshotHistoryRow[], resetRows: ResetHistoryRow[]) {
  const reachedCycles = new Map<string, Map<string, number>>();
  let trackingSince: number | null = null;
  for (const row of snapshotRows) {
    trackingSince = trackingSince === null ? row.capturedAt : Math.min(trackingSince, row.capturedAt);
    if (!row.snapshotJson) continue;
    try {
      const snapshot = JSON.parse(row.snapshotJson) as { kind?: string; fiveHour?: {usedPercent?:number;resetsAt?:number|null}|null; weekly?: {usedPercent?:number;resetsAt?:number|null}|null };
      if (snapshot.kind !== "window") continue;
      for (const [window, value] of [["fiveHour", snapshot.fiveHour], ["weekly", snapshot.weekly]] as const) {
        if (!value || Number(value.usedPercent) < 100) continue;
        const key = `${row.provider}:${window}`;
        const cycle = value.resetsAt ? String(Math.round(value.resetsAt / 60_000)) : `observed:${row.capturedAt}`;
        const cycles = reachedCycles.get(key) ?? new Map<string, number>();
        const firstObservedAt = cycles.get(cycle);
        if (firstObservedAt === undefined || row.capturedAt < firstObservedAt) {
          cycles.set(cycle, row.capturedAt);
        }
        reachedCycles.set(key, cycles);
      }
    } catch { /* Ignore malformed historical rows; current quota collection remains available. */ }
  }

  const usedResetIds = new Set<string>();
  let previousAvailable = new Map<string, ResetCreditHistory>();
  for (const row of [...resetRows].sort((a, b) => a.capturedAt - b.capturedAt)) {
    trackingSince = trackingSince === null ? row.capturedAt : Math.min(trackingSince, row.capturedAt);
    let credits: ResetCreditHistory[] = [];
    try { credits = row.creditsJson ? JSON.parse(row.creditsJson) : []; } catch { continue; }
    const currentAvailable = new Map<string, ResetCreditHistory>();
    for (const credit of credits) {
      if (!credit.id) continue;
      const status = credit.status?.toLowerCase();
      if (status && ["used", "consumed", "redeemed"].includes(status)) usedResetIds.add(credit.id);
      if (status === "available") currentAvailable.set(credit.id, credit);
    }
    for (const [id, credit] of previousAvailable) {
      const expiry = credit.expiresAt ? Date.parse(credit.expiresAt) : NaN;
      if (!currentAvailable.has(id) && (!Number.isFinite(expiry) || expiry > row.capturedAt)) usedResetIds.add(id);
    }
    previousAvailable = currentAvailable;
  }

  const windows = (["codex", "anthropic"] as const).flatMap((provider) => (["fiveHour", "weekly"] as const).map((window) => {
    const reachedAt = [...(reachedCycles.get(`${provider}:${window}`)?.values() ?? [])]
      .sort((left, right) => right - left);
    return {
      provider,
      window,
      reachedCount: reachedAt.length,
      lastReachedAt: reachedAt[0] ?? null,
      reachedAt,
    };
  }));
  return { available: snapshotRows.length > 0 || resetRows.length > 0, trackingSince, windows, codexBankedResets: { usedCount: usedResetIds.size } };
}

function collectQuotaHistory() {
  try {
    const host = new URL(baseUrl).hostname;
    if (!process.env.QUOTA_DB_PATH && host !== "127.0.0.1" && host !== "localhost") return { available: false, trackingSince: null, windows: [], codexBankedResets: { usedCount: 0 } };
    const dbPath = process.env.QUOTA_DB_PATH ?? defaultHistoryDbPath;
    if (!existsSync(dbPath)) return { available: false, trackingSince: null, windows: [], codexBankedResets: { usedCount: 0 } };
    const db = new Database(dbPath, { readonly: true });
    try {
      const snapshotRows = db.query("SELECT provider, captured_at AS capturedAt, snapshot_json AS snapshotJson FROM snapshots WHERE status IN ('ok', 'stale') ORDER BY captured_at").all() as SnapshotHistoryRow[];
      const resetRows = db.query("SELECT captured_at AS capturedAt, credits_json AS creditsJson FROM reset_credits WHERE status IN ('ok', 'stale') ORDER BY captured_at").all() as ResetHistoryRow[];
      return summarizeQuotaHistory(snapshotRows, resetRows);
    } finally { db.close(); }
  } catch {
    return { available: false, trackingSince: null, windows: [], codexBankedResets: { usedCount: 0 } };
  }
}

export async function collectQuota() {
  try {
    const [usage, resets, status] = await Promise.all(["/usage", "/resets", "/status"].map(async (path) => {
      const response = await fetch(`${baseUrl}${path}`, { signal: AbortSignal.timeout(4000) });
      if (!response.ok) throw new Error(`${path} returned ${response.status}`);
      return response.json();
    }));
    return { available: true, source: baseUrl, usage, resets, status, history: collectQuotaHistory(), collectedAt: new Date().toISOString() };
  } catch (error) {
    return { available: false, source: baseUrl, error: error instanceof Error ? error.message : String(error), history: collectQuotaHistory(), collectedAt: new Date().toISOString() };
  }
}
