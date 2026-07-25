'use strict';

var assert = require('assert');
var formatApi = require('../../.tmp/v2-core/core/api/format.js');
var lexerApi = require('../../.tmp/v2-core/core/lexer/lossless-lexer.js');

var SOURCE = "select case when a=1 then 'FROM' else 'y' end as x, b as y from t";
var dimensions = {
    keywordCase: ['upper', 'lower'],
    commaStyle: ['leading', 'trailing'],
    indentStyle: ['space', 'tab'],
    caseLayout: ['expanded', 'compactShort'],
    caseWhenThenWrapLength: [10, 200]
};

function protectedRows(source) {
    return lexerApi.lexSql(source, { dialect: 'hive' }).leaves.filter(function(leaf) {
        return leaf.channel === 'protected';
    }).map(function(leaf) {
        return [leaf.kind, leaf.raw];
    });
}

var outputs = new Map();
var runCount = 0;

dimensions.keywordCase.forEach(function(keywordCase) {
    dimensions.commaStyle.forEach(function(commaStyle) {
        dimensions.indentStyle.forEach(function(indentStyle) {
            dimensions.caseLayout.forEach(function(caseLayout) {
                dimensions.caseWhenThenWrapLength.forEach(function(threshold) {
                    var options = {
                        dialect: 'hive',
                        keywordCase: keywordCase,
                        commaStyle: commaStyle,
                        indentStyle: indentStyle,
                        caseLayout: caseLayout,
                        caseWhenThenWrapLength: threshold
                    };
                    var id = [
                        keywordCase,
                        commaStyle,
                        indentStyle,
                        caseLayout,
                        threshold
                    ].join('/');
                    var first = formatApi.formatSql(SOURCE, options);
                    assert.strictEqual(first.status, 'formatted', id);
                    assert.deepStrictEqual(
                        protectedRows(first.text),
                        protectedRows(SOURCE),
                        id + ' protected bytes'
                    );
                    assert.strictEqual(
                        first.text.split('\n')[0],
                        keywordCase === 'upper' ? 'SELECT' : 'select',
                        id + ' keywordCase'
                    );
                    assert.strictEqual(
                        first.text.indexOf(keywordCase === 'upper' ? 'FROM t' : 'from t') >= 0,
                        true,
                        id + ' clause keywordCase'
                    );
                    assert.strictEqual(
                        first.text.indexOf("'FROM'") >= 0,
                        true,
                        id + ' literal case exactness'
                    );
                    var itemIndent = indentStyle === 'space' ? '    ' : '\t';
                    assert.strictEqual(
                        first.text.split('\n')[1].indexOf(itemIndent),
                        0,
                        id + ' indentStyle'
                    );
                    if (commaStyle === 'leading') {
                        assert.ok(
                            first.text.indexOf('\n' + itemIndent + ', b') >= 0,
                            id + ' leading comma'
                        );
                    } else {
                        var trailingEnd = keywordCase === 'upper'
                            ? 'END AS x,\n'
                            : 'end as x,\n';
                        assert.ok(
                            first.text.indexOf(trailingEnd) >= 0,
                            id + ' trailing comma'
                        );
                    }
                    var caseWord = keywordCase === 'upper' ? 'CASE' : 'case';
                    var whenWord = keywordCase === 'upper' ? 'WHEN' : 'when';
                    var compact = caseLayout === 'compactShort' && threshold === 200;
                    assert.strictEqual(
                        first.text.indexOf(caseWord + ' ' + whenWord) >= 0,
                        compact,
                        id + ' case layout/threshold'
                    );
                    var second = formatApi.formatSql(first.text, options);
                    assert.strictEqual(second.status, 'unchanged', id + ' repeat');
                    assert.strictEqual(second.text, first.text, id + ' idempotency');
                    outputs.set(id, first.text);
                    runCount += 1;
                });
            });
        });
    });
});

assert.strictEqual(runCount, 32, 'full five-dimension Cartesian matrix');

function output(options) {
    return outputs.get([
        options.keywordCase,
        options.commaStyle,
        options.indentStyle,
        options.caseLayout,
        options.caseWhenThenWrapLength
    ].join('/'));
}

var base = {
    keywordCase: 'upper',
    commaStyle: 'leading',
    indentStyle: 'space',
    caseLayout: 'compactShort',
    caseWhenThenWrapLength: 200
};
Object.keys(dimensions).forEach(function(key) {
    var changed = Object.assign({}, base);
    changed[key] = dimensions[key][0] === base[key]
        ? dimensions[key][1]
        : dimensions[key][0];
    assert.notStrictEqual(
        output(base),
        output(changed),
        key + ' must not be dead configuration'
    );
});

var COMMENT_SOURCE = [
    'select aaaaaaaaaa as x -- c1',
    ', b as y -- c2',
    ', cc as z -- c3',
    'from t'
].join('\n');
var commentLeading = formatApi.formatSql(COMMENT_SOURCE, {
    dialect: 'hive',
    commaStyle: 'leading'
});
var commentTrailing = formatApi.formatSql(COMMENT_SOURCE, {
    dialect: 'hive',
    commaStyle: 'trailing'
});
assert.strictEqual(commentLeading.status, 'formatted');
assert.strictEqual(commentTrailing.status, 'formatted');
assert.strictEqual(
    commentTrailing.text,
    [
        'SELECT',
        '    aaaaaaaaaa AS x -- c1',
        '    , b        AS y -- c2',
        '    , cc       AS z -- c3',
        'FROM t'
    ].join('\n'),
    'trailing style must locally fall back only at blocked separator boundaries'
);
assert.ok(
    commentTrailing.text.indexOf('-- c1\n    , b') >= 0,
    'a comment-before-separator boundary must keep the separator on the next leading-comma line'
);
assert.strictEqual(
    formatApi.formatSql(commentTrailing.text, {
        dialect: 'hive',
        commaStyle: 'trailing'
    }).status,
    'unchanged',
    'local comma fallback must be idempotent'
);

var noCommentTrailing = formatApi.formatSql(
    'select aaaaaaaaaa as x, b as y, cc as z from t',
    { dialect: 'hive', commaStyle: 'trailing' }
);
assert.ok(
    noCommentTrailing.text.indexOf('AS x,\n') >= 0,
    'trailing style must remain active when no line comment blocks source order'
);

var blockCommentTrailing = formatApi.formatSql(
    'select aaaaaaaaaa as x /* c1 */, b as y /* c2 */, cc as z from t',
    { dialect: 'hive', commaStyle: 'trailing' }
);
assert.ok(
    blockCommentTrailing.text.indexOf('/* c1 */,\n') >= 0,
    'block comments must not force the line-comment fallback'
);

console.log('v2 Wave 3E option Cartesian matrix tests passed');
