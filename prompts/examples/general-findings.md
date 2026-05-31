# Few-shot 范例：普通代码级问题（generalFindings）

这是 `generalFindings` 的样板——**任何称职通用评审者都该发现的、有 diff 证据的确凿正确性缺陷**。它**不走**架构级 finding 的四段式：指出位置 + 普通修法即可。重点是示范**该报什么**与**绝不该报什么**（质量红线）。

---

## 输入（PR 改动节选）

PR 给 SSTable 迭代器的 `Seek` 改写了二分查找：

```go
func (it *Iterator) Seek(key []byte) {
    lo, hi := 0, len(it.entries)
    for lo < hi {
        mid := (lo + hi) / 2
        if bytes.Compare(it.entries[mid].key, key) < 0 {
            lo = mid          // 改动：原来是 lo = mid + 1
        } else {
            hi = mid
        }
    }
    it.pos = lo
}
```

---

## BanGD 的 generalFinding（普通问题，不走四段式）

- **file**：`sstable/iterator.go`
- **line**：6
- **severity**：阻塞
- **category**：逻辑错误
- **title**：二分查找 `lo = mid` 写错，下界不前进会死循环
- **description**：当 `bytes.Compare(entries[mid].key, key) < 0` 时把 `lo` 置为 `mid` 而非 `mid + 1`。一旦 `lo` 与 `mid` 相等（区间收窄到相邻两元素、且 `mid` 命中下界时），`lo` 不再前进，`lo < hi` 永远成立——`Seek` 进入**死循环**，热路径上的查询会挂死。diff 把原本的 `lo = mid + 1` 改成了 `lo = mid`，这就是引入点。
- **suggestion**：改回 `lo = mid + 1`。下界分支必须越过 `mid`，否则区间无法收敛。

---

## 反例：以下这些**绝不要**报成 generalFinding（否则 BanGD 沦为嘈杂的通用 linter）

- ❌「建议给 `mid` 的计算加一行注释说明」——这是注释/风格，不是缺陷。
- ❌「`lo`/`hi` 命名太短，建议改成 `low`/`high`」——命名 nit。
- ❌「建议为 `Seek` 补一个单元测试」——测试建议不属于 finding。
- ❌「`(lo + hi) / 2` 在超大切片下可能整型溢出」——若 diff 没有改动这一行、也没有证据表明 entries 规模会触及 `int` 上限，就是**无 diff 依据的臆测**，不报。
- ❌ 把它**同时**再写一遍架构级 finding——若某问题已作为架构 finding 报告，这里不重复。

**判据**：只报你能在 diff 里**指出具体出错行、并说清为什么错**的确凿正确性/逻辑问题；其余一律不报。没有就返回空数组 `[]`，不要硬凑。

> 边界提示：若问题不是"这一行写错了"，而是"这个数据结构在并发下的所有权模型有问题"，那它属于**架构级 finding**（四段式），不属于 generalFindings。generalFindings 只承接代码级的确凿 bug。
