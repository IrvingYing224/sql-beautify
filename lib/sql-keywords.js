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

function get_previous_code_token(tokens, index) {
    for (var i = index - 1; i >= 0; i--) {
        if (tokens[i].type != 'whitespace' && tokens[i].type != 'newline') {
            return tokens[i];
        }
    }

    return null;
}

function get_next_code_token(tokens, index) {
    for (var i = index + 1; i < tokens.length; i++) {
        if (tokens[i].type != 'whitespace' && tokens[i].type != 'newline') {
            return tokens[i];
        }
    }

    return null;
}

function is_dot_token(token) {
    return token != null && token.type == 'punctuation' && token.value == '.';
}

function is_dotted_identifier_part(tokens, index) {
    return is_dot_token(get_previous_code_token(tokens, index))
        || is_dot_token(get_next_code_token(tokens, index));
}

function apply_keyword_case(text, uppercase) {
    var tokens = tokenizer.tokenize(text);
    var in_set_payload = false;

    for (var i = 0; i < tokens.length; i++) {
        if (tokens[i].type == 'newline'
            || tokens[i].type == 'punctuation' && tokens[i].value == ';') {
            in_set_payload = false;
        }

        if (tokens[i].type == 'word' && is_keyword(tokens[i].value)) {
            if (in_set_payload || is_dotted_identifier_part(tokens, i)) {
                continue;
            }

            tokens[i].value = uppercase === false
                ? tokens[i].value.toLowerCase()
                : tokens[i].value.toUpperCase();

            if (tokens[i].value.toUpperCase() == 'SET') {
                in_set_payload = true;
            }
        }
    }

    return tokenizer.join_tokens(tokens);
}

exports.is_keyword = is_keyword;
exports.apply_keyword_case = apply_keyword_case;
