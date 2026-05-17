var assert = require('assert');
var sqlFormatter = require('../lib/sql-formatter');

var unit = 'select a as col_a, b as col_b from t where x=1 and y=2;\n';
var sql = new Array(1001).join(unit);
var start = Date.now();

var output = sqlFormatter.format_sql(sql, {
    keywordCase: 'upper',
    commaStyle: 'leading',
    indentStyle: 'space',
    maxAlignWidth: 150,
    caseWhenThenWrapLength: 80,
    dialect: 'generic',
    unsupportedSyntaxPolicy: 'preserve'
});

var elapsed = Date.now() - start;

assert.ok(output.indexOf('SELECT') >= 0, 'performance smoke must produce formatted SQL');
assert.ok(
    elapsed < 5000,
    'formatting 1000 simple statements should stay under 5000ms on CI-class hardware; actual=' + elapsed + 'ms'
);

console.log('performance smoke tests passed in ' + elapsed + 'ms');
