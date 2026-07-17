'use strict';

module.exports = Object.freeze([
    {
        id: 'hive-no-from-minimal',
        source: 'select    1',
        options: { dialect: 'hive', keywordCase: 'upper' },
        expected: 'SELECT 1',
        status: 'formatted'
    },
    {
        id: 'hive-no-from-adjacent-head-body',
        source: 'select(1)',
        options: { dialect: 'hive', keywordCase: 'upper' },
        expected: 'SELECT (1)',
        status: 'formatted'
    },
    {
        id: 'hive-keyword-shaped-names-lower',
        source: 'SELECT    WINDOW AS ORDER',
        options: { dialect: 'hive', keywordCase: 'lower' },
        expected: 'select WINDOW as ORDER',
        status: 'formatted'
    },
    {
        id: 'hive-protected-and-quoted-exact',
        source: "select    'FROM  x' as `ORDER`",
        options: { dialect: 'hive', keywordCase: 'upper' },
        expected: "SELECT 'FROM  x' AS `ORDER`",
        status: 'formatted'
    },
    {
        id: 'hive-unformatted-function-child',
        source: 'select     f(  1 )',
        options: { dialect: 'hive', keywordCase: 'upper' },
        expected: 'SELECT f(  1 )',
        status: 'formatted'
    },
    {
        id: 'hive-eof-line-comment',
        source: 'select     1 -- keep FROM',
        options: { dialect: 'hive', keywordCase: 'upper' },
        expected: 'SELECT 1 -- keep FROM',
        status: 'formatted'
    },
    {
        id: 'hive-final-crlf-presence',
        source: 'select\r\n1\r\n',
        options: { dialect: 'hive', keywordCase: 'upper' },
        expected: 'SELECT 1\r\n',
        status: 'formatted'
    },
    {
        id: 'generic-no-from-remains-verbatim',
        source: 'select    1',
        options: { dialect: 'generic', keywordCase: 'upper' },
        expected: 'select    1',
        status: 'unchanged'
    },
    {
        id: 'hive-from-remains-verbatim',
        source: 'select    a from t',
        options: { dialect: 'hive', keywordCase: 'upper' },
        expected: 'select    a from t',
        status: 'unchanged'
    }
].map(function(testCase) {
    return Object.freeze({
        id: testCase.id,
        source: testCase.source,
        options: Object.freeze(testCase.options),
        expected: testCase.expected,
        status: testCase.status
    });
}));
