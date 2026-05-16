var assert = require('assert');
var vkbeautify = require('../vkbeautify');

assert.strictEqual(typeof vkbeautify.sql, 'function', 'vkbeautify.sql must be exported');
assert.strictEqual(typeof vkbeautify.sqlddl, 'function', 'vkbeautify.sqlddl must be exported');
assert.strictEqual(typeof vkbeautify.extractddl, 'function', 'vkbeautify.extractddl must be exported');

var formatted = vkbeautify.sql('select a,b from t where x=1 and y=2', true, false, true, 150, 80).trim();
assert.ok(formatted.indexOf('SELECT') >= 0, 'sql formatter should uppercase SELECT by default');
assert.ok(formatted.indexOf('WHERE x = 1') >= 0, 'sql formatter should preserve formatted WHERE condition');

var lower = vkbeautify.sql('select a from t', false, false, true, 150, 80).trim();
assert.ok(lower.indexOf('select') >= 0, 'sql formatter should keep lower keyword mode');

console.log('formatter api tests passed');
