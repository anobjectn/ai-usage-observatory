import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import {
  Check,
  ExternalLink,
  Copy,
  Gauge,
  LayoutGrid,
  PencilLine,
  RefreshCw,
  RotateCcw,
  Tag,
  Trash2,
  X,
} from "lucide-react";
import { HeadroomOrrery, type ProviderColors, type SceneEffects } from "../scene";
import { providerHeadroom } from "../quota-headroom";
import type { DashboardData, Session, AnthropicWebCredits } from "../types";
import {
  useModalFocusTrap,
  defaultFavoriteAccents,
  textScaleBounds,
  usePrefersReducedMotion,
  type QuickOverviewMode,
  useVisibleViewportHeight,
} from "../app/preferences";
import { formatCompact } from "../app/format";
import { resetCountdownParts, condensedResetCopy, quickOverviewCards } from "../app/analytics";
import { CLAUDE_USAGE_URL, QuotaNoticeCallout } from "./quota-cards";
import { type BenchmarkSiteId, BENCHMARK_SITES } from "./benchmark-launcher";

const sceneEffectOptions: {
  key: "starfield" | "parallax" | "twinkle" | "tesseract";
  label: string;
  detail: string;
}[] = [
  {
    key: "starfield",
    label: "Starfield",
    detail: "Generative star field behind the content on every view",
  },
  {
    key: "parallax",
    label: "Depth parallax",
    detail: "Stars at different distances drift at different rates",
  },
  {
    key: "twinkle",
    label: "Twinkle & tint",
    detail: "Star flicker with accent and aqua tinted highlights",
  },
  {
    key: "tesseract",
    label: "Tesseract core",
    detail:
      "Replace the telescope icon with a 4D hypercube that contorts as the scene rotates, and use it on the loading screen",
  },
];

const starDensityLabels = [
  "",
  "Minimal",
  "Sparse",
  "Balanced",
  "Dense",
  "Dark Sky",
  "Oh My!",
];

const unchangedDismissals = [
  "fine, leaving it as is then",
  "nothing then? cool",
  "maybe next time?",
  "later",
];

const changedDismissals = ["Gotcha!", "You Got It", "Done"];

const maxDismissals = ["Nice!!", "Oh, I see!", "Oh, its like that?"];

const minDismissals = ["Chillin", "ok then"];

function randomDismissal(options: string[]) {
  return options[Math.floor(Math.random() * options.length)];
}

function ColorControl({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {}
  };
  return (
    <label className="appearance-color-setting">
      <span>{label}</span>
      <div className="accent-control">
        <input
          aria-label={`${label} color`}
          type="color"
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
        <code>{value.toUpperCase()}</code>
        <button
          type="button"
          className="accent-copy-button"
          onClick={() => void copy()}
          aria-label={
            copied
              ? `${label} color copied`
              : `Copy ${label.toLowerCase()} color`
          }
          title={copied ? "Copied" : "Copy color"}
        >
          {copied ? <Check /> : <Copy />}
        </button>
      </div>
    </label>
  );
}

function TextScaleSetting({
  label,
  detail,
  value,
  bounds,
  onChange,
}: {
  label: string;
  detail: string;
  value: number;
  bounds: { min: number; max: number };
  onChange: (value: number) => void;
}) {
  return (
    <div className="data-text-setting">
      <div>
        <b>{label}</b>
        <small>{detail}</small>
      </div>
      <div className="data-text-control">
        <button
          type="button"
          onClick={() => onChange(Math.max(bounds.min, value - 10))}
          disabled={value <= bounds.min}
          aria-label={`Decrease ${label.toLowerCase()}`}
        >
          −
        </button>
        <output aria-live="polite">{value}%</output>
        <button
          type="button"
          onClick={() => onChange(Math.min(bounds.max, value + 10))}
          disabled={value >= bounds.max}
          aria-label={`Increase ${label.toLowerCase()}`}
        >
          +
        </button>
      </div>
    </div>
  );
}

