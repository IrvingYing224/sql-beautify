var assert = require('assert');
var cases = require('../fixtures/v2-sql-corpus-cases');
var ids = Object.create(null);
var allowedDialects = ['hive', 'generic', 'postgresql', 'mysql'];
var allowedExpectations = ['required', 'opaque', 'invalid'];
var required = 0;
var hiveRequired = 0;

assert.ok(cases.length >= 14, 'Wave 0 corpus must contain at least 14 focused cases');
cases.forEach(function(testCase) {
    assert.ok(testCase.id, 'case id is required');
    assert.ok(!ids[testCase.id], 'case ids must be unique: ' + testCase.id);
    ids[testCase.id] = true;
    assert.ok(allowedDialects.indexOf(testCase.dialect) >= 0, testCase.id + ' dialect');
    assert.ok(allowedExpectations.indexOf(testCase.expectation) >= 0, testCase.id + ' expectation');
    assert.strictEqual(typeof testCase.source, 'string', testCase.id + ' source');
    assert.ok(testCase.source.length > 0, testCase.id + ' source must not be empty');
    assert.ok(Array.isArray(testCase.atomicLexemes), testCase.id + ' atomicLexemes');
    assert.ok(Array.isArray(testCase.tags), testCase.id + ' tags');
    testCase.atomicLexemes.forEach(function(lexeme) {
        assert.ok(testCase.source.indexOf(lexeme) >= 0, testCase.id + ' missing lexeme ' + lexeme);
    });
    if (testCase.expectation == 'required') {
        required++;
        if (testCase.dialect == 'hive') {
            hiveRequired++;
        }
    }
});
assert.ok(required >= 10, 'at least 10 cases must require parsing');
assert.ok(hiveRequired >= 7, 'at least 7 required cases must be Hive');
assert.ok(cases.some(function(item) { return item.expectation == 'opaque'; }), 'opaque case required');
assert.ok(cases.some(function(item) { return item.expectation == 'invalid'; }), 'invalid case required');
console.log('v2 SQL corpus contract tests passed');
