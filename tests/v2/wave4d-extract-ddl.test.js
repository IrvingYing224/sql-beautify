'use strict';

var assert = require('assert');
var ddl = require('../../.tmp/v2-core/experimental/ddl');
var extractExecution = require('../../.tmp/v2-core/experimental/ddl/extract');
var resultFactory = require('../../.tmp/v2-core/experimental/ddl/result');
var limits = require('../../.tmp/v2-core/core/api/limits');
var displayWidth = require('../../.tmp/v2-core/core/renderer/display-width');
var fixtures = require('../fixtures/v2-wave4-ddl');
var hiveStringLiteral = require('../../.tmp/v2-core/experimental/ddl/string-literal').hiveStringLiteral;

// Independent decoder for the emitted literal subset, following Hive's
// enclosure, Unicode, octal-before-short-escape ordering. It deliberately
// accepts doubled enclosures so a SQL-standard encoder fails the round trip.
function decodeHiveLiteral(literal) {
    var enclosure = null;
    var output = '';
    var escapes = { '0': '\0', b: '\b', n: '\n', r: '\r', t: '\t', Z: '\u001a' };
    for (var index = 0; index < literal.length; index++) {
        var character = literal[index];
        if (enclosure === null) {
            if (character === "'" || character === '"') enclosure = character;
        } else if (character === enclosure) {
            enclosure = null;
        } else if (character === '\\') {
            var remaining = literal.slice(index + 1);
            if (/^u[0-9a-fA-F]{4}/.test(remaining)) {
                output += String.fromCharCode(parseInt(remaining.slice(1, 5), 16));
                index += 5;
            } else if (/^[01][0-7]{2}/.test(remaining)) {
                output += String.fromCharCode(parseInt(remaining.slice(0, 3), 8));
                index += 3;
            } else {
                var next = literal[++index];
                output += Object.prototype.hasOwnProperty.call(escapes, next)
                    ? escapes[next]
                    : next;
            }
        } else {
            output += character;
        }
    }
    return output;
}

// Hive 4.0.1 BaseSemanticAnalyzer.escapeSQLString/unescapeSQLString use
// backslash quoting. SQL-standard doubled quotes lose the apostrophe there.
// https://github.com/apache/hive/blob/rel/release-4.0.1/ql/src/java/org/apache/hadoop/hive/ql/parse/BaseSemanticAnalyzer.java
[
    ["owner's column", "'owner\\'s column'"],
    ["a\\'b", "'a\\\\\\'b'"],
    ['a\\nb', "'a\\\\nb'"],
    ['a\0b', "'a\\u0000b'"],
    ['a\x0012b', "'a\\u000012b'"],
    ['a\x0077b', "'a\\u000077b'"],
    ["a\0'b", "'a\\u0000\\'b'"],
    ['a\bb', "'a\\bb'"],
    ['a\tb', "'a\\tb'"],
    ['a\nb', "'a\\nb'"],
    ['a\r\nb', "'a\\r\\nb'"],
    ['a\u001ab', "'a\\Zb'"],
    ['a\u0001b', "'a\\u0001b'"],
    ['中文 "note"', "'中文 \"note\"'"]
].forEach(function(entry) {
    assert.strictEqual(hiveStringLiteral(entry[0]), entry[1],
        'generated Hive literals must preserve the comment value');
    assert.strictEqual(decodeHiveLiteral(hiveStringLiteral(entry[0])), entry[0],
        'Hive decoding must recover the original comment including escape combinations');
    if (!/[\r\n]/.test(entry[0])) {
        var result = ddl.extractDdl('SELECT a -- ' + entry[0] + '\nFROM t');
        assert.strictEqual(result.status, 'extracted');
        assert.strictEqual(result.text,
            '     a __TYPE_REQUIRED__ COMMENT ' + entry[1] + '\n');
        var create = ddl.formatHiveDdl('CREATE TABLE t (a STRING COMMENT ' + entry[1] + ')');
        assert.strictEqual(create.status, 'formatted');
        assert.ok(create.text.includes('COMMENT ' + entry[1]),
            'formatting generated DDL must retain the literal bytes');
    }
});

