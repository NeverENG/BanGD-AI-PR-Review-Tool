## 资源与泄漏 (Resource Management)

**触发信号**：goroutine 启动、文件句柄、连接、`defer Close`、context 取消、后台循环。

**该追问的架构问题**
- 每个新 goroutine / 句柄 / 连接是否都有明确的退出/释放路径？关停时是否优雅退出？
- context 取消是否被正确传播？后台循环是否可能泄漏？