export function AppearanceModal({
  accent,
  onChange,
  providerColors,
  onProviderColorsChange,
  favoriteAccents,
  onFavoriteAccentsChange,
  dataTextScale,
  onDataTextScaleChange,
  interfaceTextScale,
  onInterfaceTextScaleChange,
  sceneEffects,
  onSceneEffectsChange,
  reducedMotion,
  onReset,
  onClose,
}: {
  accent: string;
  onChange: (value: string) => void;
  providerColors: ProviderColors;
  onProviderColorsChange: (value: ProviderColors) => void;
  favoriteAccents: string[];
  onFavoriteAccentsChange: (value: string[]) => void;
  dataTextScale: number;
  onDataTextScaleChange: (value: number) => void;
  interfaceTextScale: number;
  onInterfaceTextScaleChange: (value: number) => void;
  sceneEffects: SceneEffects;
  onSceneEffectsChange: (value: SceneEffects) => void;
  reducedMotion: boolean;
  onReset: () => void;
  onClose: () => void;
}) {
  const [editingFavorites, setEditingFavorites] = useState(false);
  const [dismissal, setDismissal] = useState<string | null>(null);
  const closeTimer = useRef<number | null>(null);
  const initial = useRef({
    accent,
    providerColors: { ...providerColors },
    favoriteAccents: [...favoriteAccents],
    dataTextScale,
    interfaceTextScale,
    sceneEffects: { ...sceneEffects },
  });
  const starting = initial.current;
  const changeCount =
    Number(accent !== starting.accent) +
    Number(providerColors.anthropic !== starting.providerColors.anthropic) +
    Number(providerColors.openai !== starting.providerColors.openai) +
    Number(providerColors.warp !== starting.providerColors.warp) +
    Number(
      favoriteAccents.length !== starting.favoriteAccents.length ||
        favoriteAccents.some(
          (color, index) => color !== starting.favoriteAccents[index],
        ),
    ) +
    Number(dataTextScale !== starting.dataTextScale) +
    Number(interfaceTextScale !== starting.interfaceTextScale) +
    Object.keys(starting.sceneEffects).reduce(
      (count, key) =>
        count +
        Number(
          sceneEffects[key as keyof SceneEffects] !==
            starting.sceneEffects[key as keyof SceneEffects],
        ),
      0,
    );
  const revertChanges = () => {
    onChange(starting.accent);
    onProviderColorsChange({ ...starting.providerColors });
    onFavoriteAccentsChange([...starting.favoriteAccents]);
    onDataTextScaleChange(starting.dataTextScale);
    onInterfaceTextScaleChange(starting.interfaceTextScale);
    onSceneEffectsChange({ ...starting.sceneEffects });
    setEditingFavorites(false);
  };
  const replaceFavorite = (index: number) => {
    onFavoriteAccentsChange(
      favoriteAccents.map((color, colorIndex) =>
        colorIndex === index ? accent : color,
      ),
    );
    setEditingFavorites(false);
  };
  const dismiss = useCallback(() => {
    if (dismissal) return;
    const setToMax =
      (sceneEffects.speed !== starting.sceneEffects.speed &&
        sceneEffects.speed === 3) ||
      (sceneEffects.starDensity !== starting.sceneEffects.starDensity &&
        sceneEffects.starDensity === 6);
    const setToMin =
      (sceneEffects.speed !== starting.sceneEffects.speed &&
        sceneEffects.speed === 0.1) ||
      (sceneEffects.starDensity !== starting.sceneEffects.starDensity &&
        sceneEffects.starDensity === 1);
    const options = changeCount === 0
      ? unchangedDismissals
      : setToMax
        ? maxDismissals
        : setToMin
          ? minDismissals
          : changedDismissals;
    setDismissal(randomDismissal(options));
    closeTimer.current = window.setTimeout(onClose, 2050);
  }, [
    accent,
    changeCount,
    dataTextScale,
    interfaceTextScale,
    dismissal,
    favoriteAccents,
    onClose,
    providerColors,
    sceneEffects,
  ]);
  useEffect(
    () => () => {
      if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    },
    [],
  );
  const dialogRef = useModalFocusTrap(dismiss);

  return (
    <div
      className={`modal-backdrop appearance-backdrop${dismissal ? " modal-backdrop--dismissing" : ""}`}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) dismiss();
      }}
    >
      <div
        ref={dialogRef}
        className={`modal appearance-modal${dismissal ? " appearance-modal--dismissing" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="appearance-modal-title"
        tabIndex={-1}
      >
        <div className="appearance-content">
          <button
            className="modal-close"
            onClick={dismiss}
            aria-label="Close appearance settings"
          >
            <X />
          </button>
          <span className="overline">LOCAL APPEARANCE</span>
          <h2 id="appearance-modal-title">Appearance</h2>
          <p>
            Adjust visual signals and data readability. These preferences stay
            on this device.
          </p>
          <span className="appearance-label">Signal colors</span>
          <div className="appearance-color-grid">
            <ColorControl label="Accent" value={accent} onChange={onChange} />
            <ColorControl
              label="Anthropic"
              value={providerColors.anthropic}
              onChange={(value) =>
                onProviderColorsChange({ ...providerColors, anthropic: value })
              }
            />
            <ColorControl
              label="OpenAI"
              value={providerColors.openai}
              onChange={(value) =>
                onProviderColorsChange({ ...providerColors, openai: value })
              }
            />
            <ColorControl
              label="Warp"
              value={providerColors.warp}
              onChange={(value) =>
                onProviderColorsChange({ ...providerColors, warp: value })
              }
            />
          </div>
          <p className="signal-color-note">
            Provider colors identify quota headroom across satellites, charts,
            and limit cards.
          </p>
          <div
            className={`accent-favorites${editingFavorites ? " editing" : ""}`}
            aria-label="Favorite accent colors"
          >
            {favoriteAccents.map((color, index) => (
              <button
                type="button"
                key={`${color}-${index}`}
                className={
                  accent.toLowerCase() === color.toLowerCase() ? "selected" : ""
                }
                style={{ backgroundColor: color }}
                aria-label={
                  editingFavorites
                    ? `Replace ${color} with ${accent}`
                    : `Use ${color} accent`
                }
                aria-pressed={
                  !editingFavorites &&
                  accent.toLowerCase() === color.toLowerCase()
                }
                onClick={() =>
                  editingFavorites ? replaceFavorite(index) : onChange(color)
                }
              >
                {editingFavorites ? <PencilLine /> : <Check />}
              </button>
            ))}
            <button
              type="button"
              className="accent-favorite-edit"
              onClick={() => setEditingFavorites((editing) => !editing)}
              aria-label={
                editingFavorites
                  ? "Finish editing favorite colors"
                  : "Edit favorite colors"
              }
              aria-pressed={editingFavorites}
              title={editingFavorites ? "Done editing" : "Edit favorites"}
            >
              <PencilLine />
            </button>
          </div>
          {editingFavorites && (
            <div className="accent-favorite-editor">
              <p>
                Pick a new color above, then choose the favorite chip to
                replace.
              </p>
              <button
                type="button"
                onClick={() => {
                  onFavoriteAccentsChange(defaultFavoriteAccents);
                  setEditingFavorites(false);
                }}
              >
                <RotateCcw /> Reset favorites
              </button>
            </div>
          )}
          <TextScaleSetting
            label="Data text size"
            detail="Tables and dense data rows across every view"
            value={dataTextScale}
            bounds={textScaleBounds.data}
            onChange={onDataTextScaleChange}
          />
          <TextScaleSetting
            label="Interface text size"
            detail="Labels, captions, headings, and controls; data text keeps its own size"
            value={interfaceTextScale}
            bounds={textScaleBounds.interface}
            onChange={onInterfaceTextScaleChange}
          />
          <div className="scene-effects">
            <span className="appearance-label">Observatory scene effects</span>
            {sceneEffectOptions.map((option) => {
              const systemSuppressed =
                option.key === "starfield" &&
                reducedMotion &&
                sceneEffects.starfield;
              return (
                <div className="effect-row" key={option.key}>
                  <div>
                    <b>{option.label}</b>
                    <small>{option.detail}</small>
                    {systemSuppressed && (
                      <small className="system-motion-note">
                        Off because Reduce Motion is enabled in system settings.
                      </small>
                    )}
                  </div>
                  <button
                    type="button"
                    role="switch"
                    className="effect-switch"
                    aria-checked={
                      systemSuppressed ? false : sceneEffects[option.key]
                    }
                    aria-label={option.label}
                    onClick={() =>
                      onSceneEffectsChange({
                        ...sceneEffects,
                        [option.key]: !sceneEffects[option.key],
                      })
                    }
                  />
                </div>
              );
            })}
            <div className="effect-row">
              <div>
                <b>Star density</b>
                <small>
                  Six fixed levels, from a visible floor to extreme depth
                </small>
              </div>
              <div className="speed-control density-control">
                <input
                  type="range"
                  min={1}
                  max={6}
                  step={1}
                  value={sceneEffects.starDensity}
                  disabled={!sceneEffects.starfield || reducedMotion}
                  aria-label="Star density"
                  aria-valuetext={starDensityLabels[sceneEffects.starDensity]}
                  onChange={(event) =>
                    onSceneEffectsChange({
                      ...sceneEffects,
                      starDensity: Number(event.target.value),
                    })
                  }
                />
                <output aria-live="polite">
                  {starDensityLabels[sceneEffects.starDensity]}
                </output>
              </div>
            </div>
            <div className="effect-row">
              <div>
                <b>Animation speed</b>
                <small>Rate of auto-rotation, orbits, and twinkle — 0 pauses</small>
              </div>
              <div className="speed-control">
                <input
                  type="range"
                  min={0}
                  max={3}
                  step={0.05}
                  value={sceneEffects.speed}
                  aria-label="Animation speed"
                  onChange={(event) =>
                    onSceneEffectsChange({
                      ...sceneEffects,
                      speed: Number(event.target.value),
                    })
                  }
                />
                <output aria-live="polite">
                  {sceneEffects.speed === 0
                    ? "Paused"
                    : `${sceneEffects.speed.toFixed(2)}x`}
                </output>
              </div>
            </div>
            <small>
              Motion effects pause automatically when your system prefers
              reduced motion.
            </small>
          </div>
          <div className="appearance-change-trail" aria-live="polite">
            <span>
              {changeCount === 0
                ? "No changes yet"
                : changeCount === 1
                  ? "1 change will apply when you close this"
                  : `${changeCount} changes will apply when you close this`}
            </span>
            {changeCount > 0 && (
              <button type="button" onClick={revertChanges}>
                Revert changes
              </button>
            )}
          </div>
          <button
            type="button"
            className="reset-appearance"
            onClick={() => {
              onReset();
              setEditingFavorites(false);
            }}
          >
            <RotateCcw /> Reset all appearance settings
          </button>
        </div>
      </div>
      {dismissal && (
        <div
          className={`appearance-dismissal${maxDismissals.includes(dismissal) ? " appearance-dismissal--max" : ""}`}
          role="status"
        >
          <h2>{dismissal}</h2>
        </div>
      )}
    </div>
  );
}

export function AnnotationModal({
  session,
  onClose,
  onSaved,
}: {
  session: Session;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [note, setNote] = useState(session.annotation.note);
  const [tags, setTags] = useState(session.annotation.tags.join(", "));
  const [saving, setSaving] = useState(false);
  const dirty =
    note !== session.annotation.note ||
    tags !== session.annotation.tags.join(", ");
  const requestClose = useCallback(() => {
    if (
      !dirty ||
      window.confirm("Discard your unsaved annotation changes?")
    ) {
      onClose();
    }
  }, [dirty, onClose]);
  const dialogRef = useModalFocusTrap(requestClose);
  const [error, setError] = useState<string | null>(null);
  // A failed save keeps the editor open with the draft intact, so the user can retry.
  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/sessions/${encodeURIComponent(session.sessionId)}/annotations`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            note,
            tags: tags
              .split(",")
              .map((t) => t.trim())
              .filter(Boolean),
          }),
        },
      );
      if (!response.ok) throw new Error(`Server returned ${response.status}`);
    } catch (reason) {
      const detail = reason instanceof Error ? reason.message : String(reason);
      setError(`The annotation was not saved (${detail}). Your draft is kept; try again.`);
      setSaving(false);
      return;
    }
    setSaving(false);
    onSaved();
    onClose();
  };
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) requestClose();
      }}
    >
      <div
        ref={dialogRef}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="annotation-modal-title"
        tabIndex={-1}
      >
        <button
          type="button"
          className="modal-close"
          onClick={requestClose}
          aria-label="Close annotation editor"
        >
          <X />
        </button>
        <span className="overline">LOCAL ANNOTATION</span>
        <h2 id="annotation-modal-title">Mark this session</h2>
        <p>
          {session.modelsUsed.join(", ")} · {formatCompact(session.totalTokens)}{" "}
          tokens
        </p>
        <label>
          Tags
          <input
            autoFocus
            data-autofocus
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            placeholder="feature, research, client-work"
          />
          <small>
            Comma separated. Manual tags remain distinct from derived path tags.
          </small>
        </label>
        <label>
          Notes
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="What was this session about?"
            rows={5}
          />
        </label>
        {error && <p className="web-import-error" role="alert">{error}</p>}
        <button className="primary-button" onClick={save} disabled={saving}>
          {saving ? <RefreshCw className="spin" /> : <Check />}{" "}
          {error ? "Retry save" : "Save annotation"}
        </button>
      </div>
    </div>
  );
}