fixtures.extract.forEach(function(fixture) {
    var result = ddl.extractDdl(fixture.source);
    assert.strictEqual(result.status, fixture.status, fixture.id + ': status');
    assert.strictEqual(result.source, fixture.source, fixture.id + ': source identity');
    assert.strictEqual(Object.isFrozen(result), true, fixture.id + ': frozen result');
    assert.strictEqual(Object.isFrozen(result.diagnostics), true,
        fixture.id + ': frozen diagnostics');
    if (fixture.status === 'extracted') {
        assert.ok(result.text.length > 0, fixture.id + ': extracted iff non-empty');
        assert.strictEqual(result.text.indexOf(' BIGINT'), -1,
            fixture.id + ': default type must not silently guess BIGINT');
        if (fixture.text) {
            assert.strictEqual(result.text, fixture.text, fixture.id + ': extracted text');
        }
        (fixture.names || []).forEach(function(name) {
            assert.ok(result.text.indexOf(name) >= 0, fixture.id + ': expected name ' + name);
        });
    } else {
        assert.strictEqual(result.text, fixture.source, fixture.id + ': non-extracted identity');
        assert.ok(result.diagnostics.length > 0, fixture.id + ': diagnostic required');
        assert.strictEqual(result.diagnostics[0].code, fixture.code, fixture.id + ': code');
    }
});

var explicitType = ddl.extractDdl('SELECT a FROM t', { defaultType: 'STRING' });
assert.strictEqual(explicitType.status, 'extracted');
assert.ok(explicitType.text.indexOf(' STRING') >= 0);
assert.strictEqual(explicitType.text.indexOf('__TYPE_REQUIRED__'), -1);

var invalidTypeSource = 'SELECT a FROM t';
var invalidType = ddl.extractDdl(invalidTypeSource, { defaultType: 'STRING; DROP' });
assert.strictEqual(invalidType.status, 'failed');
assert.strictEqual(invalidType.text, invalidTypeSource);
assert.strictEqual(invalidType.diagnostics[0].code, 'EXTRACT_DEFAULT_TYPE');

var nonString = ddl.extractDdl(null);
assert.strictEqual(nonString.status, 'failed');
assert.strictEqual(nonString.text, '');
assert.strictEqual(nonString.diagnostics[0].code, 'EXTRACT_INPUT');

var hostileOptions = ddl.extractDdl('SELECT a FROM t', null);
assert.strictEqual(hostileOptions.status, 'failed');
assert.strictEqual(hostileOptions.diagnostics[0].code, 'EXTRACT_OPTIONS');
assert.strictEqual(hostileOptions.diagnostics[0].message,
    'Extract DDL options are invalid');

[null, undefined].forEach(function(value) {
    var result = ddl.extractDdl('SELECT a FROM t', { defaultType: value });
    assert.strictEqual(result.status, 'failed', 'explicit empty defaultType');
    assert.strictEqual(result.diagnostics[0].code, 'EXTRACT_OPTIONS');
});

var getterCalls = 0;
var accessorExtractOptions = {};
Object.defineProperty(accessorExtractOptions, 'defaultType', {
    enumerable: true,
    get: function() {
        getterCalls += 1;
        return 'STRING';
    }
});
var accessorExtract = ddl.extractDdl('SELECT a FROM t', accessorExtractOptions);
assert.strictEqual(accessorExtract.status, 'failed');
assert.strictEqual(accessorExtract.diagnostics[0].code, 'EXTRACT_OPTIONS');
assert.strictEqual(getterCalls, 0, 'Extract DDL must not execute option accessors');
var proxyGets = 0;
var proxyOptions = new Proxy({}, {
    get: function() {
        proxyGets += 1;
        return 'STRING';
    }
});
assert.strictEqual(
    ddl.extractDdl('SELECT a FROM t', proxyOptions).diagnostics[0].code,
    'EXTRACT_OPTIONS'
);
assert.strictEqual(proxyGets, 0, 'Extract DDL must not execute Proxy get traps');
assert.strictEqual(
    ddl.extractDdl('SELECT a FROM t', { unexpected: true }).diagnostics[0].code,
    'EXTRACT_OPTIONS'
);
assert.strictEqual(
    ddl.extractDdl('SELECT a FROM t', { tabSize: 8 }).diagnostics[0].code,
    'EXTRACT_OPTIONS',
    'tabSize must not expand the public Extract DDL options'
);
assert.strictEqual(
    ddl.extractDdl(
        'SELECT a FROM t',
        Object.create({ defaultType: 'BIGINT' })
    ).diagnostics[0].code,
    'EXTRACT_OPTIONS'
);
var nullPrototypeOptions = Object.create(null);
nullPrototypeOptions.defaultType = 'BIGINT';
assert.strictEqual(
    ddl.extractDdl('SELECT a FROM t', nullPrototypeOptions).status,
    'extracted'
);
var symbolOptions = { defaultType: 'STRING' };
symbolOptions[Symbol('unexpected')] = true;
assert.strictEqual(
    ddl.extractDdl('SELECT a FROM t', symbolOptions).diagnostics[0].code,
    'EXTRACT_OPTIONS'
);
assert.strictEqual(
    ddl.extractDdl('SELECT a FROM t', {
        defaultType: new Array(130).join('X')
    }).diagnostics[0].code,
    'EXTRACT_DEFAULT_TYPE'
);

