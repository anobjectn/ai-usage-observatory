import { expect, test } from "bun:test";
import { resolveDbPath } from "./db-path";

test("the database path is absolute for default, relative, and absolute configuration", () => {
  expect(resolveDbPath({}, "/repo")).toBe("/repo/.usage-observatory/data.db");
  expect(resolveDbPath({ USAGE_OBSERVATORY_DB: "fixtures/data.db" }, "/repo")).toBe("/repo/fixtures/data.db");
  expect(resolveDbPath({ USAGE_OBSERVATORY_DB: "/tmp/elsewhere.db" }, "/repo")).toBe("/tmp/elsewhere.db");
});
