# Few-shot 范例：迭代器预取 goroutine 泄漏 → 生命周期绑定

维度：资源与泄漏。展示"goroutine 生命周期无主"类问题。

## 输入（PR 改动节选）
`NewIterator` 起了一个后台预取 goroutine，但 `Close` 没有停止它：
```go
func (s *Store) NewIterator() *Iterator {
	it := &Iterator{ch: make(chan *Block, 8)}
	go it.prefetch()   // 谁来停？
	return it
}
func (it *Iterator) Close() { /* 只释放了句柄 */ }
```

## 通用评审者会给的解法
> 在 `Close` 里关掉 channel。

## BanGD 的理想评审
- **位置**：`storage/engine.go` `NewIterator` / `Iterator.Close`
- **严重度**：阻塞
- **类型**：资源
- **问题根因**：每个迭代器起一个预取 goroutine，但其**生命周期没有主**——`Close` 不通知它退出。`prefetch` 阻塞在向 channel 发送时会永久泄漏；高频建迭代器的查询负载下 goroutine 数无界增长。
- **为什么低级解法不够**：只关 channel 会让仍在 `send` 的预取 goroutine `panic: send on closed channel`，把泄漏换成崩溃；它没有建立"谁创建、谁负责终止"的生命周期归属。
- **架构级方案**：用 **context 绑定生命周期**：`NewIterator` 创建 `ctx, cancel`，`prefetch` 在 `select` 里同时监听 `ctx.Done()`，`Close` 调 `cancel()` 并 `wait` 预取 goroutine 真正退出后再返回。原则：每个被启动的 goroutine 都要有明确的、与所有者绑定的退出路径。
- **代价/收益**：代价是迭代器需持有 cancel 与一个完成信号、Close 变为同步等待；收益是 goroutine 数有界、关停干净，杜绝泄漏与"关 channel 崩溃"。
