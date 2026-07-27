import { upsertAdvice } from "./store";

type Insights = { profiles: Array<{id:string;score:number|null}>; outliers:{count:number;tokenShare:number}; volume:{cacheCreation:number;cacheRead:number}; };
export type Finding = { ruleId:string; dedupeKey:string; severity:"notice"|"opportunity"|"urgent"; scope:Record<string,string>; evidence:Record<string,number|string> };

export function findAdvice(insights: Insights): Finding[] {
  const findings: Finding[] = [];
  if (insights.outliers.count && insights.outliers.tokenShare >= .25) findings.push({ruleId:"outliers-material@1",dedupeKey:"all",severity:"opportunity",scope:{scope:"all"},evidence:{outlierCount:insights.outliers.count,tokenShare:insights.outliers.tokenShare}});
  if (insights.volume.cacheCreation > 0 && insights.volume.cacheRead < insights.volume.cacheCreation) findings.push({ruleId:"cache-write-amortization@1",dedupeKey:"all",severity:"notice",scope:{scope:"all"},evidence:{cacheCreation:insights.volume.cacheCreation,cacheRead:insights.volume.cacheRead}});
  for (const profile of insights.profiles) if (profile.score !== null && profile.score < 60) findings.push({ruleId:"allowance-drifting@1",dedupeKey:profile.id,severity:"urgent",scope:{profile:profile.id},evidence:{score:profile.score}});
  return findings;
}
export function reconcileAdvice(insights: Insights) { return findAdvice(insights).map(upsertAdvice); }
