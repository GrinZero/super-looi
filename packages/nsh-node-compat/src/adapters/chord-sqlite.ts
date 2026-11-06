// Chord serializes asynchronous transactions above our synchronous Rust SQLite
// bridge. Reuse its queue and transaction-handle lifetime checks unchanged.
export {
  NodeSqliteDatabase as NshSqliteDatabase,
  openNodeSqliteDatabase as openNshSqliteDatabase,
} from "@earendil-works/chord/sqlite/node";