var unicodeExtract = ddl.extractDdl('SELECT `中`, ascii FROM t');
assert.strictEqual(unicodeExtract.status, 'extracted');
assert.strictEqual(unicodeExtract.text, [
    '     `中`  __TYPE_REQUIRED__',
    '    ,ascii __TYPE_REQUIRED__',
    ''
].join('\n'), 'Extract DDL alignment must use Unicode display columns');

var unicodeExtractMatrix = ddl.extractDdl(
    'SELECT `🙂`, `e\u0301`, `a\tb`, ascii FROM t'
);
assert.strictEqual(unicodeExtractMatrix.status, 'extracted');
var extractTypeColumns = unicodeExtractMatrix.text.split('\n').filter(Boolean).map(
    function(line) {
        var typeOffset = line.lastIndexOf('__TYPE_REQUIRED__');
        return displayWidth.displayWidth(line.slice(0, typeOffset), 0, 4);
    }
);
assert.strictEqual(extractTypeColumns.length, 4);
assert.strictEqual(new Set(extractTypeColumns).size, 1,
    'Extract emoji, combining and tab identifiers must share one display column');

var tabExtractSource = 'SELECT `a\tb`, ascii, `中` FROM t';
[2, 4, 8].forEach(function(tabSize) {
    var tabExtract = extractExecution.executeExtractDdl(
        tabExtractSource,
        undefined,
        false,
        tabSize
    );
    assert.strictEqual(tabExtract.status, 'extracted');
    var alignedColumns = tabExtract.text.split('\n').filter(Boolean).map(
        function(line) {
            return displayWidth.displayWidth(
                line.slice(0, line.lastIndexOf('__TYPE_REQUIRED__')),
                0,
                tabSize
            );
        }
    );
    assert.strictEqual(new Set(alignedColumns).size, 1,
        'Extract DDL tabSize=' + tabSize + ' must align identifier tabs');
});
assert.strictEqual(
    ddl.extractDdl(tabExtractSource).text,
    extractExecution.executeExtractDdl(tabExtractSource, undefined, false, 4).text,
    'public Extract DDL facade must retain the internal tabSize=4 default'
);
var shiftedTabExtract = extractExecution.executeExtractDdl(
    tabExtractSource,
    undefined,
    false,
    8,
    2
);
assert.strictEqual(shiftedTabExtract.status, 'extracted');
var shiftedExtractColumns = shiftedTabExtract.text.split('\n').filter(Boolean)
    .map(function(line) {
        var renderedLine = '  ' + line;
        return displayWidth.displayWidth(
            renderedLine.slice(0, renderedLine.lastIndexOf('__TYPE_REQUIRED__')),
            0,
            8
        );
    });
assert.strictEqual(new Set(shiftedExtractColumns).size, 1,
    'Extract alignment must include the transaction start column');
var invalidExtractTabSize = extractExecution.executeExtractDdl(
    tabExtractSource,
    undefined,
    false,
    257
);
assert.strictEqual(invalidExtractTabSize.status, 'failed');
assert.strictEqual(invalidExtractTabSize.text, tabExtractSource);
assert.strictEqual(invalidExtractTabSize.diagnostics[0].code, 'EXTRACT_INTERNAL');
assert.strictEqual(invalidExtractTabSize.diagnostics[0].message,
    'DDL extraction failed safely');
assert.strictEqual(
    extractExecution.executeExtractDdl(
        tabExtractSource,
        undefined,
        false,
        8,
        -1
    ).diagnostics[0].code,
    'EXTRACT_INTERNAL',
    'invalid internal Extract start columns must fail closed'
);

var wideExtractName = new Array(10001).join('x');
var wideExtractColumns = ['`' + wideExtractName + '`'];
for (var wideExtractIndex = 0; wideExtractIndex < 1000; wideExtractIndex++) {
    wideExtractColumns.push('c' + wideExtractIndex);
}
var wideExtractSource = 'SELECT ' + wideExtractColumns.join(',') + ' FROM t';
var wideExtract = ddl.extractDdl(wideExtractSource);
assert.strictEqual(wideExtract.status, 'extracted');
assert.ok(wideExtract.text.length < wideExtractSource.length * 10,
    'Extract DDL alignment output must remain linear, got ' +
    wideExtract.text.length + ' from ' + wideExtractSource.length);

