var sqlFormatUtils = require('./sql-format-utils');
var sqlClauseRegistry = require('./sql-clause-registry');
var repeat_string = sqlFormatUtils.repeat_string;

function indent_nested_blocks(str) {
	var text_final = '';
	var text_list = [];
	var text_list_orginal = String(str || '').split("\n");
	for (var i = 0; i < text_list_orginal.length; i++) {
		if (text_list_orginal[i] != "" && text_list_orginal[i] != " ") {
			text_list.push(text_list_orginal[i]);
		}
	}

	var bracket_deep = 0;
	var deep = "\t";

	for (i = 0; i < text_list.length; i++) {
		if (text_list[i].replace(/\t{0,}/, "")[0] == ')') {
			bracket_deep -= 1;
		}

		text_list[i] = repeat_string(deep, bracket_deep) + text_list[i];

		if (text_list[i].replace(/\t{0,}/, "")[0] == '(') {
			bracket_deep += 1;
		}

		text_final += "\n" + text_list[i];
	}

	return text_final;
}

function should_insert_statement_gap(current_line, previous_line, dialect) {
	var trimmed = String(current_line || '').replace(/^\s+/g, '');
	var previous = String(previous_line || '');

	if (!sqlClauseRegistry.is_statement_start(trimmed, dialect || 'generic')) {
		return false;
	}

	if (/^CREATE\b/i.exec(trimmed) && (/\bDROP\b/i.exec(previous) || /\bADD\s+JAR\b/i.exec(previous))) {
		return false;
	}

	if (/^SET\b/i.exec(trimmed) && /\bSET\b/i.exec(previous)) {
		return false;
	}

	return true;
}

function should_insert_select_after_statement_gap(current_line, previous_line, dialect) {
	return String(previous_line || '').indexOf(';') >= 0
		&& sqlClauseRegistry.is_select_block_start(current_line, dialect || 'generic');
}

function cleanup_layout_markers(str, dialect) {
	var text_final = '';
	var text_list_orginal = String(str || '').split("\n");
	var text_list = [];

	for (var i = 0; i < text_list_orginal.length; i++) {
		if (text_list_orginal[i] != "" && text_list_orginal[i] != " ") {
			text_list.push(text_list_orginal[i].replace(/\s$/ig, ""));
		}
	}

	for (let i = 0; i < text_list.length; i++) {
		var last_str = i == 0 ? "" : text_list[i - 1];

		if (i > 0) {
			text_final += '\n';
		}

		if (i > 0 && should_insert_statement_gap(text_list[i], last_str, dialect)) {
			text_final += '\n' + text_list[i];
		} else if (i > 0 && should_insert_select_after_statement_gap(text_list[i], last_str, dialect)) {
			text_final += '\n' + text_list[i];
		} else {
			text_final += text_list[i];
		}
	}

	return text_final.replace(/\n{1,2} *--/ig, "\n--").replace(/^ */ig, "")
		.replace(/\-\-\{\}WHEREiscomment/ig, "\-\-\{\} WHERE")
		.replace(/\-\-\{\}ANDiscomment/ig, "\-\-\{\} AND")
		.replace(/\-\-\{\}SELECTiscomment/ig, "\-\-\{\} SELECT")
		.replace(/\-\-\{\}FROMiscomment/ig, "\-\-\{\} FROM")
		.replace(/\-\-\{\}BETWEENiscomment/ig, "\-\-\{\} BETWEEN")
		.replace(/\-\-\{\}orderbyiscomment/ig, "\-\-\{\} ORDER BY")
		.replace(/\-\-WHEREiscomment/ig, "\-\- WHERE")
		.replace(/\-\-ANDiscomment/ig, "\-\- AND")
		.replace(/\-\-SELECTiscomment/ig, "\-\- SELECT")
		.replace(/\-\-FROMiscomment/ig, "\-\- FROM")
		.replace(/\-\-BETWEENiscomment/ig, "\-\- BETWEEN")
		.replace(/\-\-orderbyiscomment/ig, "\-\- ORDER BY")
		.replace(/\{comma\}/ig, ",")
		.replace(/UNIONALLALL/ig, "UNION ALL")
		.replace(/(\s|\n){1,};(\n|\s){0,}/ig, "\n;\n\n")
		.replace(/shouldhavenbehind\n/ig, "\n")
		.replace(/shouldhavenbehind/ig, "\n");
}

exports.indent_nested_blocks = indent_nested_blocks;
exports.cleanup_layout_markers = cleanup_layout_markers;
