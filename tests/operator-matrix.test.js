var assert = require('assert');
var operatorRegistry = require('../lib/sql-operator-registry');

function get_operator(name, dialect) {
    var lookup = operatorRegistry.get_operator_lookup(dialect);
    return lookup[name];
}

assert.strictEqual(get_operator('<=>', 'mysql').spacing, 'surround', 'mysql must register <=> as a no-split operator');
assert.strictEqual(get_operator(':=', 'mysql').spacing, 'surround', 'mysql must register :=');
assert.strictEqual(get_operator('::', 'postgres').spacing, 'none', 'postgres must register :: cast operator');
assert.strictEqual(get_operator('->', 'postgres').spacing, 'none', 'postgres must register -> JSON operator');
assert.strictEqual(get_operator('->>', 'postgres').spacing, 'none', 'postgres must register ->> JSON text operator');
assert.strictEqual(get_operator('#>', 'postgres').spacing, 'surround', 'postgres must register #> JSON path operator');
assert.strictEqual(get_operator('#>>', 'postgres').spacing, 'surround', 'postgres must register #>> JSON text path operator');
assert.strictEqual(get_operator('||', 'postgres').spacing, 'surround', 'postgres must register || concatenation operator');
assert.strictEqual(operatorRegistry.is_registered_operator('<=>', 'generic'), false, 'generic dialect must not claim mysql-only <=>');

console.log('operator matrix tests passed');
