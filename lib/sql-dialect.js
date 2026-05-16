var sqlClauseRegistry = require('./sql-clause-registry');
var sqlOperatorRegistry = require('./sql-operator-registry');

function normalize_dialect(value) {
    var dialect = String(value || 'generic').toLowerCase();
    if (dialect == 'hive' || dialect == 'generic' || dialect == 'postgres' || dialect == 'mysql') {
        return dialect;
    }
    return 'generic';
}

function get_capabilities(value) {
    var dialect = normalize_dialect(value);
    return {
        dialect: dialect,
        dollarQuotedStrings: dialect == 'generic' || dialect == 'postgres',
        hashLineComments: dialect == 'generic' || dialect == 'mysql',
        postgresJsonOperators: dialect == 'generic' || dialect == 'postgres',
        keywordVariants: sqlClauseRegistry.get_keyword_variants(dialect),
        clauseRegistry: sqlClauseRegistry.get_clauses(dialect),
        operatorLookup: sqlOperatorRegistry.get_operator_lookup(dialect)
    };
}

exports.normalize_dialect = normalize_dialect;
exports.get_capabilities = get_capabilities;
