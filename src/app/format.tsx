import { formatReadingAge } from "../quota-notice";

export const formatCompact = (value: number) =>
  Intl.NumberFormat("en", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);

export const formatMoney = (value: number) =>
  `$${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export const formatWarpCredits = (value: number) =>
  value.toLocaleString(undefined, { maximumFractionDigits: 2 });

export const formatDate = (value: string, timeZone?: string) =>
  new Date(value).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    ...(timeZone ? { timeZone, timeZoneName: "short" as const } : {}),
  });

/** `formatDate`'s locale text wrapped in a `<time dateTime>` so the instant survives even when
 * the display is rendered in a non-local `timeZone`. */
export function DateStamp({ value, timeZone }: { value: string; timeZone?: string }) {
  return <time dateTime={value}>{formatDate(value, timeZone)}</time>;
}

/** Compact `Aug 31 10:35a` stamp; `separator` sits between the day and the time. */
export const formatCompactDate = (
  value: string,
  { timeZone, separator = " " }: { timeZone?: string; separator?: string } = {},
) => {
  const parts = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone,
  }).formatToParts(new Date(value));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((valuePart) => valuePart.type === type)?.value ?? "";
  return `${part("month")} ${part("day")}${separator}${part("hour")}:${part("minute")}${part("dayPeriod").slice(0, 1).toLowerCase()}`;
};

export const formatSessionDate = (value: string) => formatCompactDate(value);

export function SessionDateStamp({ value }: { value: string }) {
  return <time dateTime={value}>{formatSessionDate(value)}</time>;
}

export const formatPromptTimestamp = (value: string | null) =>
  value
    ? new Date(value).toLocaleString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        second: "2-digit",
      })
    : "Time unavailable";

export const friendlyProject = (value: string) =>
  value.startsWith("/")
    ? (value.split("/").filter(Boolean).at(-1) ?? value)
    : value.replace(/^-Users-[^-]+-/, "").replaceAll("-", " / ");

export const providerSeries = [
  { key: "anthropic", label: "Claude", color: "var(--anthropic-color)" },
  { key: "codex", label: "Codex", color: "var(--openai-color)" },
  { key: "warp", label: "Warp", color: "var(--warp-color)" },
] as const;

const stackedProviderSeries = [...providerSeries].reverse();

type ActivityAxisTickProps = {
  x?: number | string;
  y?: number | string;
  payload?: { value?: string };
  tokens: Array<{ color: string; value: number }>;
};

export function ActivityAxisTick({ x = 0, y = 0, payload, tokens }: ActivityAxisTickProps) {
  const visibleTokens = tokens.filter((item) => item.value > 0);
  const labels = visibleTokens.length
    ? visibleTokens
    : [{ color: "var(--dim)", value: 0 }];
  return (
    <g transform={`translate(${Number(x)} ${Number(y)})`}>
      <text
        x={0}
        y={4}
        fill="#71807b"
        fontSize={11}
        fontFamily="var(--font-label)"
        textAnchor="middle"
        dominantBaseline="hanging"
      >
        {periodTickLabel(String(payload?.value ?? ""))}
      </text>
      {labels.map((item, index) => (
        <text
          key={`${item.color}-${index}`}
          x={0}
          y={19 + index * 12}
          fill={item.color}
          fontSize={9}
          fontFamily="var(--font-label)"
          fontWeight={600}
          textAnchor="middle"
          dominantBaseline="hanging"
        >
          {formatCompact(item.value)}
        </text>
      ))}
    </g>
  );
}

export function providerKey(agent: string) {
  const normalized = agent.toLowerCase();
  if (normalized.includes("claude") || normalized.includes("anthropic"))
    return "anthropic";
  if (normalized.includes("codex")) return "codex";
  if (normalized.includes("warp")) return "warp";
  return null;
}

export function resetCopy(timestamp: number | null, verb = "resets") {
  if (!timestamp || !Number.isFinite(timestamp))
    return verb === "renews"
      ? "no renewal time reported"
      : "no reset time reported";
  const delta = timestamp - Date.now();
  const absolute = new Date(timestamp).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  if (delta <= 0) return `expired · was due ${absolute}`;
  const minutes = Math.max(1, Math.ceil(delta / 60_000));
  const days = Math.floor(minutes / 1_440);
  const hours = Math.floor((minutes % 1_440) / 60);
  const remainingMinutes = minutes % 60;
  const countdown =
    days > 0
      ? `${days}d ${hours}h`
      : hours > 0
        ? `${hours}h ${remainingMinutes}m`
        : `${remainingMinutes}m`;
  return `${verb} in ${countdown} · ${absolute}`;
}

export function expiryCopy(timestamp: string | null) {
  if (!timestamp) return { text: "no expiry reported", urgent: false };
  const expiresAt = Date.parse(timestamp);
  if (!Number.isFinite(expiresAt))
    return { text: "expiry time unavailable", urgent: false };
  const delta = expiresAt - Date.now();
  const absolute = new Date(expiresAt).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  if (delta <= 0)
    return { text: `expired · was due ${absolute}`, urgent: false };
  const minutes = Math.max(1, Math.ceil(delta / 60_000));
  const days = Math.floor(minutes / 1_440);
  const hours = Math.floor((minutes % 1_440) / 60);
  const remainingMinutes = minutes % 60;
  const countdown =
    days > 0
      ? `${days}d ${hours}h`
      : hours > 0
        ? `${hours}h ${remainingMinutes}m`
        : `${remainingMinutes}m`;
  return {
    text: `expires in ${countdown} · ${absolute}`,
    urgent: delta <= 24 * 60 * 60 * 1_000,
  };
}

export function periodTickLabel(value: string) {
  const date = new Date(`${value}T12:00:00`);
  const weekday = date.toLocaleDateString(undefined, { weekday: "short" });
  const period = date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
  return `${weekday} ${period}`;
}

export function hourTickLabel(value: string) {
  return new Date(Date.UTC(2000, 0, 1, Number(value))).toLocaleTimeString(undefined, {
    hour: "numeric",
    timeZone: "UTC",
  });
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "unknown";
  return formatReadingAge(ms);
}