var exactLimitExtractPrefix = 'SELECT a FROM t';
var exactLimitExtract = exactLimitExtractPrefix + ' '.repeat(
    limits.MAX_FORMAT_SOURCE_CODE_UNITS - exactLimitExtractPrefix.length
);
var exactLimitExtractResult = ddl.extractDdl(exactLimitExtract);
assert.strictEqual(exactLimitExtract.length, limits.MAX_FORMAT_SOURCE_CODE_UNITS);
assert.strictEqual(exactLimitExtractResult.status, 'extracted',
    'the exact Extract DDL source limit must remain semantically accepted');
var overLimitExtract = exactLimitExtract + ' ';
var overLimitExtractResult = ddl.extractDdl(overLimitExtract);
assert.strictEqual(overLimitExtractResult.status, 'failed');
assert.strictEqual(overLimitExtractResult.source, overLimitExtract);
assert.strictEqual(overLimitExtractResult.text, overLimitExtract);
assert.strictEqual(
    overLimitExtractResult.diagnostics[0].code,
    'EXTRACT_RESOURCE_LIMIT'
);

var analyzePath = require.resolve('../../.tmp/v2-core/core/analysis/analyze');
var extractPath = require.resolve('../../.tmp/v2-core/experimental/ddl/extract');
var analyze = require(analyzePath);
var stableAnalyzeSql = analyze.analyzeSql;
analyze.analyzeSql = function() {
    throw new Error('private SELECT payload from analyzer');
};
delete require.cache[extractPath];
var hostileExtract = require(extractPath);
var analysisSkippedForOverLimit = hostileExtract.extractDdl(overLimitExtract);
assert.strictEqual(
    analysisSkippedForOverLimit.diagnostics[0].code,
    'EXTRACT_RESOURCE_LIMIT',
    'over-limit Extract DDL must fail before entering the hostile analyzer'
);
var safeAnalysisFailure = hostileExtract.extractDdl('SELECT secret FROM t');
assert.strictEqual(safeAnalysisFailure.status, 'failed');
assert.strictEqual(safeAnalysisFailure.diagnostics[0].code, 'EXTRACT_ANALYSIS_FAILED');
assert.strictEqual(safeAnalysisFailure.diagnostics[0].message,
    'DDL extraction analysis failed safely');
assert.strictEqual(safeAnalysisFailure.diagnostics[0].message.indexOf('secret'), -1);
assert.strictEqual(
    Object.prototype.hasOwnProperty.call(safeAnalysisFailure, 'debugEvents'),
    false
);
var debugAnalysisFailure = hostileExtract.executeExtractDdl(
    'SELECT secret FROM t', undefined, true
);
assert.strictEqual(debugAnalysisFailure.debugEvents.length, 1);
assert.ok(debugAnalysisFailure.debugEvents[0].message.indexOf('private SELECT') >= 0);
analyze.analyzeSql = stableAnalyzeSql;
delete require.cache[extractPath];

assert.throws(function() {
    resultFactory.extractDdlResult('extracted', 'SELECT a', '', null);
}, /must not be empty/, 'result boundary must reject empty extracted text');
assert.throws(function() {
    resultFactory.extractDdlResult('ambiguous', 'SELECT *', 'SELECT *');
}, /require a diagnostic/, 'result boundary must require non-extracted evidence');

for (var fuzz = 0; fuzz < 128; fuzz++) {
    var source = fuzz % 4 === 0
        ? 'SELECT a' + fuzz + ' FROM t'
        : fuzz % 4 === 1
            ? 'SELECT a' + fuzz + ', count(*) AS n FROM t'
            : fuzz % 4 === 2
                ? 'SELECT * FROM t' + fuzz
                : 'WITH c AS (SELECT x FROM t) SELECT a' + fuzz + ' FROM c';
    var fuzzResult = ddl.extractDdl(source);
    assert.ok(fuzzResult && typeof fuzzResult.text === 'string');
    if (fuzzResult.status !== 'extracted') {
        assert.strictEqual(fuzzResult.text, source, 'fuzz non-extracted source identity');
        assert.ok(fuzzResult.diagnostics.length > 0, 'fuzz non-extracted diagnostic');
    } else {
        assert.ok(fuzzResult.text.length > 0, 'fuzz extracted output must be non-empty');
    }
}

console.log('v2 Wave 4D Extract DDL tests passed');