function numField(value: number | null | undefined): string {
  return value === null || value === undefined ? "" : String(value);
}

function dateField(ms: number | null | undefined): string {
  return ms === null || ms === undefined ? "" : new Date(ms).toISOString().slice(0, 10);
}


/** Compact form for the user-imported Claude Web credit snapshot. Prefills from
 * the current observation, submits to AIUO's localhost proxy (never to Claude
 * directly, never with cookies), and refreshes on success. A failed submit
 * keeps the entered values and shows an inline error. */
export function AnthropicWebImportModal({
  credits,
  onClose,
  onSaved,
}: {
  credits: AnthropicWebCredits | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const tranche = credits?.promotionalTranches?.[0] ?? null;
  const [currentBalance, setCurrentBalance] = useState(numField(credits?.currentBalance));
  const [promoRemaining, setPromoRemaining] = useState(numField(tranche?.remainingAmount));
  const [promoGranted, setPromoGranted] = useState(
    numField(tranche?.grantedAmount ?? credits?.campaign?.amount),
  );
  const [promoExpiresAt, setPromoExpiresAt] = useState(
    tranche?.expiresOn ?? credits?.campaign?.expiresOn ?? credits?.nextExpiresOn ?? "",
  );
  const [capturedAt, setCapturedAt] = useState(
    dateField(credits?.capturedAt) || new Date().toISOString().slice(0, 10),
  );
  const [campaignId, setCampaignId] = useState(credits?.campaign?.id ?? "fable_transition");
  const [campaignGranted, setCampaignGranted] = useState(credits?.campaign?.granted ?? false);
  const [autoReloadEnabled, setAutoReloadEnabled] = useState(credits?.autoReloadEnabled ?? false);
  const [purchasedThisMonth, setPurchasedThisMonth] = useState(
    numField(credits?.purchases?.purchasedThisMonthAmount),
  );
  const [monthlyCap, setMonthlyCap] = useState(numField(credits?.purchases?.monthlyCapAmount));
  const [purchasesResetAt, setPurchasesResetAt] = useState(dateField(credits?.purchases?.resetsAt));
  const [maxDiscount, setMaxDiscount] = useState(numField(credits?.purchases?.maxDiscountPercent));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useModalFocusTrap(onClose);

  const submit = async () => {
    setSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/quotas/anthropic-web-import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          capturedAt: capturedAt || undefined,
          currency: "USD",
          currentBalance: currentBalance,
          promoRemaining,
          promoGranted,
          promoExpiresAt,
          campaignId: campaignId.trim() || null,
          campaignGranted,
          autoReloadEnabled,
          purchasedThisMonthAmount: purchasedThisMonth,
          monthlyCapAmount: monthlyCap,
          purchasesResetAt,
          maxDiscountPercent: maxDiscount,
        }),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error ?? `Import failed (${response.status})`);
      }
      onSaved();
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="modal web-import-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="web-import-title"
        tabIndex={-1}
      >
        <button type="button" className="modal-close" onClick={onClose} aria-label="Close credit import">
          <X />
        </button>
        <span className="overline">CLAUDE WEB IMPORT</span>
        <h2 id="web-import-title">Update Claude Web snapshot</h2>
        <p>
          Claude Code&apos;s login can&apos;t read prepaid balances. Copy the values from
          Claude Settings → Usage. Nothing here touches your browser session.
        </p>
        <a
          className="secondary-button web-import-open"
          href={CLAUDE_USAGE_URL}
          target="_blank"
          rel="noreferrer"
        >
          <ExternalLink /> Open Claude Usage
        </a>
        <div className="web-import-grid">
          <label>
            Current balance
            <input
              autoFocus
              data-autofocus
              type="number"
              step="0.01"
              min="0"
              value={currentBalance}
              onChange={(e) => setCurrentBalance(e.target.value)}
              placeholder="84.97"
            />
          </label>
          <label>
            Fable remaining
            <input
              type="number"
              step="0.01"
              min="0"
              value={promoRemaining}
              onChange={(e) => setPromoRemaining(e.target.value)}
              placeholder="84.96"
            />
          </label>
          <label>
            Original Fable grant
            <input
              type="number"
              step="0.01"
              min="0"
              value={promoGranted}
              onChange={(e) => setPromoGranted(e.target.value)}
              placeholder="100.00"
            />
          </label>
          <label>
            Fable expiry
            <input
              type="date"
              value={promoExpiresAt}
              onChange={(e) => setPromoExpiresAt(e.target.value)}
            />
          </label>
        </div>
        <details className="web-import-more">
          <summary>More details</summary>
          <div className="web-import-grid">
            <label>
              Observed on
              <input type="date" value={capturedAt} onChange={(e) => setCapturedAt(e.target.value)} />
            </label>
            <label>
              Campaign
              <input value={campaignId} onChange={(e) => setCampaignId(e.target.value)} />
            </label>
            <label>
              Purchased this month
              <input
                type="number"
                step="0.01"
                min="0"
                value={purchasedThisMonth}
                onChange={(e) => setPurchasedThisMonth(e.target.value)}
              />
            </label>
            <label>
              Monthly purchase cap
              <input
                type="number"
                step="0.01"
                min="0"
                value={monthlyCap}
                onChange={(e) => setMonthlyCap(e.target.value)}
              />
            </label>
            <label>
              Purchase cap resets
              <input
                type="date"
                value={purchasesResetAt}
                onChange={(e) => setPurchasesResetAt(e.target.value)}
              />
            </label>
            <label>
              Max bundle discount %
              <input
                type="number"
                step="1"
                min="0"
                value={maxDiscount}
                onChange={(e) => setMaxDiscount(e.target.value)}
              />
            </label>
          </div>
          <div className="web-import-toggles">
            <label className="web-import-check">
              <input
                type="checkbox"
                checked={campaignGranted}
                onChange={(e) => setCampaignGranted(e.target.checked)}
              />
              Campaign granted
            </label>
            <label className="web-import-check">
              <input
                type="checkbox"
                checked={autoReloadEnabled}
                onChange={(e) => setAutoReloadEnabled(e.target.checked)}
              />
              Auto-reload on
            </label>
          </div>
        </details>
        {error && <p className="web-import-error" role="alert">{error}</p>}
        <button className="primary-button" onClick={submit} disabled={saving}>
          {saving ? <RefreshCw className="spin" /> : <Check />} Save snapshot
        </button>
      </div>
    </div>
  );
}

