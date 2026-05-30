# BanGD 项目学习指南（写给 Go 后端程序员）

这份文档假设你**会 Go、几乎不会 TypeScript**。所以每讲一个 TS 概念，我都会先给你一个 Go 的对照。读完你应该能看懂这个项目的每一行，并能自己改。

---

## 第 0 章：先把 Go 的脑子搬过来（心智映射表）

| 你在 Go 里熟悉的 | TypeScript 里对应的 | 关键区别 |
|---|---|---|
| `go.mod` / `go.sum` | `package.json` / `package-lock.json` | 依赖 + 脚本都在 package.json |
| `go build` 出单个二进制 | `ncc` 打包出单个 `dist/index.js` | 见技术选型 |
| `go vet` + `golangci-lint` | `eslint` | 静态检查 |
| 编译器类型检查 | `tsc`（TypeScript 编译器） | TS 类型**只在编译期存在**，运行时全没了 |
| `interface` | `interface` | **几乎一样**！都是结构化类型（鸭子类型） |
| `struct` + 方法 | `class` 或 `interface`+对象 | 见第 5 章 |
| `type Foo = ...` | `type Foo = ...` | 概念一致 |
| `interface{}` / `any` | `unknown`（安全）或 `any`（危险） | 见第 6 章，**本项目禁用 any** |
| 指针可为 `nil` | 值可为 `null` / `undefined` | TS 严格模式逼你处理，类似 Go 逼你 `if err != nil` |
| `error` 返回值 | `throw` / `try-catch` 异常 | TS 用异常，不是返回值 |
| goroutine + channel | `async` / `await` / `Promise` | **完全不同的并发模型**，见第 6 章 |
| 接口注入做依赖解耦 | 接口注入做依赖解耦 | **思路一模一样**，这是本项目的核心 |
| `package` + 首字母大写导出 | `export` 关键字导出 | TS 用显式 `export` |

**最重要的一句**：TypeScript = JavaScript + 类型。类型在 `tsc` 编译后**被擦除**，运行的是纯 JS。所以"运行时拿不到类型"——这正是项目要用 **Zod** 的原因（第 4 章）。

---

## 第 1 章：这个项目在干什么（30 秒全景）

BanGD 是一个 GitHub PR 评审机器人：PR 一开，它拉取代码 diff，发给大模型（Claude/DeepSeek），让模型以"资深数据库内核工程师"的身份给出架构级评审，再把结果贴回 PR。

**一次评审的数据流**（记住这条链，全项目都围着它转）：

```
GitHub PR 事件
  → action.ts（入口，读取配置）
    → 组装上下文（diff + PR 信息 + 提示词）
      → 调用大模型（要求按固定 JSON 结构返回）
        → 用 Zod 校验返回的 JSON
          → 渲染成 Markdown
            → 通过 GitHub API 贴评论
```

---

## 第 2 章：设计步骤（我们实际是怎么一步步搭的）

这也是你自己从零搭一个类似项目的推荐顺序：

1. **技术选型**：定语言（TS）、形态（GitHub Action）、模型（Claude，可配置）。
2. **写提示词资产**（`prompts/`）：人设 + 评审 rubric + few-shot 范例。**这是垂类项目最值钱的部分**，先于代码。
3. **搭工程脚手架**：`package.json` / `tsconfig.json` / eslint / 测试框架。
4. **写核心逻辑 `core/`**：与"怎么触发""用哪个模型"完全无关的纯逻辑。
5. **写外壳 `shell/`**：把 core 接到真实的 GitHub 和 Anthropic 上。
6. **打包**：用 ncc 打成单文件 `dist/`，GitHub Action 跑的是它。
7. **验证**：单元测试 + 真实 PR 跑一次。

**为什么是这个顺序**？因为第 4 步的 core 不依赖第 5 步的任何东西（这叫依赖倒置），所以可以先把核心逻辑和测试写完、跑通，再去接真实世界。

---

## 第 3 章：技术选型逐个讲（每个都对照 Go）

