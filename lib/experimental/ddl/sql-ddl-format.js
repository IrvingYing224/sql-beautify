var sqlKeywords = require('../../core/sql-keywords');
var sqlTokenizer = require('../../core/sql-tokenizer');
var ddlShared = require('./sql-ddl-shared');
var repeat_space = ddlShared.repeat_space;

function find_matching_ddl_paren(text, start) {
    var quote = '';
    var depth = 0;

    for (var i = start; i < text.length; i++) {
        if (quote != '') {
            if (text[i] == '\\' && i + 1 < text.length) {
                i += 1;
                continue;
            }
            if (text[i] == quote) {
                if (text[i + 1] == quote) {
                    i += 1;
                    continue;
                }
                quote = '';
            }
            continue;
        }

        if (text[i] == '\'' || text[i] == '"') {
            quote = text[i];
            continue;
        }

        if (text[i] == '(') {
            depth += 1;
            continue;
        }

        if (text[i] == ')') {
            depth -= 1;
            if (depth == 0) {
                return i;
            }
        }
    }

    return -1;
}

function split_ddl_items(text) {
    var items = [];
    var quote = '';
    var paren_depth = 0;
    var angle_depth = 0;
    var start = 0;

    for (var i = 0; i < text.length; i++) {
        if (quote != '') {
            if (text[i] == '\\' && i + 1 < text.length) {
                i += 1;
                continue;
            }
            if (text[i] == quote) {
                if (text[i + 1] == quote) {
                    i += 1;
                    continue;
                }
                quote = '';
            }
            continue;
        }

        if (text[i] == '\'' || text[i] == '"') {
            quote = text[i];
            continue;
        }

        if (text[i] == '(') {
            paren_depth += 1;
        } else if (text[i] == ')' && paren_depth > 0) {
            paren_depth -= 1;
        } else if (text[i] == '<') {
            angle_depth += 1;
        } else if (text[i] == '>' && angle_depth > 0) {
            angle_depth -= 1;
        } else if (text[i] == ',' && paren_depth == 0 && angle_depth == 0) {
            items.push(text.slice(start, i));
            start = i + 1;
        }
    }

    items.push(text.slice(start));
    return items;
}

function find_ddl_comment_index(text) {
    var tokens = sqlTokenizer.tokenize(text);

    for (var i = 0; i < tokens.length; i++) {
        if (tokens[i].type == 'word' && /^COMMENT$/i.exec(tokens[i].value)) {
            return tokens[i].start;
        }
    }

    return -1;
}

function normalize_ddl_type(text) {
    return String(text || '')
        .replace(/\s+/g, ' ')
        .replace(/\s*<\s*/g, '<')
        .replace(/\s*>\s*/g, '>')
        .replace(/\s*,\s*/g, ',')
        .replace(/\s*:\s*/g, ':')
        .replace(/\b(array|bigint|boolean|date|datetime|decimal|double|float|int|map|string|struct|text|timestamp|tinyint|varchar)\b/ig, function(match) {
            return match.toUpperCase();
        })
        .replace(/DECIMAL\s*\(/ig, 'DECIMAL(')
        .replace(/\s+$/g, '');
}

function parse_ddl_column(item) {
    var clean = String(item || '').replace(/^\s*,\s*/, '').replace(/^\s+|\s+$/g, '').replace(/\s+/g, ' ');
    var comment_index = find_ddl_comment_index(clean);
    var code = comment_index >= 0 ? clean.slice(0, comment_index).replace(/\s+$/g, '') : clean;
    var comment = comment_index >= 0 ? clean.slice(comment_index + 'COMMENT'.length).replace(/^\s+|\s+$/g, '') : '';
    var match = /^(`(?:``|[^`])+`|[^\s]+)\s+([\s\S]+)$/.exec(code);

    if (!match) {
        return null;
    }

    if (/^(CREATE|PARTITIONED|STORED|ROW|TBLPROPERTIES|LOCATION|COMMENT)$/i.exec(match[1])) {
        return null;
    }

    return {
        name: match[1],
        type: normalize_ddl_type(match[2]),
        comment: comment
    };
}

function format_ddl_columns(items) {
    var columns = [];
    var max_name = 0;
    var max_type = 0;

    for (var i = 0; i < items.length; i++) {
        var column = parse_ddl_column(items[i]);
        if (column) {
            columns.push(column);
            max_name = Math.max(max_name, column.name.length);
            max_type = Math.max(max_type, column.type.length);
        }
    }

    if (columns.length == 0) {
        return null;
    }

    var lines = [];
    for (var q = 0; q < columns.length; q++) {
        var prefix = q == 0 ? '     ' : '    ,';
        var line = prefix
            + columns[q].name
            + repeat_space(max_name - columns[q].name.length)
            + ' '
            + columns[q].type;

        if (columns[q].comment != '') {
            line += repeat_space(max_type - columns[q].type.length) + ' COMMENT ' + columns[q].comment;
        }

        lines.push(line);
    }

    return lines.join('\n');
}

function ddl(str) {
    var source = String(str || '').replace(/\r\n|\r/g, '\n').replace(/^\s+|\s+$/g, '');
    var open_index = source.indexOf('(');

    if (open_index >= 0) {
        var close_index = find_matching_ddl_paren(source, open_index);
        if (close_index > open_index) {
            var header = sqlKeywords.apply_keyword_case(source.slice(0, open_index).replace(/\s+/g, ' ').replace(/\s+$/g, ''), true);
            var body = source.slice(open_index + 1, close_index);
            var suffix = source.slice(close_index + 1).replace(/^\s+|\s+$/g, '');
            var formatted_columns = format_ddl_columns(split_ddl_items(body));

            if (formatted_columns != null) {
                return header
                    + '\n(\n'
                    + formatted_columns
                    + '\n)'
                    + (suffix == '' ? '' : '\n' + sqlKeywords.apply_keyword_case(suffix.replace(/\s+/g, ' '), true));
            }
        }
    }

    var fallback_columns = format_ddl_columns(split_ddl_items(source.replace(/\n/g, ',')));
    if (fallback_columns != null) {
        return fallback_columns;
    }

    return sqlKeywords.apply_keyword_case(source.replace(/\s+/g, ' '), true);
}

exports.ddl = ddl;
