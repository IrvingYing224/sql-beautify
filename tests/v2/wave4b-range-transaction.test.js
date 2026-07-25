var assert = require('assert');
var range = require('../../.tmp/v2-core/adapters/transaction/range');

function target(id, start, end, mode) {
    return { id: id, start: start, end: end, mode: mode || 'fragment' };
}

function valid(source, targets, dialect) {
    return range.validateFormatTargetRanges(source, targets, {
        dialect: dialect || 'hive'
    });
}

function assertInvalid(result, code, targetId) {
    assert.strictEqual(result.status, 'invalid');
    assert.strictEqual(result.code, code);
    assert.strictEqual(result.targetId, targetId);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(result, 'source'), false);
    assert.strictEqual(Object.isFrozen(result), true);
}

var source = 'select a,\n       b\nfrom t\nwhere x = 1\n';
var selectEnd = source.indexOf('\nfrom');
var fromStart = source.indexOf('from');
var fromEnd = source.indexOf('\n', fromStart);
var whereStart = source.indexOf('where');
var whereEnd = source.indexOf('\n', whereStart);

var selectClause = valid(source, [target('select', 0, selectEnd)]);
assert.strictEqual(selectClause.status, 'valid', 'complete SELECT clause is a valid fragment');
var fromClause = valid(source, [target('from', fromStart, fromEnd)]);
assert.strictEqual(fromClause.status, 'valid', 'complete FROM clause is a valid fragment');
var endBeforeNewline = valid(source, [target('where', whereStart, whereEnd)]);
assert.strictEqual(endBeforeNewline.status, 'valid', 'end immediately before newline is accepted');

var withNewline = valid(source, [target('where-with-newline', whereStart, whereEnd + 1)]);
assert.strictEqual(withNewline.status, 'valid', 'end after newline is accepted');
assert.strictEqual(
    valid(source, [
        target('from-batch', fromStart, fromEnd),
        target('where-batch', whereStart, whereEnd)
    ]).status,
    'valid',
    'multiple fragments are validated against one full-source analysis'
);

var partialLine = valid(source, [target('partial', 1, selectEnd)]);
assertInvalid(partialLine, 'ADAPTER_RANGE_LINE', 'partial');
var continuation = valid(source, [target('continuation', source.indexOf('b'), whereEnd)]);
assertInvalid(continuation, 'ADAPTER_RANGE_LINE', 'continuation');

var stringSource = "select 'a\\nb' from t\n";
var stringStart = stringSource.indexOf("'a");
var stringEnd = stringSource.indexOf("'", stringStart + 1) + 1;
assertInvalid(
    valid(stringSource, [target('string-inside', stringStart + 3, stringEnd)]),
    'ADAPTER_RANGE_PROTECTED',
    'string-inside'
);
var commentSource = 'select a /* comment */ from t\n';
var commentStart = commentSource.indexOf('/*');
assertInvalid(
    valid(commentSource, [target('comment-inside', 0, commentStart + 3)]),
    'ADAPTER_RANGE_PROTECTED',
    'comment-inside'
);
var quotedSource = 'select `a` from t\n';
var quotedStart = quotedSource.indexOf('`');
assertInvalid(
    valid(quotedSource, [target('quoted-inside', 0, quotedStart + 2)]),
    'ADAPTER_RANGE_PROTECTED',
    'quoted-inside'
);
var parameterSource = 'select ${param} from t\n';
var parameterStart = parameterSource.indexOf('${');
assertInvalid(
    valid(parameterSource, [target('parameter-inside', 0, parameterStart + 3)]),
    'ADAPTER_RANGE_PROTECTED',
    'parameter-inside'
);

