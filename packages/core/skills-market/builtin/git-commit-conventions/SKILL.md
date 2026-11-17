---
title: Git commit conventions
domain: git
tags: [git, workflow, commits]
---

# 何时使用

每次提交代码前，构造 commit message 时。

# 执行步骤

1. 选 type：
   - `feat`：新功能
   - `fix`：修复缺陷
   - `refactor`：不改变行为的内部重构
   - `perf`：性能优化（用户可感知）
   - `test`：只动测试
   - `docs`：只动文档/注释
   - `chore`：杂项（依赖/配置）
   - `ci`：CI/构建脚本
2. 第一行 `<type>: <imperative summary>`，≤72 字符，动词原形开头。
3. 留一个空行，写正文：**为什么**这样改、解决什么问题、副作用与权衡。
4. 引用相关 issue/PR / 关联资产（如 `[[skill:tdd-workflow]]`）。
5. 不在 commit message 里放 author 署名（全局已禁用）。

# 常见坑

- 把"做了什么"写进 summary → 缺乏意图，半年后看不懂。
- 一次 commit 改多件事 → 不可回滚、review 噪音大。
- "fix bug" / "update" 这种空话 summary。

# 检查清单

- [ ] type 正确
- [ ] summary 表达**意图**而非操作
- [ ] body 解释**为什么**
- [ ] 单一职责
- [ ] 通过 lint / typecheck / tests
