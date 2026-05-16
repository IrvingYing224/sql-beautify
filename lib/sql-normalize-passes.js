var sqlTokenizer = require('./sql-tokenizer');
var sqlFormatUtils = require('./sql-format-utils');
sqlFormatUtils.install_string_times();

function normalize_set_payload(payload) {
	var tokens = sqlTokenizer.tokenize(payload.replace(/^\s+/ig, '').replace(/\s+$/ig, ''));
	var text = '';

	for (var i = 0; i < tokens.length; i++) {
		if (tokens[i].type == 'whitespace') {
			if (text != '' && !/\s$/.exec(text)) {
				text += ' ';
			}
			continue;
		}

		if (tokens[i].type == 'operator' && tokens[i].value == '=') {
			text = text.replace(/\s+$/ig, '') + ' = ';
			continue;
		}

		text += tokens[i].value;
	}

	text = text.replace(/\s+$/ig, '');
	return text == '' ? '' : ' ' + text;
}

function protect_set_payloads(str, context) {
	var tokens = sqlTokenizer.tokenize(str);
	var text = '';
	var at_statement_start = true;

	for (var i = 0; i < tokens.length; i++) {
		if (tokens[i].type == 'word' && /^SET$/i.exec(tokens[i].value) && at_statement_start) {
			var payload_text = '';
			text += tokens[i].value;
			i += 1;

			while (i < tokens.length
				&& !(tokens[i].type == 'punctuation' && tokens[i].value == ';')
				&& tokens[i].type != 'newline') {
				payload_text += tokens[i].value;
				i += 1;
			}

			text += context.store('set_payload', normalize_set_payload(payload_text));

			if (i < tokens.length) {
				text += tokens[i].value;
				if (tokens[i].type == 'punctuation' && tokens[i].value == ';'
					&& i + 1 < tokens.length
					&& tokens[i + 1].type == 'newline') {
					text += context.store('set_newline', '\n');
					i += 1;
				}
				at_statement_start = tokens[i].type == 'punctuation' && tokens[i].value == ';'
					|| tokens[i].type == 'newline';
			}
			continue;
		}

		text += tokens[i].value;

		if (tokens[i].type == 'punctuation' && tokens[i].value == ';') {
			at_statement_start = true;
		} else if (tokens[i].type == 'newline') {
			at_statement_start = true;
		} else if (tokens[i].type != 'whitespace') {
			at_statement_start = false;
		}
	}

	return {
		text: text
	};
}

function restore_set_payloads(str, context) {
	return context.restore('set_newline', context.restore('set_payload', str));
}

function replace_char(str) {
	return str.replace(/\n/g, " ")
		.replace(/\s+/ig, " ")
		.replace(/ AND /ig, " AND ")
		.replace(/ OR /ig, " OR ")
		.replace(/ NOT /ig, " NOT ")
		.replace(/ IS /ig, " IS ")
		.replace(/\nAND /ig, " AND ")
		.replace(/\nOR /ig, " OR ")
		.replace(/(^|[^.A-Za-z0-9_$])NULL\b/ig, "$1NULL")
		.replace(/(^|[^.A-Za-z0-9_$])TRUE\b/ig, "$1TRUE")
		.replace(/(^|[^.A-Za-z0-9_$])FALSE\b/ig, "$1FALSE")
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
		.replace(/-\s*>\s*>/ig, "->>")
		.replace(/-\s*>/ig, "->")
		.replace(/->>\s+/ig, "->>")
		.replace(/->\s+/ig, "->")
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
				
				(/\b(JOIN|WITH)\b/i.exec(last_str) 
				
				||  /^\)\s*\,\s*\w+\s+AS/.exec(last_str) 
				|| (/\bFROM\b/i.exec(last_str) && !/\b(EXPLODE|POSEXPLODE)\b/i.exec(last_str))
				
				
				)  
				
				&& !/\bORDER\s+BY\b/i.exec(last_str)  
	
				
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

		if (i > 0 && (/^\s*[^,]\s*INSERT\b/i.exec(text_list[i]) || /^\s*DROP\b/i.exec(text_list[i]) || /^\s*ALTER\b/i.exec(text_list[i]) || (/^\s*CREATE\b/i.exec(text_list[i]) &&  !/\bDROP\b/i.exec(last_str) && !/\bADD\s+JAR\b/i.exec(last_str)) || (/^\s*SET\b/i.exec(text_list[i]) && !/\bSET\b/i.exec(last_str)))) {
			text_final += '\n' + text_list[i];   //必须不是首行
		} else if(i > 0 && (/^\s*SELECT\b/i.exec(text_list[i]) && last_str.indexOf(';') >= 0)){
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

exports.normalize_set_payload = normalize_set_payload;
exports.protect_set_payloads = protect_set_payloads;
exports.restore_set_payloads = restore_set_payloads;
exports.replace_char = replace_char;
exports.get_bracket = get_bracket;
exports.bracket_deep = bracket_deep;
exports.extra = extra;
