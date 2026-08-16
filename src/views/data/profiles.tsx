import { ShieldCheck } from "lucide-react";
import { Cell, Pie, PieChart, ResponsiveContainer } from "recharts";
import { foldEffort } from "../../effort-model";
import { familyOf } from "../../model-family";
import { providerFromModel } from "../../provider";
import type { EffortAggregate, EffortGroupRow, EffortSummary } from "../../types";
import {
  ComboPill,
  EffortCoverage,
  EffortState,
  effortColor,
  effortLabel,
  sharePercent,
} from "../../components/effort";
import { type ProfileCard, providerColor } from "./insights";

const providerOf = (id: string) => (id.includes("anthropic") ? "anthropic" : "codex");
type Provider = ReturnType<typeof providerOf>;
const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

function providerSummary(rows: EffortGroupRow[]): EffortSummary | null {
  if (rows.length === 0) return null;
  const levels = new Map<string, { effort: string; observations: number; tokens: number }>();
  for (const row of rows) {
    for (const level of row.summary.levels) {
      const bucket = levels.get(level.effort) ?? { effort: level.effort, observations: 0, tokens: 0 };
      bucket.observations += level.observations;
      bucket.tokens += level.tokens;
      levels.set(level.effort, bucket);
    }
  }
  const quality = rows.some((row) => row.summary.quality === "degraded")
    ? "degraded"
    : rows.some((row) => row.summary.quality === "stale")
      ? "stale"
      : "ok";
  return foldEffort([...levels.values()], {
    eligibleTokens: rows.reduce((sum, row) => sum + row.summary.eligibleTokens, 0),
    unknownObservations: rows.reduce((sum, row) => sum + row.summary.unknownObservations, 0),
    quality,
  });
}

function ProviderEffortPie({
  provider,
  aggregate,
}: {
  provider: Provider;
  aggregate: EffortAggregate | null;
}) {
  const rows = (aggregate?.rows ?? []).filter((row) => providerFromModel(row.key) === provider);
  const summary = providerSummary(rows);
  const pie = (summary?.levels ?? [])
    .filter((level) => level.tokens > 0)
    .map((level) => ({
      effort: level.effort,
      label: effortLabel(level.effort),
      value: level.tokens,
      color: effortColor(level.effort),
    }));
  const comboTotals = new Map<string, { family: string; effort: string; tokens: number }>();
  for (const row of rows) {
    const family = familyOf(row.key);
    for (const level of row.summary.levels) {
      if (level.tokens <= 0) continue;
      const key = `${family}\0${level.effort}`;
      const combo = comboTotals.get(key) ?? { family, effort: level.effort, tokens: 0 };
      combo.tokens += level.tokens;
      comboTotals.set(key, combo);
    }
  }
  const combos = [...comboTotals.values()]
    .sort((left, right) => right.tokens - left.tokens || left.family.localeCompare(right.family))
    .slice(0, 4);
  const providerTotal = summary?.attributedTokens ?? 0;
  const providerLabel = provider === "anthropic" ? "Claude" : "Codex";

  return (
    <section className="provider-effort">
      <span className="overline">EFFORTS ACROSS ALL {providerLabel.toUpperCase()}</span>
      <p>Unfiltered corpus distribution; the session filters and rule chips below do not change it.</p>
      <EffortState status={aggregate?.status ?? null} summary={summary}>
        {summary && (
          <>
            <div
              className="provider-effort-pie"
              role="img"
              aria-label={`${providerLabel} recorded effort distribution: ${pie.map((slice) => `${slice.label} ${sharePercent(slice.value, providerTotal)}`).join(", ")}`}
            >
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={pie}
                    dataKey="value"
                    nameKey="label"
                    innerRadius={47}
                    outerRadius={68}
                    paddingAngle={2}
                    stroke="none"
                    isAnimationActive={false}
                  >
                    {pie.map((slice) => <Cell key={slice.effort} fill={slice.color} />)}
                  </Pie>
                </PieChart>
              </ResponsiveContainer>
              <div aria-hidden="true">
                <b>{compact.format(providerTotal)}</b>
                <small>recorded tokens</small>
              </div>
            </div>
            <ul className="provider-effort-legend">
              {pie.map((slice) => (
                <li key={slice.effort}>
                  <i style={{ background: slice.color }} aria-hidden="true" />
                  <span>{slice.label}</span>
                  <b>{sharePercent(slice.value, providerTotal)}</b>
                </li>
              ))}
            </ul>
            <EffortCoverage
              summary={summary}
              indexing={aggregate?.status.phase === "indexing"}
            />
            {combos.length > 0 && (
              <div className="provider-effort-combos">
                <span className="overline">TOP MODEL × EFFORT</span>
                <div>
                  {combos.map((combo) => (
                    <ComboPill
                      key={`${combo.family}-${combo.effort}`}
                      combo={combo}
                      trailing={sharePercent(combo.tokens, providerTotal)}
                    />
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </EffortState>
    </section>
  );
}

export function AllowanceProfiles({
  profiles,
  modelEffort,
}: {
  profiles: ProfileCard[];
  modelEffort: EffortAggregate | null;
}) {
  return (
    <section className="data-section">
      <header className="data-section__head">
        <div>
          <span className="overline">SUBSCRIPTION ALLOWANCE</span>
          <h2>Did the included capacity get used?</h2>
        </div>
        <p className="allowance-profiles__intro">
          Graded per provider from locally observed quota history, never blended. Scores and effort
          distributions are whole-corpus context; the session facets below do not change them.
        </p>
      </header>
      <div className="profile-grid">
        {profiles.map((profile) => {
          const provider = providerOf(profile.id);
          return (
            <article className="profile-card" key={profile.id} style={{ ["--provider" as string]: providerColor(provider) }}>
              <div className="profile-card__score-column">
                <div className="profile-card__top">
                  <span className="profile-provider">
                    <ShieldCheck /> {provider === "anthropic" ? "Claude" : "Codex"}
                  </span>
                  <span className={`profile-band ${profile.band ?? "na"}`}>{profile.band ? profile.band.replace("-", " ") : "not graded"}</span>
                </div>
                <div className="profile-score">
                  {profile.score ?? "—"}
                  <span>/100 · {profile.confidence} confidence</span>
                </div>
                <h3>Allowance capture</h3>
                <p>{profile.explanation}</p>
                <dl>
                  {profile.components.map((component) => (
                    <div key={component.id}>
                      <dt>
                        {component.label}
                        <small>{component.weight}% weight</small>
                      </dt>
                      <dd>
                        {component.normalized === null ? "N/A" : Math.round(component.normalized)}
                        {component.value !== null && <small>measured {Math.round(component.value)}</small>}
                      </dd>
                      {component.unavailableReason && <em>{component.unavailableReason}</em>}
                    </div>
                  ))}
                </dl>
                <footer>rubric {profile.rubricVersion}</footer>
              </div>
              <ProviderEffortPie provider={provider} aggregate={modelEffort} />
            </article>
          );
        })}
      </div>
    </section>
  );
}
