import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { SoilPageFrontmatterSchema, type SoilPageFrontmatter } from "./types.js";
import { computeSoilChecksum } from "./checksum.js";
import { createSoilConfig, type SoilConfig, type SoilConfigInput } from "./config.js";
import { normalizeSoilId, soilIdToRelativePath, resolveSoilPageFilePath } from "./paths.js";
import { writeSoilMarkdownFile } from "./io.js";

export interface SoilCompileInput {
  frontmatter: SoilPageFrontmatter;
  body: string;
}

export interface SoilCompileResult {
  frontmatter: SoilPageFrontmatter;
  body: string;
  checksum: string;
  relativePath: string;
  filePath: string;
}

export interface SoilCompilerOptions {
  clock?: () => Date;
}

function nowIso(clock?: () => Date): string {
  return (clock?.() ?? new Date()).toISOString();
}

function withoutVolatileFields(frontmatter: SoilPageFrontmatter): SoilPageFrontmatter {
  return SoilPageFrontmatterSchema.parse({
    ...frontmatter,
    checksum: undefined,
    generated_at: "1970-01-01T00:00:00.000Z",
    updated_at: "1970-01-01T00:00:00.000Z",
    generation_watermark: {
      ...frontmatter.generation_watermark,
      generated_at: "1970-01-01T00:00:00.000Z",
    },
  });
}

export class SoilCompiler {
  constructor(
    private readonly config: SoilConfig,
    private readonly options: SoilCompilerOptions = {}
  ) {}

  static create(input: SoilConfigInput = {}, options: SoilCompilerOptions = {}): SoilCompiler {
    return new SoilCompiler(createSoilConfig(input), options);
  }

  async compile(input: SoilCompileInput): Promise<SoilCompileResult> {
    const normalized = SoilPageFrontmatterSchema.parse(input.frontmatter);
    const timestamp = nowIso(this.options.clock);
    const frontmatter: SoilPageFrontmatter = SoilPageFrontmatterSchema.parse({
      ...normalized,
      soil_id: normalizeSoilId(normalized.soil_id),
      generated_at: timestamp,
      updated_at: timestamp,
      generation_watermark: {
        ...normalized.generation_watermark,
        generated_at: timestamp,
      },
      stale: false,
    });
    const checksum = computeSoilChecksum({
      frontmatter: withoutVolatileFields(frontmatter),
      body: input.body,
    });
    const compiledFrontmatter: SoilPageFrontmatter = SoilPageFrontmatterSchema.parse({
      ...frontmatter,
      checksum,
    });
    const relativePath = soilIdToRelativePath(compiledFrontmatter.soil_id);
    const filePath = resolveSoilPageFilePath(this.config.rootDir, compiledFrontmatter.soil_id);
    return {
      frontmatter: compiledFrontmatter,
      body: input.body,
      checksum,
      relativePath,
      filePath,
    };
  }

  async write(input: SoilCompileInput): Promise<SoilCompileResult> {
    const compiled = await this.compile(input);
    await fsp.mkdir(path.dirname(compiled.filePath), { recursive: true });
    await writeSoilMarkdownFile(compiled.filePath, compiled.frontmatter, compiled.body);
    return compiled;
  }
}

export async function compileSoilPage(
  input: SoilCompileInput,
  configInput: SoilConfigInput = {},
  options: SoilCompilerOptions = {}
): Promise<SoilCompileResult> {
  return SoilCompiler.create(configInput, options).compile(input);
}

export async function writeSoilPage(
  input: SoilCompileInput,
  configInput: SoilConfigInput = {},
  options: SoilCompilerOptions = {}
): Promise<SoilCompileResult> {
  return SoilCompiler.create(configInput, options).write(input);
}
