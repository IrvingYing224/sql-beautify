'use strict';

var assert = require('assert');
var ddl = require('../../.tmp/v2-core/experimental/ddl');
var lexer = require('../../.tmp/v2-core/core/lexer/lossless-lexer');
var displayWidth = require('../../.tmp/v2-core/core/renderer/display-width');
var fixtures = require('../fixtures/v2-wave4-ddl');

assert.strictEqual(
    lexer.lexSql('PARTITIONED BY', { dialect: 'hive' }).leaves[0].kind,
    'keyword',
    'modeled Hive DDL suffix words must participate in keyword-case equivalence'
);

fixtures.ddl.forEach(function(fixture) {
    var result = ddl.formatHiveDdl(fixture.source);
    assert.strictEqual(result.status, fixture.status, fixture.id + ': status');
    assert.strictEqual(result.source, fixture.source, fixture.id + ': source identity');
    assert.strictEqual(Object.isFrozen(result), true, fixture.id + ': frozen result');
    assert.strictEqual(Object.isFrozen(result.diagnostics), true,
        fixture.id + ': frozen diagnostics');
    if (fixture.status === 'formatted') {
        assert.strictEqual(result.text, fixture.text, fixture.id + ': formatted text');
        assert.deepStrictEqual(result.diagnostics, [], fixture.id + ': no diagnostic');
        var repeated = ddl.formatHiveDdl(result.text);
        assert.strictEqual(repeated.status, 'unchanged', fixture.id + ': idempotent status');
        assert.strictEqual(repeated.text, result.text, fixture.id + ': idempotent text');
    } else {
        assert.strictEqual(result.text, fixture.source, fixture.id + ': fail closed text');
        assert.ok(result.diagnostics.length > 0, fixture.id + ': diagnostic required');
        if (fixture.code) {
            assert.strictEqual(result.diagnostics[0].code, fixture.code, fixture.id + ': code');
        }
    }
});

var nonString = ddl.formatHiveDdl(null);
assert.strictEqual(nonString.status, 'failed');
assert.strictEqual(nonString.text, '');
assert.strictEqual(nonString.diagnostics[0].code, 'DDL_INPUT');

assert.strictEqual(ddl.formatHiveDdl.length, 1,
    'optional DDL options must preserve one-argument runtime compatibility');
var optionSource = 'create table t (a int,b string) ' +
    'partitioned by (ds string,rn int) stored as orc;';
var optionResult = ddl.formatHiveDdl(optionSource, {
    keywordCase: 'lower',
    commaStyle: 'trailing',
    indentStyle: 'tab'
});
assert.strictEqual(optionResult.status, 'formatted');
assert.strictEqual(optionResult.text, [
    'create table t',
    '(',
    '\ta int,',
    '\tb string',
    ')',
    'partitioned by',
    '(',
    '\tds string,',
    '\trn int',
    ')',
    'stored as orc;',
    ''
].join('\n'));
assert.strictEqual(ddl.formatHiveDdl(optionResult.text, {
    keywordCase: 'lower', commaStyle: 'trailing', indentStyle: 'tab'
}).status, 'unchanged', 'DDL option output must be idempotent');

[
    { keywordCase: 'title' },
    { commaStyle: 'middle' },
    { indentStyle: 'mixed' },
    { maxAlignWidth: 0 },
    { maxAlignWidth: 501 },
    { maxAlignWidth: 1.5 },
    { dialect: 'hive' },
    null
].forEach(function(options) {
    var invalid = ddl.formatHiveDdl('CREATE TABLE t (a INT)', options);
    assert.strictEqual(invalid.status, 'failed');
    assert.strictEqual(invalid.text, 'CREATE TABLE t (a INT)');
    assert.strictEqual(invalid.diagnostics[0].code, 'DDL_OPTIONS');
});
var accessorOptions = {};
Object.defineProperty(accessorOptions, 'keywordCase', {
    enumerable: true,
    get: function() { throw new Error('must not read DDL option accessors'); }
});
assert.strictEqual(
    ddl.formatHiveDdl('CREATE TABLE t (a INT)', accessorOptions).diagnostics[0].code,
    'DDL_OPTIONS'
);
assert.strictEqual(
    ddl.formatHiveDdl('CREATE TABLE t (a INT)', new Proxy({}, {})).diagnostics[0].code,
    'DDL_OPTIONS'
);

