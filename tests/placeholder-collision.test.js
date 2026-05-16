var assert = require('assert');
var vkbeautify = require('../vkbeautify');

function format(sql) {
    return vkbeautify.sql(sql, true, false, true, 150, 80).trim();
}

function assert_contains(name, input, expected) {
    var actual = format(input);
    assert.ok(actual.indexOf(expected) >= 0, name + '\n--- expected ---\n' + expected + '\n--- actual ---\n' + actual);
}

function assert_not_contains(name, input, forbidden) {
    var actual = format(input);
    assert.strictEqual(actual.indexOf(forbidden), -1, name + '\n--- forbidden ---\n' + forbidden + '\n--- actual ---\n' + actual);
}

assert_not_contains('NEEDReplace identifier is not replaced with undefined', 'select NEEDReplace as c from t', 'undefined');
assert_contains('NEEDReplace identifier survives', 'select NEEDReplace as c from t', 'NEEDReplace');

assert_not_contains('line comment marker text is not restored from internal store', 'select a --{LC0}\nfrom t', 'undefined');
assert_contains('line comment marker text survives', 'select a --{LC0}\nfrom t', '-- {LC0}');

assert_not_contains('set payload marker-looking code is not restored from internal store', 'select {SQLSETPAYLOAD0} as x from t', 'undefined');
assert_contains('set payload marker-looking code survives', 'select {SQLSETPAYLOAD0} as x from t', '{SQLSETPAYLOAD0}');

assert_not_contains('standalone marker-looking code is not restored from internal store', 'select {SQLSTANDALONECOMMENT0} as x from t -- c', 'undefined');
assert_contains('standalone marker-looking code survives', 'select {SQLSTANDALONECOMMENT0} as x from t -- c', '{SQLSTANDALONECOMMENT0}');

console.log('placeholder collision tests passed');
