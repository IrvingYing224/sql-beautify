var DIALECTS = ['generic', 'hive', 'postgres', 'mysql'];

var OPERATORS = [
    { value: '=', dialects: DIALECTS, spacing: 'surround' },
    { value: '!=', dialects: DIALECTS, spacing: 'surround' },
    { value: '<>', dialects: DIALECTS, spacing: 'surround' },
    { value: '<=', dialects: DIALECTS, spacing: 'surround' },
    { value: '>=', dialects: DIALECTS, spacing: 'surround' },
    { value: '<', dialects: DIALECTS, spacing: 'surround' },
    { value: '>', dialects: DIALECTS, spacing: 'surround' },
    { value: '<=>', dialects: ['mysql'], spacing: 'surround' },
    { value: ':=', dialects: ['mysql'], spacing: 'surround' },
    { value: '::', dialects: ['postgres'], spacing: 'none' },
    { value: '->', dialects: ['generic', 'postgres'], spacing: 'none' },
    { value: '->>', dialects: ['generic', 'postgres'], spacing: 'none' },
    { value: '#>', dialects: ['postgres'], spacing: 'surround' },
    { value: '#>>', dialects: ['postgres'], spacing: 'surround' },
    { value: '||', dialects: ['generic', 'postgres'], spacing: 'surround' }
];

function normalize_dialect(value) {
    return String(value || 'generic').toLowerCase();
}

function get_operators(dialect) {
    var normalized = normalize_dialect(dialect);
    return OPERATORS.filter(function(operator) {
        return operator.dialects.indexOf(normalized) >= 0;
    });
}

function get_operator_lookup(dialect) {
    var lookup = {};
    var operators = get_operators(dialect);

    for (var i = 0; i < operators.length; i++) {
        lookup[operators[i].value] = operators[i];
    }

    return lookup;
}

function is_registered_operator(value, dialect) {
    return !!get_operator_lookup(dialect)[value];
}

exports.OPERATORS = OPERATORS;
exports.get_operators = get_operators;
exports.get_operator_lookup = get_operator_lookup;
exports.is_registered_operator = is_registered_operator;