var unicodeAlignment = ddl.formatHiveDdl(
    'CREATE TABLE t (`中` STRING, ascii STRING)'
);
assert.strictEqual(unicodeAlignment.status, 'formatted');
assert.strictEqual(unicodeAlignment.text, [
    'CREATE TABLE t',
    '(',
    '     `中`  STRING',
    '    ,ascii STRING',
    ')',
    ''
].join('\n'), 'DDL alignment must use display columns rather than UTF-16 length');

var unicodeWidthMatrix = ddl.formatHiveDdl(
    'CREATE TABLE t (`🙂` STRING, `e\u0301` STRING, `a\tb` STRING, ascii STRING)'
);
assert.strictEqual(unicodeWidthMatrix.status, 'formatted');
var unicodeTypeColumns = unicodeWidthMatrix.text.split('\n').filter(function(line) {
    return line.indexOf(' STRING') >= 0;
}).map(function(line) {
    var typeOffset = line.lastIndexOf('STRING');
    return displayWidth.displayWidth(line.slice(0, typeOffset), 0, 4);
});
assert.strictEqual(unicodeTypeColumns.length, 4);
assert.strictEqual(new Set(unicodeTypeColumns).size, 1,
    'emoji, combining and tab identifiers must align on one display column');

var wideName = new Array(10001).join('x');
var wideColumns = ['`' + wideName + '` STRING'];
for (var wideIndex = 0; wideIndex < 1000; wideIndex++) {
    wideColumns.push('c' + wideIndex + ' STRING');
}
var wideSource = 'CREATE TABLE t (' + wideColumns.join(',') + ')';
var wideResult = ddl.formatHiveDdl(wideSource);
assert.strictEqual(wideResult.status, 'formatted');
assert.ok(wideResult.text.length < wideSource.length * 5,
    'wide DDL alignment output must remain linear, got ' +
    wideResult.text.length + ' from ' + wideSource.length);
assert.ok(wideResult.text.indexOf('c0 STRING') >= 0,
    'over-budget alignment must degrade to one required separator space');

var parserPath = require.resolve('../../.tmp/v2-core/core/syntax/parser');
var hiveFormatterPath = require.resolve('../../.tmp/v2-core/experimental/ddl/hive-ddl');
var parser = require(parserPath);
var stableParseSqlArtifact = parser.parseSqlArtifact;
parser.parseSqlArtifact = function() {
    throw new Error('private CREATE TABLE payload from parser');
};
delete require.cache[hiveFormatterPath];
var hostileFormatter = require(hiveFormatterPath);
var safeFailure = hostileFormatter.formatHiveDdl('CREATE TABLE secret (a INT)');
assert.strictEqual(safeFailure.status, 'failed');
assert.strictEqual(safeFailure.diagnostics[0].code, 'DDL_INTERNAL');
assert.strictEqual(safeFailure.diagnostics[0].message,
    'Hive DDL formatting failed safely');
assert.strictEqual(safeFailure.diagnostics[0].message.indexOf('secret'), -1,
    'public DDL diagnostics must not contain internal exception text or SQL');
assert.strictEqual(Object.prototype.hasOwnProperty.call(safeFailure, 'debugEvents'), false,
    'public DDL facade must not expose debug detail without opt-in execution');
var debugFailure = hostileFormatter.executeFormatHiveDdl(
    'CREATE TABLE secret (a INT)', undefined, true
);
assert.strictEqual(debugFailure.debugEvents.length, 1);
assert.strictEqual(debugFailure.debugEvents[0].code, 'DDL_INTERNAL');
assert.ok(debugFailure.debugEvents[0].message.indexOf('private CREATE TABLE') >= 0,
    'internal opt-in execution must retain bounded debug evidence');
parser.parseSqlArtifact = stableParseSqlArtifact;
delete require.cache[hiveFormatterPath];

console.log('v2 Wave 4D Hive DDL tests passed');
