# 实现记录

## R3 并发回归封板（v5）

> 日期: 2026-02-28 | 状态: **封板通过**

### 覆盖范围

| 阶段 | 场景 | 断言数 |
|------|------|--------|
| Phase 1 | 冷启动并发 batch×2，去重 + 精确计数 | 2 |
| Phase 2 | generating 下 batch + single POST 冲击（6 采样点单调） | 5 |
| Phase 3 | gap-hunting：20轮×3并发=60 请求，打 `_batch_inflight` 空窗 | 3 |
| Phase 4 | 热态 recover+batch 部分重叠（vid 已在队列） | 3 |
| Phase 5 | **冷态** partial-overlap + fresh-failed（重启后端清内存，重叠 vid 双方都有资格入队） | 5 |

### 结果

**18/18 断言全部通过**

关键证据：
- Phase 3：60 次请求，20/20 轮有效冲击（存在 generating vid），零击穿
- Phase 5：`[23,31]` vs `[31,40]` 并发，重叠 vid=31 恰好一方入队，总数精确 3

### 证据路径

```
execution/reports/artifacts/concurrent_recover_regression_20260228T144727Z.json
execution/reports/artifacts/concurrent_recover_test.py
```

### 非阻塞未覆盖风险

| # | 风险 | 说明 |
|---|------|------|
| 1 | 服务重启中途队列丢失 | 进程内存队列无持久化，与原始 `create_task` 行为一致，非回归 |
| 2 | 超大批量（>100 vid）并发入队锁争用 | 功能正确性已覆盖，属压测范畴 |
