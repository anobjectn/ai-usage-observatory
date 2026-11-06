type SortDirection = "asc" | "desc";

export type CompactSortOption<K extends string> = {
  key: K;
  label: string;
  /** How the two directions read: numbers run high/low, names A–Z, dates newest/oldest. */
  kind: "number" | "text" | "date";
};

const directionWords = {
  number: { desc: "high to low", asc: "low to high" },
  text: { asc: "A to Z", desc: "Z to A" },
  date: { desc: "newest first", asc: "oldest first" },
} as const;

/** One select in place of a table's sortable headers, for widths where the table is a stack of
 * cards. It uses the Projects sort control's look and its "Field: direction" wording. */
export function CompactSort<K extends string>({
  className,
  options,
  sortKey,
  direction,
  onChange,
}: {
  className?: string;
  options: CompactSortOption<K>[];
  sortKey: K;
  direction: SortDirection;
  onChange: (next: { key: K; direction: SortDirection }) => void;
}) {
  return (
    <label className={`project-sort compact-sort${className ? ` ${className}` : ""}`}>
      <span>Sort</span>
      <select
        value={`${sortKey}:${direction}`}
        onChange={(event) => {
          const [key, next] = event.target.value.split(":") as [K, SortDirection];
          onChange({ key, direction: next });
        }}
      >
        {options.flatMap((option) => {
          const words = directionWords[option.kind];
          const order: SortDirection[] = option.kind === "text" ? ["asc", "desc"] : ["desc", "asc"];
          return order.map((dir) => (
            <option key={`${option.key}:${dir}`} value={`${option.key}:${dir}`}>
              {option.label}: {words[dir]}
            </option>
          ));
        })}
      </select>
    </label>
  );
}
