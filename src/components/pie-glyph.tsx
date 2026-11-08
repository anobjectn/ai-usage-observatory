/** Inline pie for a single share: an outline ring with a filled wedge from twelve o'clock,
 * clockwise. Sized in `em` so it sits on the text line it annotates. A sliver is never drawn
 * smaller than a visible minimum, so a present share cannot read as empty. */
export function PieGlyph({
  share,
  color,
  className,
  label,
}: {
  /** 0–1. Values outside the range are clamped. */
  share: number;
  /** Defaults to the inherited text colour, so a class can tone it. */
  color?: string;
  className?: string;
  /** Accessible name; omitted glyphs are decorative. */
  label?: string;
}) {
  const clamped = Number.isFinite(share) ? Math.max(0, Math.min(1, share)) : 0;
  const shown = clamped > 0 && clamped < 0.04 ? 0.04 : clamped;
  return (
    <svg
      className={className ? `pie-glyph ${className}` : "pie-glyph"}
      viewBox="0 0 16 16"
      style={color ? { color } : undefined}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      {label && <title>{label}</title>}
      <circle cx="8" cy="8" r="7.25" fill="none" stroke="currentColor" strokeWidth="1.5" opacity="0.45" />
      {shown >= 0.999 ? (
        <circle cx="8" cy="8" r="5.5" fill="currentColor" />
      ) : shown > 0 ? (
        <path d={wedgePath(shown, 5.5)} fill="currentColor" />
      ) : null}
    </svg>
  );
}

function wedgePath(share: number, radius: number) {
  const angle = share * 2 * Math.PI;
  const x = 8 + radius * Math.sin(angle);
  const y = 8 - radius * Math.cos(angle);
  const largeArc = share > 0.5 ? 1 : 0;
  return `M8 8V${8 - radius}A${radius} ${radius} 0 ${largeArc} 1 ${x.toFixed(3)} ${y.toFixed(3)}Z`;
}
