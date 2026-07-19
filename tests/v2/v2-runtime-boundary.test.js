var assert = require('assert');
var fs = require('fs');
var path = require('path');

var root = path.join(__dirname, '..', '..');
var runtimePath = path.join(root, 'dist', 'v2-core.cjs');
var ddlRuntimePath = path.join(root, 'dist', 'v2-ddl.cjs');
var workerPath = path.join(root, 'dist', 'v2-worker.cjs');
assert.ok(fs.existsSync(runtimePath), 'production v2 runtime must be built before boundary tests');
assert.ok(fs.existsSync(ddlRuntimePath),
    'production v2 DDL runtime must be built before boundary tests');
assert.ok(fs.existsSync(workerPath), 'production v2 worker must be built before boundary tests');

var runtime = require(runtimePath);
var ddlRuntime = require(ddlRuntimePath);
assert.deepStrictEqual(
    Object.keys(runtime).sort(),
    ['formatSql', 'formatSqlTarget', 'lexSql'],
    'production v2 runtime must expose the public API and one adapter-private target API'
);
assert.strictEqual(typeof runtime.formatSql, 'function', 'production runtime must expose formatSql');
assert.strictEqual(typeof runtime.formatSqlTarget, 'function', 'production runtime must expose adapter target API');
assert.strictEqual(typeof runtime.lexSql, 'function', 'production runtime must expose lexSql');
assert.deepStrictEqual(
    Object.keys(ddlRuntime).sort(),
    ['extractDdl', 'formatHiveDdl'],
    'production v2 DDL runtime must expose only experimental DDL values'
);
assert.strictEqual(typeof ddlRuntime.formatHiveDdl, 'function');
assert.strictEqual(typeof ddlRuntime.extractDdl, 'function');
var bundledDdl = ddlRuntime.formatHiveDdl('create table t (a int);');
assert.strictEqual(bundledDdl.status, 'formatted');
assert.strictEqual(bundledDdl.text.endsWith(');\n'), true,
    'bundled DDL runtime must retain statement terminators');
var bundledAmbiguous = ddlRuntime.extractDdl('SELECT * AS x FROM t');
assert.strictEqual(bundledAmbiguous.status, 'ambiguous');
assert.strictEqual(bundledAmbiguous.text, 'SELECT * AS x FROM t');

[
    'hive',
    'generic',
    'postgresql',
    'mysql'
].forEach(function(dialect) {
    var result = runtime.formatSql('select a from t', {
        dialect: dialect,
        unsupportedSyntaxPolicy: 'preserve'
    });
    assert.ok(
        result.status == 'formatted' || result.status == 'unchanged',
        dialect + ' production runtime smoke must produce a safe result'
    );
    assert.strictEqual(typeof result.text, 'string', dialect + ' result must retain text');
});

var malformed = runtime.formatSql('select (', { dialect: 'hive' });
assert.ok(
    malformed.status == 'preserved' || malformed.status == 'failed',
    'malformed SQL must fail closed in the production runtime'
);
assert.strictEqual(malformed.text, 'select (', 'malformed SQL must retain original source');

console.log('v2 runtime boundary tests passed');
