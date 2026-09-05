import { Boxes, Database, Layers3 } from "lucide-react";
import { compactTokens, type Insights, percent, providerColor, providerLabel } from "./insights";

const ratioLabel = (value: number | null, digits = 0) => (value === null ? "N/A" : `${value.toFixed(digits)} : 1`);
const tokens = (value: number) => compactTokens.format(value);

/** Four-part composition bar. The parts are deliberately not one "total" — a cache read and a
 * generated output token cost different amounts and mean different things. */
function CompositionBar({ parts, label }: { parts: Array<{ key: string; value: number; color: string }>; label: string }) {
  const total = parts.reduce((sum, part) => sum + part.value, 0) || 1;
  return (
    <div className="composition-bar" role="img" aria-label={`${label}: ${parts.map((part) => `${part.key} ${Math.round((part.value / total) * 100)}%`).join(", ")}`}>
      {parts.map((part) => (
        <i key={part.key} style={{ width: `${(part.value / total) * 100}%`, background: part.color }} />
      ))}
    </div>
  );
}

const compositionKeys = [
  // Same series slots as the Explorer composition bar and the token-type tables.
  { key: "direct input", field: "directInput", color: "var(--color-series-2)" },
  { key: "cache read", field: "cacheRead", color: "var(--color-series-1)" },
  { key: "cache write", field: "cacheCreation", color: "var(--color-series-3)" },
  { key: "output", field: "output", color: "var(--color-series-4)" },
] as const;

