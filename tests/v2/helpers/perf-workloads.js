'use strict';

function statementSource(count) {
    var values = [];
    for (var index = 0; index < count; index++) {
        values.push('SELECT ' + index + ';');
    }
    return values.join('\n');
}

function formattedListSource(count) {
    var values = [];
    for (var index = 0; index < count; index++) {
        values.push(String(index));
    }
    return 'select  ' + values.join(',  ');
}

function parserSource(statementCount) {
    var statements = [];
    for (var index = 0; index < statementCount; index++) {
        var suffix = String(index).padStart(4, '0');
        statements.push([
            'WITH source_' + suffix + ' AS (',
            'SELECT id, ROW_NUMBER() OVER (PARTITION BY id ORDER BY ts DESC) AS rn',
            'FROM fact_' + suffix + " WHERE ds = '2026-07-13'",
            ') SELECT s.id, d.name FROM source_' + suffix + ' s',
            'LEFT OUTER JOIN dim_' + suffix + ' d ON s.id = d.id',
            'WHERE s.rn = 1 DISTRIBUTE BY s.id SORT BY d.name DESC LIMIT 100;'
        ].join('\n'));
    }
    return statements.join('\n');
}

module.exports = Object.freeze({
    formattedListSource: formattedListSource,
    parserSource: parserSource,
    statementSource: statementSource
});