### TypeScript（语言）
- **为什么不用 Go**？被评审的 BanDB 虽是 Go，但评审工具读 Go 代码的能力取决于大模型，跟工具自身语言无关。选 TS 是因为目标形态是 GitHub Action / 未来的 GitHub App，这条生态里 TS 是一等公民。

### npm + package.json（依赖与脚本）≈ go.mod + Makefile
```jsonc
{
  "type": "module",        // 用 ESM 模块系统（现代标准），见第 6 章
  "scripts": {             // ≈ Makefile 的 target，用 `npm run <名>` 执行
    "test": "vitest run",
    "build:action": "ncc build src/shell/action.ts -o dist ..."
  },
  "dependencies": { ... },     // 运行时依赖
  "devDependencies": { ... }   // 仅开发期需要（编译器、测试、linter）
}
```
`dependencies` vs `devDependencies` 的区分 Go 没有（Go 不分）。

### tsc（编译器）+ 严格模式 ≈ Go 编译器但可调严格度
`tsconfig.json` 里我们把严格选项全开了：
- `strict: true`：总开关。
- `noUncheckedIndexedAccess`：访问 `arr[i]` 时类型自动带上 `| undefined`，逼你判空——Go 里数组越界是 panic，这里编译期就拦你。
- `exactOptionalPropertyTypes`：可选字段语义更精确（见第 5 章的条件展开）。

### Zod（运行时校验库）≈ Go 的 validator + 手写校验，但更强
Go 里你有 struct，反序列化 JSON 后类型是确定的。TS 不行——类型编译后擦除，从网络拿到的 JSON 运行时就是个 `unknown`。Zod 让你**定义一次 schema，既生成编译期类型、又做运行时校验**。这是 TS 生态解决"运行时类型安全"的标准答案。详见第 4 章。

### ncc（打包器）≈ go build 出静态单文件
Go `go build` 直接出一个自带所有依赖的二进制。Node 默认不行——它运行时要去 `node_modules` 找几百个依赖目录。GitHub Action 不会帮你 `npm install`，所以我们用 `ncc` 把所有源码 + 依赖**打成一个 `dist/index.js`**，提交进仓库。这就是 Go 单二进制的等价物。

### eslint ≈ golangci-lint
我们配了一条关键规则：`@typescript-eslint/no-explicit-any: 'error'`——**禁用 `any`**（第 6 章解释为什么）。

### vitest ≈ Go 的 `testing` 包 + `go test`
测试文件命名 `*.test.ts`，`npm test` 运行。

---

## 第 4 章：核心概念精读 —— Zod 与类型（`src/core/schema.ts`）

这是整个项目最该理解的一章。

```typescript
import { z } from 'zod';

// 1. 定义一个枚举 schema
export const SeveritySchema = z.enum(['阻塞', '重要', '建议']);

// 2. 从 schema "推导"出 TS 类型
export type Severity = z.infer<typeof SeveritySchema>;
//   => 等价于 type Severity = '阻塞' | '重要' | '建议'
```

**逐行拆解（Go 视角）**：

- `import { z } from 'zod'`：≈ Go 的 `import "github.com/.../zod"`，但 TS 用花括号做**具名导入**（只导入 `z` 这个导出）。
- `z.enum([...])`：定义一个"值只能是这三个字符串之一"的 schema。
- `export type Severity = z.infer<typeof SeveritySchema>`：**这行是 TS 的精髓**。
  - `typeof SeveritySchema`：拿到这个 schema 变量的**类型**（不是值）。TS 里 `typeof` 用在类型位置，意思是"这个值的类型"。
  - `z.infer<...>`：泛型，从 schema 推出对应的 TS 类型。`<>` 是泛型参数，和 Go 1.18+ 的 `[T any]` 一个意思。
  - 结果：`Severity` 这个类型 = 这三个字符串字面量的联合。**联合类型（`A | B`）Go 没有**——Go 你得用 iota 常量或 interface。

