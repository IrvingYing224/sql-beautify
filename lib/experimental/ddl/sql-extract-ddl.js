var sqlTokenizer = require('../../core/sql-tokenizer');
var ddlShared = require('./sql-ddl-shared');
var repeat_space = ddlShared.repeat_space;
var is_ignorable_token = ddlShared.is_ignorable_token;
var update_sql_depth = ddlShared.update_sql_depth;

function is_select_end_word(word) {
    return /^(FROM|WHERE|GROUP|ORDER|SORT|CLUSTER|LIMIT|DISTRIBUTE|UNION|HAVING|QUALIFY)$/i.exec(word || '') != null;
}

function find_final_top_level_select(tokens) {
    var state = {
        paren_depth: 0
    };
    var select_index = -1;

    for (var i = 0; i < tokens.length; i++) {
        if (tokens[i].type == 'word'
            && /^SELECT$/i.exec(tokens[i].value)
            && state.paren_depth == 0) {
            select_index = i;
        }

        update_sql_depth(tokens[i], state);
    }

    return select_index;
}

function find_select_list_end(tokens, select_index) {
    var state = {
        paren_depth: 0
    };

    for (var i = select_index + 1; i < tokens.length; i++) {
        if (tokens[i].type == 'word'
            && state.paren_depth == 0
            && is_select_end_word(tokens[i].value)) {
            return i;
        }

        update_sql_depth(tokens[i], state);
    }

    return tokens.length;
}

function split_select_items(tokens) {
    var items = [];
    var state = {
        paren_depth: 0
    };
    var start = 0;

    for (var i = 0; i < tokens.length; i++) {
        if (tokens[i].type == 'punctuation'
            && tokens[i].value == ','
            && state.paren_depth == 0) {
            items.push(tokens.slice(start, i));
            start = i + 1;
            continue;
        }

        update_sql_depth(tokens[i], state);
    }

    items.push(tokens.slice(start));
    return items;
}

function comment_text_from_item(tokens) {
    for (var i = 0; i < tokens.length; i++) {
        if (tokens[i].type == 'line_comment') {
            return tokens[i].value.replace(/^--\s*/, '').replace(/\s+$/g, '');
        }
    }

    return ' ';
}

function explicit_alias_from_select_item(tokens) {
    var state = {
        paren_depth: 0
    };
    var as_index = -1;

    for (var i = 0; i < tokens.length; i++) {
        if (tokens[i].type == 'line_comment') {
            break;
        }

        if (tokens[i].type == 'word'
            && /^AS$/i.exec(tokens[i].value)
            && state.paren_depth == 0) {
            as_index = i;
        }

        update_sql_depth(tokens[i], state);
    }

    if (as_index >= 0) {
        for (var j = as_index + 1; j < tokens.length; j++) {
            if (tokens[j].type == 'line_comment') {
                break;
            }
            if (is_ignorable_token(tokens[j])) {
                continue;
            }
            if (tokens[j].type == 'word' || tokens[j].type == 'quoted_identifier') {
                return tokens[j].value;
            }
            break;
        }
    }

    return '';
}

function simple_reference_name_from_select_item(tokens) {
    var significant = [];

    for (var i = 0; i < tokens.length; i++) {
        if (tokens[i].type == 'line_comment') {
            break;
        }
        if (is_ignorable_token(tokens[i])) {
            continue;
        }
        significant.push(tokens[i]);
    }

    while (significant.length > 0 && significant[0].type == 'word' && /^DISTINCT$/i.exec(significant[0].value)) {
        significant = significant.slice(1);
    }

    if (significant.length == 0) {
        return '';
    }

    var expect_identifier = true;
    var last_identifier = '';

    for (var j = 0; j < significant.length; j++) {
        if (expect_identifier) {
            if (significant[j].type != 'word' && significant[j].type != 'quoted_identifier') {
                return '';
            }
            last_identifier = significant[j].value;
            expect_identifier = false;
            continue;
        }

        if (significant[j].type == 'punctuation' && significant[j].value == '.') {
            expect_identifier = true;
            continue;
        }

        return '';
    }

    if (expect_identifier) {
        return '';
    }

    return last_identifier;
}

function column_name_from_select_item(tokens) {
    var alias = explicit_alias_from_select_item(tokens);
    if (alias != '') {
        return alias;
    }

    return simple_reference_name_from_select_item(tokens);
}

function render_extract_columns(columns) {
    if (columns.length == 0) {
        return '';
    }

    var max_name = 0;
    for (var i = 0; i < columns.length; i++) {
        if (columns[i].name.length > max_name) {
            max_name = columns[i].name.length;
        }
    }

    var lines = [];
    for (var q = 0; q < columns.length; q++) {
        var prefix = q == 0 ? '     ' : '    ,';
        lines.push(
            prefix
            + columns[q].name
            + repeat_space(max_name - columns[q].name.length)
            + ' BIGINT COMMENT "'
            + columns[q].comment
            + '"'
        );
    }

    return lines.join('\n');
}

function extract_select_columns(sql) {
    var tokens = sqlTokenizer.tokenize(String(sql || ''), {
        dollarQuotedStrings: true,
        hashLineComments: true
    });
    var select_index = find_final_top_level_select(tokens);
    var columns = [];

    if (select_index < 0) {
        return columns;
    }

    var end_index = find_select_list_end(tokens, select_index);
    var item_tokens = split_select_items(tokens.slice(select_index + 1, end_index));

    for (var i = 0; i < item_tokens.length; i++) {
        var column_name = column_name_from_select_item(item_tokens[i]);
        if (column_name == '') {
            continue;
        }

        columns.push({
            name: column_name,
            comment: comment_text_from_item(item_tokens[i])
        });
    }

    return columns;
}

function extractddl(str) {
    var columns = extract_select_columns(str);
    return render_extract_columns(columns);
}

exports.extractddl = extractddl;
