var tokenizer = require('./sql-tokenizer');

var KEYWORDS = [
    'ADD', 'ALL', 'ALTER', 'AND', 'ANTI', 'AS', 'ASC', 'AVG', 'BETWEEN',
    'BIGINT', 'BOOLEAN', 'BY', 'CASE', 'CAST', 'CEIL', 'CLUSTER', 'COLUMNS',
    'COUNT', 'CREATE', 'CROSS', 'CUBE', 'CURRENT', 'DATE', 'DATEDIFF',
    'DECIMAL', 'DELETE', 'DESC', 'DISTINCT', 'DISTRIBUTE', 'DOUBLE', 'DROP',
    'ELSE', 'END', 'EXCEPT', 'EXISTS', 'EXPLODE', 'EXTERNAL', 'FALSE',
    'FLOAT', 'FLOOR', 'FOLLOWING', 'FROM', 'FULL', 'GROUP', 'GROUPING',
    'HAVING', 'IN', 'INNER', 'INSERT', 'INT', 'INTERSECT', 'INTO',
    'IS', 'JAR', 'JOIN', 'LATERAL', 'LEFT', 'LIKE', 'LIMIT', 'MAX', 'MIN',
    'NOT', 'NULL', 'ON', 'OR', 'ORDER', 'OUTER', 'OVER', 'OVERWRITE',
    'PARQUET', 'PARTITION', 'PARTITIONED', 'POSEXPLODE', 'PRECEDING',
    'REGEXP', 'RIGHT', 'RLIKE', 'ROLLUP', 'ROW', 'ROWS', 'ROW_NUMBER',
    'SELECT', 'SEMI', 'SET', 'SETS', 'SORT', 'STORED', 'STRING', 'SUM', 'TABLE',
    'TBLPROPERTIES', 'THEN', 'TIMESTAMP', 'TRUE', 'UNBOUNDED', 'UNION',
    'USING', 'VIEW', 'WHEN', 'WHERE', 'WITH'
];

var KEYWORD_LOOKUP = {};
for (var i = 0; i < KEYWORDS.length; i++) {
    KEYWORD_LOOKUP[KEYWORDS[i]] = true;
}

function is_keyword(word) {
    return KEYWORD_LOOKUP[String(word || '').toUpperCase()] === true;
}

function apply_keyword_case(text, uppercase) {
    var tokens = tokenizer.tokenize(text);

    for (var i = 0; i < tokens.length; i++) {
        if (tokens[i].type == 'word' && is_keyword(tokens[i].value)) {
            tokens[i].value = uppercase === false
                ? tokens[i].value.toLowerCase()
                : tokens[i].value.toUpperCase();
        }
    }

    return tokenizer.join_tokens(tokens);
}

exports.is_keyword = is_keyword;
exports.apply_keyword_case = apply_keyword_case;
