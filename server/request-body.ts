import { z } from "zod";

export class RequestInputError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

export async function readBody<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
  if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
    throw new RequestInputError("Content-Type must be application/json", 415);
  }
  let value: unknown;
  try { value = await request.json(); }
  catch { throw new RequestInputError("Expected a JSON request body"); }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new RequestInputError(parsed.error.issues.map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`).join("; "));
  }
  return parsed.data;
}

export const objectBody = z.record(z.string(), z.unknown());
export const effortSettingsBody = z.object({ enabled: z.boolean() });
export const ruleBody = z.object({
  pattern: z.string().trim().min(1),
  tag: z.string().trim().min(1),
  kind: z.enum(["glob", "regex"]),
}).superRefine((value, context) => {
  if (value.kind !== "regex") return;
  try { new RegExp(value.pattern, "i"); }
  catch { context.addIssue({ code: "custom", path: ["pattern"], message: "Invalid regular expression" }); }
});
export const annotationBody = z.object({ tags: z.array(z.string()).default([]), note: z.string().default("") });
export const verdictBody = z.object({ verdict: z.enum(["good", "mixed", "bad"]).nullable() });
export const snoozeBody = z.object({ snoozedUntil: z.iso.datetime({ offset: true }) });
export const externalOpenBody = z.discriminatedUnion("target", [
  z.object({ target: z.literal("transcript"), action: z.enum(["reveal", "vscode", "default-editor"]) }),
  z.object({ target: z.literal("file"), action: z.enum(["reveal", "vscode", "default-editor"]), path: z.string().min(1) }),
]);
export const quotaContextsBody = z.object({ sessionIds: z.array(z.string().min(1)).max(25) });
export const settingsBody = z.record(z.string().min(1), z.union([z.string(), z.number().finite(), z.boolean()]));

export function pageNumber(value: string | null, fallback: number, maximum?: number) {
  if (value === null) return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new RequestInputError("Pagination values must be positive integers");
  return maximum ? Math.min(maximum, number) : number;
}
