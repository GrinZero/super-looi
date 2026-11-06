import process from "./process.js";
import { call, unsupported } from "../bridge.js";
export type SQLInputValue = string | number | bigint | null | Uint8Array;
export class DatabaseSync {
  private id: number;
  private closed = false;
  constructor(
    path: string,
    options: { timeout?: number; readOnly?: boolean } = {},
  ) {
    if (options.readOnly) unsupported("read-only SQLite connections");
    path =
      path === ":memory:" || path.startsWith("/")
        ? path
        : `${process.cwd()}/${path}`;
    this.id = call<number>("sqlite.open", { path, timeout: options.timeout });
  }
  private request<T>(op: string, args: Record<string, unknown> = {}): T {
    if (this.closed) throw new Error("ERR_INVALID_STATE: database is closed");
    return call<T>(`sqlite.${op}`, { id: this.id, ...args });
  }
  exec(sql: string) {
    this.request("exec", { sql });
  }
  prepare(sql: string) {
    return new StatementSync(this, sql);
  }
  execute<T>(op: string, sql: string, args: unknown[]): T {
    return this.request(op, {
      sql,
      args: args.map((v) => {
        if (v instanceof Uint8Array) return Array.from(v);
        if (typeof v === "bigint") {
          if (
            v > BigInt(Number.MAX_SAFE_INTEGER) ||
            v < BigInt(Number.MIN_SAFE_INTEGER)
          )
            unsupported("unsafe SQLite integer");
          return Number(v);
        }
        return v;
      }),
    });
  }
  close() {
    if (!this.closed) this.request("close");
    this.closed = true;
  }
}
export class StatementSync {
  constructor(
    private database: DatabaseSync,
    private sql: string,
  ) {}
  run(...args: SQLInputValue[]) {
    return this.database.execute<{ changes: number; lastInsertRowid: number }>(
      "run",
      this.sql,
      args,
    );
  }
  get(...args: SQLInputValue[]) {
    return (
      this.database.execute<Record<string, unknown> | null>(
        "get",
        this.sql,
        args,
      ) ?? undefined
    );
  }
  all(...args: SQLInputValue[]) {
    return this.database.execute<Record<string, unknown>[]>(
      "all",
      this.sql,
      args,
    );
  }
  *iterate(...args: SQLInputValue[]) {
    yield* this.all(...args);
  }
  setAllowBareNamedParameters(_value: boolean) {
    return this;
  }
  setReadBigInts(value: boolean) {
    if (value) unsupported("SQLite BigInt result mode");
    return this;
  }
}
export default { DatabaseSync, StatementSync };
