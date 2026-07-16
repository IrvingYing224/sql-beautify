'use strict';

var assert = require('assert');
var resolver = require('../../.tmp/v2-core/core/config/resolve-options.js');

function resolve(value) {
    return arguments.length === 0
        ? resolver.resolveFormatOptions()
        : resolver.resolveFormatOptions(value);
}

function assertFailure(value, code, label) {
    var result;
    assert.doesNotThrow(function() {
        result = resolve(value);
    }, label + ' must not throw');
    assert.strictEqual(result.ok, false, label + ' must fail');
    assert.strictEqual(result.code, code, label + ' failure code');
    assert.strictEqual(Object.isFrozen(result), true, label + ' failure must be frozen');
}

(function testDefaultsAndCanonicalIdentity() {
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
    assert.strictEqual(resolver.isCanonicalFormatOptions(result.options), true);
    assert.strictEqual(
        resolver.isCanonicalFormatOptions(Object.assign({}, result.options)),
        false,
        'plain clone must not inherit canonical identity'
    );
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
            'invalid maxAlignWidth ' + String(value)
        );
    });
    [0, 301, 1.5, NaN, Infinity].forEach(function(value) {
        assertFailure(
            { caseWhenThenWrapLength: value },
            'CFG_OPTION_VALUE',
            'invalid caseWhenThenWrapLength ' + String(value)
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
        assertFailure(input, 'CFG_OPTION_VALUE', 'invalid ' + entry[0]);
    });
})();

(function testUnknownAndHiddenKeys() {
    assertFailure({ keywordcase: 'lower' }, 'CFG_UNKNOWN_OPTION', 'typo key');

    var symbolInput = {};
    symbolInput[Symbol('hidden')] = true;
    assertFailure(symbolInput, 'CFG_UNKNOWN_OPTION', 'symbol key');

    var hiddenInput = {};
    Object.defineProperty(hiddenInput, 'dialect', {
        value: 'hive',
        enumerable: false
    });
    assertFailure(hiddenInput, 'CFG_UNKNOWN_OPTION', 'non-enumerable key');
})();

(function testAccessorsAreRejectedWithoutReading() {
    var reads = 0;
    var input = {};
    Object.defineProperty(input, 'dialect', {
        enumerable: true,
        get: function() {
            reads += 1;
            throw new Error('must not run');
        }
    });
    assertFailure(input, 'CFG_OPTION_ACCESSOR', 'accessor option');
    assert.strictEqual(reads, 0, 'resolver must inspect descriptor without invoking getter');
})();

(function testProxyAndRevokedProxyFailClosed() {
    assertFailure(
        new Proxy({ dialect: 'hive' }, {}),
        'CFG_OPTIONS_PROXY',
        'transparent Proxy'
    );
    var revoked = Proxy.revocable({ dialect: 'hive' }, {});
    revoked.revoke();
    assertFailure(revoked.proxy, 'CFG_OPTIONS_PROXY', 'revoked Proxy');
})();

(function testNonPlainValuesFailClosed() {
    assertFailure(null, 'CFG_OPTIONS_TYPE', 'null');
    assertFailure([], 'CFG_OPTIONS_TYPE', 'array');
    assertFailure('hive', 'CFG_OPTIONS_TYPE', 'string');
    assertFailure(new Date(), 'CFG_OPTIONS_SHAPE', 'exotic prototype');
})();

console.log('v2 Wave 3A canonical option resolver tests passed');
