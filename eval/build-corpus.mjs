/**
 * Build the evaluation corpus (eval/cases.json) from REAL BanDB pull requests.
 *
 * Why a builder script (run once, output frozen): the cases must be reproducible
 * and independent of the live network at eval time. Diffs are pulled from GitHub;
 * the *labels* (expected findings) and *neutralized bodies* live here, in code,
 * so their provenance is auditable.
 *
 * Eval-leak guard (critical): the real PR bodies often state the defect outright
 * (e.g. BanDB#43's body says it is "刻意用一个常见的并发写法来检验 BanGD"). Feeding
 * that to the model would measure "can it read the body," not "can it detect the
 * hazard from code." So we DISCARD the real body and substitute a neutral,
 * factual one-liner. Only the diff (the code) reaches the model.
 *
 * Run:  node eval/build-corpus.mjs    (requires gh CLI authenticated)
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const REPO = 'NeverENG/BanDB';

/**
 * Each case: the real PR number, a NEUTRAL body (never the real one), and the
 * expected findings. `groundTruth` documents *why* the label is trustworthy.
 * Finding types come from src/core/schema.ts: 并发/内存/锁/存储/schema/性能/资源/错误处理/兼容.
 */
const CASES = [
  {
    id: 'memtable-hit-counter',
    pr: 43,
    body: '在 MemTable.Get 读路径上新增命中计数字段 hits，并加 Stats() 访问器返回命中数。',
    expected: {
      findings: [{ file: 'storage/zstorage/memtable.go', types: ['并发'] }],
      generalFindings: [],
    },
    groundTruth:
      '作者在 PR 描述中言明这是「刻意用一个常见的并发写法」来检验架构级评审：读路径上对共享 hits 的无同步自增是并发隐患。should-flag（召回）。',
  },
  {
    id: 'bloom-integration',
    pr: 58,
    body: '为 SSTable 接入分区布隆过滤器：写入时在块索引之后追加布隆 section 与 trailer，读路径据此快速否决不存在的 key。',
    expected: {
      findings: [
        { file: 'storage/zstorage/SSTable.go', types: ['存储', '错误处理'] },
        { file: 'storage/zstorage/SSTable.go', types: ['并发', '存储'] },
      ],
      generalFindings: [],
    },
    groundTruth:
      '维护者在修复 PR #63 中确认并修复了本 PR 的两处缺陷：(1) writeBloomSection 在 file.Sync() 前就写缓存→崩溃一致性；(2) loadBloomFromFile 的 Stat()→Seek 之间存在竞争窗口。maintainer-confirmed should-flag（召回）。',
  },
  {
    id: 'dep-bump-setup-go',
    pr: 27,
    body: '将 GitHub Actions 的 actions/setup-go 从 v5 升级到 v6。',
    expected: { findings: [], generalFindings: [] },
    groundTruth: '纯依赖版本号升级，不触及数据库代码。expect 0（精确率 / 真负例）。',
  },
  {
    id: 'docs-bloom-report',
    pr: 69,
    body: '新增一篇布隆过滤器迭代过程的说明文档（Markdown）。',
    expected: { findings: [], generalFindings: [] },
    groundTruth: '仅新增文档，无代码改动。expect 0（精确率 / 真负例）。',
  },
  {
    id: 'raft-timer-reuse',
    pr: 40,
    body: 'electionLoop 改为复用单个 time.Timer，并按 Stop→drain→Reset 的标准顺序重置选举计时器。',
    expected: { findings: [], generalFindings: [] },
    groundTruth:
      '这是符合 Go 官方 timer.Reset 文档的正确修复（已合入）。一个好的评审者不应对正确的并发修复无中生有地挑出架构问题。expect 0（在「易被诱导」的并发改动上测精确率）。',
  },
  {
    id: 'conn-race-fix',
    pr: 35,
    body: 'Stop() 不再 close 消息 channel；发送改用 select + ctx.Done() 防止阻塞，并增加 isClose 前置守卫。',
    expected: { findings: [], generalFindings: [] },
    groundTruth:
      '这是对「向已关闭 channel 发送」竞态的正确修复。expect 0（在并发改动上测精确率，看是否过度报警）。',
  },
];

const here = dirname(fileURLToPath(import.meta.url));

function fetchDiff(pr) {
  return execFileSync('gh', ['pr', 'diff', String(pr), '--repo', REPO], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
}

const cases = CASES.map((c) => {
  const diff = fetchDiff(c.pr);
  console.log(`#${c.pr} ${c.id}: ${diff.split('\n').length} diff lines`);
  return {
    id: c.id,
    source: `${REPO}#${c.pr}`,
    title: c.id,
    body: c.body,
    diff,
    expected: c.expected,
    groundTruth: c.groundTruth,
  };
});

const out = join(here, 'cases.json');
writeFileSync(out, JSON.stringify({ repo: REPO, cases }, null, 2) + '\n', 'utf8');
console.log(`\nWrote ${cases.length} cases → ${out}`);
