'use strict';

var assert = require('assert');
var resolver = require('../../.tmp/v2-core/core/config/resolve-options.js');

function resolve(value) {
    return arguments.length === 0
        ? resolver.resolveFormatOptions()
        : resolver.resolveFormatOptions(value);
}

function assertFailure(value, code, label, optionKey) {
    var result;
    assert.doesNotThrow(function() {
        result = resolve(value);
    }, label + ' must not throw');
    assert.strictEqual(result.ok, false, label + ' must fail');
    assert.strictEqual(result.code, code, label + ' failure code');
    assert.strictEqual(result.optionKey, optionKey === undefined ? null : optionKey,
        label + ' safe option key');
    assert.strictEqual(Object.isFrozen(result), true, label + ' failure must be frozen');
}

(function testDefaults() {
    var result = resolve();
    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(result.options, {
        dialect: 'hive',
        keywordCase: 'upper',
        commaStyle: 'leading',
        indentStyle: 'space',
        maxAlignWidth: 150,
        caseWhenThenWrapLength: 50,
        caseLayout: 'expanded',
        unsupportedSyntaxPolicy: 'warn'
    });
    assert.strictEqual(Object.isFrozen(result), true);
    assert.strictEqual(Object.isFrozen(result.options), true);
})();

(function testCompleteValidOptionsAndNullPrototype() {
    var input = Object.assign(Object.create(null), {
        dialect: 'postgresql',
        keywordCase: 'lower',
        commaStyle: 'trailing',
        indentStyle: 'tab',
        maxAlignWidth: 1,
        caseWhenThenWrapLength: 300,
        caseLayout: 'compactShort',
        unsupportedSyntaxPolicy: 'bail_out'
    });
    var result = resolve(input);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.options.dialect, 'postgresql');
    assert.strictEqual(result.options.maxAlignWidth, 1);
    assert.strictEqual(result.options.caseWhenThenWrapLength, 300);
    input.dialect = 'mysql';
    assert.strictEqual(result.options.dialect, 'postgresql', 'caller mutation must not escape');
})();

(function testRangeBoundaries() {
    assert.strictEqual(resolve({ maxAlignWidth: 500 }).ok, true);
    assert.strictEqual(resolve({ caseWhenThenWrapLength: 1 }).ok, true);
    [0, 501, 1.5, NaN, Infinity].forEach(function(value) {
        assertFailure(
            { maxAlignWidth: value },
            'CFG_OPTION_VALUE',
            'invalid maxAlignWidth ' + String(value),
            'maxAlignWidth'
        );
    });
    [0, 301, 1.5, NaN, Infinity].forEach(function(value) {
        assertFailure(
            { caseWhenThenWrapLength: value },
            'CFG_OPTION_VALUE',
            'invalid caseWhenThenWrapLength ' + String(value),
            'caseWhenThenWrapLength'
        );
    });
})();

(function testInvalidEnumsAndExplicitEmptyValues() {
    [
        ['dialect', 'postgres'],
        ['keywordCase', 'title'],
        ['commaStyle', 'none'],
        ['indentStyle', 'mixed'],
        ['caseLayout', 'auto'],
        ['unsupportedSyntaxPolicy', 'ignore'],
        ['dialect', undefined],
        ['dialect', null]
    ].forEach(function(entry) {
        var input = {};
        input[entry[0]] = entry[1];
        assertFailure(input, 'CFG_OPTION_VALUE', 'invalid ' + entry[0], entry[0]);
    });
})();

(function testUnknownKeys() {
    assertFailure({ keywordcase: 'lower' }, 'CFG_UNKNOWN_OPTION', 'typo key');
})();

(function testNonPlainValuesFailClosed() {
    assertFailure(null, 'CFG_OPTIONS_TYPE', 'null');
    assertFailure([], 'CFG_OPTIONS_TYPE', 'array');
    assertFailure('hive', 'CFG_OPTIONS_TYPE', 'string');
})();

(function testManifestMatchesRuntimeDefinitions() {
    var definitions = require('../../.tmp/v2-core/core/config/definitions');
    var properties = require('../../package.json').contributes.configuration.properties;
    definitions.FORMAT_OPTION_KEYS.forEach(function(key) {
        var definition = definitions.FORMAT_OPTION_DEFINITIONS[key];
        var property = properties['sqlBeautify.' + key];
        assert.strictEqual(property.scope, 'language-overridable', key + ' language scope');
        Object.keys(definition).forEach(function(field) {
            assert.deepStrictEqual(property[field], definition[field], key + ' ' + field);
        });
        [null, undefined].forEach(function(value) {
            var input = {};
            input[key] = value;
            assertFailure(input, 'CFG_OPTION_VALUE', key + ' explicit empty value', key);
        });
    });
})();

console.log('v2 Wave 3A canonical option resolver tests passed');
