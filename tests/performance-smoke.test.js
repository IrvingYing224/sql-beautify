var assert = require('assert');
var sqlFormatter = require('../lib/sql-formatter');

var simpleUnit = 'select a as col_a, b as col_b from t where x=1 and y=2;\n';
var commentHeavyCaseUnit = [
    'select',
    'case when city_id in (',
    '1001, -- city one',
    '1002 -- city two',
    ") then concat_ws(',', name, city)",
    "else 'unknown'",
    'end as city_label',
    'from dim_user',
    "where ds='2026-05-17' and status=1;"
].join('\n') + '\n';
var nestedListUnit = [
    'select *',
    'from fact_orders',
    'where coalesce(',
    'buyer_id,',
    'payer_id',
    ') in (',
    '1001, -- buyer one',
    '1002 -- buyer two',
    ')',
    'and exists(select 1 from dim_user u where u.id=fact_orders.buyer_id);'
].join('\n') + '\n';
var sql = new Array(1001).join(simpleUnit)
    + new Array(101).join(commentHeavyCaseUnit)
    + new Array(101).join(nestedListUnit);
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
assert.ok(output.indexOf('-- city one') >= 0, 'performance smoke must preserve comment-heavy CASE SQL');
assert.ok(output.indexOf('-- buyer one') >= 0, 'performance smoke must include nested function/list SQL');
assert.ok(
    elapsed < 5000,
    'formatting mixed 1000+ statement corpus should stay under 5000ms on CI-class hardware; actual=' + elapsed + 'ms'
);

console.log('performance smoke tests passed in ' + elapsed + 'ms');
