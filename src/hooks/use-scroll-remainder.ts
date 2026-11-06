import { useEffect, useState } from "react";

/** Where a scroll box stands: everything fits, rows wait below the fold, or it is scrolled to its
 * end. */
export type ScrollRemainder = "fits" | "more" | "end";

/** Tracks a scroll box's remainder, so a list can fade its foot and say "scroll for more" only
 * while rows wait below. `contentKey` changes whenever the rows change, since new rows do not
 * resize a box held at its max height. */
export function useScrollRemainder<T extends HTMLElement>(contentKey: unknown) {
  const [node, setNode] = useState<T | null>(null);
  const [remainder, setRemainder] = useState<ScrollRemainder>("fits");
  useEffect(() => {
    if (!node) return;
    const update = () => {
      const hidden = node.scrollHeight - node.clientHeight;
      // A couple of pixels of rounding is not a hidden row.
      setRemainder(hidden <= 2 ? "fits" : node.scrollTop >= hidden - 2 ? "end" : "more");
    };
    update();
    node.addEventListener("scroll", update, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    observer?.observe(node);
    return () => {
      node.removeEventListener("scroll", update);
      observer?.disconnect();
    };
  }, [node, contentKey]);
  return [setNode, remainder] as const;
}
