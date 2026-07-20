import { z } from "zod";

const modelBreakdownSchema = z.object({
  modelName: z.string(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number(),
  cacheCreationTokens: z.number(),
  cost: z.number(),
});

const agentBreakdownSchema = z.object({
  agent: z.string(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number(),
  cacheCreationTokens: z.number(),
  totalTokens: z.number(),
  totalCost: z.number(),
  modelsUsed: z.array(z.string()).default([]),
  modelBreakdowns: z.array(modelBreakdownSchema).default([]),
});

export const usageRowSchema = z.object({
  agent: z.string().default("all"),
  period: z.string(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number(),
  cacheCreationTokens: z.number(),
  totalTokens: z.number(),
  totalCost: z.number(),
  modelsUsed: z.array(z.string()).default([]),
  modelBreakdowns: z.array(modelBreakdownSchema).default([]),
  agents: z.array(agentBreakdownSchema).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const unifiedReportSchema = z.object({
  daily: z.array(usageRowSchema).default([]),
  weekly: z.array(usageRowSchema).default([]),
  monthly: z.array(usageRowSchema).default([]),
  session: z.array(usageRowSchema).default([]),
  totals: z.object({
    inputTokens: z.number(),
    outputTokens: z.number(),
    cacheReadTokens: z.number(),
    cacheCreationTokens: z.number(),
    totalTokens: z.number(),
    totalCost: z.number(),
  }),
});

export const blocksReportSchema = z.object({
  blocks: z
    .array(
      z.object({
        id: z.string(),
        startTime: z.string(),
        endTime: z.string(),
        actualEndTime: z.string().nullable().optional(),
        isActive: z.boolean().default(false),
        isGap: z.boolean().default(false),
        totalTokens: z.number(),
        costUSD: z.number(),
        burnRate: z
          .object({
            tokensPerMinute: z.number().optional(),
            costPerHour: z.number().optional(),
          })
          .nullable()
          .optional(),
        projection: z
          .object({
            totalTokens: z.number().optional(),
            totalCost: z.number().optional(),
          })
          .nullable()
          .optional(),
        models: z.array(z.string()).default([]),
        entries: z.number(),
      }),
    )
    .default([]),
});

export const projectsReportSchema = z.object({
  projects: z
    .record(
      z.string(),
      z.array(
        z.object({
          project: z.string(),
          date: z.string(),
          totalTokens: z.number(),
          totalCost: z.number(),
          inputTokens: z.number(),
          outputTokens: z.number(),
          cacheReadTokens: z.number(),
          cacheCreationTokens: z.number(),
          modelsUsed: z.array(z.string()).default([]),
          modelBreakdowns: z.array(modelBreakdownSchema).default([]),
        }),
      ),
    )
    .default({}),
  totals: z.record(z.string(), z.number()).optional(),
});

export type UsageRow = z.infer<typeof usageRowSchema>;
export type UnifiedReport = z.infer<typeof unifiedReportSchema>;
export type BlocksReport = z.infer<typeof blocksReportSchema>;
export type ProjectsReport = z.infer<typeof projectsReportSchema>;
