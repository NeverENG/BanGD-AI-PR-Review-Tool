/**
 * The review dimensions. Each maps to a rubric fragment (prompts/rubric/<id>.md)
 * and optionally a few-shot example (prompts/examples/<exampleFile>). This is the
 * progressive-disclosure registry: instead of sending the whole rubric + every
 * example on every request, the router picks the relevant dimension ids and only
 * those fragments/examples are loaded into the prompt (see router.ts, review.ts).
 *
 * `keywords` drive the heuristic router. They are matched case-insensitively
 * against the diff text and changed-file paths.
 */

export type DimensionId =
  | 'concurrency'
  | 'memory'
  | 'lock'
  | 'storage'
  | 'schema'
  | 'performance'
  | 'resource'
  | 'error'
  | 'compatibility';

export interface Dimension {
  id: DimensionId;
  /** Human label, used in the LLM-fallback routing prompt. */
  title: string;
  /** prompts/examples/<file>, if this dimension has a few-shot exemplar. */
  exampleFile?: string;
  /** Lowercased substrings that signal this dimension. */
  keywords: string[];
}

export const DIMENSIONS: Dimension[] = [
  {
    id: 'concurrency',
    title: '并发与同步',
    exampleFile: 'concurrency-panic-dual-table.md',
    keywords: ['go func', 'goroutine', 'chan ', 'chan)', 'channel', 'sync.', 'mutex', 'atomic', 'map[', 'race', '并发', '计数'],
  },
  {
    id: 'memory',
    title: '内存管理与生命周期',
    exampleFile: 'memory-pool-use-after-free.md',
    keywords: ['unsafe', 'sync.pool', 'buffer', '内存', 'alloc', 'free(', '复用', '[]byte'],
  },
  {
    id: 'lock',
    title: '锁与隔离级别',
    exampleFile: 'lock-ordering-deadlock.md',
    keywords: ['lock(', 'unlock', 'rlock', 'runlock', 'mvcc', 'isolation', '隔离', '事务', 'transaction', 'deadlock', '死锁'],
  },
  {
    id: 'storage',
    title: '存储格式、WAL 与崩溃恢复',
    exampleFile: 'wal-ordering-crash-safety.md',
    keywords: ['wal', 'fsync', 'checkpoint', 'redo', 'undo', 'snapshot', 'sstable', 'flush', '落盘', '磁盘', 'serialize', '序列化'],
  },
  {
    id: 'schema',
    title: 'Schema 演进与迁移',
    exampleFile: 'schema-online-migration.md',
    keywords: ['schema', 'alter', 'migrat', '迁移', '表结构', 'column', 'ddl'],
  },
  {
    id: 'performance',
    title: '热路径性能',
    exampleFile: 'performance-hot-path-alloc.md',
    keywords: ['index', '索引', 'scan', '热路径', 'hot path', 'benchmark', 'cache', '缓存', '批处理', 'batch'],
  },
  {
    id: 'resource',
    title: '资源与泄漏',
    exampleFile: 'resource-goroutine-leak.md',
    keywords: ['defer ', 'close()', '.close(', 'context', 'ctx', '句柄', 'connection', '泄漏', 'leak'],
  },
  {
    id: 'error',
    title: '错误处理与崩溃安全',
    exampleFile: 'error-swallowed-fsync.md',
    keywords: ['panic', 'recover', 'err !=', 'err ==', '_ =', 'partial', '吞'],
  },
  {
    id: 'compatibility',
    title: '接口与兼容契约',
    exampleFile: 'compatibility-wire-format.md',
    keywords: ['proto', 'rpc', 'grpc', 'api', '协议', 'config', '兼容', 'version', '版本'],
  },
];

export const ALL_DIMENSION_IDS: DimensionId[] = DIMENSIONS.map((d) => d.id);
