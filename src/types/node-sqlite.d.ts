/**
 * node:sqlite 最小类型声明（Node 24 内置模块）。
 * 项目 @types/node 为 v20，尚未包含该模块类型；仅声明实际用到的 API。
 */
declare module "node:sqlite" {
  export interface StatementSync {
    run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
    get(...params: unknown[]): Record<string, unknown> | undefined;
    all(...params: unknown[]): Record<string, unknown>[];
  }

  export class DatabaseSync {
    constructor(path: string);
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }
}
