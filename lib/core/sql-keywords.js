var tokenizer = require('./sql-tokenizer');
var sqlClauseRegistry = require('./sql-clause-registry');

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

function build_keyword_lookup(tokenizer_options) {
    var lookup = {};
    var variants = (tokenizer_options && tokenizer_options.keywordVariants)
        || sqlClauseRegistry.get_keyword_variants((tokenizer_options && tokenizer_options.dialect) || 'generic');

    for (var i = 0; i < KEYWORDS.length; i++) {
        lookup[KEYWORDS[i]] = true;
    }

    for (var j = 0; j < variants.length; j++) {
        lookup[String(variants[j] || '').toUpperCase()] = true;
    }

    return lookup;
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

function is_if_not_exists(tokens, index) {
    var next = get_next_code_token(tokens, index);
    if (!next || next.type != 'word' || !/^NOT$/i.exec(next.value)) {
        return false;
    }

    var next_index = tokens.indexOf(next);
    var after_next = get_next_code_token(tokens, next_index);
    return after_next && after_next.type == 'word' && /^EXISTS$/i.exec(after_next.value);
}

function apply_keyword_case(text, useUpperKeywordCase, tokenizer_options) {
    var tokens = tokenizer.tokenize(text, tokenizer_options);
    var in_set_payload = false;
    var keyword_lookup = build_keyword_lookup(tokenizer_options);

    for (var i = 0; i < tokens.length; i++) {
        if (tokens[i].type == 'newline'
            || tokens[i].type == 'punctuation' && tokens[i].value == ';') {
            in_set_payload = false;
        }

        if (tokens[i].type == 'word' && /^IF$/i.exec(tokens[i].value) && is_if_not_exists(tokens, i)) {
            tokens[i].value = useUpperKeywordCase === false ? tokens[i].value.toLowerCase() : tokens[i].value.toUpperCase();
            continue;
        }

        if (tokens[i].type == 'word' && keyword_lookup[String(tokens[i].value || '').toUpperCase()] === true) {
            if (in_set_payload || is_dotted_identifier_part(tokens, i)) {
                continue;
            }

            tokens[i].value = useUpperKeywordCase === false
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
