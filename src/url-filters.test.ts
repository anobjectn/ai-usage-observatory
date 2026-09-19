import { expect, test } from "bun:test";
import { carryUrlFilters, defaultUrlFilters, parseUrlFilters, writeUrlFilters, type UrlFilters } from "./url-filters";

const roundTrip = (filters: UrlFilters) => {
  const params = new URLSearchParams();
  writeUrlFilters(params, filters);
  return { search: params.toString(), parsed: parseUrlFilters(params) };
};

test("default selections write no parameters", () => {
  expect(roundTrip(defaultUrlFilters)).toEqual({ search: "", parsed: defaultUrlFilters });
});

test("a full analysis round-trips through the URL", () => {
  const filters: UrlFilters = {
    range: "custom",
    customRange: { from: "2026-08-01", to: "2026-08-31" },
    agent: ["agent:claude", "model:gpt-5.5"],
    pathTag: "quota-service",
    showCache: false,
  };
  expect(roundTrip(filters).parsed).toEqual(filters);
});

test("a preset range round-trips without date keys", () => {
  const { search, parsed } = roundTrip({ ...defaultUrlFilters, range: "7" });
  expect(search).toBe("range=7");
  expect(parsed.range).toBe("7");
});

test("malformed values fall back to the defaults", () => {
  expect(parseUrlFilters("?range=banana&agent=claude&cache=yes")).toEqual(defaultUrlFilters);
  // A custom range needs two valid, ordered dates.
  expect(parseUrlFilters("?range=custom&from=2026-08-31&to=2026-08-01")).toEqual(defaultUrlFilters);
  expect(parseUrlFilters("?range=custom&from=2026-08-01")).toEqual(defaultUrlFilters);
});

test("writing replaces earlier filter keys and keeps the other parameters", () => {
  const params = new URLSearchParams("view=sessions&range=7&agent=agent:codex&session=abc");
  writeUrlFilters(params, { ...defaultUrlFilters, pathTag: "work" });
  expect(params.toString()).toBe("view=sessions&session=abc&path=work");
});

test("carrying copies the filter keys only", () => {
  const target = new URLSearchParams("view=models");
  carryUrlFilters(new URLSearchParams("view=sessions&session=abc&range=14&cache=0"), target);
  expect(target.toString()).toBe("view=models&range=14&cache=0");
});
