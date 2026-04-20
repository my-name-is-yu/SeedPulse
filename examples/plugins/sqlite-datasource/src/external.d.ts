declare module "better-sqlite3" {
  interface Statement {
    all(): unknown[];
    get(): unknown;
  }

  class Database {
    constructor(filePath: string);
    prepare(sql: string): Statement;
    close(): void;
  }

  namespace Database {
    export type Database = InstanceType<typeof Database>;
  }

  export default Database;
}