再看对象 schema：
```typescript
export const FindingSchema = z.object({
  file: z.string().min(1),          // 非空字符串
  line: z.number().int().nullable(),// 整数，或 null（≈ Go 的 *int）
  severity: SeveritySchema,         // 复用上面的枚举
  // ...
});
export type Finding = z.infer<typeof FindingSchema>;  // 又一次：schema → 类型
```

**为什么这么设计**？因为后面 `review.ts` 里有这么一行：
```typescript
return ReviewResultSchema.parse(raw);  // raw 是模型返回的 unknown
```
`.parse()` 在**运行时**校验 `raw` 符不符合 schema：符合就返回带类型的对象，不符合就抛异常。这一步把"大模型可能乱返回"的风险挡在边界外。**一处定义（schema），两处受益（编译期类型 + 运行时校验）**——这是 Go 做不到的（Go 的类型和校验是分开的两件事）。

### `as const`（顺带一个语法点）
```typescript
export const reviewResultJsonSchema = { type: 'object', ... } as const;
```
`as const` 告诉 TS"这个对象是只读字面量，别把 `type: 'object'` 宽化成 `type: string`"。≈ Go 里你想表达"这是个编译期常量结构"。

---

## 第 5 章：接口、依赖注入、类（`ports.ts` / `review.ts` / `llm.ts`）

### 5.1 接口 ≈ Go 接口（这块你最熟）

`src/core/ports.ts`：
```typescript
export interface LlmClient {
  generateStructured(request: LlmRequest): Promise<unknown>;
}

export interface PrContext {
  readonly metadata: PrMetadata;
  getDiff(): Promise<string>;
  readFile(path: string): Promise<string | null>;
}
```
- 和 Go 接口几乎一样：定义方法签名，谁实现了这些方法谁就满足这个接口（**结构化/鸭子类型，跟 Go 一致**，不需要像 Java 那样 `implements` 声明——虽然 TS 也允许写 `implements`）。
- `Promise<unknown>`：见第 6 章，≈"未来会返回一个 unknown 的异步结果"。
- `string | null`：联合类型，≈ Go 的 `*string`（可能没有）。
- `readonly`：字段只读，≈ Go 里你不希望被改的字段（但 Go 没有语言级 readonly）。

### 5.2 依赖注入 ——本项目的灵魂（和你 Go 里的做法一模一样）

`src/core/review.ts`：
```typescript
export interface ReviewDeps {
  llm: LlmClient;
  pr: PrContext;
}

export async function review(deps: ReviewDeps, prompts: PromptTexts): Promise<ReviewResult> {
  const diff = await deps.pr.getDiff();              // 拿 diff
  const system = assembleSystemPrompt(prompts);      // 组装提示词
  const user = assembleUserPrompt(deps.pr.metadata, diff);
  const raw = await deps.llm.generateStructured({ system, user, outputSchema: ... });
  return ReviewResultSchema.parse(raw);              // 校验后返回
}
```
- `review` 不知道 `llm` 到底是 Claude 还是 DeepSeek，也不知道 `pr` 是 GitHub 还是别的——它只认接口。**这就是你在 Go 里常做的：函数收 interface，不收具体实现。**
- 好处和 Go 里一样：测试时塞个假的 `LlmClient`（返回写死的数据），不用真连网络。
- `async function ... : Promise<ReviewResult>`：这是个异步函数，返回 `Promise`（见第 6 章）。
- `await deps.pr.getDiff()`：等异步操作完成再继续，**写起来像同步代码**。

### 5.3 类（`class`）≈ Go 的 struct + 方法

