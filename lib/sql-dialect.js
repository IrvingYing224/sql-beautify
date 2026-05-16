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
        postgresJsonOperators: dialect == 'generic' || dialect == 'postgres'
    };
}

exports.normalize_dialect = normalize_dialect;
exports.get_capabilities = get_capabilities;
