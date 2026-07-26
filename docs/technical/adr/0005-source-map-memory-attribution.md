# ADR 0005：保留 source-map 形状并建立内存归因基线

状态：接受

日期：2026-07-26

## 背景

公开 `FormatResult.sourceMap` 是 range/multi-selection 恢复、worker structured clone 和 adapter
安全校验共同依赖的边界。审计发现大型 list 会生成大量 source-map entry，但此前没有把 source map、
analysis index、layout artifact、renderer 临时对象与 structured clone 的成本分开测量。仅凭 entry 数量
无法证明 source map 是峰值内存主因，也不足以安全地设计 compact wire 或拒绝既有合法输入的 entry budget。

source/output 双单调和完整边界校验是正确性契约，不能作为性能调参项放宽。

## 方法

`scripts/profile-source-map-memory.js` 为每个样本启动独立 `node --expose-gc` 进程，通过 inspector
Sampling Heap Profiler 和显式 major GC 分阶段记录：

- analysis、layout/compile、render 的 retained heap 与 sampled allocation；
- 释放 analysis/layout/render 引用后，仅 output + source map 的 retained heap；
- source map 单独 structured clone、完整 `FormatResult` clone 的 9 次中位时间与 retained heap；
- structural index snapshot 与 source map 的 V8 serialized bytes、entry 数和独立进程 maxRSS。

测量用于归因和宽松增长门，不把 sampling profile 当作精确对象所有权证明。V8 heap、JIT、allocator
page retention 和 GC 时机都会造成噪声；`output + source map` retained delta 也包含模块/runtime 常驻状态。
因此结论只接受跨不同结构样本重复出现的数量级差异，不从单次 heap delta 推导拒绝阈值。

## 证据

Apple M1 Pro、Node v24.18.0；每行是独立进程。clone 取预热后 9 次中位数：

| 样本 | source units / leaves | map entries / serialized | analysis retained | output + map retained | map clone retained / median | maxRSS |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1,000-item list | 11,902 / 3,004 | 2,002 / 176,134 B | 3,076,024 B | 2,713,432 B | 378,408 B / 2.45 ms | 83,040 KiB |
| 4,000-item list | 50,902 / 12,004 | 8,002 / 704,134 B | 7,999,584 B | 5,106,968 B | 1,437,544 B / 9.15 ms | 138,208 KiB |
| 50,000-char comment | 50,020 / 9 | 4 / 367 B | 720,016 B | 1,129,344 B | 28,728 B / 0.009 ms | 67,120 KiB |

list 从 1,000 增至 4,000 items 时，entry、serialized bytes、clone retained heap 与 clone 时间均近似
4 倍线性增长。相同 source 长度的 comment 几乎没有 map 成本，但 render sampled allocation 仍约
23.6 MB；list 的 analysis sampled allocation 为约 11.9–42.6 MB，render 热点主要位于
display-width/metrics，而不是 source-map freeze。source map 是大型 list 的显著常驻和传输成本，
但现有证据不能证明它是总体峰值内存主因。

## 决策

- 保持公开和 worker wire 的 source-map entry 形状、完整 source/output 双单调及边界验证不变；
- 本轮不实施 compact wire，不增加 source-map entry budget，也不因 entry 数拒绝 512 Ki code-unit
  上限内的合法输入；
- 把独立进程 profile 纳入长期 Wave 3 门：entry 数必须随输入线性增长，clone 时间使用宽松线性门，
  每个样本 maxRSS 必须低于 1.25 GiB；
- 完整热点明细默认保留给人工归因，`--summary` 为自动回归输出稳定、精简字段。

## 重新评估条件

只有 production/private corpus 或 heap snapshot 证明 source map 是 512 Ki 请求峰值内存的主导对象，
并且能从现有映射语义证明 compact encoding 的确定上界与无损解码时，才另立设计。该设计必须同时
覆盖 direct/worker 等价、structured-clone、range/multi-selection、伪造结果拒绝和双单调证明；不能
以降低 entry 数为由抽样校验或缩短 source span。
