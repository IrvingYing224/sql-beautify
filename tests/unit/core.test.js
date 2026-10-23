'use strict';

// Core results that golden does not record: source maps (cursor and selection restore), diagnostic
// metadata (severity, capabilityId, recovery and span drive the host), the core input limit and
// option validation. Expected values were measured on 2.2.1.

var assert = require('assert');
var fs = require('fs');
var path = require('path');
var test = require('node:test');
var m = require('./helpers/src')({
    format: 'core/api/format',
    resolve: 'core/config/resolve-options',
    definitions: 'core/config/definitions'
});

function format(source, options) {
    return m.format.formatSql(source, Object.assign({ dialect: 'hive' }, options));
}

function entries(result) {
    return result.sourceMap.entries.map(function(entry) {
        return [entry.source.start, entry.source.end, entry.output.start, entry.output.end];
    });
}

function assertSourceMap(source, result) {
    var previous = [0, 0, 0, 0];
    entries(result).forEach(function(entry) {
        assert.ok(entry[0] >= previous[1] && entry[2] >= previous[3], 'sorted and disjoint');
        assert.ok(entry[1] <= source.length && entry[3] <= result.text.length, 'in bounds');
        assert.ok(entry[1] > entry[0] && entry[1] - entry[0] === entry[3] - entry[2], 'non-empty, equal widths');
        var input = source.slice(entry[0], entry[1]);
        var output = result.text.slice(entry[2], entry[3]);
        assert.ok(input === output || (/^[\x00-\x7f]*$/.test(input) && input.toLowerCase() === output.toLowerCase()),
            JSON.stringify([input, output]));
        previous = entry;
    });
}

test('U-SM M1: source maps of real formatting', function() {
    var cases = [
        ['select a from t', {}, [[0, 6, 0, 6], [7, 8, 13, 14], [9, 13, 15, 19], [14, 15, 20, 21]]],
        ["select a as x, longer_name as y from t where a='FROM'", {}, [[0, 6, 0, 6], [7, 8, 13, 14], [9, 11, 25, 27],
            [12, 13, 28, 29], [13, 14, 34, 35], [15, 26, 36, 47], [27, 29, 48, 50], [30, 31, 51, 52], [32, 36, 53, 57],
            [37, 38, 58, 59], [39, 44, 60, 65], [45, 46, 66, 67], [46, 47, 68, 69], [47, 53, 70, 76]]],
        ['select    1', {}, [[0, 6, 0, 6], [10, 11, 7, 8]]],
        ['select a,b\r\nfrom t', {}, [[0, 6, 0, 6], [7, 8, 14, 15], [8, 9, 21, 22], [9, 10, 23, 24], [12, 16, 26, 30], [17, 18, 31, 32]]],
        ['select    window as order', { keywordCase: 'upper' }, [[0, 6, 0, 6], [10, 16, 7, 13], [17, 19, 14, 16], [20, 25, 17, 22]]],
        ['select\r\n1\r\n', {}, [[0, 6, 0, 6], [8, 11, 7, 10]]]
    ];
    cases.forEach(function(value) {
        var result = format(value[0], value[1]);
        assert.deepStrictEqual(entries(result), value[2], value[0]);
        assertSourceMap(value[0], result);
        assert.deepStrictEqual(format(value[0], value[1]).sourceMap, result.sourceMap);
    });
    assert.deepStrictEqual(entries(format('﻿select a,b from t'))[0], [0, 7, 0, 7]);
    [
        'SELECT a, b FROM ${db}.t WHERE ds = ${hivevar:day}',
        'SELECT a -- first\n     , b /* second */\nFROM t',
        'select a from t',
        'SELECT 1'
    ].forEach(function(source) {
        [{}, { keywordCase: 'lower' }].forEach(function(options) {
            var result = format(source, options);
            assert.ok(result.status === 'formatted' || result.status === 'unchanged', source);
            assertSourceMap(source, result);
        });
    });
    var preserved = format("select 'unterminated");
    assert.deepStrictEqual([preserved.status, preserved.sourceMap], ['preserved', undefined]);
});

