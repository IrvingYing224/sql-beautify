'use strict';

var assert = require('assert');
var ddl = require('../../.tmp/v2-core/experimental/ddl');
var resultFactory = require('../../.tmp/v2-core/experimental/ddl/result');
var fixtures = require('../fixtures/v2-wave4-ddl');

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