var listSource = 'select\n  a,\n  b\nfrom t\n';
var listStart = listSource.indexOf('\n') + 1;
var listEnd = listSource.indexOf('\nfrom');
assert.strictEqual(
    valid(listSource, [target('select-list', listStart, listEnd)]).status,
    'valid',
    'complete list boundary is accepted'
);
assertInvalid(
    valid(listSource, [target('list-item', listStart, listSource.indexOf('\n', listStart))]),
    'ADAPTER_RANGE_OWNERSHIP',
    'list-item'
);
assertInvalid(
    valid(source, [target('mixed-clauses', fromStart, whereEnd)]),
    'ADAPTER_RANGE_OWNERSHIP',
    'mixed-clauses'
);

var empty = valid(source, [target('empty', 3, 3)]);
assert.strictEqual(empty.status, 'valid', 'empty fragments are valid at arbitrary offsets');
var documentTarget = valid(source, [target('document', 0, source.length, 'document')]);
assert.strictEqual(documentTarget.status, 'valid', 'document target only requires full range');
assert.strictEqual(
    valid('select (\n', [target('malformed-document', 0, 9, 'document')]).status,
    'valid',
    'document target validation checks only that the complete source is covered'
);
assertInvalid(
    valid(source, [target('bad-document', 0, source.length - 1, 'document')]),
    'ADAPTER_RANGE_DOCUMENT',
    'bad-document'
);

var malformed = 'select (\n';
assertInvalid(
    valid(malformed, [target('malformed', 0, malformed.length)]),
    'ADAPTER_RANGE_ANALYSIS',
    'malformed'
);
var opaque = 'select a\nqualify row_number() over (order by a)=1\n';
assertInvalid(
    valid(opaque, [target('opaque', 0, opaque.indexOf('\n'))]),
    'ADAPTER_RANGE_OPAQUE',
    'opaque'
);

var outOfBounds = valid(source, [target('outside', 0, source.length + 1)]);
assertInvalid(outOfBounds, 'ADAPTER_RANGE_TARGET', 'outside');
var transparentTargetProxy = new Proxy(target('proxy', 0, selectEnd), {});
assertInvalid(valid(source, [transparentTargetProxy]), 'ADAPTER_RANGE_TARGET', null);
assertInvalid(
    range.validateFormatTargetRanges(source, new Proxy([target('proxy-array', 0, selectEnd)], {}), {
        dialect: 'hive'
    }),
    'ADAPTER_RANGE_TARGET',
    null
);
var dialectReads = 0;
var dynamicRangeOptions = {};
Object.defineProperty(dynamicRangeOptions, 'dialect', {
    enumerable: true,
    get: function() {
        dialectReads += 1;
        return dialectReads == 1 ? 'hive' : 'generic';
    }
});
assertInvalid(
    range.validateFormatTargetRanges(source, [target('dynamic-options', 0, selectEnd)],
        dynamicRangeOptions),
    'ADAPTER_RANGE_ANALYSIS',
    null
);
assert.strictEqual(dialectReads, 0, 'range option accessors must never execute');
assertInvalid(
    range.validateFormatTargetRanges(source, [target('proxy-options', 0, selectEnd)],
        new Proxy({ dialect: 'hive' }, {})),
    'ADAPTER_RANGE_ANALYSIS',
    null
);
assertInvalid(
    range.validateFormatTargetRanges(source, [target('unknown-options', 0, selectEnd)],
        { unknownOption: true }),
    'ADAPTER_RANGE_ANALYSIS',
    null
);
assertInvalid(
    valid(source, [target('no-expansion', whereStart, whereEnd - 2)]),
    'ADAPTER_RANGE_LINE',
    'no-expansion'
);

['hive', 'generic', 'postgresql', 'mysql'].forEach(function(dialect) {
    var sql = 'select a from t\n';
    assert.strictEqual(
        valid(sql, [target(dialect, 0, sql.length - 1)], dialect).status,
        'valid',
        dialect + ' document-line fragment must be accepted'
    );
});

var stable = valid(source, [target('stable', fromStart, fromEnd)]);
assert.strictEqual(Object.isFrozen(stable), true);
assert.strictEqual(Object.isFrozen(stable.diagnostics), true);
console.log('v2 Wave 4B range transaction tests passed');
