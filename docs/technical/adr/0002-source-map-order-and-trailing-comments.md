# ADR 0002: 保持 source-map 双单调并局部降级 trailing comma

- 状态：Accepted
- 日期：2026-07-26
- 目标版本：3.0.0

## 背景

当 `commaStyle=trailing` 且 SELECT list item 后存在行尾注释时，source 顺序是
`item → comment → comma`，理想显示顺序却是 `item → comma → comment`。当前 renderer、
source-map、selection mapping、alignment 和 token-equivalence 都要求 source-derived emission
保持原 source 顺序；直接交换注释与逗号会同时违反 source-map 双单调和 token 顺序等价契约。

## 决策

保持 source/output 双单调与现有 token-equivalence 不变。仅在单个 separator boundary 检测到
左 item 与 separator 之间有 line comment 时，把该 boundary 局部降级为 leading comma；
同一 list 中没有冲突的 boundary 继续遵循用户选择的 trailing style。block comment 不触发降级。

## 被拒绝的方案

本次不实现非单调 source run。该方案不仅要改变 source-map validation，还必须重新设计：

- generated gap 的 cursor affinity 与跨重排 selection mapping；
- transaction 中多个 target source map 的组合；
- alignment 依赖的有序 source-map lookup；
- token-equivalence 对受证明 separator/comment permutation 的许可机制；
- direct/worker boundary snapshot 与公开 `SourceMap` 契约。

不能把 token comparison 放宽成 multiset；那会允许真实 SQL token 重排越过安全门。

## 后果

输出在冲突 boundary 上不是纯 trailing style，但保持 lossless、幂等、可解释且能继续使用现有
source-map/selection 证明。只有真实用户证据表明局部降级不可接受，并且新设计能为上述五项给出
完整证明时，才允许另起 ADR 重新考虑非单调 source run。
