'use strict';

var DEFAULT_SEED = 0x3f202607;
var DEFAULT_CASE_COUNT = 128;
var MIN_CASE_COUNT = 64;
var MAX_CASE_COUNT = 20000;
var UINT32_RANGE = 0x100000000;

var DIALECTS = Object.freeze(['hive', 'generic', 'postgresql', 'mysql']);
var LEFT_FAMILIES = Object.freeze(['expression', 'string', 'quoted', 'case']);
var RIGHT_FAMILIES = Object.freeze(['expression', 'call', 'parameter', 'predicate']);

function assertInteger(name, value, minimum, maximum) {
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
        throw new Error(name + ' must be an integer from ' + minimum +
            ' through ' + maximum + '; received ' + JSON.stringify(value));
    }
    return value;
}

function seededRandom(seed) {
    var state = assertInteger('seed', seed, 1, 0xffffffff) >>> 0;
    function next() {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return state;
    }
    return Object.freeze({
        pick: function(values) {
            if (!Array.isArray(values) || values.length === 0) {
                throw new Error('pick requires a non-empty array');
            }
            return values[Math.floor(next() / UINT32_RANGE * values.length)];
        },
        integerBelow: function(limit) {
            assertInteger('limit', limit, 1, 0xffffffff);
            return Math.floor(next() / UINT32_RANGE * limit);
        }
    });
}

function quotedIdentifier(dialect) {
    return dialect === 'hive' || dialect === 'mysql'
        ? '`Mixed Name`'
        : '"Mixed Name"';
}

function nativeParameter(dialect) {
    if (dialect === 'hive') {
        return '?';
    }
    if (dialect === 'generic') {
        return ':value';
    }
    if (dialect === 'postgresql') {
        return '$1';
    }
    return '@value';
}

function leftExpression(family, dialect) {
    if (family === 'expression') {
        return 'a+1';
    }
    if (family === 'string') {
        return "'FROM  x'";
    }
    if (family === 'quoted') {
        return quotedIdentifier(dialect);
    }
    return 'case when a=1 then 2 else 3 end';
}

function rightExpression(family, dialect) {
    if (family === 'expression') {
        return 'b*2';
    }
    if (family === 'call') {
        return 'coalesce(b,0)';
    }
    if (family === 'parameter') {
        return nativeParameter(dialect);
    }
    return 'not flag';
}

function buildDeterministicFormatterFuzzCases(count, seed) {
    assertInteger('count', count, MIN_CASE_COUNT, MAX_CASE_COUNT);
    var random = seededRandom(seed);
    var whitespace = Object.freeze([' ', '  ', '\n', '\t']);
    var values = [];
    for (var index = 0; index < count; index++) {
        var dialect = DIALECTS[index % DIALECTS.length];
        var leftFamily = LEFT_FAMILIES[
            Math.floor(index / DIALECTS.length) % LEFT_FAMILIES.length
        ];
        var rightFamily = RIGHT_FAMILIES[
            Math.floor(index / (DIALECTS.length * LEFT_FAMILIES.length)) %
                RIGHT_FAMILIES.length
        ];
        var commentKind = index % 11 === 0 ? 'line-comment' : 'block-comment';
        var comment = commentKind === 'line-comment'
            ? '-- fuzz ' + index + '\n'
            : '/* fuzz ' + index + ' */';
        var source = random.pick(['select', 'SELECT', 'SeLeCt']) +
            random.pick(whitespace) + leftExpression(leftFamily, dialect) +
            random.pick(whitespace) + 'as x,' + random.pick(whitespace) +
            comment + random.pick(whitespace) +
            rightExpression(rightFamily, dialect) +
            random.pick(whitespace) + 'as y' + random.pick(whitespace) +
            random.pick(['from', 'FROM', 'FrOm']) + random.pick(whitespace) +
            't where a=1 and b>2';
        values.push(Object.freeze({
            id: 'fuzz/' + index,
            source: source,
            options: Object.freeze({
                dialect: dialect,
                keywordCase: random.pick(['upper', 'lower']),
                commaStyle: random.pick(['leading', 'trailing']),
                indentStyle: random.pick(['space', 'tab']),
                caseLayout: random.pick(['expanded', 'compactShort']),
                caseWhenThenWrapLength: 20 + random.integerBelow(80),
                maxAlignWidth: 40 + random.integerBelow(120),
                unsupportedSyntaxPolicy: random.pick([
                    'warn',
                    'preserve',
                    'bail_out'
                ])
            }),
            fuzzDimensions: Object.freeze({
                dialect: dialect,
                leftFamily: leftFamily,
                rightFamily: rightFamily,
                commentKind: commentKind
            })
        }));
    }
    return Object.freeze(values);
}

module.exports = Object.freeze({
    DEFAULT_SEED: DEFAULT_SEED,
    DEFAULT_CASE_COUNT: DEFAULT_CASE_COUNT,
    MIN_CASE_COUNT: MIN_CASE_COUNT,
    MAX_CASE_COUNT: MAX_CASE_COUNT,
    DIALECTS: DIALECTS,
    LEFT_FAMILIES: LEFT_FAMILIES,
    RIGHT_FAMILIES: RIGHT_FAMILIES,
    buildDeterministicFormatterFuzzCases: buildDeterministicFormatterFuzzCases
});
