var sqlCommentFormatter = require('./sql-comment-formatter');
var sqlCaseFormatter = require('./sql-case-formatter');
var sqlConditionFormatter = require('./sql-condition-formatter');
var sqlFormatUtils = require('./sql-format-utils');
sqlFormatUtils.install_string_times();
var expand_tabs_for_width = sqlFormatUtils.expand_tabs_for_width;
var split_code_and_comment = sqlCommentFormatter.split_code_and_comment;
var get_first_comment_loc = sqlCommentFormatter.get_first_comment_loc;
var format_case_expression_line = sqlCaseFormatter.format_case_expression_line;
var find_top_level_as_loc = sqlCaseFormatter.find_top_level_as_loc;
var get_outer_as_code_width = sqlCaseFormatter.get_outer_as_code_width;
var get_alignment_width_for_code = sqlCaseFormatter.get_alignment_width_for_code;
var condition_wrap = sqlConditionFormatter.condition_wrap;

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

	text_final = text_final.replace(', ', ',').replace('GROUP BY', 'GROUP BY ').replace('ORDER BY', 'ORDER BY ').replace(/\,\s{0,}/ig, ",").replace('SELECT','SELECT ');

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

function special_wrap(text,as_loc_cnt,case_when_then_wrap_length) {
	var text_final = '';
	var text_restore_orginal = text;
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
		if(/\bORDER\s+BY\b/i.exec(text_list[q])){
			var left_brkt = 0;
			var right_brkt = 0;
			var order_match = text_list[q].match(/\bORDER\s+BY\b/i);
			var ordr_loc = order_match.index + order_match[0].length;
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
				text_list[q] = text_list[q].replace(/\s+ORDER\s+BY\s+/i, '\nORDER BY ');
			}
		}
	
		text_final += "\n" + text_list[q];
	
	}

	return text_final;
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
		var comment_loc = get_first_comment_loc(this_line)
		var is_comment = comment_loc;
		
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

exports.expand_tabs_for_width = expand_tabs_for_width;
exports.align_as_in_select_blocks = align_as_in_select_blocks;
exports.special_wrap = special_wrap;
exports.except_subquery = except_subquery;
exports.convert_comma_loaction = convert_comma_loaction;
