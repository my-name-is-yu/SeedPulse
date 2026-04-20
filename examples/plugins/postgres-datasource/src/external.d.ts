declare module "pg" {
  export class Pool {
    constructor(options?: { connectionString?: string });
    connect(): Promise<{ release(): void }>;
    query(sql: string): Promise<{ rows: unknown[] }>;
    end(): Promise<void>;
  }

  const pg: {
    Pool: typeof Pool;
  };

  export default pg;
}
