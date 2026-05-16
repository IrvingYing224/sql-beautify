var sqlKeywords = require('./sql-keywords');
var sqlTokenizer = require('./sql-tokenizer');

function modify_comma_to_speicific(text) {
	var quote_cnt = 0;
	var quote_tag = '';
	var start_loc = 0;
	var end_loc = 0;
	for (let p = 0; p < text.length; p++) {
		if (text[p] == '"' || text[p] == "'") {
			if (quote_cnt == 0) 
			{
				quote_cnt += 1;
				quote_tag = text[p];
			} 
			else 
			{
				if (text[p] == quote_tag) 
				{
					quote_cnt -= 1;
					end_loc = p
				}
			}
		}
		else if(text[p] == ',' && quote_cnt != 0)
		{
			text = text.slice(0, p) + '，' + text.slice(p+1,)
		}
	}
	return text
}

function repeat_space(count) {
    if (count <= 0) {
        return '';
    }

    return new Array(count + 1).join(' ');
}

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

function ddl(str){
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

// 优化有comment的语句
// 几种常见的评论形式
// SELECT a -- comment 
// ,b

// SELECT a,
// -- comment
// b,

// SELECT nvl(a,' --'),
// -- comment
// b,

// SELECT nvl(a.xxx,' --') -- comm--e)nt 如果有三个注释符号如果定位到中间一个

exports.ddl = ddl;

function newsql(text) {
	return require('./sql-formatter').format_sql(text, {
		uppercase: true,
		comma_location: false,
		bracket_char: false,
		as_loc_cnt: 150,
		case_when_then_wrap_length: 50,
		dialect: 'hive'
	});
}

function is_select_end_word(word) {
	return /^(FROM|WHERE|GROUP|ORDER|SORT|CLUSTER|LIMIT|DISTRIBUTE|UNION|HAVING|QUALIFY)$/i.exec(word || '') != null;
}

function is_ignorable_token(token) {
	return token.type == 'whitespace'
		|| token.type == 'newline'
		|| token.type == 'line_comment'
		|| token.type == 'block_comment';
}

function update_sql_depth(token, state) {
	if (token.type == 'punctuation' && token.value == '(') {
		state.paren_depth += 1;
	} else if (token.type == 'punctuation' && token.value == ')' && state.paren_depth > 0) {
		state.paren_depth -= 1;
	}
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

function alias_from_select_item(tokens) {
	var state = {
		paren_depth: 0
	};
	var as_index = -1;
	var fallback = '';

	for (var i = 0; i < tokens.length; i++) {
		if (tokens[i].type == 'line_comment') {
			break;
		}

		if (tokens[i].type == 'word'
			&& /^AS$/i.exec(tokens[i].value)
			&& state.paren_depth == 0) {
			as_index = i;
		}

		if ((tokens[i].type == 'word' || tokens[i].type == 'quoted_identifier')
			&& state.paren_depth == 0
			&& !/^(SELECT|DISTINCT|AS)$/i.exec(tokens[i].value)) {
			fallback = tokens[i].value;
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

	return fallback;
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
		var alias = alias_from_select_item(item_tokens[i]);
		if (alias == '') {
			continue;
		}

		columns.push({
			name: alias,
			comment: comment_text_from_item(item_tokens[i])
		});
	}

	return columns;
}

function extractddl(str){
	var columns = extract_select_columns(str);
	var text_final = '';

	for (var i = 0; i < columns.length; i++) {
		text_final += columns[i].name + ' BIGINT COMMENT "' + columns[i].comment + '"\n';
	}

	if (text_final == '') {
		return '';
	}

	text_final = '     ' + ddl(text_final).trim();
	return text_final
}

exports.extractddl = extractddl;
