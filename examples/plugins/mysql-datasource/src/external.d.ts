declare module "mysql2/promise" {
  export interface PoolConnection {
    release(): void;
  }

  export interface Pool {
    getConnection(): Promise<PoolConnection>;
    query(sql: string): Promise<[unknown, unknown]>;
    end(): Promise<void>;
  }

  export function createPool(connectionUri: string): Pool;

  const mysql: {
    createPool(connectionUri: string): Pool;
  };

  export default mysql;
}