`src/shell/llm.ts`：
```typescript
export class AnthropicLlmClient implements LlmClient {
  private readonly client: Anthropic;     // 私有字段，≈ Go 小写字段
  private readonly model: string;

  constructor(options: AnthropicLlmOptions) {  // 构造函数 ≈ Go 的 NewXxx()
    this.client = new Anthropic({ apiKey: options.apiKey });
    this.model = options.model ?? 'claude-opus-4-8';  // ?? 见下
  }

  async generateStructured(request: LlmRequest): Promise<unknown> {
    // ...实现接口方法
  }
}
```
- `class ... implements LlmClient`：声明这个类实现了 `LlmClient` 接口。Go 里你不写 `implements`，但效果一样；TS 写出来是为了让编译器帮你检查"方法是不是都实现全了"。
- `private readonly`：私有 + 只读字段。Go 用首字母小写表私有，没有 readonly。
- `constructor`：构造函数。`new AnthropicLlmClient({...})` 时调用。≈ 你 Go 里的 `func NewAnthropicLlmClient(...) *AnthropicLlmClient`。
- `this.xxx`：≈ Go 方法里的接收者 `c.xxx`（只是 TS 固定叫 `this`）。
- `options.model ?? 'claude-opus-4-8'`：**空值合并运算符**。如果 `options.model` 是 `null`/`undefined`，就用右边的默认值。≈ Go 里 `if model == "" { model = "默认" }`。

---

## 第 6 章：Go 程序员最容易卡的 4 个 TS 语法专题

### 6.1 `null` / `undefined` 与严格判空 ≈ Go 的 nil 但更狠

TS 有两个"空"：`null`（显式的空）和 `undefined`（没赋值/不存在）。严格模式下，一个 `string` 类型**不能**是 null，想表达"可能没有"必须写 `string | null` 或 `string | undefined`。

```typescript
readFile(path: string): Promise<string | null>   // 明确说"可能返回 null"
```
拿到后必须判空才能用，否则编译器报错——就像 Go 逼你 `if err != nil`，这里逼你处理空值。

### 6.2 `async` / `await` / `Promise` ≈ 不是 goroutine！

这是和 Go **最不同**的地方，务必转过弯：

- Go：并发靠 goroutine + channel，多个 goroutine 真并行。
- Node/TS：**单线程事件循环**。`async` 函数返回一个 `Promise`（≈"一个将来才有结果的盒子"）。`await` 表示"卡在这里等盒子出结果，期间让出 CPU 给别的任务"。

```typescript
const diff = await deps.pr.getDiff();  // 等 getDiff 这个异步操作完成
```
- 你**不用**手动开 goroutine、不用 channel。`await` 让异步代码写得像同步。
- 心智模型：`Promise<T>` ≈ "一个承诺，将来会给你一个 `T`"。`await` 把承诺兑现成 `T`。
- 类比 Go：有点像 `result := <-ch`（从 channel 取值会阻塞），但底层是单线程协作式调度，不是抢占式并行。

### 6.3 `unknown` vs `any` ≈ `interface{}` 的安全版与危险版

- `any`：关掉类型检查，想怎么用怎么用——**等于 Go 的 `interface{}` 然后到处强转，本项目用 eslint 禁用它**。
- `unknown`：也是"任何类型"，但**用之前必须先收窄/校验**，否则编译器不让你碰它的属性。

```typescript
generateStructured(request: LlmRequest): Promise<unknown>  // 模型返回的，先当 unknown
// ...
return ReviewResultSchema.parse(raw);  // 用 Zod 校验后，才变成有类型的 ReviewResult
```
为什么这么设计：模型返回什么我们运行时不敢信，所以先 `unknown`，强制走 Zod 校验这道关，校验通过才获得类型。**这是"不信任外部输入"在类型层面的体现**，比 Go 的 `interface{}` + 类型断言更安全（Go 的断言失败是运行时 panic，这里是编译期就逼你处理）。

### 6.4 模块系统：`import`/`export` 和那个诡异的 `.js` 后缀

```typescript
import { review } from './core/review.js';   // 注意：import 的是 .js！
```
- `export` / `import { 名字 }`：具名导出/导入，≈ Go 的大写导出 + import 包。
- **为什么 import `.ts` 文件却写 `.js`**？这是 ESM 规范的要求：源码是 `review.ts`，但编译成 JS 后是 `review.js`，运行时找的是 `.js`。所以**写 import 时就写最终的 `.js` 后缀**。刚开始会觉得别扭，记住"写 .js 就对了"即可。
- `import * as core from '@actions/core'`：把整个模块当作 `core` 命名空间导入，≈ Go 的 `import "fmt"` 然后 `fmt.Println`。

