function createShiftArr(step) {
	var space = '    ';
	
	if ( isNaN(parseInt(step)) ) {  // argument is string
		space = step;
	} else { // argument is integer
		switch(step) {
			case 1: space = ' '; break;
			case 2: space = '  '; break;
			case 3: space = '   '; break;
			case 4: space = '    '; break;
			case 5: space = '     '; break;
			case 6: space = '      '; break;
			case 7: space = '       '; break;
			case 8: space = '        '; break;
			case 9: space = '         '; break;
			case 10: space = '          '; break;
			case 11: space = '           '; break;
			case 12: space = '            '; break;
		}
	}

	var shift = ['\n']; // array of shifts
	for(var ix=0;ix<100;ix++){
		shift.push(shift[ix]+space); 
	}
	return shift;
}

function vkbeautify(){
	this.step = '    '; // 4 spaces
	this.shift = createShiftArr(this.step);
};

var restore_list = [];
var restore_cnt = 0;
var standalone_comment_list = [];

//----------------------------------------------------------------------------
function replace_char(str) {
	return str.replace(/\n/g, " ")
		.replace(/\s+/ig, " ")
		.replace(/ AND /ig, " AND ")
		.replace(/ OR /ig, " OR ")
		.replace(/ NOT /ig, " NOT ")
		.replace(/ IS /ig, " IS ")
		.replace(/\nAND /ig, " AND ")
		.replace(/\nOR /ig, " OR ")
		.replace(/\bNULL\b/ig, "NULL")
		.replace(/\bTRUE\b/ig, "TRUE")
		.replace(/\bFALSE\b/ig, "FALSE")
		.replace(/\bDISTINCT\b/ig, "DISTINCT")
		.replace(/\bCAST\(/ig, "CAST(")
		.replace(/ THEN /ig, " THEN ")
		.replace(/ WHEN /ig, " WHEN ")
		.replace(/INSERT OVERWRITE/ig, "INSERT OVERWRITE")
		.replace(/INSERT INTO/ig, "INSERT INTO")
		.replace(/ BETWEEN /ig, " BETWEEN ")
		.replace(/ CASE WHEN /ig, " CASE WHEN ")
		.replace(/ \,CASE WHEN /ig, " ,CASE WHEN ")
		.replace(/ DATEDIFF\(/ig, " DATEDIFF(")
		.replace(/\,DATEDIFF\(/ig, ",DATEDIFF(")
		.replace(/ CEIL\(/ig, " CEIL(")
		.replace(/ FLOOR\(/ig, " FLOOR(")
		.replace(/\,CEIL\(/ig, ",CEIL(")
		.replace(/\,FLOOR\(/ig, ",FLOOR(")
		.replace(/ FROM\(/ig, " FROM (")
		.replace(/ JOIN\(/ig, " JOIN (")
		.replace(/ FROM /ig, "\nFROM ")
		.replace(/ DISTRIBUTE BY /ig, "\nDISTRIBUTE BY ")
		.replace(/ AS /ig, " AS ")
		.replace(/ TABLE /ig, " TABLE ")
		.replace(/ EXTERNAL /ig, " EXTERNAL ")
		.replace(/ STORED AS /ig, " STORED AS ")
		.replace(/\bTBLPROPERTIES\b/ig, "TBLPROPERTIES")
		.replace(/\bPARQUET\b/ig, "PARQUET")
		.replace(/ IF EXISTS /ig, " IF EXISTS ")
		.replace(/ IF NOT EXISTS /ig, " IF NOT EXISTS ")
		.replace(/ HAVING /ig, "\nHAVING ")
		.replace(/ USING /ig, " USING ")
		.replace(/ IN /ig, " IN ")
		.replace(/\bSTRING\b/ig, "STRING")
		.replace(/\bINT\b/ig, "INT")
		.replace(/\bBIGINT\b/ig, "BIGINT")
		.replace(/\bDOUBLE\b/ig, "DOUBLE")
		.replace(/\bBOOLEAN\b/ig, "BOOLEAN")
		.replace(/\bFLOAT\b/ig, "FLOAT")
		.replace(/\bDECIMAL\b/ig, "DECIMAL")
		.replace(/\bTIMESTAMP\b/ig, "TIMESTAMP")
		.replace(/\bDATE\b/ig, "DATE")
		.replace(/\(SELECT/ig, "( SELECT")
		.replace(/(^|\s{1,})SELECT /ig, "\nSELECT ")
		.replace(/ WHERE /ig, "\nWHERE ")
		.replace(/ ON /ig, "\nON ")
		.replace(/ JOIN /ig, "\nJOIN ")
		.replace(/ LEFT SEMI\nJOIN /ig, "\nLEFT SEMI JOIN ")
		.replace(/ LEFT ANTI\nJOIN /ig, "\nLEFT ANTI JOIN ")
		.replace(/ CROSS\nJOIN /ig, "\nCROSS JOIN ")
		.replace(/ INNER\nJOIN /ig, "\nINNER JOIN ")
		.replace(/ LEFT\nJOIN /ig, "\nLEFT JOIN ")
		.replace(/ RIGHT\nJOIN /ig, "\nRIGHT JOIN ")
		// .replace(/ ORDER\s{1,}BY /ig, "\nORDER BY ")
		.replace(/ ORDER\s{1,}BY /ig, " ORDER BY ")
		.replace(/ GROUP\s{1,}BY /ig, "\nGROUP BY ")
		.replace(/ GROUPING\s{1,}SETS/ig, " GROUPING SETS")
		.replace(/\bROLLUP\(/ig, "ROLLUP(")
		.replace(/\bCUBE\(/ig, "CUBE(")
		.replace(/ SORT\s{1,}BY /ig, "\nSORT BY ")
		.replace(/ CLUSTER\s{1,}BY /ig, "\nCLUSTER BY ")
		.replace(/UNION ALL/ig, "\nUNIONALLALL\n")  //先合并unionall避免和union换行发生冲突
		.replace(/(\s|\\n)union(\s|\\n)/ig, "\nUNION \n")
		.replace(/(\s|\\n)intersect(\s|\\n)/ig, "\nINTERSECT\n")
		.replace(/(\s|\\n)except(\s|\\n)/ig, "\nEXCEPT\n")
		.replace(/ LEFT OUTER\nJOIN /ig, "\nLEFT OUTER JOIN ")
		.replace(/ RIGHT OUTER\nJOIN /ig, "\nRIGHT OUTER JOIN ")
		.replace(/ FULL OUTER\nJOIN /ig, "\nFULL OUTER JOIN ")
		.replace(/ FULL\nJOIN /ig, "\nFULL JOIN ")
		.replace(/(^)DROP /ig, "\nDROP ")
		.replace(/(;\s{0,})DROP /ig, ";\nDROP ") 
		.replace(/(^| )CREATE /ig, "\nCREATE ")
		.replace(/(^| )INSERT /ig, "\nINSERT ")
		.replace(/(^| )SET /ig, "\nSET ")
		.replace(/(^| )DELETE /ig, "\nDELETE ")
		.replace(/ADD JAR/ig, "ADD JAR")
		.replace(/Alter /ig, "\nALTER ")
		.replace(/MAX\(/ig, "MAX(")
		.replace(/MIN\(/ig, "MIN(")
		.replace(/SUM\(/ig, "SUM(")
		.replace(/AVG\(/ig, "AVG(")
		.replace(/COUNT\(/ig, "COUNT(")
		.replace(/WITH /ig, "\nWITH ")
		.replace(/ NOT IN /ig, " NOT IN ")
		.replace(/ NOT EXISTS /ig, " NOT EXISTS ")
		.replace(/ EXISTS /ig, " EXISTS ")
		.replace(/NOT EXISTS\(/ig, "NOT EXISTS (")
		.replace(/EXISTS\(/ig, "EXISTS (")
		.replace(/ LIKE /ig, " LIKE ")
		.replace(/ RLIKE /ig, " RLIKE ")
		.replace(/ REGEXP /ig, " REGEXP ")
		.replace(/ OVER /ig, " OVER ")
		.replace(/OVER\(/ig, "OVER(")
		.replace(/ PARTITION BY /ig, " PARTITION BY ")
		.replace(/PARTITION\(/ig, "PARTITION(")
		.replace(/\(PARTITION BY /ig, "(PARTITION BY ")
		.replace(/ LATERAL VIEW OUTER /ig, " LATERAL VIEW OUTER ")
		.replace(/ LATERAL VIEW /ig, " LATERAL VIEW ")
		.replace(/\bPOSEXPLODE\(/ig, "POSEXPLODE(")
		.replace(/\bEXPLODE\(/ig, "EXPLODE(")
		.replace(/row_number /ig, "ROW_NUMBER ")
		.replace(/row_number\(/ig, "ROW_NUMBER(")
		.replace(/\bROWS\b/ig, "ROWS")
		.replace(/\bUNBOUNDED\b/ig, "UNBOUNDED")
		.replace(/\bPRECEDING\b/ig, "PRECEDING")
		.replace(/\bFOLLOWING\b/ig, "FOLLOWING")
		.replace(/\bCURRENT ROW\b/ig, "CURRENT ROW")
		.replace(/ ASC /ig, " ASC ")
		.replace(/ DESC /ig, " DESC ")
		.replace(/ ASC\)/ig, " ASC)")
		.replace(/ DESC\)/ig, " DESC)")
		.replace(/(^|\s{1,})LIMIT /ig, "\nLIMIT ")
		.replace(/\s{0,}=\s{0,}/ig," = ") //等号左右强制加空格
		.replace(/! =/ig,"!=")
		.replace(/< =/ig,"<=")
		.replace(/> =/ig,">=")
		.replace(/: =/ig,":=") //mysql写法自适应
		.replace(/\s{0,}>\s{0,}/ig," > ") //大于号左右强制加空格
		.replace(/> =/ig,">=")
		.replace(/< >/ig,"<>")
		.replace(/\s{0,}<\s{0,}/ig," < ") //小于号左右强制加空格
		.replace(/< =/ig,"<=")
		.replace(/< >/ig,"<>")
		.replace(/- >/ig,"->")
		.replace(/\s{0,}!=\s{0,}/ig," != ") //小于等号左右强制加空格
};

function get_bracket(str) {
	var text = str.replace(/\(/g, "\n\(").replace(/\)/g, "\n\)").replace(/\'/g, "\n\'");
	var text_list_orginal = text.split("\n");
	var text_list = []
	for (var i = 0; i < text_list_orginal.length; i++) {
		if (text_list_orginal[i] != "" && text_list_orginal[i] != " ") {
			text_list.push(text_list_orginal[i]);
		}
	}

	var text_final = '';
	var left = [];
	var right = [];
	var bracket = [];
	var bracket_back = [];
	var is_colon = 0;

	for (i = 0; i < text_list.length; i++) {
		var last_str = i == 0 ? "" : text_list[i - 1];

		if(text_list[i][0] == "'"){
			if(is_colon == 0){
				is_colon += 1
			}else{
				is_colon -= 1
			}
		}

		if (/\(/ig.exec(text_list[i]) && is_colon == 0) {
			// 加入with as 的判断可能会有坑
			if (
				
				(/JOIN|WITH/.exec(last_str) 
				
				||  /^\)\s*\,\s*\w+\s+AS/.exec(last_str) 
				|| (/FROM /.exec(last_str) && !/ (EXPLODE|POSEXPLODE)/ig.exec(last_str))
				
				
				)  
				
				&& !/ORDER BY/.exec(last_str)  
	
				
				)  
			 {

				left.push(i);
				bracket.push(i);
				bracket_back.push(1);
			} else { // 由于''之间可以随便出现多个中文(号 所以需要过滤一层条件
					bracket.push(i);
					bracket_back.push(0);
			}
		}

		if (/\)/ig.exec(text_list[i]) && is_colon == 0) {
			if (bracket_back[bracket_back.length - 1] == 1) {
				right.push(i);
			}

			bracket = bracket.slice(0, -1);
			bracket_back = bracket_back.slice(0, -1);
		}
	}

	for (i = 0; i < text_list.length; i++) {
		text_list[i] = text_list[i].replace("\n", "");
	}

	for (i = 0; i < left.length; i++) {
		text_list[left[i]] = '\n' + text_list[left[i]];
		text_list[right[i]] = '\n' + text_list[right[i]];
	}

	for (i = 0; i < text_list.length; i++) {
		if (/\(|\)/ig.exec(text_list[i])) {
			text_final += text_list[i];
		} else {
			text_final += "\n" + text_list[i];
		}
	}

	return text_final.replace(/\n\'/ig, "'") //恢复因为'导致的换行
};




String.prototype.times = function(n) {
	return (new Array(n + 1)).join(this);
};

function bracket_deep(str) {
	var text_final = '';
	var text_list = [];
	var text_list_orginal = str.split("\n");
	for (var i = 0; i < text_list_orginal.length; i++) {
		if (text_list_orginal[i] != "" && text_list_orginal[i] != " ") {
			text_list.push(text_list_orginal[i]);
		}
	}

	var bracket_deep = 0;
	var deep = "\t";

	for (i = 0; i < text_list.length; i++) {

		if (text_list[i].replace(/\t{0,}/, "")[0] == ')') {
			bracket_deep -= 1;}
			
		text_list[i] = deep.times(bracket_deep) + text_list[i];

		if (text_list[i].replace(/\t{0,}/, "")[0] == '(') {
			bracket_deep += 1;
		}

		text_final += "\n" + text_list[i]
	}
	return text_final
};

function is_word_char(ch) {
	return /[A-Za-z0-9_]/.test(ch || '');
}

function get_line_comment_loc(text) {
	if (text.indexOf('--') < 0) {
		return -1;
	}
	return return_right_comment_loc(text);
}

function split_code_and_comment(text) {
	var comment_loc = get_line_comment_loc(text);
	if (comment_loc >= 0) {
		return {
			code: text.slice(0, comment_loc).replace(/\s+$/ig, ''),
			comment: text.slice(comment_loc).replace(/\s+$/ig, '')
		};
	}

	return {
		code: text.replace(/\s+$/ig, ''),
		comment: ''
	};
}

function split_line_before_end(text) {
	var parts = split_code_and_comment(text);
	var tokens = get_case_tokens(parts.code);
	var end_token = null;

	for (let i = 0; i < tokens.length; i++) {
		if (tokens[i].word == 'END') {
			end_token = tokens[i];
			break;
		}
	}

	if (end_token == null) {
		return null;
	}

	return {
		before_end: parts.code.slice(0, end_token.start).replace(/\s+$/ig, ''),
		suffix_text: parts.code.slice(end_token.end).replace(/^\s+/ig, '').replace(/\s+$/ig, ''),
		comment: parts.comment
	};
}

function split_line_at_token(text, token) {
	var parts = split_code_and_comment(text);

	return {
		before_token: parts.code.slice(0, token.start).replace(/\s+$/ig, ''),
		suffix_text: parts.code.slice(token.end).replace(/^\s+/ig, '').replace(/\s+$/ig, ''),
		comment: parts.comment
	};
}

function get_case_tokens(text) {
	var tokens = [];
	var quote_cnt = 0;
	var quote_tag = '';
	var case_depth = 0;

	for (let i = 0; i < text.length; i++) {
		if ((text[i] == '"' || text[i] == "'")) {
			if (quote_cnt == 0) {
				quote_cnt = 1;
				quote_tag = text[i];
			} else if (text[i] == quote_tag) {
				quote_cnt = 0;
				quote_tag = '';
			}
			continue;
		}

		if (quote_cnt > 0) {
			continue;
		}

		if (text[i] == '-' && text[i + 1] == '-') {
			break;
		}

		if (!is_word_char(text[i])) {
			continue;
		}

		var start = i;
		while (i < text.length && is_word_char(text[i])) {
			i += 1;
		}

		var end = i;
		var word = text.slice(start, end).toUpperCase();
		var prev_char = start > 0 ? text[start - 1] : '';
		var next_char = end < text.length ? text[end] : '';

		if (is_word_char(prev_char) || is_word_char(next_char)) {
			i -= 1;
			continue;
		}

		if (word == 'CASE') {
			case_depth += 1;
			tokens.push({ word: word, start: start, end: end, depth: case_depth });
		} else if (word == 'END') {
			tokens.push({ word: word, start: start, end: end, depth: case_depth });
			if (case_depth > 0) {
				case_depth -= 1;
			}
		} else if (word == 'WHEN' || word == 'THEN' || word == 'ELSE') {
			tokens.push({ word: word, start: start, end: end, depth: case_depth });
		}

		i -= 1;
	}

	return tokens;
}

function format_case_branch_value(indent, keyword, value_text) {
	var value_parts = split_code_and_comment(value_text);
	var line = indent + keyword;

	if (value_parts.code != '') {
		line += ' ' + value_parts.code;
	}

	if (value_parts.comment != '') {
		line += ' ' + value_parts.comment;
	}

	return line.replace(/\s+$/ig, '');
}

function append_case_value_text(current_text, next_text) {
	var current_trimmed = current_text.replace(/\s+$/ig, '');
	var next_trimmed = next_text.replace(/^\s+/ig, '').replace(/\s+$/ig, '');

	if (next_trimmed == '') {
		return current_trimmed;
	}

	if (current_trimmed == '') {
		return next_trimmed;
	}

	return current_trimmed + ' ' + next_trimmed;
}

function expand_tabs_for_width(text) {
	return text.replace(/\t/ig, "    ");
}

function find_top_level_as_loc(text) {
	var quote_cnt = 0;
	var quote_tag = '';
	var bracket_cnt = 0;

	for (let i = 0; i < text.length - 3; i++) {
		if ((text[i] == '"' || text[i] == "'")) {
			if (quote_cnt == 0) {
				quote_cnt = 1;
				quote_tag = text[i];
			} else if (text[i] == quote_tag) {
				quote_cnt = 0;
				quote_tag = '';
			}
			continue;
		}

		if (quote_cnt > 0) {
			continue;
		}

		if (text[i] == '(') {
			bracket_cnt += 1;
			continue;
		}

		if (text[i] == ')' && bracket_cnt > 0) {
			bracket_cnt -= 1;
			continue;
		}

		if (bracket_cnt == 0 && text.slice(i, i + 4) == ' AS ') {
			return i;
		}
	}

	return -1;
}

function is_case_branch_line(text) {
	var trimmed = text.replace(/^\s+/ig, '');
	return /^WHEN\b/i.exec(trimmed) || /^THEN\b/i.exec(trimmed) || /^ELSE\b/i.exec(trimmed);
}

function get_outer_as_code_width(code, top_level_as_loc) {
	if (top_level_as_loc >= 0) {
		return expand_tabs_for_width(code.slice(0, top_level_as_loc).replace(/\s+$/ig, '')).length;
	}

	return expand_tabs_for_width(code.replace(/\s+$/ig, '')).length;
}

function get_alignment_width_for_code(code) {
	var normalized_code = code.replace(/\s+$/ig, '');
	var top_level_as_loc = find_top_level_as_loc(normalized_code);

	return {
		top_level_as_loc: top_level_as_loc,
		width: get_outer_as_code_width(normalized_code, top_level_as_loc)
	};
}

function get_case_balance_delta(text) {
	var tokens = get_case_tokens(text);
	var balance = 0;

	for (let i = 0; i < tokens.length; i++) {
		if (tokens[i].word == 'CASE') {
			balance += 1;
		} else if (tokens[i].word == 'END') {
			balance -= 1;
		}
	}

	return balance;
}

function find_outer_then_token(code) {
	var tokens = get_case_tokens(code);

	for (let i = 0; i < tokens.length; i++) {
		if (tokens[i].word == 'THEN' && tokens[i].depth == 0) {
			return tokens[i];
		}
	}

	return null;
}

function find_case_block_end(line, current_depth) {
	var parts = split_code_and_comment(line);
	var tokens = get_case_tokens(parts.code);
	var depth = current_depth;

	for (let i = 0; i < tokens.length; i++) {
		if (tokens[i].word == 'CASE') {
			depth += 1;
		} else if (tokens[i].word == 'END') {
			depth -= 1;
			if (depth == 0) {
				var split_parts = split_line_at_token(line, tokens[i]);
				return {
					found: true,
					before_end: split_parts.before_token,
					suffix_text: split_parts.suffix_text,
					comment: split_parts.comment,
					depth: depth
				};
			}
		}
	}

	return {
		found: false,
		depth: depth
	};
}

function get_case_prefix_layout(prefix_raw) {
	var prefix_trimmed = prefix_raw.replace(/\s+$/ig, '');

	if (/^SELECT$/i.exec(prefix_trimmed)) {
		return {
			prefix_output: 'SELECT',
			case_line_prefix: '       ',
			case_start_indent: '       '
		};
	}

	if (/^GROUP BY$/i.exec(prefix_trimmed)) {
		return {
			prefix_output: 'GROUP BY',
			case_line_prefix: '         ',
			case_start_indent: '         '
		};
	}

	if (/^\s*,$/.exec(prefix_trimmed)) {
		return {
			prefix_output: null,
			case_line_prefix: prefix_trimmed,
			case_start_indent: " ".times(expand_tabs_for_width(prefix_trimmed).length)
		};
	}

	return {
		prefix_output: null,
		case_line_prefix: prefix_raw,
		case_start_indent: " ".times(expand_tabs_for_width(prefix_raw).length)
	};
}

function parse_case_expression(text) {
	var parts = split_code_and_comment(text);
	var code = parts.code;
	var tokens = get_case_tokens(code);
	var root_case = null;
	var root_end = null;
	var boundary_tokens = [];
	var first_when = null;
	var case_operand = '';
	var when_items = [];
	var else_value = '';
	var next_boundary = null;
	var suffix_text = code.replace(/\s+$/ig, '');

	for (let i = 0; i < tokens.length; i++) {
		if (tokens[i].word == 'CASE' && tokens[i].depth == 1) {
			root_case = tokens[i];
			break;
		}
	}

	if (root_case == null) {
		return null;
	}

	for (let i = 0; i < tokens.length; i++) {
		if (tokens[i].word == 'END' && tokens[i].depth == 1 && tokens[i].start > root_case.start) {
			root_end = tokens[i];
			break;
		}
	}

	if (root_end == null) {
		return null;
	}

	for (let i = 0; i < tokens.length; i++) {
		if (tokens[i].depth == 1
			&& tokens[i].start > root_case.start
			&& tokens[i].start < root_end.start
			&& (tokens[i].word == 'WHEN' || tokens[i].word == 'THEN' || tokens[i].word == 'ELSE')) {
			boundary_tokens.push(tokens[i]);
		}
	}

	for (let i = 0; i < boundary_tokens.length; i++) {
		if (boundary_tokens[i].word == 'WHEN') {
			first_when = boundary_tokens[i];
			break;
		}
	}

	if (first_when == null) {
		return null;
	}

	case_operand = code.slice(root_case.end, first_when.start).replace(/\s+/ig, ' ').trim();

	for (let i = 0; i < boundary_tokens.length; i++) {
		if (boundary_tokens[i].word == 'WHEN') {
			var then_token = null;

			for (let j = i + 1; j < boundary_tokens.length; j++) {
				if (boundary_tokens[j].word == 'THEN') {
					then_token = boundary_tokens[j];
					break;
				}
				if (boundary_tokens[j].word == 'WHEN' || boundary_tokens[j].word == 'ELSE') {
					break;
				}
			}

			if (then_token == null) {
				return null;
			}

			next_boundary = root_end;
			for (let j = i + 1; j < boundary_tokens.length; j++) {
				if (boundary_tokens[j].start > then_token.start && (boundary_tokens[j].word == 'WHEN' || boundary_tokens[j].word == 'ELSE')) {
					next_boundary = boundary_tokens[j];
					break;
				}
			}

			when_items.push({
				when_text: code.slice(boundary_tokens[i].end, then_token.start).replace(/\s+/ig, ' ').trim(),
				then_text: code.slice(then_token.end, next_boundary.start).replace(/\s+/ig, ' ').trim()
			});
		}

		if (boundary_tokens[i].word == 'ELSE') {
			else_value = code.slice(boundary_tokens[i].end, root_end.start).replace(/\s+/ig, ' ').trim();
			break;
		}
	}

	suffix_text = code.slice(root_end.end).replace(/^\s+/ig, '').replace(/\s+$/ig, '');
	if (parts.comment != '') {
		suffix_text += (suffix_text != '' ? ' ' : '') + parts.comment;
	}

	return {
		prefix_raw: code.slice(0, root_case.start),
		case_operand: case_operand,
		when_items: when_items,
		else_value: else_value,
		suffix_text: suffix_text
	};
}

function build_case_formatted_text(prefix_raw, case_operand, when_items, else_value, suffix_text, case_when_then_wrap_length) {
	if (when_items.length == 0) {
		return null;
	}

	var layout = get_case_prefix_layout(prefix_raw);
	var wrap_limit = parseInt(case_when_then_wrap_length, 10);
	if (!wrap_limit || wrap_limit < 1) {
		wrap_limit = 50;
	}

	var should_wrap_then = false;
	var max_when_header_len = 0;

	for (let i = 0; i < when_items.length; i++) {
		var when_header = 'WHEN ' + when_items[i].when_text;
		if (when_header.length > max_when_header_len) {
			max_when_header_len = when_header.length;
		}
		if (when_items[i].when_text.length > wrap_limit || when_items[i].then_text.length > wrap_limit) {
			should_wrap_then = true;
		}
	}

	var when_indent = layout.case_start_indent + '    ';
	var value_indent = when_indent + '    ';
	var lines = [];

	if (layout.prefix_output != null) {
		lines.push(layout.prefix_output);
	}

	lines.push(layout.case_line_prefix + 'CASE' + (case_operand != '' ? ' ' + case_operand : ''));

	for (let i = 0; i < when_items.length; i++) {
		var when_line = when_indent + 'WHEN ' + when_items[i].when_text;
		if (should_wrap_then) {
			lines.push(when_line);
			lines.push(format_case_branch_value(value_indent, 'THEN', when_items[i].then_text));
		} else {
			var padding = " ".times(max_when_header_len - ('WHEN ' + when_items[i].when_text).length);
			lines.push(format_case_branch_value(when_indent, 'WHEN ' + when_items[i].when_text + padding + ' THEN', when_items[i].then_text));
		}
	}

	if (else_value != '') {
		if (should_wrap_then) {
			lines.push(when_indent + 'ELSE');
			lines.push((value_indent + else_value).replace(/\s+$/ig, ''));
		} else {
			lines.push((when_indent + 'ELSE ' + else_value).replace(/\s+$/ig, ''));
		}
	}

	lines.push((layout.case_start_indent + 'END' + (suffix_text != '' ? (/^[\),]/.exec(suffix_text) ? '' : ' ') + suffix_text : '')).replace(/\s+$/ig, ''));

	return lines.join('\n');
}

function format_case_expression_line(line, case_when_then_wrap_length) {
	var parsed = parse_case_expression(line);

	if (parsed == null || parsed.when_items.length == 0) {
		return null;
	}

	return build_case_formatted_text(
		parsed.prefix_raw,
		parsed.case_operand,
		parsed.when_items,
		parsed.else_value,
		parsed.suffix_text,
		case_when_then_wrap_length
	);
}

function format_case_blocks(str, case_when_then_wrap_length) {
	var text_list = str.split('\n');
	var text_final = [];

	for (let i = 0; i < text_list.length; i++) {
		var current_line = text_list[i];
		var case_loc = -1;
		var line_tokens = get_case_tokens(current_line);

		for (let j = 0; j < line_tokens.length; j++) {
			if (line_tokens[j].word == 'CASE' && line_tokens[j].depth == 1) {
				case_loc = line_tokens[j].start;
				break;
			}
		}

		if (case_loc < 0) {
			text_final.push(current_line);
			continue;
		}

		var single_line_formatted = format_case_expression_line(current_line, case_when_then_wrap_length);
		if (single_line_formatted != null) {
			var single_line_tokens = get_case_tokens(split_code_and_comment(current_line).code);
			var has_root_end_on_same_line = false;
			for (let j = 0; j < single_line_tokens.length; j++) {
				if (single_line_tokens[j].word == 'END' && single_line_tokens[j].depth == 1) {
					has_root_end_on_same_line = true;
					break;
				}
			}

			if (has_root_end_on_same_line) {
				var single_line_parts = single_line_formatted.split('\n');
				for (let j = 0; j < single_line_parts.length; j++) {
					text_final.push(single_line_parts[j]);
				}
				continue;
			}
		}

		var block_lines = [current_line];
		var block_end_index = i;
		var end_suffix = '';
		var case_depth = 1;

		for (let j = i + 1; j < text_list.length; j++) {
			var end_line_parts = find_case_block_end(text_list[j], case_depth);
			case_depth = end_line_parts.depth;
			if (end_line_parts.found) {
				if (end_line_parts.before_end != '') {
					block_lines.push(end_line_parts.before_end);
				}
				block_end_index = j;
				end_suffix = end_line_parts.suffix_text + (end_line_parts.comment != '' ? ' ' + end_line_parts.comment : '');
				break;
			}
			block_lines.push(text_list[j]);
		}

		if (block_end_index == i) {
			text_final.push(current_line);
			continue;
		}

		var prefix_raw = current_line.slice(0, case_loc);
		var first_line_parts = split_code_and_comment(current_line.slice(case_loc + 4));
		var case_after_text = first_line_parts.code.replace(/\s+/ig, ' ').trim();
		var case_operand = '';
		var when_items = [];
		var else_value = '';
		var pending_type = '';
		var nested_case_depth = 0;
		var active_value_target = '';

		if (case_after_text != '') {
			if (/^WHEN\b/i.exec(case_after_text)) {
				block_lines[0] = 'WHEN ' + case_after_text.replace(/^WHEN\b/i, '').trim() + (first_line_parts.comment != '' ? ' ' + first_line_parts.comment : '');
			} else {
				var case_match = /^(.*?)(\bWHEN\b.*)$/i.exec(case_after_text);
				if (case_match) {
					case_operand = case_match[1].replace(/\s+/ig, ' ').trim();
					block_lines[0] = case_match[2] + (first_line_parts.comment != '' ? ' ' + first_line_parts.comment : '');
				} else {
					case_operand = case_after_text;
					block_lines[0] = '';
				}
			}
		} else {
			block_lines[0] = '';
		}

		for (let j = 0; j < block_lines.length; j++) {
			var source_line = block_lines[j];
			var parts = split_code_and_comment(source_line);
			var code = parts.code.replace(/^\s+/ig, '').replace(/\s+/ig, ' ').trim();
			var code_with_comment = code + (parts.comment != '' ? ' ' + parts.comment : '');
			if (code == '') {
				continue;
			}

			if (nested_case_depth > 0) {
				if (active_value_target == 'THEN' && when_items.length > 0) {
					when_items[when_items.length - 1].then_text = append_case_value_text(when_items[when_items.length - 1].then_text, code_with_comment);
				} else if (active_value_target == 'ELSE') {
					else_value = append_case_value_text(else_value, code_with_comment);
				}
				nested_case_depth += get_case_balance_delta(code);
				if (nested_case_depth < 0) {
					nested_case_depth = 0;
				}
				if (nested_case_depth == 0) {
					active_value_target = '';
				}
				continue;
			}

			if (/^WHEN\b/i.exec(code)) {
				var then_token = find_outer_then_token(code);
				if (then_token != null) {
					var when_text = code.slice(4, then_token.start).replace(/\s+/ig, ' ').trim();
					var then_code = code.slice(then_token.end).replace(/\s+/ig, ' ').trim();
					var then_text = then_code + (parts.comment != '' ? ' ' + parts.comment : '');
					when_items.push({
						when_text: when_text,
						then_text: then_text
					});
					pending_type = '';
					nested_case_depth = get_case_balance_delta(then_code);
					if (nested_case_depth > 0) {
						active_value_target = 'THEN';
					}
				} else {
					when_items.push({
						when_text: code.replace(/^WHEN\b/i, '').replace(/\s+/ig, ' ').trim(),
						then_text: ''
					});
					pending_type = 'THEN';
				}
				continue;
			}

			if (/^THEN\b/i.exec(code) && when_items.length > 0) {
				var then_line_text = code.replace(/^THEN\b/i, '').replace(/\s+/ig, ' ').trim();
				when_items[when_items.length - 1].then_text = then_line_text + (parts.comment != '' ? ' ' + parts.comment : '');
				pending_type = '';
				nested_case_depth = get_case_balance_delta(then_line_text);
				if (nested_case_depth > 0) {
					active_value_target = 'THEN';
				}
				continue;
			}

			if (/^ELSE\b/i.exec(code)) {
				var else_line_text = code.replace(/^ELSE\b/i, '').replace(/\s+/ig, ' ').trim();
				else_value = else_line_text + (parts.comment != '' ? ' ' + parts.comment : '');
				pending_type = else_value == '' ? 'ELSE' : '';
				nested_case_depth = get_case_balance_delta(else_line_text);
				if (nested_case_depth > 0) {
					active_value_target = 'ELSE';
				}
				continue;
			}

			if (pending_type == 'THEN' && when_items.length > 0) {
				when_items[when_items.length - 1].then_text = code_with_comment;
				pending_type = '';
				nested_case_depth = get_case_balance_delta(code);
				if (nested_case_depth > 0) {
					active_value_target = 'THEN';
				}
				continue;
			}

			if (pending_type == 'ELSE') {
				else_value = code_with_comment;
				pending_type = '';
				nested_case_depth = get_case_balance_delta(code);
				if (nested_case_depth > 0) {
					active_value_target = 'ELSE';
				}
			}
		}

		var formatted_block = build_case_formatted_text(prefix_raw, case_operand, when_items, else_value, end_suffix, case_when_then_wrap_length);
		if (formatted_block == null) {
			text_final.push(current_line);
			continue;
		}

		var formatted_lines = formatted_block.split('\n');
		for (let j = 0; j < formatted_lines.length; j++) {
			text_final.push(formatted_lines[j]);
		}
		i = block_end_index;
	}

	return text_final.join('\n');
}

function is_select_item_start(line) {
	var trimmed = line.replace(/^\s+/ig, '');
	return /^SELECT\b/i.exec(trimmed) || /^GROUP BY\b/i.exec(trimmed) || /^,/.exec(trimmed);
}

function collect_as_alignment_items(text_list) {
	var items = [];
	var current_item = null;

	for (let i = 0; i < text_list.length; i++) {
		if (is_select_item_start(text_list[i])) {
			if (current_item != null) {
				items.push(current_item);
			}
			current_item = {
				start_line_index: i,
				as_line_index: -1,
				as_loc: -1,
				as_visual_loc: -1
			};
		}

		if (current_item != null) {
			var top_level_as_loc = find_top_level_as_loc(text_list[i]);
			if (top_level_as_loc >= 0) {
				current_item.as_line_index = i;
				current_item.as_loc = top_level_as_loc;
				current_item.as_visual_loc = get_outer_as_code_width(text_list[i], top_level_as_loc);
			}
		}
	}

	if (current_item != null) {
		items.push(current_item);
	}

	return items;
}

function is_select_block_start(line) {
	var trimmed = line.replace(/^\s+/ig, '');
	return /^SELECT\b/i.exec(trimmed) || /^GROUP BY\b/i.exec(trimmed);
}

function is_select_block_end(line) {
	var trimmed = line.replace(/^\s+/ig, '');
	return /^FROM\b/i.exec(trimmed)
		|| /^WHERE\b/i.exec(trimmed)
		|| /^HAVING\b/i.exec(trimmed)
		|| /^ORDER BY\b/i.exec(trimmed)
		|| /^SORT BY\b/i.exec(trimmed)
		|| /^CLUSTER BY\b/i.exec(trimmed)
		|| /^LIMIT\b/i.exec(trimmed)
		|| /^DISTRIBUTE BY\b/i.exec(trimmed)
		|| /^UNION\b/i.exec(trimmed)
		|| /^JOIN\b/i.exec(trimmed)
		|| /^LEFT\b/i.exec(trimmed)
		|| /^RIGHT\b/i.exec(trimmed)
		|| /^FULL\b/i.exec(trimmed)
		|| /^INNER\b/i.exec(trimmed)
		|| /^CROSS\b/i.exec(trimmed)
		|| /^ON\b/i.exec(trimmed);
}

function apply_as_alignment_on_items(text_list, items, as_loc_cnt) {
	var max_as_loc = 0;

	for (let i = 0; i < items.length; i++) {
		if (items[i].max_code_width > max_as_loc && items[i].max_code_width < as_loc_cnt) {
			max_as_loc = items[i].max_code_width;
		}
	}

	for (let i = 0; i < items.length; i++) {
		if (items[i].as_line_index >= 0 && items[i].as_loc >= 0) {
			var current_line = text_list[items[i].as_line_index];
			var before_as = current_line.slice(0, items[i].as_loc).replace(/\s+$/ig, '');
			var after_as = current_line.slice(items[i].as_loc + 4).replace(/^\s+/ig, '');
			var before_as_visual_length = expand_tabs_for_width(before_as).length;
			var padding = max_as_loc - before_as_visual_length;
			if (padding >= 0) {
				text_list[items[i].as_line_index] = before_as + " ".times(padding) + " AS " + after_as;
			}
		}
	}
}

function align_as_in_select_blocks(str, as_loc_cnt) {
	var text_list = str.split('\n');
	var current_items = [];
	var current_item = null;
	var in_block = false;

	for (let i = 0; i < text_list.length; i++) {
		if (is_select_block_start(text_list[i])) {
			if (in_block) {
				apply_as_alignment_on_items(text_list, current_items, as_loc_cnt);
			}
			in_block = true;
			current_items = [{
				as_line_index: -1,
				as_loc: -1,
				max_code_width: 0
			}];
			current_item = current_items[0];
		} else if (in_block && is_select_block_end(text_list[i])) {
			apply_as_alignment_on_items(text_list, current_items, as_loc_cnt);
			in_block = false;
			current_items = [];
			current_item = null;
		} else if (in_block && /^,/.exec(text_list[i].replace(/^\s+/ig, ''))) {
			current_item = {
				as_line_index: -1,
				as_loc: -1,
				max_code_width: 0
			};
			current_items.push(current_item);
		}

		if (in_block && current_item != null) {
			var line_parts = split_code_and_comment(text_list[i]);
			var code = line_parts.code.replace(/\s+$/ig, '');
			var code_width = 0;
			var alignment_info = get_alignment_width_for_code(code);
			var top_level_as_loc = alignment_info.top_level_as_loc;

			if (code != '') {
				if (top_level_as_loc >= 0) {
					current_item.as_line_index = i;
					current_item.as_loc = top_level_as_loc;
					code_width = alignment_info.width;
				} else {
					code_width = alignment_info.width;
				}

				if (code_width > current_item.max_code_width) {
					current_item.max_code_width = code_width;
				}
			}
		}
	}

	if (in_block) {
		apply_as_alignment_on_items(text_list, current_items, as_loc_cnt);
	}

	return text_list.join('\n');
}


function select_wrap(text,tag,as_loc_cnt,case_when_then_wrap_length) {
	var text_final = '';
	var bracket_cnt = 0;
	var quote_cnt = 0;
	var text_final_case = '';
	var max_as_loc = 0;
	var text_as_final ='';
	var text_list = [];
	var text_as_list = [];
	var as_alignment_items = [];

	for (let i = 0; i < text.length; i++) {
		let p = i;
		if (text[p] == '(' && quote_cnt == 0) {
			bracket_cnt += 1;
		}

		if (text[p] == '"' || text[p] == "'") {
			if(quote_cnt==0){
				quote_cnt += 1;
			} else{
				quote_cnt -= 1;
			}

		}

		if (text[p] == ')' && quote_cnt == 0) {
			if(bracket_cnt > 0){
				bracket_cnt -= 1;
			}
		}

		if (bracket_cnt == 0 && quote_cnt == 0 && text[p] == ',') {
			if(tag == 0){
				text_final += '\n       ' + text[p];
			}
			if(tag == 1){
				text_final += '\n         ' + text[p];
			}

		} else {
			text_final += text[p];
		}
	}

	text_final = extract_quotation_mark(text_final) //为了下面case when和as对齐的逻辑，提取引号内容
	text_final = text_final.replace(', ', ',').replace('GROUP BY', 'GROUP BY ').replace('ORDER BY', 'ORDER BY ').replace(/\,\s{0,}/ig, ",").replace('SELECT','SELECT ');
	text_final = restore_strmark(text_final) //复原



	text_list = text_final.split('\n');

	for (let i = 0; i < text_list.length; i++) {
		var formatted_case_line = format_case_expression_line(text_list[i], case_when_then_wrap_length);
		if (formatted_case_line != null) {
			text_final_case += '\n' + formatted_case_line;
		} else {
			text_final_case += '\n' + text_list[i];
		}
	}




		// 让as进行对齐

		text_as_list = text_final_case.split('\n');
		as_alignment_items = collect_as_alignment_items(text_as_list);
		
		//获取最大的as 的位置
	for (let i = 0; i < as_alignment_items.length; i++) {
		if (as_alignment_items[i].as_visual_loc >= 0 && as_alignment_items[i].as_visual_loc > max_as_loc && as_alignment_items[i].as_visual_loc < as_loc_cnt) { //150个字符后不再参与as对齐 20211031改成自定义
			max_as_loc = as_alignment_items[i].as_visual_loc;
		}
	}
	
		//替换as
	for (let i = 0; i < as_alignment_items.length; i++) {
		var item = as_alignment_items[i];
		if (item.as_line_index >= 0 && item.as_loc >= 0 && item.as_loc <= max_as_loc) {
			var before_as = text_as_list[item.as_line_index].slice(0, item.as_loc).replace(/\s+$/ig, '');
			var after_as = text_as_list[item.as_line_index].slice(item.as_loc + 4).replace(/^\s+/ig, '');
			var before_as_visual_length = expand_tabs_for_width(before_as).length;
			text_as_list[item.as_line_index] = before_as + " ".times(max_as_loc - before_as_visual_length) + " AS " + after_as;
		}
	}

	for (i = 0; i < text_as_list.length; i++) {
		if (text_as_list[i] != "" && text_as_list[i] != " ") {
			text_as_final += text_as_list[i] + '\n';
		}
	}

	return text_as_final
};

function condition_wrap(text) {
	var text_final = '';
	var if_cnt = 0;
    var if_bracket_cnt = 0;
    var bracket_cnt = 0;
	var case_depth = 0;
	var between_and_cnt = 0;
	var in_comment = false;
	text = text.replace('IF (', 'IF(').replace('IN (', 'IN(').replace('if (', 'IF(').replace('if(', 'IF(');
	var text_list = text.split(" ");

	for (let i = 0; i < text_list.length; i++) {
        let t = i;
        var last_str = i == 0 ? "" : text_list[i - 1];

		if (/^--/.exec(text_list[t])) {
			in_comment = true;
		}

		if (in_comment) {
			if (text_list[t].indexOf('\n') >= 0 || text_list[t].indexOf('shouldhavenbehind') >= 0) {
				in_comment = false;
			}
			continue;
		}

		if (/BETWEEN/.exec(text_list[t])) {
			between_and_cnt += 1;
		}

        // 如果and后面本身就跟着括号，等同于存在if(或者in
		if (/IF\(/.exec(text_list[t]) || /IN\(/.exec(text_list[t])) {
            if_cnt += 1;
		}

		if (/\(/.exec(text_list[t]) && if_cnt > 0 && text_list[t].indexOf('IF(') == -1 && text_list[t].indexOf('IN(') == -1) {
			if_bracket_cnt += 1;
		}

		if (/\)/.exec(text_list[t]) && if_cnt > 0 && if_bracket_cnt > 0) {
			if_bracket_cnt -= 1;
		}

		if (/\)/.exec(text_list[t]) && if_cnt > 0 && if_bracket_cnt == 0) {
			if_cnt -= 1;
        }

		for (let p = 0; p < text_list[t].length; p++) {
			if (/\(/.exec(text_list[t][p])){
				bracket_cnt += 1;
			}
			if (/\)/.exec(text_list[t][p])) {
				bracket_cnt -= 1;
			}
		}


		if (/^(AND|OR)$/i.exec(text_list[t])) {
			if (between_and_cnt == 0 && if_cnt == 0 && bracket_cnt == 0 && case_depth == 0) {
				text_list[t] = '\n' + text_list[t];
			}
			if (/^AND$/i.exec(text_list[t]) && between_and_cnt > 0) {
					between_and_cnt -= 1;
			}
			
		}

		case_depth += get_case_balance_delta(text_list[t]);
		if (case_depth < 0) {
			case_depth = 0;
		}

	}

	for (let i = 0; i < text_list.length; i++) {
		let v = i;
		text_final += text_list[v] + ' ';
		text_final = text_final.replace('IN(', 'IN (');
	}

	return text_final

};

function special_wrap(text,as_loc_cnt,case_when_then_wrap_length) {
	var text_final = '';
	var text_restore_orginal = restore_strmark(text) //先进行复原成原来样子，此时restore_list重新变为空
	var text_list_orginal = text_restore_orginal.split("\n");
	var text_list = [];
	var new_text_list = [];

	for (i = 0; i < text_list_orginal.length; i++) {
		if (text_list_orginal[i] != "" && text_list_orginal[i] != " ") {
			text_list.push(text_list_orginal[i]);
		}
	}

		//因为对齐的时候需要保持原样
	for (let i = 0; i < text_list.length; i++) {
		let q = i
		if (text_list[q].slice(0, 6) == 'SELECT') { //需要部分进行提取再做变化再复原
			text_list[q] = select_wrap(text_list[q],0,as_loc_cnt,case_when_then_wrap_length);
		}

		if (text_list[q].slice(0, 8) == 'GROUP BY') {
			text_list[q] = select_wrap(text_list[q],1,as_loc_cnt,case_when_then_wrap_length);
		}

		if (/^(ON|WHERE|HAVING)\b/.exec(text_list[q])) {
			text_list[q] = condition_wrap(text_list[q]);
		}

		//增加order by 换行逻辑
		if(/ORDER BY/ig.exec(text_list[q])){
			var left_brkt = 0;
			var right_brkt = 0;
			var ordr_loc = text_list[q].indexOf('ORDER BY') + 8;
			var new_str = text_list[q].slice(ordr_loc,-1);
			for (let t = 0; t < new_str.length; t++){
				if(new_str[t] == '('){
					left_brkt += 1;
				}
				if(new_str[t] == ')'){
					right_brkt += 1;
				}
			}

			if(right_brkt <= left_brkt){
				text_list[q] = text_list[q].replace(' ORDER BY ','\nORDER BY ');
			}
		}
	
		text_final += "\n" + text_list[q];
	
	}

	return extract_quotation_mark(text_final);
}

function except_subquery(text){
	var text_final = '';
	var text_list_orginal = text.split("\n");
	var text_list = [];

	for (i = 0; i < text_list_orginal.length; i++) {
		if (text_list_orginal[i] != "" && text_list_orginal[i] != " ") {
			text_list.push(text_list_orginal[i]);
		}
	}

	var in_bracket_cnt = 0;
	var bracket_cnt = 0;
	var bracket_loc = [];
	var bracket_loc_back = []; //闭

	for (let i = 0; i < text_list.length; i++) {

		if(in_bracket_cnt > 0 && bracket_cnt>0){
			for(let p = 0; p<text_list[i].length;p++){
				if(text_list[i][p] == "("){
					bracket_cnt += 1;
				}
				if(text_list[i][p] == ")"){
					bracket_cnt -= 1;
					if(bracket_cnt == 0){
						bracket_loc_back.push(i);
						break; 
					}
				}


			}

		} 

		if (/(IN|EXISTS) \($/.exec(text_list[i])) {
			in_bracket_cnt += 1;
			bracket_cnt += 1;
			bracket_loc.push(i);
		}
	}

	for (let i = 0; i < text_list.length; i++) {
		var if_return = 0;
		if(bracket_loc.length > 0){
			for(let q = 0; q < bracket_loc.length; q++){
				if(i>bracket_loc[q] && i <= bracket_loc_back[q]){
					if_return = 1;
					break;
				}
			}

			if(if_return > 0){
				text_final += " " + text_list[i];
			} else{
				text_final += "\n" + text_list[i];
			}
			
		}else{
			text_final += "\n" + text_list[i];
		}
	}

	return text_final
};

// 功能型函数
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


function ddl(str){
    var str = modify_comma_to_speicific(str);
	var text_final = '';
	var text_list = [];
	var text_list_orginal = str.replace(/(\d+)\s{0,},\s{0,}(\d+)/ig, "$1，$2") //处理ddl列名中有数字的形式 demical(8,2) demical(8 ,2) demical(8 , 2)
								.replace(/\,/ig, "\n,")
								.replace(/\n\s{1,}/ig, "\n")
								.replace(/\s{1,}BIGINT/ig, " BIGINT")
								.replace(/\s{1,}DOUBLE/ig, " DOUBLE")
								.replace(/\s{1,}INT/ig, " INT")
								.replace(/\s{1,}VARCHAR/ig, " VARCHAR")
								.replace(/\s{1,}STRING/ig, " STRING")
								.replace(/\s{1,}DECIMAL/ig, " DECIMAL")
								.replace(/ COMMENT/ig, " COMMENT ")
								.replace(/ COMMENT '/ig, "COMMENT'")
								.replace(/ COMMENT "/ig, 'COMMENT"')
								.replace(/CREATE TABLE/ig, "CREATE TABLE")
								.replace(/PARTITIONED/ig, "PARTITIONED")
								.replace(/PARTITIONED/ig, "PARTITIONED")
								.replace(/string\s{0,},\s{0,}string/ig,"STRINGSTRING")
								.replace(/COLUMNS\s{0,}\(/ig, "COLUMNS\n(")
								.replace(/^\(/ig, "(\n")
								.replace(/\s{1,}DECIMAL\s{1,}\(/ig, " DECIMAL(")
								.replace(/ \s{1,}timestamp/ig, " TIMESTAMP")
							.split("\n");

	for (i = 0; i < text_list_orginal.length; i++) {		
		if (text_list_orginal[i] != "" && text_list_orginal[i] != " ") {
			if(/^\(/ig.exec(text_list_orginal[i]) && text_list_orginal[i].slice(1).replace(/\s{1,}/ig, " ") !=""){
				text_list.push("(");
				text_list.push(text_list_orginal[i].slice(1).replace(/\s{1,}/ig, " "));
			}else{
				text_list.push(text_list_orginal[i].replace(/\s{1,}/ig, " "));
			}
		}
	}

	var m = 0
	var n = 0
	var is_comment_before = 0
while (n<text_list.length)
{
	var current_text = text_list[n]
	var last_text = text_list[m]

	// if((is_comment_before == 0 ||  /comment/ig.exec(text_list[n]) || n == 0 || /^\(|^\)|PARTITIONED|STORED|STRING|DOUBLE|BIGINT|INT|VARCHAR/ig.exec(text_list[n])) && /,\s{0,}string>/ig.exec(text_list[n]) == null ){
	// 	n = n+1
	// 	m = n - 1
	// }
	
	
	if(is_comment_before == 1 
		&& /^,/ig.exec(text_list[n]) 
		&& / STRING| DOUBLE| BIGINT| INT| VARCHAR| DECIMAL| TIMESTAMP/ig.exec(text_list[n]) == null){
		text_list[m] += text_list[n]
		delete text_list[n]
		n = n + 1
	}else{
		n = n+1
		m = n - 1
	}

	if(/comment/ig.exec(last_text)){
		is_comment_before = 1
	}else{
		is_comment_before = 0
	}
}





	
	var col_name = [];
	var col_len = [];
	var col_type = [];
	var col_type_len = [];
	var col_comment = [];
	var start_end = [];

	for (i = 0; i < text_list.length; i++) {
		if(/ STRING | DOUBLE | BIGINT | INT | VARCHAR| DECIMAL| TIMESTAMP| BIGINT| TINYINT| DATETIME| TEXT| FLOAT\(/ig.exec(text_list[i]) && text_list[i].indexOf('PARTITIONED') == -1){
			var new_str_list = text_list[i].replace(/\s{1,}/ig, " ")
			                                // .replace(/(\d+),(\d+)/, "$1#?$2")
											.replace(/,\s{0,}/ig, "")
											.replace(/^\s{1,}/ig, "")
											.replace(/\s{0,},/ig, ",")
											.replace(/string\s{0,}string/ig,"string,string")
											.split(" ");
			col_name.push(new_str_list[0]);
			col_len.push(new_str_list[0].length)
			col_type.push(new_str_list[1]);
			col_type_len.push(new_str_list[1].length)
			col_comment.push(text_list[i].split("COMMENT")[1]);
			start_end.push(i);
		}

	}

	if(col_name.length >0){
		var col = '';
		if(col_name.length > 0){
			var max_col_name = Math.max.apply(Math,col_len);
			var max_col_type = Math.max.apply(Math,col_type_len);
			for (let q = 0; q < col_name.length; q++){
				if(q==0){
					col += '\n     ';
				} else{
					col += '\n    ,';
				}

				col += col_name[q] + " ".times(max_col_name - col_len[q]) + " " + col_type[q] + " ".times(max_col_type - col_type_len[q]) + " " + "COMMENT " + col_comment[q];
			}
		}
	
		for (let i = 0; i < start_end[0]; i++) {
			if(i == 0){
				text_final += text_list[i];
			} else 
			{
				text_final += "\n" + text_list[i];
			}
		}
	
		text_final =  text_final + col;
	
		for (let i = start_end[start_end.length-1]+1; i < text_list.length; i++) {
			text_final += "\n" + text_list[i];
		}
	
	} else{
		for (let i = 0; i < text_list.length; i++) {
			if(i == 0){
				text_final += text_list[i];
			} else 
			{
				text_final += "\n" + text_list[i];
			}
		}
	}

	return text_final.replace(/COMMENT'/ig, "COMMENT '").replace(/COMMENT"/ig, 'COMMENT "').replace(/\n\s{0,}\n/ig, '\n')
	.replace(/，/ig, ',') 
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

function reshape_comment(str){
	var text_final = '';
	str = str
	.replace(/\-\- WHERE/ig,"\-\-WHEREiscomment")
	.replace(/\-\- AND/ig,"\-\-ANDiscomment")
	.replace(/\-\- SELECT/ig,"\-\-SELECTiscomment")
	.replace(/\-\- FROM/ig,"\-\-FROMiscomment")
	.replace(/\-\- between/ig,"\-\-BETWEENiscomment")
	.replace(/\-\- order by/ig,"\-\-orderbyiscomment")
	// 避免关键词注释换行先缩进，使用 {} 标记独立行注释
	.replace(/^ *\-\-(?!\{\})/g, "--{}")
	.replace(/\n *\-\-(?!\{\})/ig, " \-\-{}");
	
	var quo_cnt = 0;
	var quo_text = ""
	for (let i = 0; i < str.length; i++) {
		if(str[i] == "'" && quo_cnt == 0){
			quo_cnt += 1
		} else if(str[i] == "'" && quo_cnt == 1){
			quo_cnt -= 1
		}

		if(quo_cnt==0 && str[i] == ","){
			quo_text= quo_text + str[i] + " "
		}else{
			quo_text += str[i]
		}

	}

	var text_list_orginal = quo_text.split("\n"); // 已知评论不可能和下个字段写在一行


	for (let i = 0; i < text_list_orginal.length; i++) {
		var comment_loc = 0;
		
		if (text_list_orginal[i] != "" && text_list_orginal[i] != " ") {
			// 确保注释 -- 后面有一个空格，但排除 --{} 标记
			text_list_orginal[i] = text_list_orginal[i].replace(/--(?![{}])([^\s\-\n])/g, "-- $1");
			
			var is_comment = text_list_orginal[i].indexOf('--')
			if(is_comment > 0){
				comment_loc = return_right_comment_loc(text_list_orginal[i])
			}

			//如果出现SELECT nvl(a.xxx,' --') -- comment"这类，会错误的把commet_loc定位错，所以需要判断所有--符号的位置
			if(is_comment > 0){
			var a = text_list_orginal[i].slice(0,comment_loc).replace(/\s+/ig, " "); //注释前的东西
			text_list_orginal[i] = a.replace(/(\,)\s+$/ig," ") + " " + text_list_orginal[i].slice(comment_loc,)
			.replace(/\,/ig,"{comma}") //剔除注释后的逗号
			.replace(/\(/ig,"{.*.*}")
			.replace(/\)/ig,"{*.*.}") + 'shouldhavenbehind'
			
			; //让注释后的括号不参加排序
			
			if(/\,$/.exec(a.replace(/\s+/ig, ""))){  
					text_list_orginal[i] = text_list_orginal[i] + ','
				}
			}
			text_final += "\n" + text_list_orginal[i];
		}
	}
	return text_final
}

function protect_standalone_comments(str) {
	var text_list = str.split("\n");
	for (let i = 0; i < text_list.length; i++) {
		if (/^\s*--/.exec(text_list[i])) {
			var comment_text = text_list[i].replace(/^\s*/, "").replace(/\s+$/ig, "");
			comment_text = comment_text
			.replace(/^--\s*WHERE\b/ig, "-- WHERE")
			.replace(/^--\s*AND\b/ig, "-- AND")
			.replace(/^--\s*SELECT\b/ig, "-- SELECT")
			.replace(/^--\s*FROM\b/ig, "-- FROM")
			.replace(/^--\s*between\b/ig, "-- BETWEEN")
			.replace(/^--\s*order\s+by\b/ig, "-- ORDER BY");
			standalone_comment_list.push(comment_text);
			text_list[i] = " --{}{LC" + (standalone_comment_list.length - 1) + "}";
		}
	}
	return text_list.join("\n");
}

function get_first_comment_loc(text) {
	var quote_cnt = 0;
	var quote_tag = '';

	for (let i = 0; i < text.length - 1; i++) {
		if ((text[i] == '"' || text[i] == "'")) {
			if (quote_cnt == 0) {
				quote_cnt += 1;
				quote_tag = text[i];
			} else if (text[i] == quote_tag) {
				quote_cnt -= 1;
			}
		}

		if (quote_cnt == 0 && text[i] == '-' && text[i + 1] == '-') {
			return i;
		}
	}

	return -1;
}

function protect_inline_comments(str) {
	var text_list = str.split("\n");
	for (let i = 0; i < text_list.length; i++) {
		if (/^\s*--/.exec(text_list[i]) || /\{LC\d+\}/.exec(text_list[i])) {
			continue;
		}

		var comment_loc = get_first_comment_loc(text_list[i]);
		var comment_text = comment_loc >= 0 ? text_list[i].slice(comment_loc) : "";
		var code_text = comment_loc >= 0 ? text_list[i].slice(0, comment_loc) : "";
		if (comment_loc >= 0
			&& (comment_text.slice(2).indexOf('--') >= 0
				|| comment_text.indexOf('${') >= 0
				|| /^\s*(FROM|AND|OR|ON|WHERE|HAVING)\s*$/i.exec(code_text))) {
			standalone_comment_list.push(text_list[i].slice(comment_loc).replace(/\s+$/ig, ""));
			text_list[i] = text_list[i].slice(0, comment_loc) + "--{LC" + (standalone_comment_list.length - 1) + "}";
		}
	}
	return text_list.join("\n");
}

function restore_standalone_comments(str) {
	return str.replace(/--\s*\{LC(\d+)\}/ig, function(match, comment_index) {
		return standalone_comment_list[parseInt(comment_index, 10)];
	});
}


function extra(str){
	var text = str.replace(/^\n/ig, "")
	.replace(/UNIONALL/ig, "\nUNION ALL\n")
	.replace(/^ *--/ig, "--")
	.replace(/\s{0,}\;/ig, ";");
	// .replace(/\;\s{0,}INSERT/ig, ";\n\nINSERT")
	// .replace(/\;\s{0,}DROP/ig, ";\n\nDROP");

	var text_final = '';
	var text_list_orginal = str.split("\n");
	var text_list = [];

	for (i = 0; i < text_list_orginal.length; i++) {
		if (text_list_orginal[i] != "" && text_list_orginal[i] != " ") {
			text_list.push(text_list_orginal[i].replace(/\s$/ig, ""));//剔除行末尾空格
		}
	}

	for (let i = 0; i < text_list.length; i++) {
		var last_str = i == 0 ? "" : text_list[i - 1];

		if(i > 0){
			text_final += '\n';
		}

		if (i > 0 && (/\s{0,}[^,]INSERT/ig.exec(text_list[i]) || /\s{0,}DROP/ig.exec(text_list[i]) || /\s{0,}ALTER/ig.exec(text_list[i]) || (/^\s{0,}CREATE/ig.exec(text_list[i]) &&  last_str.indexOf('DROP') == -1 && last_str.indexOf('ADD JAR') == -1) || (/^\s{0,}SET/ig.exec(text_list[i]) && last_str.indexOf('SET') == -1))) {
			text_final += '\n' + text_list[i];   //必须不是首行
		} else if(i > 0 && (/\s{0,}SELECT/ig.exec(text_list[i]) && last_str.indexOf(';') >= 0)){
			text_final += '\n' + text_list[i]; 
		}
		else {
			text_final += text_list[i];
		}
	}

	return text_final.replace(/\n{1,2} *--/ig, "\n--").replace(/^ */ig, "")
	.replace(/\-\-\{\}WHEREiscomment/ig,"\-\-\{\} WHERE")
	.replace(/\-\-\{\}ANDiscomment/ig,"\-\-\{\} AND")
	.replace(/\-\-\{\}SELECTiscomment/ig,"\-\-\{\} SELECT")
	.replace(/\-\-\{\}FROMiscomment/ig,"\-\-\{\} FROM")
	.replace(/\-\-\{\}BETWEENiscomment/ig,"\-\-\{\} BETWEEN")
	.replace(/\-\-\{\}orderbyiscomment/ig,"\-\-\{\} ORDER BY")
	.replace(/\-\-WHEREiscomment/ig,"\-\- WHERE")
	.replace(/\-\-ANDiscomment/ig,"\-\- AND")
	.replace(/\-\-SELECTiscomment/ig,"\-\- SELECT")
	.replace(/\-\-FROMiscomment/ig,"\-\- FROM")
	.replace(/\-\-BETWEENiscomment/ig,"\-\- BETWEEN")
	.replace(/\-\-orderbyiscomment/ig,"\-\- ORDER BY")	
	//避免关键词注释换行先缩进
	.replace(/\-\-\{\}orderbyiscomment/ig,"\-\-\{\} ORDER BY")
	.replace(/\-\-orderbyiscomment/ig,"\-\- ORDER BY")
	.replace(/\{comma\}/ig,",") //换回之前的逗号
	.replace(/UNIONALLALL/ig, "UNION ALL")
	.replace(/(\s|\n){1,};(\n|\s){0,}/ig, "\n;\n\n")
	.replace(/shouldhavenbehind\n/ig, "\n")
	.replace(/shouldhavenbehind/ig, "\n")
}

//辅助函数，定位正确的comment
function return_right_comment_loc(text){
	var bracket_cnt = 0;
	var last_char = '';
	var quote_cnt = 0;
	var final_loc = 0;

	for (let i = 0; i < text.length; i++) {
		let p = i;
		if (text[p] == '(' && quote_cnt == 0) {
			bracket_cnt += 1;
		}

		if (text[p] == '"' || text[p] == "'") {
			if(quote_cnt==0){
				quote_cnt += 1;
			} else{
				quote_cnt -= 1;
			}
		}

		if (text[p] == ')' && quote_cnt == 0) {
			if(bracket_cnt > 0){
				bracket_cnt -= 1;
			}
		}

		if (bracket_cnt == 0 && quote_cnt == 0 && text[p] == '-' && last_char == '-') {
			break
		}
		
		last_char = text[p];
		final_loc = i;
	}

	return final_loc
}


//遍历替换逻辑
function repeat_text_replace(text) {
	var quote_cnt = 0;
	var quote_tag = '';
	var start_loc = 0;
	var end_loc = 0;
	for (let p = 0; p < text.length; p++) {
		if (text[p] == '"' || text[p] == "'") {
			if (quote_cnt == 0) {
				quote_cnt += 1;
				quote_tag = text[p]; // 需要对起始符号标记类型
				start_loc = p;
			} else {
				if (text[p] == quote_tag) {
					//命中处理逻辑
					quote_cnt -= 1;
					end_loc = p
					//提取p和q 
					var modify_line = text.slice(0, start_loc) + 'NEEDReplace' + text.slice(end_loc+1,)
					restore_list.push(text.slice(start_loc, end_loc+1))
					return repeat_text_replace(modify_line)
				}
			}
		}
	}
	return text
}


function extract_quotation_mark(str){
	var text_list_orginal = str.split("\n");
	var text_final = '';
	for (let i = 0; i < text_list_orginal.length; i++) {
		var this_line = text_list_orginal[i] 

		//假如有评论?,只需处理评论前一段的东西
		var is_comment = this_line.indexOf('--')
		if(is_comment >= 0){
			var comment_loc = return_right_comment_loc(this_line)
			var line_fisrt = this_line.slice(0,comment_loc)
			var line_last = this_line.slice(comment_loc,)
			text_final += repeat_text_replace(line_fisrt) + line_last+'\n'
		}
		else{
			text_final += repeat_text_replace(this_line) + '\n'
		}
	}
	return text_final
}

function restore_strmark(str){
	var replace_loc = str.indexOf('NEEDReplace')
	if(replace_loc>=0){
		var modify_line = str.slice(0, replace_loc) + restore_list[restore_cnt] + str.slice(replace_loc+11,)
		restore_cnt+= 1
		return restore_strmark(modify_line) 
	}
	else{
		restore_list = []
		restore_cnt = 0
		return str
	}
}



function newsql(text){
	var step1 = reshape_comment(text);
	var step2 = replace_char(step1) ;
	var step3 = get_bracket(step2);
	var step4 = except_subquery(step3)
	.replace(/\{\.\*\.\*\}/ig,"(")  //复原之前修改的注释后中文()的项目
	.replace(/\{\*\.\*\.\}/ig,")");

	var step5 = special_wrap(step4).replace(/\-\-\s{0,}\n/ig, "\n-- ");
	// console.log(step5);
	var step6 = bracket_deep(step5); //union all需要单独函数来考虑
	var step7 = extra(step6);
	return step7;
}


function extractddl(str){
	str = newsql(str)
		 .replace(/\n\s{0,}WHEN/ig, " WHEN");

    var text_final = '';

	var text_list = str.split("\n");
	for (let i = 0; i < text_list.length; i++){
		var text_elmt = text_list[i].trim().replace(/\s{1,}/ig, " ").replace(/\./ig, " ")
		// 判断是否有注释
		var comment_loc = text_elmt.indexOf('--');
		if(comment_loc > 0 && text_elmt.indexOf('FROM') == -1){
			var as_text = text_elmt.slice(0,comment_loc);
			var comment_text = text_elmt.slice(comment_loc,).replace(/-/ig, "").trim();
			var test_list_list = as_text.trim().replace(/\s{1,}/ig, " ").split(" ");
			text_final += test_list_list[test_list_list.length-1] + ' BIGINT COMMENT "' + comment_text +  '"\n';

		}else if(text_elmt.indexOf('FROM') == -1){
			var test_list_list = text_elmt.split(" ");
			text_final += test_list_list[test_list_list.length-1] + ' BIGINT COMMENT " "\n';
		}
	}
	text_final = '     ' + ddl(text_final).trim();
	return text_final
}

function convert_lowercase(str){
	return str.replace(/ AND /ig, " and ")
	        .replace(/\nAND /ig, "\nand ")
	        .replace(/\tAND /ig, "\tand ")
		.replace(/ OR /ig, " or ")
		.replace(/\nOR /ig, "\nor ")
		.replace(/\tOR /ig, "\tor ")
		.replace(/ NOT /ig, " not ")
		.replace(/ IS /ig, " is ")
		.replace(/\bNULL\b/ig, "null")
		.replace(/\bTRUE\b/ig, "true")
		.replace(/\bFALSE\b/ig, "false")
		.replace(/\bDISTINCT\b/ig, "distinct")
		.replace(/\bCAST\(/ig, "cast(")
		.replace(/\bCASE\b/ig, "case")
		.replace(/THEN /ig, "then ")
		.replace(/ALTER /ig, "alter ")
		.replace(/OVERWRITE /ig, "overwrite ")
		.replace(/WHEN /ig, "when ")
		.replace(/ELSE /ig, "else ")
		.replace(/ END /ig, " end ")
		.replace(/\bEND\b/ig, "end")
		.replace(/INSERT/ig, "insert")
		.replace(/INSERT INTO/ig, "insert into")
		.replace(/BETWEEN /ig, "between ")
		.replace(/CASE WHEN/ig, "case when")
		.replace(/DATEDIFF\(/ig, "datediff(")
		.replace(/CEIL\(/ig, "ceil(")
		.replace(/FLOOR\(/g, "floor(")
		.replace(/FROM /ig, "from ")
		.replace(/\nFROM\n/ig, "\nfrom\n")
		.replace(/\tFROM\n/ig, "\tfrom\n")
		.replace(/\tFROM\t/ig, "\tfrom\t")
		.replace(/JOIN /ig, "join ")
	    .replace(/\nJOIN\n/ig, "\njoin\n")
		.replace(/DISTRIBUTE BY /ig, "distribute by ")
		.replace(/ AS/ig, " as")
		.replace(/TABLE /ig, "table ")
		.replace(/EXTERNAL /ig, "external ")
		.replace(/STORED AS /ig, "stored as ")
		.replace(/\bTBLPROPERTIES\b/ig, "tblproperties")
		.replace(/\bPARQUET\b/ig, "parquet")
		.replace(/IF EXISTS/ig, "if exists")
		.replace(/IF NOT EXISTS/ig, "if not exists")
		.replace(/HAVING /ig, "having ")
		.replace(/USING /ig, "using ")
		.replace(/IN /g, "in ")
		.replace(/\bSTRING\b/ig, "string")
		.replace(/\bINT\b/ig, "int")
		.replace(/\bBIGINT\b/ig, "bigint")
		.replace(/\bDOUBLE\b/ig, "double")
		.replace(/\bBOOLEAN\b/ig, "boolean")
		.replace(/\bFLOAT\b/ig, "float")
		.replace(/\bDECIMAL\b/ig, "decimal")
		.replace(/\bTIMESTAMP\b/ig, "timestamp")
		.replace(/\bDATE\b/ig, "date")
		.replace(/SELECT/ig, "select")
		.replace(/WHERE/ig, "where")
		.replace(/ON /ig, "on ")
		.replace(/CROSS JOIN /ig, "cross join ")
	    .replace(/\nCROSS JOIN\n/ig, "\ncross join\n")
		.replace(/INNER JOIN /ig, "inner join ")
		.replace(/\nINNER JOIN\n/ig, "\ninner join\n")
		.replace(/LEFT JOIN /ig, "left join ")
		.replace(/\nLEFT JOIN\n/ig, "\nleft join\n")
		.replace(/\tLEFT JOIN\n/ig, "\tleft join\n")
		.replace(/\tLEFT JOIN\t/ig, "\tleft join\t")
		.replace(/LEFT SEMI JOIN /ig, "left semi join ")
		.replace(/LEFT ANTI JOIN /ig, "left anti join ")
		.replace(/RIGHT JOIN /ig, "right join ")
		.replace(/\nRIGHT JOIN\n/ig, "\nright join\n")
		.replace(/\tRIGHT JOIN\n/ig, "\tright join\n")
		.replace(/\tRIGHT JOIN\t/ig, "\tright join\t")
		.replace(/ORDER BY /ig, "order by ")
		.replace(/GROUP BY /ig, "group by ")
		.replace(/GROUPING SETS/ig, "grouping sets")
		.replace(/\bROLLUP\(/ig, "rollup(")
		.replace(/\bCUBE\(/ig, "cube(")
		.replace(/SORT BY /ig, "sort by ")
		.replace(/CLUSTER BY /ig, "cluster by ")
		.replace(/UNION ALL/ig, "union all")
		.replace(/UNION /ig, "union ")
		.replace(/UNION\n/ig, "union\n")
		.replace(/INTERSECT/ig, "intersect")
		.replace(/EXCEPT/ig, "except")
		.replace(/LEFT OUTER JOIN /ig, "left outer join ")
	    .replace(/\nLEFT OUTER JOIN\n/ig, "\nleft outer join\n")
	    .replace(/\tLEFT OUTER JOIN\t/ig, "\tleft outer join\t")
	    .replace(/\tLEFT OUTER JOIN\n/ig, "\tleft outer join\n")
		.replace(/RIGHT OUTER JOIN /ig, "right outer join ")
		.replace(/\nRIGHT OUTER JOIN\n/ig, "\nright outer join\n")
		.replace(/\tRIGHT OUTER JOIN\n/ig, "\tright outer join\n")
		.replace(/\tRIGHT OUTER JOIN\t/ig, "\tright outer join\t")
		.replace(/FULL OUTER JOIN /ig, "full outer join ")
	    .replace(/\nFULL OUTER JOIN\n/ig, "\nfull outer join\n")
	    .replace(/\tFULL OUTER JOIN\t/ig, "\tfull outer join\t")
	    .replace(/\tFULL OUTER JOIN\n/ig, "\tfull outer join\n")
		.replace(/FULL JOIN /ig, "full join ")
		.replace(/\nFULL JOIN\n/ig, "\nfull join\n")
		.replace(/\tFULL JOIN\n/ig, "\tfull join\n")
		.replace(/\tFULL JOIN\t/ig, "\tfull join\t")
		.replace(/DROP /ig, "drop ")
		.replace(/CREATE/ig, "create")
		.replace(/SET/ig, "set")
		.replace(/MAX\(/ig, "max(")
		.replace(/MIN\(/ig, "min(")
		.replace(/SUM\(/ig, "sum(")
		.replace(/AVG\(/ig, "avg(")
		.replace(/COUNT\(/ig, "count(")
		.replace(/LIMIT/ig, "limit")
		.replace(/LATERAL VIEW OUTER/ig, "lateral view outer")
		.replace(/LATERAL VIEW explode/ig, "lateral view explode")
		.replace(/LATERAL VIEW /ig, "lateral view ")
		.replace(/ NOT IN /ig, " not in ")
		.replace(/ NOT EXISTS /ig, " not exists ")
		.replace(/ EXISTS /ig, " exists ")
		.replace(/ LIKE /ig, " like ")
		.replace(/ RLIKE /ig, " rlike ")
		.replace(/ REGEXP /ig, " regexp ")
		.replace(/ OVER /ig, " over ")
		.replace(/OVER\(/ig, "over(")
		.replace(/ PARTITION BY /ig, " partition by ")
		.replace(/PARTITION\(/ig, "partition(")
		.replace(/\(PARTITION BY /ig, "(partition by ")
		.replace(/\bPOSEXPLODE\(/ig, "posexplode(")
		.replace(/\bEXPLODE\(/ig, "explode(")
		.replace(/row_number /ig, "row_number ")
		.replace(/row_number\(/ig, "row_number(")
		.replace(/\bROWS\b/ig, "rows")
		.replace(/\bUNBOUNDED\b/ig, "unbounded")
		.replace(/\bPRECEDING\b/ig, "preceding")
		.replace(/\bFOLLOWING\b/ig, "following")
		.replace(/\bCURRENT ROW\b/ig, "current row")
		.replace(/ asc /ig, " asc ")
		.replace(/ desc /ig, " desc ")
}

function convert_comma_loaction(str){
	var text_final = '';
	var text_list = str.replace(/\n *\-\-/ig, " \-\-{}").split("\n"); 
	for (let i = 0; i < text_list.length; i++) {
		var this_line = text_list[i]
		var next_line = ''
		
		if(i + 1 <= text_list.length){
			next_line = text_list[i+1]
		}

		//判断this line是否有评论
		var is_comment = this_line.indexOf('--')
		if(is_comment >= 0){
			var comment_loc = return_right_comment_loc(this_line)
		}
		
		//针对本行，如果有逗号，先剔除
		if (/^\s+\,/.exec(this_line)) {
			var the_comma_loc = this_line.indexOf(',');
			this_line = this_line.slice(0,the_comma_loc) + ' ' + this_line.slice(the_comma_loc+1,);
		}

		this_line.replace(/\s$/ig, "") + ',' + '\n '
		

		if (/^\s+\,/.exec(next_line)){
			if(is_comment >0){//如果有comment可以调整逗号位置
				text_final += this_line.slice(0,comment_loc).replace(/\s$/ig, "") + "," + this_line.slice(comment_loc,) + '\n';
			}else{
				text_final += this_line.replace(/\s$/ig, "") + ',' + '\n'; 
			}

		} else{
			text_final +=this_line + '\n';
		}
	}
	return text_final.replace(/\-\-\{\}/ig, "\n--")
}

function order_comment(str, as_loc_cnt){
	var final_text="";
	var text_list = str.split("\n");
	var current_group = [];

	function is_comment_alignment_break(line) {
		var trimmed = line.replace(/^\s+/ig, '');
		return trimmed === ""
			|| /^\($/.exec(trimmed)
			|| /^\)/.exec(trimmed)
			|| /^SELECT\b/i.exec(trimmed)
			|| /^UNION\b/i.exec(trimmed)
			|| /^WITH\b/i.exec(trimmed);
	}

	function get_inline_comment_parts(line) {
		var comment_loc = get_line_comment_loc(line);
		if (comment_loc <= 0 || line.slice(0, comment_loc).trim() === "") {
			return null;
		}

		return {
			code: line.slice(0, comment_loc).replace(/\s+$/ig, ''),
			comment: line.slice(comment_loc).replace(/^--\s*/ig, '').replace(/\s+$/ig, '')
		};
	}

	function flush_group() {
		if (current_group.length === 0) {
			return;
		}

		var target_comment_loc = 0;

		for (let i = 0; i < current_group.length; i++) {
			var visual_code_length = expand_tabs_for_width(current_group[i].code).length;
			var alignment_width = get_alignment_width_for_code(current_group[i].code).width;
			if (alignment_width < as_loc_cnt && visual_code_length + 1 > target_comment_loc) {
				target_comment_loc = visual_code_length + 1;
			}
		}

		for (let i = 0; i < current_group.length; i++) {
			var item = current_group[i];
			var item_visual_length = expand_tabs_for_width(item.code).length;
			var item_alignment_width = get_alignment_width_for_code(item.code).width;
			if (item_alignment_width >= as_loc_cnt || target_comment_loc <= 0) {
				text_list[item.index] = item.code + ' -- ' + item.comment;
			} else {
				text_list[item.index] = item.code + " ".times(target_comment_loc - item_visual_length) + '-- ' + item.comment;
			}
		}

		current_group = [];
	}

	for (let i = 0; i < text_list.length; i++){
		if (is_comment_alignment_break(text_list[i])) {
			flush_group();
		}

		var parts = get_inline_comment_parts(text_list[i]);
		if (parts == null) {
			continue;
		}

		current_group.push({
			index: i,
			code: parts.code,
			comment: parts.comment
		});
	}

	flush_group();

	for (let i = 0; i < text_list.length; i++){
		final_text+=(text_list[i]+"\n");
	}
	return final_text;
}

function get_condition_leading_tabs(line) {
	var match = line.match(/^\t*/);
	return match == null ? '' : match[0];
}

function find_root_case_start_loc(line) {
	var code = split_code_and_comment(line).code;
	var tokens = get_case_tokens(code);

	for (let i = 0; i < tokens.length; i++) {
		if (tokens[i].word == 'CASE' && tokens[i].depth == 1) {
			return tokens[i].start;
		}
	}

	return -1;
}

function shift_line_leading_indent(line, delta) {
	if (delta == 0 || line == '') {
		return line;
	}

	var match = line.match(/^\s*/);
	var leading = match == null ? '' : match[0];
	var rest = line.slice(leading.length);
	var new_width = expand_tabs_for_width(leading).length + delta;

	if (new_width < 0) {
		new_width = 0;
	}

	return " ".times(new_width) + rest;
}

function build_condition_line(prefix_tabs, target_keyword_end, keyword, suffix_text) {
	var prefix_width = expand_tabs_for_width(prefix_tabs).length;
	var indent_length = target_keyword_end - prefix_width - keyword.length;
	if (indent_length < 0) {
		indent_length = 0;
	}

	return prefix_tabs + " ".times(indent_length) + keyword + suffix_text;
}

function align_condition_clauses(str) {
	var final_text = "";
	var text_list = str.split("\n");
	var current_target_keyword_end = -1;
	var current_prefix_tabs = '';
	var case_indent_delta = 0;
	var case_block_depth = 0;

	for (let i = 0; i < text_list.length; i++) {
		var sen = text_list[i];
		var should_shift_case_line = false;
		var before_case_loc = -1;

		if (case_block_depth > 0) {
			should_shift_case_line = !/^(ON|WHERE|HAVING|AND|OR)\b/i.exec(sen.replace(/^\s+/ig, ''));
			if (should_shift_case_line) {
				sen = shift_line_leading_indent(sen, case_indent_delta);
			}
		}

		before_case_loc = find_root_case_start_loc(sen);
		var trimmed = sen.replace(/^\s+/ig, '');
		var clause_match = trimmed.match(/^(ON|WHERE|HAVING)\b/i);
		var condition_match = trimmed.match(/^(AND|OR)\b/i);
		var aligned_condition_line = false;
		var started_case_block = false;

		if (clause_match != null) {
			var keyword = clause_match[1];
			current_prefix_tabs = get_condition_leading_tabs(sen);
			var prefix_width = expand_tabs_for_width(current_prefix_tabs).length;
			if (/^ON$/i.exec(keyword)) {
				current_target_keyword_end = prefix_width + 7;
			} else {
				current_target_keyword_end = prefix_width + keyword.length;
			}

			sen = build_condition_line(
				current_prefix_tabs,
				current_target_keyword_end,
				keyword,
				trimmed.slice(keyword.length)
			);
			aligned_condition_line = true;
		} else if (condition_match != null && current_target_keyword_end >= 0) {
			var condition_keyword = condition_match[1];
			sen = build_condition_line(
				current_prefix_tabs,
				current_target_keyword_end,
				condition_keyword,
				trimmed.slice(condition_keyword.length)
			);
			aligned_condition_line = true;
		} else if (/^(SELECT|FROM|JOIN|LEFT|RIGHT|FULL|INNER|CROSS|GROUP BY|ORDER BY|SORT BY|CLUSTER BY|LIMIT|DISTRIBUTE BY|UNION|WITH)\b/i.exec(trimmed)
			|| /^\)/.exec(trimmed)
			|| /^\($/.exec(trimmed)) {
			current_target_keyword_end = -1;
			current_prefix_tabs = '';
		}

		if (aligned_condition_line) {
			var after_case_loc = find_root_case_start_loc(sen);
			var line_case_delta = get_case_balance_delta(sen);
			if (after_case_loc >= 0 && line_case_delta > 0) {
				case_indent_delta = before_case_loc >= 0 ? after_case_loc - before_case_loc : 0;
				case_block_depth = line_case_delta;
				started_case_block = true;
			}
		}

		if (!started_case_block && case_block_depth > 0 && should_shift_case_line) {
			case_block_depth += get_case_balance_delta(sen);
			if (case_block_depth <= 0) {
				case_block_depth = 0;
				case_indent_delta = 0;
			}
		}

		if (sen != "") {
			final_text += sen + "\n";
		}
	}

	return final_text;
}


vkbeautify.prototype.sql = function(text,uppercase,comma_location,bracket_char,as_loc_cnt,case_when_then_wrap_length) {
	restore_list = []
	restore_cnt = 0
	standalone_comment_list = []

	var step0 = extract_quotation_mark(text)
	step0 = protect_standalone_comments(step0);
	step0 = protect_inline_comments(step0);
	var step1 = reshape_comment(step0);
	var step2 = replace_char(step1) ;
	var step3 = get_bracket(step2);
	var step4 = except_subquery(step3)
	.replace(/\{\.\*\.\*\}/ig,"(")  //复原之前修改的注释后中文()的项目
	.replace(/\{\*\.\*\.\}/ig,")");
	// step5 = special_wrap(step4).replace(/\-\-\s{0,}\n/ig, "\n-- ");
	var step5 = special_wrap(step4, as_loc_cnt, case_when_then_wrap_length);
	var step6 = bracket_deep(step5); 
	var step7 = extra(step6);
	var step8 = restore_strmark(step7);

	// 恢复独立行注释的换行
	var currentStep = step8.replace(/\s{0,1}--\{\}/g, "\n--");
	currentStep = restore_standalone_comments(currentStep);
	currentStep = format_case_blocks(currentStep, case_when_then_wrap_length);
	currentStep = align_as_in_select_blocks(currentStep, as_loc_cnt);
	
	if (uppercase === false) {
		currentStep = convert_lowercase(currentStep);
	}
	
	if (comma_location === true) {
		currentStep = convert_comma_loaction(currentStep);
	}
	
	currentStep = align_condition_clauses(currentStep);
	currentStep = order_comment(currentStep, as_loc_cnt);

	if (bracket_char === true) {
		currentStep = currentStep.replace(/\t/ig, "    ");
	}

	// 确保所有 -- 后面都有空格
	currentStep = currentStep.replace(/--([^\s\-\n])/g, "-- $1");

	return currentStep;
};

vkbeautify.prototype.sqlddl = function(text) {
	return ddl(text)
}


vkbeautify.prototype.extractddl = function(text) {
	return extractddl(text)
}

module.exports = new vkbeautify();
