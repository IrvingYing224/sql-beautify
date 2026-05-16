var assert = require('assert');
var clauseRegistry = require('../lib/sql-clause-registry');

assert.ok(clauseRegistry.is_select_block_start('SELECT a', 'generic'), 'SELECT must start a select block');
assert.ok(clauseRegistry.is_select_block_start('GROUP BY a', 'generic'), 'GROUP BY must start a grouped item block');
assert.ok(clauseRegistry.is_select_block_end('FROM t', 'generic'), 'FROM must end a select block');
assert.ok(clauseRegistry.is_select_block_end('QUALIFY rn = 1', 'postgres'), 'QUALIFY must terminate select item alignment scope');
assert.ok(clauseRegistry.is_condition_clause('QUALIFY rn = 1', 'postgres'), 'QUALIFY must be a condition-like clause');
assert.ok(clauseRegistry.resets_condition_alignment('VALUES (1,2)', 'postgres'), 'VALUES must reset condition alignment state');
assert.ok(clauseRegistry.get_keyword_variants('postgres').indexOf('RECURSIVE') >= 0, 'postgres keyword registry must include RECURSIVE');
assert.ok(clauseRegistry.get_keyword_variants('postgres').indexOf('QUALIFY') >= 0, 'postgres keyword registry must include QUALIFY');

console.log('clause registry tests passed');