test('D1: diagnostic severity, capability, recovery and span', function() {
    function rows(source, options) {
        var result = format(source, options);
        return [result.status].concat(result.diagnostics.map(function(item) {
            return [item.code, item.severity, item.capabilityId, item.recovery, item.span.start, item.span.end];
        }));
    }
    var nested = 'select ' + 'case when a=1 then '.repeat(44) + '0' + ' else 1 end'.repeat(44) + ' from t';
    var table = [
        ['UPDATE target SET value=1 WHERE id=2', {}, ['unchanged', ['SYN_UNSUPPORTED_STATEMENT', 'warning', 'update', 'verbatim-node', 0, 36]]],
        ['DELETE FROM target WHERE id=2', {}, ['unchanged', ['SYN_UNSUPPORTED_STATEMENT', 'warning', 'delete', 'verbatim-node', 0, 29]]],
        ['CREATE TABLE t (id int)', {}, ['unchanged', ['SYN_UNSUPPORTED_STATEMENT', 'warning', 'hive-ddl', 'verbatim-node', 0, 23]]],
        ["SELECT TRANSFORM(payload) USING 'cat' AS (value string) FROM src", {}, ['unchanged',
            ['SYN_UNMODELED_CONSTRUCT', 'warning', 'transform', 'preserve-statement', 0, 64],
            ['SYN_UNMODELED_CONSTRUCT', 'warning', 'transform', 'preserve-statement', 7, 64]]],
        ['SELECT region, count(*) FROM sales GROUP BY region GROUPING SETS ((region),())', {}, ['unchanged',
            ['SYN_UNMODELED_CONSTRUCT', 'warning', 'grouping-sets', 'preserve-statement', 0, 78],
            ['SYN_UNMODELED_CONSTRUCT', 'warning', 'grouping-sets', 'preserve-statement', 51, 78]]],
        ['select a from t qualify row_number() over(order by a)=1', {}, ['unchanged',
            ['SYN_UNMODELED_CONSTRUCT', 'warning', 'qualify', 'preserve-statement', 0, 55],
            ['SYN_UNMODELED_CONSTRUCT', 'warning', 'qualify', 'preserve-statement', 16, 55]]],
        ['select  1; select a from t qualify row_number() over(order by a)=1', { unsupportedSyntaxPolicy: 'bail_out' }, ['preserved',
            ['SYN_UNMODELED_CONSTRUCT', 'warning', 'qualify', 'preserve-statement', 10, 66],
            ['SYN_UNMODELED_CONSTRUCT', 'warning', 'qualify', 'preserve-statement', 27, 66],
            ['FMT_UNSUPPORTED_BAIL_OUT', 'warning', null, 'preserve-target', 0, 66]]],
        ['select a div b from t', {}, ['formatted', ['SYN_UNEXPECTED_TOKEN', 'warning', null, 'verbatim-node', 7, 14]]],
        ['select (a +) from t', {}, ['formatted', ['SYN_INCOMPLETE_CLAUSE', 'warning', null, 'verbatim-node', 8, 11]]],
        ["SELECT 'unterminated", {}, ['preserved',
            ['SYN_UNEXPECTED_TOKEN', 'warning', null, 'preserve-target', 0, 20],
            ['LEX_UNTERMINATED_STRING', 'error', null, 'preserve-target', 7, 20]]],
        ['select aaaaaaaaaa as x -- c1\n, b as y -- c2\n, cc as z -- c3\nfrom t', { commaStyle: 'trailing' }, ['formatted',
            ['LAYOUT_COMMA_FALLBACK', 'info', null, 'none', 0, 66]]],
        [nested, {}, ['preserved', ['LAYOUT_COMPILE_RESOURCE', 'warning', null, 'preserve-target', 0, nested.length]]],
        ['select 1', { dialect: 'postgres' }, ['failed', ['CFG_OPTION_VALUE', 'error', null, 'preserve-target', 0, 8]]],
        ['select 1', { foo: 1 }, ['failed', ['CFG_UNKNOWN_OPTION', 'error', null, 'preserve-target', 0, 8]]]
    ];
    table.forEach(function(value) {
        assert.deepStrictEqual(rows(value[0], value[1]), value[2], value[0].slice(0, 60));
    });
    assert.strictEqual(format('select a div b from t').text, 'SELECT\n      a div b\nFROM t');
    assert.strictEqual(format('select (a +) from t').text, 'SELECT\n      (a +)\nFROM t');

    // Capabilities of the Hive corpus cases, in diagnostic order.
    var corpus = path.join(__dirname, '..', 'golden', 'cases', 'corpus');
    [
        ['hive-nested-qualify-budget', ['qualify', 'qualify']],
        ['hive-preserve-ddl', ['hive-ddl']],
        ['hive-preserve-delete', ['delete']],
        ['hive-preserve-explain', ['explain']],
        ['hive-preserve-grouping-sets', ['grouping-sets', 'grouping-sets']],
        ['hive-preserve-transform', ['transform', 'transform']],
        ['hive-preserve-update', ['update']]
    ].forEach(function(value) {
        var raw = fs.readFileSync(path.join(corpus, value[0] + '.in.txt'), 'utf8');
        var header = raw.startsWith('-- golden: ') ? JSON.parse(raw.slice(11, raw.indexOf('\n'))) : {};
        var source = raw.startsWith('-- golden: ') ? raw.slice(raw.indexOf('\n') + 1) : raw;
        var capabilities = format(source, header.options).diagnostics
            .map(function(item) { return item.capabilityId; })
            .filter(function(id) { return id !== null; });
        assert.deepStrictEqual(capabilities, value[1], value[0]);
    });
});

