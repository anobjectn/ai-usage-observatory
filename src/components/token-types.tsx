import type { ReactNode } from "react";
import {
  footnotesFor,
  summarizeTokenTypes,
  type FootnoteContext,
  type ModelRowInput,
  type TokenType,
  type TokenTypeSummary,
} from "../token-types";
import type { RateCardSummary } from "../types";

/** Same hues the Explorer composition bar assigns to these four types, so a reader can carry
 * the colour from one view to the other. */
const tokenTypeColors: Record<TokenType, string> = {
  cacheRead: "#b7f25c",
  cacheWrite: "#ff9e64",
  output: "#d7b3ff",
  input: "#58d9cf",
};

export function formatShare(share: number | null) {
  if (share === null) return "—";
  if (share > 0 && share < 0.0005) return "<0.1%";
  return `${(share * 100).toFixed(1)}%`;
}

/** Whole cents when the amount is worth cents; otherwise enough decimals to be non-zero, so a
 * fraction-of-a-cent row does not read as free. */
export function formatCostCell(cost: number | null) {
  if (cost === null) return "—";
  if (cost === 0) return "$0.00";
  if (cost >= 0.01) return `$${cost.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const precise = cost.toFixed(6).replace(/0+$/, "");
  return precise.endsWith(".") ? "$0.00" : `$${precise}`;
}

const withheldLabel = "Cost withheld; see the note below the table.";

export function TokenTypeTable({
  summary,
  context,
  title = "Cost by token type",
  eyebrow = "TOKEN TYPES",
  children,
}: {
  summary: TokenTypeSummary;
  context?: FootnoteContext;
  title?: string;
  eyebrow?: string;
  /** Optional content between the table and the footnotes, such as a per-model disclosure. */
  children?: ReactNode;
}) {
  const footnotes = footnotesFor(summary, context);
  return (
    <section className="token-types" aria-label={title}>
      <header className="token-types__head">
        <div>
          <span className="overline">{eyebrow}</span>
          <h4>{title}</h4>
        </div>
        <span className="token-types__totals">
          <b>{summary.totalTokens.toLocaleString()}</b> tokens
          {summary.costAvailable && summary.totalCost !== null ? (
            <>
              {" · "}
              <b>{formatCostCell(summary.totalCost)}</b> API-equivalent
            </>
          ) : null}
        </span>
      </header>
      <div className="measure-scroll">
        <table className="measure-table token-types__table">
          <thead>
            <tr>
              <th scope="col">Token type</th>
              <th scope="col">Exact tokens</th>
              <th scope="col">Token share</th>
              <th scope="col">Cost</th>
              <th scope="col">Cost share</th>
            </tr>
          </thead>
          <tbody>
            {summary.rows.map((row) => (
              <tr key={row.type}>
                <th scope="row">
                  <i style={{ background: tokenTypeColors[row.type] }} aria-hidden="true" />
                  {row.label}
                </th>
                <td>{row.tokens.toLocaleString()}</td>
                <td>{formatShare(row.tokenShare)}</td>
                <td aria-label={row.cost === null ? withheldLabel : undefined}>{formatCostCell(row.cost)}</td>
                <td aria-label={row.costShare === null ? withheldLabel : undefined}>{formatShare(row.costShare)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {children}
      {footnotes.length > 0 && (
        <footer className="token-types__notes">
          {footnotes.map((line) => (
            <p key={line}>{line}</p>
          ))}
        </footer>
      )}
    </section>
  );
}

/** The one-line stand-ins for a table that must not be drawn: cache tokens hidden, or a scope
 * with only Warp's generic tokens. */
export function TokenTypesNotice({ eyebrow = "TOKEN TYPES", children }: { eyebrow?: string; children: ReactNode }) {
  return (
    <section className="token-types token-types--notice" aria-label="Token types">
      <span className="overline">{eyebrow}</span>
      <p>{children}</p>
    </section>
  );
}

/** Collapsed per-model view for a mixed scope: each model's own four rows with its own
 * reconciled cost, so the reader can see which model drives the cache reads. Warp rows never
 * reach here; the parent summary already excluded them. */
export function TokenTypesByModel({
  inputs,
  rateCard,
  unpricedModels,
}: {
  inputs: ModelRowInput[];
  rateCard: Pick<RateCardSummary, "models"> | null;
  unpricedModels: string[];
}) {
  const byModel = new Map<string, ModelRowInput[]>();
  for (const input of inputs) byModel.set(input.breakdown.modelName, [...(byModel.get(input.breakdown.modelName) ?? []), input]);
  const models = [...byModel.entries()]
    .map(([model, rows]) => ({ model, summary: summarizeTokenTypes(rows, rateCard, unpricedModels) }))
    .filter(({ summary }) => summary.totalTokens > 0)
    .sort((left, right) => right.summary.totalTokens - left.summary.totalTokens);
  if (models.length < 2) return null;
  return (
    <details className="token-types__models">
      <summary>By model · {models.length}</summary>
      <ul>
        {models.map(({ model, summary }) => (
          <li key={model}>
            <b>
              {model}
              <small>
                {summary.totalTokens.toLocaleString()} tokens
                {summary.costAvailable && summary.totalCost !== null ? ` · ${formatCostCell(summary.totalCost)}` : " · cost withheld"}
              </small>
            </b>
            <div className="measure-scroll">
              <table className="measure-table">
                <tbody>
                  {summary.rows.map((row) => (
                    <tr key={row.type}>
                      <th scope="row">
                        <i style={{ background: tokenTypeColors[row.type] }} aria-hidden="true" />
                        {row.label}
                      </th>
                      <td>{row.tokens.toLocaleString()}</td>
                      <td>{formatShare(row.tokenShare)}</td>
                      <td>{formatCostCell(row.cost)}</td>
                      <td>{formatShare(row.costShare)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </li>
        ))}
      </ul>
    </details>
  );
}

export const cacheHiddenNotice = "Token types are hidden while cache tokens are excluded.";
export const warpOnlyNotice = "Token-type accounting is unavailable for Warp's generic recorded tokens.";