export function InferenceVolume({ insights }: { insights: Insights }) {
  const { volume } = insights;
  return (
    <article className="measure-panel">
      <header>
        <Layers3 />
        <div>
          <span className="overline">INFERENCE VOLUME</span>
          <h3>What the subscriptions actually produced</h3>
        </div>
        <span className="measure-chip">measurement · not a ranking</span>
      </header>
      <p>
        Output is the only figure here that represents work the model handed back. Everything else is
        context being moved into the model, which is why raw totals are never compared across
        providers: tokenizers, cache accounting, and rate cards all differ. Read each provider row on
        its own terms.
      </p>
      <div className="measure-headline">
        <div>
          <span>Generated output</span>
          <b>{tokens(volume.output)}</b>
          <small>{percent(volume.outputShare, 2)} of processed tokens</small>
        </div>
        <div>
          <span>Context carry</span>
          <b>{ratioLabel(volume.contextCarry)}</b>
          <small>cache-read tokens per output token</small>
        </div>
        <div>
          <span>Processed</span>
          <b>{tokens(volume.processed)}</b>
          <small>{volume.sessions.toLocaleString()} sessions · median {tokens(volume.medianSession)}</small>
        </div>
        <div>
          <span>API-equivalent</span>
          <b>${volume.cost.toFixed(2)}</b>
          <small>what this would have cost on pay-as-you-go</small>
        </div>
      </div>
      <h4>By provider</h4>
      <div className="measure-scroll">
        <table className="measure-table">
          <thead>
            <tr>
              <th scope="col">Provider</th>
              <th scope="col">Sessions</th>
              <th scope="col">Output</th>
              <th scope="col">Cache read</th>
              <th scope="col">Cache write</th>
              <th scope="col">Carry</th>
              <th scope="col">Median</th>
              <th scope="col">p90</th>
            </tr>
          </thead>
          <tbody>
            {volume.providers.map((row) => (
              <tr key={row.provider}>
                <th scope="row"><i style={{ background: providerColor(row.provider) }} />{providerLabel(row.provider)}</th>
                <td>{row.sessions.toLocaleString()}</td>
                <td>{tokens(row.output)}</td>
                <td>{tokens(row.cacheRead)}</td>
                <td>{row.cacheWritesReported ? tokens(row.cacheCreation) : <em>none</em>}</td>
                <td>{ratioLabel(row.contextCarry)}</td>
                <td>{tokens(row.medianSession)}</td>
                <td>{tokens(row.p90Session)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <footer>
        Carry is cache-read tokens per output token — how much context each answer had to drag along.
        Median and p90 are per-session processed tokens, which is where a handful of long threads show
        up as a gap between the two.
      </footer>
    </article>
  );
}

export function ModelBreakdown({ insights }: { insights: Insights }) {
  const { models } = insights.volume;
  return (
    <article className="measure-panel measure-panel--wide">
      <header>
        <Boxes />
        <div>
          <span className="overline">BY MODEL</span>
          <h3>Which model did which kind of work</h3>
        </div>
        <span className="measure-chip">measurement · not a ranking</span>
      </header>
      <p>
        Sorted by processed tokens under the current scope. “Lead in” counts the sessions where the
        model held the largest token share, which is the basis every cohort comparison on this page
        uses. Look for a family with a high carry and a low output share: that is where context is
        being paid for repeatedly.
      </p>
      <div className="measure-scroll">
        <table className="measure-table">
          <thead>
            <tr>
              <th scope="col">Model</th>
              <th scope="col">Lead in</th>
              <th scope="col">Sessions seen</th>
              <th scope="col">Processed</th>
              <th scope="col">Output</th>
              <th scope="col">Output share</th>
              <th scope="col">Carry</th>
              <th scope="col">Hit rate</th>
              <th scope="col">Cache write</th>
              <th scope="col">Median session</th>
              <th scope="col">Outliers</th>
              <th scope="col">$ / Mtok</th>
            </tr>
          </thead>
          <tbody>
            {models.map((row) => (
              <tr key={row.model}>
                <th scope="row"><i style={{ background: providerColor(row.provider) }} />{row.model}</th>
                <td>{row.dominantIn}</td>
                <td>{row.sessions}</td>
                <td>{tokens(row.processed)}</td>
                <td>{tokens(row.output)}</td>
                <td>{percent(row.outputShare, 2)}</td>
                <td>{ratioLabel(row.contextCarry)}</td>
                <td>{percent(row.cacheHitRate, 1)}</td>
                <td>{row.cacheCreation ? tokens(row.cacheCreation) : <em>none</em>}</td>
                <td>{row.dominantIn ? tokens(row.medianSession) : <em>—</em>}</td>
                <td>{row.outliers || <em>0</em>}</td>
                <td>{row.priced && row.ratePerMillion !== null ? `$${row.ratePerMillion.toFixed(2)}` : <em>unpriced</em>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <footer>
        $ / Mtok is blended over observed traffic, so a cache-heavy model reads cheap — it is a
        cost-tier proxy for the mismatch rule, never a capability ranking. Unpriced models have real
        tokens and no rate card, so they are excluded from every cost figure rather than counted free.
      </footer>
    </article>
  );
}

export function CacheComposition({ insights }: { insights: Insights }) {
  const { cacheComposition: composition } = insights;
  return (
    <article className="measure-panel">
      <header>
        <Database />
        <div>
          <span className="overline">CACHE COMPOSITION</span>
          <h3>Where the tokens went, and how often they paid off</h3>
        </div>
        <span className="measure-chip">measurement · local records</span>
      </header>
      <p>
        A cache <em>write</em> stores a prompt prefix; a cache <em>read</em> re-sends it cheaply on a
        later turn. Reads per write is the amortisation: below 1 the write never paid for itself,
        above 10 a long thread is reusing its context efficiently. Hit rate is the share of incoming
        context that came from cache instead of being sent fresh.
      </p>
      <CompositionBar
        label="Overall token composition"
        parts={compositionKeys.map((entry) => ({ key: entry.key, value: composition[entry.field], color: entry.color }))}
      />
      <ul className="composition-legend">
        {compositionKeys.map((entry) => (
          <li key={entry.key}>
            <i style={{ background: entry.color }} />
            {entry.key}
            <b>{tokens(composition[entry.field])}</b>
          </li>
        ))}
      </ul>
      <div className="measure-headline">
        <div>
          <span>Cache hit rate</span>
          <b>{percent(composition.cacheHitRate, 1)}</b>
          <small>of incoming context served from cache</small>
        </div>
        <div>
          <span>Reads per write</span>
          <b>{composition.amplification === null ? "N/A" : composition.amplification.toFixed(1)}</b>
          <small>{composition.amplification === null ? "no cache writes reported in scope" : "higher means writes were reused more"}</small>
        </div>
      </div>
      {composition.providers.map((row) => (
        <div className="cache-provider" key={row.provider}>
          <div className="cache-provider__head">
            <b><i style={{ background: providerColor(row.provider) }} />{providerLabel(row.provider)}</b>
            <span>hit rate {percent(row.cacheHitRate, 1)} · reads per write {row.amplification === null ? "N/A" : row.amplification.toFixed(1)}</span>
          </div>
          <CompositionBar
            label={`${providerLabel(row.provider)} token composition`}
            parts={compositionKeys.map((entry) => ({ key: entry.key, value: row[entry.field], color: entry.color }))}
          />
          {row.cacheWritesReported ? (
            <dl>
              <div>
                <dt>Median turns per session</dt>
                <dd>{row.medianTurns ?? "N/A"}</dd>
              </div>
              <div>
                <dt>Median context written</dt>
                <dd>{row.medianContextWritten === null ? "N/A" : tokens(row.medianContextWritten)}</dd>
              </div>
              <div>
                <dt>Largest context written</dt>
                <dd>{row.largestContextWritten === null ? "N/A" : tokens(row.largestContextWritten)}</dd>
              </div>
            </dl>
          ) : (
            <p className="cache-provider__gap">
              ccusage reports no cache-creation tokens for {providerLabel(row.provider)}, so cache
              writes, reads-per-write, turn counts, and context size are unavailable here — not zero.
              Its cache reads are still counted above.
            </p>
          )}
        </div>
      ))}
      <footer>
        Turns and context size are estimates, not observations: one cache write per turn and roughly
        linear context growth give turns ≈ 2 × cache read ÷ cache write and context ≈ cache write. A
        compaction or an expired cache re-writes the prefix and inflates both.
      </footer>
    </article>
  );
}