### 6.5 顺带几个小语法

```typescript
// 模板字符串（反引号），≈ Go 的 fmt.Sprintf 但更直观
`${metadata.title} 有 ${count} 条`     // 直接把变量塞进字符串

// 箭头函数（匿名函数），≈ Go 的 func(){}
const files = entries.filter((name) => name.endsWith('.md'));
//                            ^^^^^^^^^^^^^^^^^^^^^^^^^^^^ 这是个匿名函数

// 条件展开（满足 exactOptionalPropertyTypes 的技巧）
new AnthropicLlmClient({ apiKey, ...(model ? { model } : {}) });
//   如果 model 有值，就展开出 model 字段；没有就展开空对象 {}。
//   ≈ Go 里 if model != "" 才设置这个字段
```

`Record<K, V>` 类型（`format.ts` 里）：
```typescript
const SEVERITY_EMOJI: Record<Finding['severity'], string> = { 阻塞: '🛑', ... };
//  Record<K,V> ≈ Go 的 map[K]V，但这里 K 是那三个字面量，编译器会检查你三个都填了
```

---

## 第 7 章：把各文件对到功能上（按数据流读）

| 文件 | 在数据流的哪一步 | 对应 Go 你会怎么写 |
|---|---|---|
| `src/shell/action.ts` | 入口：读配置、串起全流程、发评论 | `main.go` |
| `src/core/prompt.ts` | 组装系统/用户提示词（纯函数） | 一个无副作用的 util 包 |
| `src/core/review.ts` | 编排：拿 diff → 调模型 → 校验 | service 层 |
| `src/core/schema.ts` | 定义数据结构 + 校验规则 | `types.go` + validator |
| `src/core/ports.ts` | 定义两个接口（注入点） | `interfaces.go` |
| `src/shell/llm.ts` | 接口实现：真的调 Anthropic/DeepSeek | 一个 client 实现 |
| `src/shell/github.ts` | 接口实现：真的调 GitHub API | 一个 repo/client 实现 |
| `src/shell/format.ts` | 把结果渲染成 Markdown（纯函数） | 一个 formatter |
| `src/shell/prompts.ts` | 从磁盘读 prompts/*.md | 读配置文件 |
| `src/smoke.ts` | 手动端到端冒烟跑一次 | 一个 `main` 里的临时调试入口 |

**core/ 与 shell/ 的分界**：core 不碰网络、不碰文件系统、不知道 GitHub 存在；shell 负责所有"脏活"（IO、网络）。这就是为什么 core 能用假实现做纯单测。

---

## 第 8 章：动手练习（建议顺序）

1. **跑起来**：`npm install` → `npm test`（看 12 个测试怎么用假实现测 core）→ 读 `src/core/review.test.ts`，这是理解 DI 的最佳入口。
2. **改一个纯函数**：去 `format.ts` 改改 Markdown 输出格式，跑 `npm test` 看 `format.test.ts` 红/绿。
3. **加一个枚举值**：给 `FindingTypeSchema` 加一个类型（比如 `'缓存'`），看编译器会逼你在哪些地方补全——体会"一处定义，处处约束"。
4. **看类型擦除**：`npm run build` 后去 `build/` 看编译出的 `.js`，你会发现类型全没了，只剩纯 JS——印证第 0 章那句话。
5. **读一遍数据流**：从 `action.ts` 的 `run()` 开始，顺着 `review()` 一路读到 `llm.ts`，对照第 1 章那条链。

---

## 一句话总结

如果你只带走一件事：**这个项目的骨架 = Go 你最熟的"接口注入解耦" + TS 特有的"Zod 让类型在运行时也可信"**。前者你已经会了，后者是 TS 相对 Go 的主要新增心智负担，吃透第 4 章和第 6 章就过关了。
