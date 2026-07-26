# ADR 0003：alignment 第二遍限定到候选 list item

状态：接受

日期：2026-07-26

## 背景

alignment 必须依赖第一次 render 的真实行列，不能提前到纯 Layout IR 阶段。旧实现只在入口用
`hasPotentialAlignmentGroup` 排除完全没有连续 alias/comment 的文档；一旦结构上命中，就会为全部
node、leaf 和 source-map entry 建 projection。大型查询只在两个 list item 上可能对齐时，第二遍仍按
完整文档规模工作；结构候选最后因多行表达式失效的 false-positive 也支付同样成本。

本决策不改变第二遍、source-map 双单调契约、display-width 计算或 alignment target 语义。

## 决策

先按 CST list item 收集长度至少为 2 的连续显式 `AS` 或单 trailing comment run，只保留这些 run
涉及的 item。后续阶段限定为：

- comment owner 通过 structural index 的 parent facts 解析到最近 list item，不遍历全部 node；
- 合并候选 item leaf range 和候选 comment leaf，只对这些 range 二分定位 source-map entry；
- `outputLineStarts` 仍对完整输出做一次线性扫描；候选 output offset 的 display column 只在所在行计算；
- item shape 直接从候选 item 的可证明 leaf range 构造，不再建立全 node projection；
- dominating verbatim claims 继续使用既有 canonical cache，候选 item 用按 claim end 二分的 overlap 查询；
- alignment target 使用稀疏 map，最终按 leaf id 排序，保持旧实现的 target 顺序。

没有连续结构候选时仍直接返回 canonical empty plan。密集候选会退化为完整线性工作，不增加输入拒绝
条件，也不引入第二套生产 alignment 实现。

## 等价性证据

`scripts/profile-alignment-candidates.js` 同时加载基线提交 `58ffaa5` 和候选 build，对 Wave 3 的完整
68-case corpus（含当时公开 production corpus）、128 个确定性 fuzz、48 个确定性 malformed case 和
12 个 alignment option matrix case 比较：

- 256/256 case 的 analysis 状态、alignment targets 与完整 `FormatResult` 逐项相等；
- 其中 14 个 case 实际产生 target，共 22 个 target；
- 另对下述三类 2,000-item 性能样本先独立断言 target 逐项相等。

复现命令（`--baseline-root` 指向基线的 `.tmp/v2-core` build）：

```bash
node scripts/profile-alignment-candidates.js \
    --baseline-root /path/to/baseline/.tmp/v2-core \
    --candidate-root "$PWD/.tmp/v2-core"
```

既有 `wave3e-alignment-options`、完整 Wave 3 properties 与 alignment performance regression 同时通过。

## 性能证据

Apple M1 Pro、Node v24.18.0；每类预热 25 次，15 个 sample，每个 sample 20 次 derive，记录每次
alignment derive 的中位数。两个独立进程测量结果稳定：

| 样本 | target | 基线中位数 | 候选实现中位数 | 候选/基线 |
| --- | ---: | ---: | ---: | ---: |
| 6,044 leaves，稀疏结构命中但无有效 target | 0 | 14.40–14.44 ms | 0.539 ms | 3.73–3.74% |
| 6,012 leaves，稀疏真实 target | 1 | 14.30–14.33 ms | 0.447–0.448 ms | 3.12–3.13% |
| 14,004 leaves，密集真实 target | 1,000 | 49.14–49.16 ms | 50.78–50.83 ms | 103.28–103.44% |

稀疏两类均有稳定阶段收益；密集最坏样本约回退 3.4%，没有改变渐进复杂度。由于真实大型查询的
审计问题是稀疏/false-positive 全局投影，这个取舍被接受。测试另外用 1,200-item 三类样本设置
current-only 回归门：两类稀疏阶段中位数都必须小于密集阶段的 20%，不能用候选 leaf 比例替代耗时证据。

## 后果与重新评估条件

- 新 node kind 若改变 list-item leaf-range containment，必须先通过 node invariant registry，再更新
  alignment 等价性 profile；不能在 alignment 中猜测 ownership。
- source-map wire shape 或 display-width 算法变化时重新运行双 build profile。
- 若密集 workload 在真实 production corpus 中占主导且回退超过噪声范围，再评估 Map/排序的机械优化；
  不以此为理由放宽 source-map 或关闭第二遍。
