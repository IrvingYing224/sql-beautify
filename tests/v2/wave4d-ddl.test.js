'use strict';

var assert = require('assert');
var ddl = require('../../.tmp/v2-core/experimental/ddl');
var fixtures = require('../fixtures/v2-wave4-ddl');

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

console.log('v2 Wave 4D Hive DDL tests passed');
