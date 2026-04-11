import type { SoilPublishConfig, SoilPublishPageResult, SoilPublishState, SoilSnapshotFile } from "./types.js";

export interface NotionPublishClient {
  createPage(input: { parentPageId: string; title: string }): Promise<string>;
  replacePageMarkdown(input: { pageId: string; title: string; markdown: string }): Promise<void>;
  archivePage?(input: { pageId: string; relativePath: string }): Promise<void>;
}

interface NotionFetchResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

type NotionFetch = (url: string, init: RequestInit) => Promise<NotionFetchResponse>;

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

async function readNotionJson(response: NotionFetchResponse): Promise<Record<string, unknown>> {
  const body = await response.json().catch(async () => ({ message: await response.text().catch(() => "") }));
  return asRecord(body);
}

function textBlocks(markdown: string): Array<Record<string, unknown>> {
  const chunks: string[] = [];
  for (let index = 0; index < markdown.length; index += 1800) {
    chunks.push(markdown.slice(index, index + 1800));
  }
  return chunks.map((chunk) => ({
    object: "block",
    type: "code",
    code: {
      language: "markdown",
      rich_text: [{ type: "text", text: { content: chunk } }],
    },
  }));
}

function chunkBlocks(blocks: Array<Record<string, unknown>>, size: number): Array<Array<Record<string, unknown>>> {
  const chunks: Array<Array<Record<string, unknown>>> = [];
  for (let index = 0; index < blocks.length; index += size) {
    chunks.push(blocks.slice(index, index + size));
  }
  return chunks;
}

export class FetchNotionPublishClient implements NotionPublishClient {
  private readonly fetchFn: NotionFetch;

  constructor(private readonly token: string, fetchFn?: NotionFetch) {
    this.fetchFn = fetchFn ?? (globalThis.fetch as unknown as NotionFetch);
  }

  private async request(path: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
    const response = await this.fetchFn(`https://api.notion.com/v1${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    });
    const body = await readNotionJson(response);
    if (!response.ok) {
      throw new Error(`Notion API ${response.status}: ${String(body["message"] ?? "request failed")}`);
    }
    return body;
  }

  async createPage(input: { parentPageId: string; title: string }): Promise<string> {
    const body = await this.request("/pages", {
      method: "POST",
      body: JSON.stringify({
        parent: { page_id: input.parentPageId },
        properties: {
          title: {
            title: [{ type: "text", text: { content: input.title } }],
          },
        },
      }),
    });
    const id = body["id"];
    if (typeof id !== "string") {
      throw new Error("Notion create page response did not include an id");
    }
    return id;
  }

  async replacePageMarkdown(input: { pageId: string; title: string; markdown: string }): Promise<void> {
    let cursor: string | undefined;
    do {
      const suffix = cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : "";
      const children = await this.request(`/blocks/${input.pageId}/children?page_size=100${suffix}`, { method: "GET" });
      for (const child of Array.isArray(children["results"]) ? children["results"] : []) {
        const record = asRecord(child);
        if (typeof record["id"] === "string") {
          await this.request(`/blocks/${record["id"]}`, { method: "DELETE" });
        }
      }
      cursor = children["has_more"] === true && typeof children["next_cursor"] === "string"
        ? children["next_cursor"]
        : undefined;
    } while (cursor);

    const blocks = [
      {
        object: "block",
        type: "heading_2",
        heading_2: { rich_text: [{ type: "text", text: { content: input.title } }] },
      },
      ...textBlocks(input.markdown || "\n"),
    ];
    for (const children of chunkBlocks(blocks, 90)) {
      await this.request(`/blocks/${input.pageId}/children`, {
        method: "PATCH",
        body: JSON.stringify({ children }),
      });
    }
  }

  async archivePage(input: { pageId: string }): Promise<void> {
    await this.request(`/pages/${input.pageId}`, {
      method: "PATCH",
      body: JSON.stringify({ archived: true }),
    });
  }
}

export async function publishNotionSnapshot(input: {
  config: SoilPublishConfig;
  files: SoilSnapshotFile[];
  state: SoilPublishState;
  dryRun?: boolean;
  client?: NotionPublishClient;
  clock?: () => Date;
}): Promise<SoilPublishPageResult[]> {
  const config = input.config.notion;
  if (!config?.enabled) {
    return [{ provider: "notion", relativePath: "", status: "skipped", message: "Notion publish is disabled" }];
  }
  if (!config.token || !config.parentPageId) {
    return [{ provider: "notion", relativePath: "", status: "skipped", message: "Notion token and parentPageId are required" }];
  }

  const client = input.client ?? new FetchNotionPublishClient(config.token);
  const results: SoilPublishPageResult[] = [];
  const currentPaths = new Set(input.files.map((file) => file.relativePath));
  for (const file of input.files) {
    const existing = input.state.notion.pages[file.relativePath];
    if (existing?.source_hash === file.sourceHash && existing.notion_page_id) {
      results.push({
        provider: "notion",
        relativePath: file.relativePath,
        status: "skipped",
        sourceHash: file.sourceHash,
        destinationId: existing.notion_page_id,
        message: "source hash unchanged",
      });
      continue;
    }
    if (input.dryRun) {
      results.push({ provider: "notion", relativePath: file.relativePath, status: "dry_run", sourceHash: file.sourceHash });
      continue;
    }

    try {
      const title = `${config.titlePrefix ?? "Soil"} / ${file.relativePath}`;
      const pageId = existing?.notion_page_id ?? await client.createPage({ parentPageId: config.parentPageId, title });
      await client.replacePageMarkdown({ pageId, title, markdown: file.content });
      input.state.notion.pages[file.relativePath] = {
        notion_page_id: pageId,
        source_hash: file.sourceHash,
        published_at: (input.clock?.() ?? new Date()).toISOString(),
      };
      results.push({
        provider: "notion",
        relativePath: file.relativePath,
        status: "published",
        sourceHash: file.sourceHash,
        destinationId: pageId,
      });
    } catch (error) {
      results.push({
        provider: "notion",
        relativePath: file.relativePath,
        status: "error",
        sourceHash: file.sourceHash,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  for (const [relativePath, existing] of Object.entries(input.state.notion.pages)) {
    if (currentPaths.has(relativePath)) {
      continue;
    }
    if (input.dryRun) {
      results.push({
        provider: "notion",
        relativePath,
        status: "dry_run",
        destinationId: existing.notion_page_id,
        message: "stale Notion page would be archived",
      });
      continue;
    }
    try {
      if (typeof client.archivePage === "function") {
        await client.archivePage({ pageId: existing.notion_page_id, relativePath });
      }
      delete input.state.notion.pages[relativePath];
      results.push({
        provider: "notion",
        relativePath,
        status: "archived",
        destinationId: existing.notion_page_id,
        message: "Soil page no longer exists",
      });
    } catch (error) {
      results.push({
        provider: "notion",
        relativePath,
        status: "error",
        destinationId: existing.notion_page_id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}
