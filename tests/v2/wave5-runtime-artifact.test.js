var assert = require('assert');
var crypto = require('crypto');
var fs = require('fs');
var path = require('path');

var root = path.join(__dirname, '..', '..');
var dist = path.join(root, 'dist');
var runtimePath = path.join(dist, 'runtime.cjs');
var formatterPath = path.join(dist, 'sql-formatter.cjs');
var ddlPath = path.join(dist, 'hive-ddl.cjs');
var workerPath = path.join(dist, 'formatter-worker.cjs');
var extensionPath = path.join(dist, 'extension.cjs');
var legacyBridgePath = path.join(dist, 'v2-format-bridge.cjs');
var runtimeSourcePath = path.join(root, 'src', 'runtime', 'internal.ts');

assert.ok(fs.existsSync(runtimePath), 'Wave 5 runtime artifact must be built');
assert.ok(fs.existsSync(formatterPath), 'Wave 5 public formatter facade must be built');
assert.ok(fs.existsSync(ddlPath), 'Wave 5 public DDL facade must be built');
assert.ok(fs.existsSync(workerPath), 'Wave 5 worker artifact must be built');
assert.ok(fs.existsSync(extensionPath), 'Wave 5 extension artifact must be built');
assert.strictEqual(fs.existsSync(legacyBridgePath), false,
    'Wave 5 build must delete the legacy format bridge artifact');

var runtime = require(runtimePath);
var formatter = require(formatterPath);
var ddl = require(ddlPath);

assert.deepStrictEqual(Object.keys(formatter).sort(), ['formatSql', 'lexSql'],
    'public formatter facade must expose only approved values');
assert.deepStrictEqual(Object.keys(ddl).sort(), ['extractDdl', 'formatHiveDdl'],
    'public DDL facade must expose only approved values');
[
    'formatSql', 'formatSqlTarget', 'executeFormatSql',
    'validateAndFormatTargets', 'lexSql', 'formatHiveDdl', 'extractDdl',
    'prepareFormatTransaction', 'resolveFormatOptions', 'runHostTransaction',
    'runExperimentalDdlTransaction', 'createProductionFormatterExecutor'
].forEach(function(name) {
    assert.strictEqual(typeof runtime[name], 'function',
        'internal runtime must expose host-neutral capability ' + name);
});
assert.strictEqual(formatter.formatSql, runtime.formatSql,
    'public formatter facade must delegate to shared runtime artifact');
assert.strictEqual(formatter.lexSql, runtime.lexSql,
    'public lexer facade must delegate to shared runtime artifact');
assert.strictEqual(ddl.formatHiveDdl, runtime.formatHiveDdl,
    'public DDL facade must delegate to shared runtime artifact');
assert.strictEqual(ddl.extractDdl, runtime.extractDdl,
    'public DDL facade must delegate to shared runtime artifact');
assert.ok(fs.statSync(formatterPath).size < fs.statSync(runtimePath).size / 4,
    'public formatter facade must not bundle a second formatter core');
assert.ok(fs.statSync(ddlPath).size < fs.statSync(runtimePath).size / 4,
    'public DDL facade must not bundle a second formatter core');
assert.ok(fs.statSync(extensionPath).size < fs.statSync(runtimePath).size / 4,
    'extension host wiring must not bundle a second formatter core');
assert.ok(fs.readFileSync(extensionPath, 'utf8').indexOf('runtime.cjs') >= 0,
    'extension host wiring must load the shared runtime artifact');
assert.ok(fs.readFileSync(runtimePath, 'utf8').indexOf('require("vscode")') < 0,
    'shared runtime must remain independent from the VS Code host module');
var runtimeSource = fs.readFileSync(runtimeSourcePath, 'utf8');
assert.ok(runtimeSource.indexOf('readFileSync(workerPath)') < 0,
    'worker artifact probing must not read the complete bundle into memory');
assert.ok(runtimeSource.indexOf('statSync(workerPath).isFile()') >= 0 &&
    runtimeSource.indexOf('accessSync(workerPath, constants.R_OK)') >= 0,
    'worker artifact probing must verify a readable regular file');

var directModule = require('../../.tmp/v2-core/adapters/executor/direct');
var runtimeDigest = crypto.createHash('sha256')
    .update(fs.readFileSync(runtimePath)).digest('hex');
assert.strictEqual(runtime.runtimeDigest, undefined,
    'runtime implementation must not expose mutable global digest state');
assert.strictEqual(runtimeDigest.length, 64);

async function main() {
    var calls = 0;
    var injected = new directModule.DirectFormatterExecutor(function(source) {
        calls += 1;
        return {
            status: 'unchanged', text: source, diagnostics: [],
            sourceMap: { entries: [] }
        };
    });
    var injectedResult = await injected.format({
        source: '', options: { dialect: 'hive' }, mode: 'document',
        documentVersion: 1, targetId: 'test'
    });
    assert.strictEqual(calls, 1, 'direct executor must call the injected target');
    assert.strictEqual(injectedResult.status, 'unchanged');

    var direct = runtime.createProductionFormatterExecutor({
        runtimePath: runtimePath,
        workerPath: workerPath,
        thresholds: { sourceCodeUnits: 1000000, leafCount: 1000000 }
    });
    var worker = runtime.createProductionFormatterExecutor({
        runtimePath: runtimePath,
        workerPath: workerPath,
        thresholds: { sourceCodeUnits: 1, leafCount: 1 }
    });
    assert.strictEqual(direct.runtimeDigest, runtimeDigest);
    assert.strictEqual(worker.runtimeDigest, runtimeDigest);
    var request = {
        source: 'select a from t', options: { dialect: 'hive' }, mode: 'document',
        documentVersion: 2, targetId: 'parity'
    };
    var directResult = await direct.format(request);
    var workerResult = await worker.format(request);
    assert.strictEqual(direct.lastRoute(), 'direct');
    assert.strictEqual(worker.lastRoute(), 'worker');
    assert.deepStrictEqual(workerResult, directResult,
        'direct and worker must execute the same runtime artifact bytes');
    assert.throws(function() {
        runtime.createProductionFormatterExecutor({
            runtimePath: formatterPath,
            workerPath: workerPath
        });
    }, /runtime/i, 'production executor factory must reject a different runtime artifact');

    await Promise.all([injected.dispose(), direct.dispose(), worker.dispose()]);
    console.log('v2 Wave 5 runtime artifact tests passed');
}

main().catch(function(error) {
    console.error(error);
    process.exitCode = 1;
});
