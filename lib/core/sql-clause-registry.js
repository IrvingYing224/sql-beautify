var DIALECTS = ['generic', 'hive', 'postgres', 'mysql'];

var CLAUSES = [
    { name: 'DROP', keywords: ['DROP'], dialects: DIALECTS, selectStart: false, selectEnd: false, conditionReset: true, statementStart: true, rangeStart: true },
    { name: 'CREATE', keywords: ['CREATE'], dialects: DIALECTS, selectStart: false, selectEnd: false, conditionReset: true, statementStart: true, rangeStart: true },
    { name: 'ALTER', keywords: ['ALTER'], dialects: DIALECTS, selectStart: false, selectEnd: false, conditionReset: true, statementStart: true, rangeStart: true },
    { name: 'INSERT', keywords: ['INSERT'], dialects: DIALECTS, selectStart: false, selectEnd: false, conditionReset: true, statementStart: true, rangeStart: true },
    { name: 'DELETE', keywords: ['DELETE'], dialects: DIALECTS, selectStart: false, selectEnd: false, conditionReset: true, statementStart: true, rangeStart: true },
    { name: 'SET', keywords: ['SET'], dialects: DIALECTS, selectStart: false, selectEnd: false, conditionReset: true, statementStart: true, rangeStart: true },
    { name: 'WITH', keywords: ['WITH'], dialects: DIALECTS, selectStart: false, selectEnd: false, conditionReset: true, rangeStart: true },
    { name: 'RECURSIVE', keywords: ['RECURSIVE'], dialects: ['generic', 'postgres'], selectStart: false, selectEnd: false, conditionReset: false },
    { name: 'SELECT', keywords: ['SELECT'], dialects: DIALECTS, selectStart: true, selectEnd: false, conditionReset: true, rangeStart: true },
    { name: 'VALUES', keywords: ['VALUES'], dialects: ['generic', 'postgres', 'mysql'], selectStart: false, selectEnd: false, conditionReset: true },
    { name: 'FROM', keywords: ['FROM'], dialects: DIALECTS, selectStart: false, selectEnd: true, conditionReset: true },
    { name: 'JOIN', keywords: ['JOIN'], dialects: DIALECTS, selectStart: false, selectEnd: true, conditionReset: true },
    { name: 'LEFT JOIN', keywords: ['LEFT', 'JOIN'], dialects: DIALECTS, selectStart: false, selectEnd: true, conditionReset: true },
    { name: 'LEFT OUTER JOIN', keywords: ['LEFT', 'OUTER', 'JOIN'], dialects: DIALECTS, selectStart: false, selectEnd: true, conditionReset: true },
    { name: 'RIGHT JOIN', keywords: ['RIGHT', 'JOIN'], dialects: DIALECTS, selectStart: false, selectEnd: true, conditionReset: true },
    { name: 'RIGHT OUTER JOIN', keywords: ['RIGHT', 'OUTER', 'JOIN'], dialects: DIALECTS, selectStart: false, selectEnd: true, conditionReset: true },
    { name: 'FULL JOIN', keywords: ['FULL', 'JOIN'], dialects: DIALECTS, selectStart: false, selectEnd: true, conditionReset: true },
    { name: 'FULL OUTER JOIN', keywords: ['FULL', 'OUTER', 'JOIN'], dialects: DIALECTS, selectStart: false, selectEnd: true, conditionReset: true },
    { name: 'INNER JOIN', keywords: ['INNER', 'JOIN'], dialects: DIALECTS, selectStart: false, selectEnd: true, conditionReset: true },
    { name: 'CROSS JOIN', keywords: ['CROSS', 'JOIN'], dialects: DIALECTS, selectStart: false, selectEnd: true, conditionReset: true },
    { name: 'LEFT SEMI JOIN', keywords: ['LEFT', 'SEMI', 'JOIN'], dialects: ['generic', 'hive'], selectStart: false, selectEnd: true, conditionReset: true },
    { name: 'LEFT ANTI JOIN', keywords: ['LEFT', 'ANTI', 'JOIN'], dialects: ['generic', 'hive'], selectStart: false, selectEnd: true, conditionReset: true },
    { name: 'ON', keywords: ['ON'], dialects: DIALECTS, selectStart: false, selectEnd: true, conditionReset: false, conditionClause: true },
    { name: 'WHERE', keywords: ['WHERE'], dialects: DIALECTS, selectStart: false, selectEnd: true, conditionReset: false, conditionClause: true },
    { name: 'HAVING', keywords: ['HAVING'], dialects: DIALECTS, selectStart: false, selectEnd: true, conditionReset: false, conditionClause: true },
    { name: 'QUALIFY', keywords: ['QUALIFY'], dialects: ['generic', 'postgres', 'hive', 'mysql'], selectStart: false, selectEnd: true, conditionReset: false, conditionClause: true },
    { name: 'GROUP BY', keywords: ['GROUP', 'BY'], dialects: DIALECTS, selectStart: true, selectEnd: false, conditionReset: true },
    { name: 'ORDER BY', keywords: ['ORDER', 'BY'], dialects: DIALECTS, selectStart: false, selectEnd: true, conditionReset: true },
    { name: 'SORT BY', keywords: ['SORT', 'BY'], dialects: ['generic', 'hive'], selectStart: false, selectEnd: true, conditionReset: true },
    { name: 'CLUSTER BY', keywords: ['CLUSTER', 'BY'], dialects: ['generic', 'hive'], selectStart: false, selectEnd: true, conditionReset: true },
    { name: 'DISTRIBUTE BY', keywords: ['DISTRIBUTE', 'BY'], dialects: ['generic', 'hive'], selectStart: false, selectEnd: true, conditionReset: true },
    { name: 'LIMIT', keywords: ['LIMIT'], dialects: DIALECTS, selectStart: false, selectEnd: true, conditionReset: true },
    { name: 'UNION', keywords: ['UNION'], dialects: DIALECTS, selectStart: false, selectEnd: true, conditionReset: true },
    { name: 'INTERSECT', keywords: ['INTERSECT'], dialects: ['generic', 'postgres'], selectStart: false, selectEnd: true, conditionReset: true },
    { name: 'EXCEPT', keywords: ['EXCEPT'], dialects: ['generic', 'postgres'], selectStart: false, selectEnd: true, conditionReset: true }
];