test('R1: the core keeps input over 524,288 code units unchanged', function() {
    assert.deepStrictEqual([format(' '.repeat(524288)).status, format(' '.repeat(524288)).diagnostics], ['unchanged', []]);
    var over = ' '.repeat(524289);
    var result = format(over);
    assert.deepStrictEqual([result.status, result.text === over], ['preserved', true]);
    assert.deepStrictEqual(result.diagnostics.map(function(item) {
        return [item.code, item.severity, item.capabilityId, item.recovery, item.span.start, item.span.end];
    }), [['FMT_INPUT_LIMIT', 'warning', null, 'preserve-target', 0, 524289]]);
    assert.strictEqual(format('select 1'.padEnd(524288, ' ')).status, 'formatted');
});

test('U-CFG: option validation and the manifest agree', function() {
    var resolve = m.resolve.resolveFormatOptions;
    assert.deepStrictEqual(resolve(), { ok: true, options: { dialect: 'hive', keywordCase: 'upper', commaStyle: 'leading',
        indentStyle: 'space', maxAlignWidth: 150, caseWhenThenWrapLength: 50, caseLayout: 'expanded', unsupportedSyntaxPolicy: 'warn' } });
    var full = { dialect: 'postgresql', keywordCase: 'lower', commaStyle: 'trailing', indentStyle: 'tab', maxAlignWidth: 1,
        caseWhenThenWrapLength: 300, caseLayout: 'compactShort', unsupportedSyntaxPolicy: 'bail_out' };
    assert.deepStrictEqual(resolve(full), { ok: true, options: full });
    assert.strictEqual(resolve({ maxAlignWidth: 500 }).ok, true);
    assert.strictEqual(resolve({ caseWhenThenWrapLength: 1 }).ok, true);
    function failure(values) {
        var result = resolve(values);
        return [result.ok, result.code, result.optionKey];
    }
    [0, 501, 1.5, NaN, Infinity].forEach(function(value) {
        assert.deepStrictEqual(failure({ maxAlignWidth: value }), [false, 'CFG_OPTION_VALUE', 'maxAlignWidth']);
    });
    [0, 301, 1.5, NaN, Infinity].forEach(function(value) {
        assert.deepStrictEqual(failure({ caseWhenThenWrapLength: value }), [false, 'CFG_OPTION_VALUE', 'caseWhenThenWrapLength']);
    });
    [['keywordCase', 'title'], ['commaStyle', 'none'], ['indentStyle', 'mixed'], ['caseLayout', 'auto'],
        ['unsupportedSyntaxPolicy', 'ignore'], ['dialect', 'postgres']].forEach(function(pair) {
        var values = {};
        values[pair[0]] = pair[1];
        assert.deepStrictEqual(failure(values), [false, 'CFG_OPTION_VALUE', pair[0]]);
    });

    var manifest = require('../../package.json').contributes.configuration.properties;
    m.definitions.FORMAT_OPTION_KEYS.forEach(function(key) {
        var nulled = {};
        nulled[key] = null;
        assert.deepStrictEqual(failure(nulled), [false, 'CFG_OPTION_VALUE', key]);
        var definition = m.definitions.FORMAT_OPTION_DEFINITIONS[key];
        var property = manifest['sqlBeautify.' + key];
        assert.strictEqual(property.scope, 'language-overridable', key);
        ['type', 'enum', 'default', 'minimum', 'maximum'].forEach(function(field) {
            assert.deepStrictEqual(property[field], definition[field], key + '.' + field);
        });
    });
});
