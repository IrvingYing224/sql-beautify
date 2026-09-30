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
| 真实 VS Code 宿主 | `npm run test:vscode-smoke` | 真实格式化命令、多选原子性、undo、诊断、CRLF、worker 取消 |

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

## 私有生产语料

`SQL_BEAUTIFY_CORPUS_DIR=/absolute/path npm run test:production-private`
读取指定目录的 `.sql` 和可选同名 `.options.json`。默认每条必须得到
`formatted` 或 `unchanged`，再验证 token 保真、幂等和换行边界。
需要有意保留的输入可使用同名 `foo.expected.json`。例如 `CREATE TABLE` 配合
`foo.options.json` 中的 `unsupportedSyntaxPolicy: "bail_out"`：

```json
{ "status": "preserved", "codes": ["SYN_UNSUPPORTED_STATEMENT", "FMT_UNSUPPORTED_BAIL_OUT"] }
```

状态和 codes 必须与当前输入及选项的预期精确一致；不允许声明 `failed`，内部错误、
契约破坏或 error 诊断始终失败。运行器汇总状态、诊断码和失败 caseIndex，避免输出私有
SQL、文件路径或底层异常详情。公开模拟契约门会故意注入整批失败，确保安全回退不能冒充可用性通过。

## 真实宿主测试

测试使用 `@vscode/test-electron` 的独立 Extension Development Host，缓存、workspace、
设置和扩展目录均在 `.tmp/vscode-smoke`；不会使用个人配置。首次下载需要网络。
`SQL_BEAUTIFY_VSCODE_VERSION=1.90.0` 指定最低版本，默认 `stable`；也可通过
`SQL_BEAUTIFY_VSCODE_EXECUTABLE=/absolute/path/to/executable` 复用已安装的可执行文件。
Linux 无显示环境时使用 `xvfb-run -a npm run test:vscode-smoke`。

此门独立于不下载宿主的 `test:verify`，CI 对 `1.90.0` 和 `stable` 都要求通过。
取消测试使用真实 `CancellationTokenSource` 与生产 worker 事务；没有模拟点击通知栏的取消按钮。
发布打包仍要求 PATH 中存在 `zip` / `unzip`；Node 编排消除了 shell 版本插值，Windows 宿主
和 ZIP 工具兼容性仍需在对应平台运行验证。