function normalize_dialect(value) {
    return String(value || 'generic').toLowerCase();
}

function supports_clause(clause, dialect) {
    return clause.dialects.indexOf(normalize_dialect(dialect)) >= 0;
}

function get_clauses(dialect) {
    var normalized = normalize_dialect(dialect);
    return CLAUSES.filter(function(clause) {
        return supports_clause(clause, normalized);
    });
}

function clause_matches_line(line, clause) {
    var trimmed = String(line || '').replace(/^\s+/g, '');
    var keywords = clause.keywords.join('\\s+');
    return new RegExp('^' + keywords + '\\b', 'i').test(trimmed);
}

function line_starts_clause(line, dialect, predicate_name) {
    return get_matching_clause(line, dialect, predicate_name) != null;
}

function get_matching_clause(line, dialect, predicate_name) {
    var clauses = get_clauses(dialect);

    for (var i = 0; i < clauses.length; i++) {
        if (predicate_name && clauses[i][predicate_name] !== true) {
            continue;
        }
        if (clause_matches_line(line, clauses[i])) {
            return clauses[i];
        }
    }

    return null;
}

function is_select_block_start(line, dialect) {
    return line_starts_clause(line, dialect, 'selectStart');
}

function is_select_block_end(line, dialect) {
    return line_starts_clause(line, dialect, 'selectEnd');
}

function is_condition_clause(line, dialect) {
    return line_starts_clause(line, dialect, 'conditionClause');
}

function get_condition_clause(line, dialect) {
    return get_matching_clause(line, dialect, 'conditionClause');
}

function resets_condition_alignment(line, dialect) {
    return line_starts_clause(line, dialect, 'conditionReset');
}

function is_statement_start(line, dialect) {
    return line_starts_clause(line, dialect, 'statementStart');
}

function is_range_start(line, dialect) {
    return line_starts_clause(line, dialect, 'rangeStart')
        || is_statement_start(line, dialect)
        || is_select_block_start(line, dialect)
        || is_condition_clause(line, dialect);
}

function get_keyword_variants(dialect) {
    var variants = {};
    var clauses = get_clauses(dialect);

    for (var i = 0; i < clauses.length; i++) {
        for (var j = 0; j < clauses[i].keywords.length; j++) {
            variants[clauses[i].keywords[j].toUpperCase()] = true;
        }
    }

    return Object.keys(variants);
}

exports.CLAUSES = CLAUSES;
exports.get_clauses = get_clauses;
exports.is_select_block_start = is_select_block_start;
exports.is_select_block_end = is_select_block_end;
exports.is_condition_clause = is_condition_clause;
exports.get_condition_clause = get_condition_clause;
exports.resets_condition_alignment = resets_condition_alignment;
exports.is_statement_start = is_statement_start;
exports.is_range_start = is_range_start;
exports.get_keyword_variants = get_keyword_variants;
