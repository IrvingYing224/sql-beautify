var assert = require('assert');
var childProcess = require('child_process');
var fs = require('fs');
var path = require('path');
var packageJson = require('../../package.json');

var root = path.join(__dirname, '..', '..');
var runtimePath = path.join(root, 'dist', 'v2-core.cjs');
var ddlRuntimePath = path.join(root, 'dist', 'v2-ddl.cjs');
var bridgePath = path.join(root, 'dist', 'v2-format-bridge.cjs');
var workerPath = path.join(root, 'dist', 'v2-worker.cjs');
var bridgeSourcePath = path.join(root, 'src', 'adapters', 'runtime', 'v2-format-bridge.ts');
var buildScript = path.join(root, 'scripts', 'build-v2-runtime.js');
var transactionSource = fs.readFileSync(
    path.join(root, 'src', 'adapters', 'transaction', 'prepare.ts'),
    'utf8'
);
var ddlTransactionSource = fs.readFileSync(
    path.join(root, 'src', 'adapters', 'transaction', 'experimental-ddl.ts'),
    'utf8'
);
var directExecutorSource = fs.readFileSync(
    path.join(root, 'src', 'adapters', 'executor', 'direct.ts'),
    'utf8'
);

assert.ok(fs.existsSync(runtimePath), 'Wave 4 must provide a production v2 runtime');
assert.ok(fs.existsSync(ddlRuntimePath), 'Wave 4 must provide an experimental DDL runtime');
assert.ok(fs.existsSync(bridgePath), 'Wave 4 must provide a host-neutral v2 bridge');
assert.ok(fs.existsSync(workerPath), 'Wave 4 must provide a persistent worker runtime');
assert.ok(fs.existsSync(bridgeSourcePath), 'v2 bridge source must live under src/adapters');
assert.ok(!fs.existsSync(path.join(root, 'lib', 'runtime', 'v2-core.js')),
    'v2 runtime artifact must not reintroduce lib as a source/output boundary');
assert.ok(!fs.existsSync(path.join(root, 'lib', 'adapters', 'v2-format-bridge.js')),
    'v2 bridge source must not reintroduce a lib adapter authority');
assert.ok(fs.existsSync(buildScript), 'Wave 4 must provide a reproducible runtime build script');
assert.ok(packageJson.scripts['build:v2-runtime'], 'package scripts must expose v2 runtime build');
assert.ok(packageJson.scripts['test:v2:wave4'], 'package scripts must expose Wave 4 tests');
assert.ok(packageJson.scripts['package:vsix'].indexOf('build:v2-runtime') >= 0,
    'VSIX packaging must build the production v2 runtime');

var vscodeIgnore = fs.readFileSync(path.join(root, '.vscodeignore'), 'utf8');
assert.ok(/(?:^|\n)src\/\*\*/.test(vscodeIgnore), 'VSIX must exclude v2 TypeScript sources');
assert.ok(/(?:^|\n)\.tmp\/\*\*/.test(vscodeIgnore), 'VSIX must exclude development .tmp output');
assert.ok(!/(?:^|\n)dist\/\*\*/.test(vscodeIgnore), 'VSIX must include production runtime');

var packagedFiles = childProcess.execFileSync(
    process.execPath,
    [require.resolve('@vscode/vsce/vsce'), 'ls'],
    { cwd: root, encoding: 'utf8' }
).split(/\r?\n/).filter(Boolean);
assert.ok(packagedFiles.indexOf('dist/v2-core.cjs') >= 0,
    'VSIX manifest must include the v2 core runtime');
assert.ok(packagedFiles.indexOf('dist/v2-ddl.cjs') >= 0,
    'VSIX manifest must include the experimental DDL runtime');
assert.ok(packagedFiles.indexOf('dist/v2-format-bridge.cjs') >= 0,
    'VSIX manifest must include the v2 adapter bridge');
assert.ok(packagedFiles.indexOf('dist/v2-worker.cjs') >= 0,
    'VSIX manifest must include the v2 worker runtime');
assert.strictEqual(packagedFiles.some(function(file) {
    return /^dist\/.*\.tmp$/.test(file);
}), false, 'VSIX manifest must exclude temporary runtime artifacts');

var runtimeSource = fs.readFileSync(runtimePath, 'utf8');
var ddlRuntimeSource = fs.readFileSync(ddlRuntimePath, 'utf8');
var workerSource = fs.readFileSync(workerPath, 'utf8');
var bridgeSource = fs.readFileSync(bridgeSourcePath, 'utf8');
assert.ok(runtimeSource.indexOf("require('typescript')") < 0, 'runtime must not require TypeScript');
assert.ok(runtimeSource.indexOf('dt-sql-parser') < 0, 'runtime must not bundle evaluation parser');
assert.ok(workerSource.indexOf('dt-sql-parser') < 0, 'worker must not bundle evaluation parser');
assert.ok(workerSource.indexOf('formatSqlWithStatistics') < 0,
    'worker entry must load the shared runtime instead of bundling formatter core');
assert.ok(ddlRuntimeSource.indexOf('dt-sql-parser') < 0,
    'experimental DDL runtime must not bundle the rejected evaluation parser');
assert.ok(ddlRuntimeSource.indexOf("require('typescript')") < 0,
    'experimental DDL runtime must not require TypeScript');
assert.ok(!/from\s+["'][^"']*lib\//.test(
    transactionSource + ddlTransactionSource + directExecutorSource + bridgeSource
),
    'v2 adapter sources must not import the 1.x CommonJS runtime');
assert.ok(!/from\s+["']vscode["']/.test(
    transactionSource + ddlTransactionSource + directExecutorSource + bridgeSource
),
    'host-neutral transaction/executor sources must not import vscode');

var experimentalSources = fs.readdirSync(path.join(root, 'src', 'experimental', 'ddl'))
    .filter(function(file) { return file.endsWith('.ts'); })
    .map(function(file) {
        return fs.readFileSync(path.join(root, 'src', 'experimental', 'ddl', file), 'utf8');
    }).join('\n');
assert.ok(!/from\s+["'][^"']*adapters\//.test(experimentalSources),
    'experimental DDL must not import adapter transaction or host code');
assert.ok(!/from\s+["'][^"']*vscode["']/.test(experimentalSources),
    'experimental DDL must remain host-neutral');

console.log('wave4 boundary tests passed');
