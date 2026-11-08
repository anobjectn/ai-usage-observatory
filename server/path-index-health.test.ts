import { expect, test } from "bun:test";
import { pathIndexHealth } from "./collector";

test("path index health reports duplicate rollouts and degrades only for stale plain copies", () => {
  expect(pathIndexHealth(12, { pairs: 0, stalePlain: [] })).toMatchObject({ status: "healthy", detail: "12 transcript sessions joined · metadata only" });
  expect(pathIndexHealth(12, undefined).status).toBe("healthy");
  const pair = pathIndexHealth(12, { pairs: 1, stalePlain: [] });
  expect(pair.status).toBe("healthy");
  expect(pair.detail).toContain("1 Codex rollout is on disk both plain and compressed, counted once");
  const stale = pathIndexHealth(12, { pairs: 41, stalePlain: Array.from({ length: 41 }, (_, index) => `.codex/sessions/${index}.jsonl`) });
  expect(stale.status).toBe("degraded");
  expect(stale.detail).toContain("41 plain copies are older than the compressed copy");
});