export function benchmarkLoadedAtLabel(loadedAt: number | null, siteLabel: string) {
  if (loadedAt === null) return `Loading ${siteLabel}...`;
  return `Loaded ${new Date(loadedAt).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })}`;
}

export function BenchmarkModal({
  onClose,
  initialSiteId,
  open = true,
}: {
  onClose: () => void;
  initialSiteId?: BenchmarkSiteId;
  open?: boolean;
}) {
  const dialogRef = useModalFocusTrap(onClose, open);
  const [siteId, setSiteId] = useState<BenchmarkSiteId>(initialSiteId ?? "deepswe");
  const [visitedSites, setVisitedSites] = useState<Set<BenchmarkSiteId>>(
    () => new Set([initialSiteId ?? "deepswe"]),
  );
  const [loadedAt, setLoadedAt] = useState<Partial<Record<BenchmarkSiteId, number>>>({});
  const [refreshVersions, setRefreshVersions] = useState<Record<BenchmarkSiteId, number>>({
    deepswe: 0,
    artificialanalysis: 0,
  });
  useEffect(() => {
    if (!initialSiteId) return;
    setSiteId(initialSiteId);
    setVisitedSites((current) => {
      if (current.has(initialSiteId)) return current;
      const next = new Set(current);
      next.add(initialSiteId);
      return next;
    });
  }, [initialSiteId]);
  const site = BENCHMARK_SITES.find((entry) => entry.id === siteId) ?? BENCHMARK_SITES[0];
  const activeLoadedAt = loadedAt[site.id] ?? null;
  const chooseSite = (nextSiteId: BenchmarkSiteId) => {
    setSiteId(nextSiteId);
    setVisitedSites((current) => {
      if (current.has(nextSiteId)) return current;
      const next = new Set(current);
      next.add(nextSiteId);
      return next;
    });
  };
  const hardRefresh = () => {
    setLoadedAt((current) => ({ ...current, [site.id]: undefined }));
    setRefreshVersions((current) => ({
      ...current,
      [site.id]: current[site.id] + 1,
    }));
  };
  return createPortal(
    <div
      className={`modal-backdrop benchmark-backdrop${open ? "" : " benchmark-backdrop--closed"}`}
      aria-hidden={!open || undefined}
      onMouseDown={(e) => {
        if (open && e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="modal benchmark-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="benchmark-title"
        tabIndex={-1}
      >
        <button type="button" className="modal-close" onClick={onClose} aria-label="Close benchmark comparison">
          <X />
        </button>
        <span className="overline">EXTERNAL BENCHMARKS</span>
        <h2 id="benchmark-title">Compare cost and efficiency</h2>
        <div className="benchmark-tabs" role="tablist">
          {BENCHMARK_SITES.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="tab"
              aria-selected={entry.id === siteId}
              className={entry.id === siteId ? "active" : ""}
              onClick={() => chooseSite(entry.id)}
            >
              <img className={`benchmark-favicon benchmark-favicon--${entry.id}`} src={entry.favicon} alt="" loading="lazy" />
              {entry.label}
            </button>
          ))}
        </div>
        <div className="benchmark-toolbar">
          <p>{site.description}</p>
          <div className="benchmark-toolbar__actions">
            <time
              className="benchmark-loaded-at"
              dateTime={activeLoadedAt === null ? undefined : new Date(activeLoadedAt).toISOString()}
              aria-live="polite"
            >
              {benchmarkLoadedAtLabel(activeLoadedAt, site.label)}
            </time>
            <button
              type="button"
              className="secondary-button benchmark-hard-refresh"
              onClick={hardRefresh}
              aria-label={`Hard refresh ${site.label}`}
              title={`Reload ${site.label} and reset its current selections`}
            >
              <RefreshCw /> Hard refresh
            </button>
            <a className="secondary-button" href={site.url} target="_blank" rel="noreferrer">
              <ExternalLink /> Open in new tab
            </a>
          </div>
        </div>
        <div className="benchmark-frame">
          {BENCHMARK_SITES.map((entry) =>
            visitedSites.has(entry.id) ? (
              <iframe
                key={`${entry.id}-${refreshVersions[entry.id]}`}
                className={entry.id === site.id ? "is-active" : ""}
                src={entry.url}
                title={entry.label}
                loading="lazy"
                onLoad={() => setLoadedAt((current) => ({ ...current, [entry.id]: Date.now() }))}
              />
            ) : null,
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function ResetCountdown({
  resetAt,
  verb,
  suspended,
  layout = "inline",
}: {
  resetAt: number | null;
  verb: "resets" | "renews";
  suspended: boolean;
  layout?: "inline" | "stacked";
}) {
  // Reduced motion drops the ticking seconds; the minute countdown still updates.
  const reducedMotion = usePrefersReducedMotion();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, []);
  if (suspended)
    return <small className="quick-overview__reset">suspended</small>;
  if (resetAt === null) return null;
  if (layout === "stacked") {
    const parts = resetCountdownParts(resetAt, now, !reducedMotion);
    return (
      <small className="quick-overview__reset quick-overview__reset--stacked">
        {parts === null ? (
          `${verb} now`
        ) : (
          <>
            <span>{verb === "renews" ? "renew in" : "reset in"}</span>
            <b>{parts.countdown}</b>
            <span>{parts.stamp}</span>
          </>
        )}
      </small>
    );
  }
  return (
    <small className="quick-overview__reset">
      {condensedResetCopy(resetAt, verb, now, !reducedMotion)}
    </small>
  );
}

function quickHeadroomState(left: number | null) {
  if (left === null) return null;
  if (left > 50) return { tone: "go", label: "Plenty remaining" } as const;
  if (left > 20) return { tone: "coast", label: "Use with care" } as const;
  return { tone: "low", label: "Very low remaining" } as const;
}

export function QuickOverviewModal({
  quotas,
  mode,
  onModeChange,
  accent,
  providerColors,
  sceneEffects,
  onClose,
}: {
  quotas: DashboardData["quotas"];
  mode: QuickOverviewMode;
  onModeChange: (mode: QuickOverviewMode) => void;
  accent: string;
  providerColors: ProviderColors;
  sceneEffects: SceneEffects;
  onClose: () => void;
}) {
  const dialogRef = useModalFocusTrap(onClose);
  const visibleViewportHeight = useVisibleViewportHeight();
  const cards = quickOverviewCards(quotas);
  return (
    <div
      className="modal-backdrop quick-overview-backdrop"
      style={visibleViewportHeight === null ? undefined : {
        "--quick-overview-visible-height": `${visibleViewportHeight}px`,
      } as CSSProperties}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className={`modal quick-overview-modal quick-overview-modal--${mode}`}
        role="dialog"
        aria-modal="true"
        aria-label="Quick quota overview"
        tabIndex={-1}
      >
        <button
          type="button"
          className="modal-close"
          onClick={onClose}
          aria-label="Close quick overview"
        >
          <X />
        </button>
        {/* The tesseract preference only swaps the orrery's core (hypercube vs
            telescope), matching the hero orrery; the orrery itself always shows. */}
        <div className="quick-overview__orrery">
          <HeadroomOrrery
            accent={accent}
            effects={sceneEffects}
            providerColors={providerColors}
            headroom={providerHeadroom(quotas)}
            interactive={false}
          />
        </div>
        {cards.length === 0 ? (
          <p className="quick-overview__empty">
            No provider quota windows are currently reported.
          </p>
        ) : mode === "gauges" ? (
          <div className="quick-overview__providers">
            {cards.map((card) => (
              <section
                className={`quick-overview__provider ${card.provider} ${card.state}`}
                key={card.provider}
              >
                <header>
                  <span>{card.providerLabel}</span>
                  <i>{card.stateLabel}</i>
                </header>
                {card.notice && <QuotaNoticeCallout notice={card.notice} compact />}
                <div className="quick-overview__dials">
                  {card.buckets.map((bucket) => {
                    const left =
                      bucket.usedPercent === null
                        ? null
                        : Math.max(0, Math.min(100, 100 - bucket.usedPercent));
                    return (
                      <div
                        className={`quick-overview__dial ${bucket.state}`}
                        key={bucket.id}
                        aria-label={`${card.providerLabel} ${bucket.windowLabel}: ${left === null ? bucket.state : `${left.toFixed(0)}% left`}`}
                      >
                        <div
                          className="quota-dial"
                          style={
                            {
                              "--fill": `${left ?? 0}%`,
                            } as React.CSSProperties
                          }
                        >
                          <div>
                            <strong>
                              {left === null ? "—" : `${left.toFixed(0)}%`}
                            </strong>
                            <span>
                              {left === null ? bucket.state : "left"}
                            </span>
                          </div>
                        </div>
                        <small>{bucket.windowLabel}</small>
                        <ResetCountdown
                          resetAt={bucket.resetAt}
                          verb={bucket.resetVerb}
                          suspended={bucket.state === "suspended"}
                          layout="stacked"
                        />
                      </div>
                    );
                  })}
                </div>
              </section>
            ))}
          </div>
        ) : (
          <div className="quick-overview__groups">
            {cards.map((card) => (
              <section
                className={`quick-overview__group ${card.provider} ${card.state}`}
                key={card.provider}
              >
                <header>
                  <span>{card.providerLabel}</span>
                  <i>{card.stateLabel}</i>
                </header>
                {card.notice && <QuotaNoticeCallout notice={card.notice} compact />}
                {card.buckets.map((bucket) => {
                  const left =
                    bucket.usedPercent === null
                      ? null
                      : Math.max(0, Math.min(100, 100 - bucket.usedPercent));
                  const headroom = quickHeadroomState(left);
                  return (
                    <div
                      className={`quick-overview__row ${bucket.state}`}
                      key={bucket.id}
                    >
                      <b>
                        {headroom && (
                          <i
                            className={`quick-overview__headroom-dot ${headroom.tone}`}
                            role="img"
                            aria-label={headroom.label}
                            title={headroom.label}
                          />
                        )}
                        {bucket.windowLabel}
                      </b>
                      <strong>
                        {left === null ? "—" : `${left.toFixed(0)}% left`}
                      </strong>
                      <ResetCountdown
                        resetAt={bucket.resetAt}
                        verb={bucket.resetVerb}
                        suspended={bucket.state === "suspended"}
                      />
                    </div>
                  );
                })}
              </section>
            ))}
          </div>
        )}
        <div
          className="quick-overview__mode"
          role="group"
          aria-label="Overview layout"
        >
          <button
            type="button"
            className="accent-icon-button"
            aria-pressed={mode === "gauges"}
            onClick={() => onModeChange("gauges")}
          >
            <Gauge /> Gauges
          </button>
          <button
            type="button"
            className="accent-icon-button"
            aria-pressed={mode === "grid"}
            onClick={() => onModeChange("grid")}
          >
            <LayoutGrid /> Grid
          </button>
        </div>
      </div>
    </div>
  );
}

export function RulesModal({
  data,
  onClose,
  onSaved,
}: {
  data: DashboardData;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [tag, setTag] = useState("");
  const [pattern, setPattern] = useState("");
  const [kind, setKind] = useState<"glob" | "regex">("glob");
  const add = async () => {
    if (!tag || !pattern) return;
    await fetch("/api/rules", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tag, pattern, kind }),
    });
    setTag("");
    setPattern("");
    onSaved();
  };
  const remove = async (id: number) => {
    await fetch(`/api/rules/${id}`, { method: "DELETE" });
    onSaved();
  };
  const dialogRef = useModalFocusTrap(onClose);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="modal rules-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="rules-modal-title"
        tabIndex={-1}
      >
        <button
          type="button"
          className="modal-close"
          onClick={onClose}
          aria-label="Close path rules"
        >
          <X />
        </button>
        <span className="overline">DERIVED METADATA</span>
        <h2 id="rules-modal-title">Working-directory rules</h2>
        <p>
          Rules are re-evaluated over indexed paths. Only path strings are
          stored; transcript content is never copied.
        </p>
        <div className="rules-list">
          {data.rules.map((rule) => (
            <div key={rule.id}>
              <Tag />
              <span>
                <b>{rule.tag}</b>
                <small>
                  {rule.kind} · {rule.pattern}
                </small>
              </span>
              <button
                onClick={() => remove(rule.id)}
                aria-label={`Delete ${rule.tag}`}
              >
                <Trash2 />
              </button>
            </div>
          ))}
        </div>
        <div className="rule-form">
          <input
            value={tag}
            onChange={(e) => setTag(e.target.value)}
            placeholder="Tag name"
          />
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as "glob" | "regex")}
          >
            <option value="glob">Glob</option>
            <option value="regex">Regex</option>
          </select>
          <input
            value={pattern}
            onChange={(e) => setPattern(e.target.value)}
            placeholder="**/project-worktree*"
          />
          <button className="primary-button" onClick={add}>
            <Tag /> Add rule
          </button>
        </div>
      </div>
    </div>
  );
}
