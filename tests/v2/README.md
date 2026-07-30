# V2 测试路由

历史 `wave*` 名称保留为兼容 alias，实际编排由
`scripts/v2-suite-manifest.js` 声明，并由 `scripts/run-v2-suite.js` 串行执行。
同一 worktree 的 `.tmp/v2-core` 与 `dist` 是共享产物，禁止并行运行 build/test。

## 改动域到 targeted suite

| 改动域 | 最小命令 | 主要覆盖 |
| --- | --- | --- |
| lexer、token、方言词法 | `npm run test:v2:wave1` | lossless、语料契约、lexer scale |
| CST、parser、recovery、analysis | `npm run test:v2:wave2` | syntax registry、invariant、fuzz、support matrix、parser scale |
| layout、renderer、alignment、format kernel | `npm run test:v2:wave3` | Layout IR、resource closure、属性测试、operation counts |
| transaction、source map、worker、DDL | `npm run test:v2:wave4` | public API、原子事务、executor、worker lifecycle、DDL |
| VS Code host、runtime artifact、package/release | `npm run test:v2:wave5` | bundle activation、adapter、corpus、allowlist、clean package |
| package/build/test runner 本身 | `npm run test:v2:infrastructure` | build lock/cache/failure、single-build plan、manifest negative case |
| registry / support boundary | `npm run test:v2:support-matrix` | generated support matrix 与 `--check` |
| 所有公开回归 | `npm run test:verify` | 上述 suite 去重后按固定顺序执行 |

`test:verify` 的 prerequisites 固定为一次 typecheck、一次 current core build、一次
runtime build；可用下面的只读命令检查展开后的计划：

```bash
node scripts/run-v2-suite.js verify --plan --json
```

## 性能与 fuzz

PR 的主门是确定性 operation count、线性上限和宽松 disaster gate。严格 release-relative
墙钟只在 main、手动 workflow 或本地候选验证时运行：

```bash
npm run test:v2:performance-relative
```

它从 `tests/v2/perf-baseline.json` 读取唯一基线，并用当前项目本地 TypeScript 编译/缓存
release baseline；current 直接复用 canonical `.tmp/v2-core`。性能测试不比较跨版本格式化
文本 digest，布局行为由独立 token fingerprint 契约覆盖。

固定 fuzz corpus 始终进入 CI，也可在本地扩大探索；任何失败都会打印 seed 和 case index：

```bash
FUZZ_SEED=0x12345678 FUZZ_CASES=512 npm run test:v2:recovery
```

主 formatter 的 property fuzz 使用独立变量，最少 64 cases 才能完整覆盖四方言、四种左表达式与四种右表达式；
候选验证固定运行 20,000 cases：

```bash
FORMATTER_FUZZ_SEED=0x91e10da5 FORMATTER_FUZZ_CASES=20000 node tests/v2/wave3-properties.test.js
```

`scripts/profile-alignment-candidates.js` 与 `scripts/profile-source-map-memory.js` 用于诊断；
profile 中的绝对 timing/allocation 仅作观测，不作为严格 hosted wall-clock 判定。
