import { z } from "zod";
import type {
  ITool,
  ToolResult,
  ToolCallContext,
  PermissionCheckResult,
  ToolMetadata,
  ToolDescriptionContext,
} from "../../types.js";
import { SoilDoctor } from "../../../platform/soil/index.js";
import { DESCRIPTION } from "./prompt.js";
import { ALIASES, MAX_OUTPUT_CHARS, PERMISSION_LEVEL, READ_ONLY, TAGS, TOOL_NAME } from "./constants.js";

export const SoilDoctorInputSchema = z.object({
  rootDir: z.string().min(1).optional(),
});
export type SoilDoctorInput = z.infer<typeof SoilDoctorInputSchema>;

export interface SoilDoctorOutput {
  report: {
    rootDir: string;
    totalPages: number;
    findingCount: number;
    errorCount: number;
    warnCount: number;
  };
  findings: Array<{
    code: string;
    severity: "error" | "warn";
    soilId?: string;
    relativePath: string;
    absolutePath: string;
    message: string;
    details?: Record<string, unknown>;
  }>;
}

export class SoilDoctorTool implements ITool<SoilDoctorInput, SoilDoctorOutput> {
  readonly metadata: ToolMetadata = {
    name: TOOL_NAME,
    aliases: [...ALIASES],
    permissionLevel: PERMISSION_LEVEL,
    isReadOnly: READ_ONLY,
    isDestructive: false,
    shouldDefer: false,
    alwaysLoad: false,
    maxConcurrency: 0,
    maxOutputChars: MAX_OUTPUT_CHARS,
    tags: [...TAGS],
  };

  readonly inputSchema = SoilDoctorInputSchema;

  description(_context?: ToolDescriptionContext): string {
    return DESCRIPTION;
  }

  async call(input: SoilDoctorInput, _context: ToolCallContext): Promise<ToolResult> {
    const startTime = Date.now();

    try {
      const parsedInput = this.inputSchema.parse(input);
      const report = await SoilDoctor.create({ rootDir: parsedInput.rootDir }).inspect();
      const errorCount = report.findings.filter((finding) => finding.severity === "error").length;
      const warnCount = report.findings.filter((finding) => finding.severity === "warn").length;
      const output: SoilDoctorOutput = {
        report: {
          rootDir: report.rootDir,
          totalPages: report.totalPages,
          findingCount: report.findings.length,
          errorCount,
          warnCount,
        },
        findings: report.findings.map((finding) => ({
          code: finding.code,
          severity: finding.severity,
          soilId: finding.soilId,
          relativePath: finding.relativePath,
          absolutePath: finding.absolutePath,
          message: finding.message,
          details: finding.details,
        })),
      };

      return {
        success: true,
        data: output,
        summary: `${output.report.findingCount} Soil finding${output.report.findingCount !== 1 ? "s" : ""} across ${output.report.totalPages} page${output.report.totalPages !== 1 ? "s" : ""}`,
        durationMs: Date.now() - startTime,
      };
    } catch (err) {
      return {
        success: false,
        data: {
          report: {
            rootDir: input.rootDir ?? "",
            totalPages: 0,
            findingCount: 0,
            errorCount: 0,
            warnCount: 0,
          },
          findings: [],
        } satisfies SoilDoctorOutput,
        summary: `Soil doctor failed: ${(err as Error).message}`,
        error: (err as Error).message,
        durationMs: Date.now() - startTime,
      };
    }
  }

  async checkPermissions(_input: SoilDoctorInput, _context: ToolCallContext): Promise<PermissionCheckResult> {
    return { status: "allowed" };
  }

  isConcurrencySafe(_input?: SoilDoctorInput): boolean {
    return true;
  }
}
