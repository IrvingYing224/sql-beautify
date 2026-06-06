var sqlDialect = require('./sql-dialect');
var sqlTokenizer = require('./sql-tokenizer');

function resolve_tokenizer_options(options) {
	if (typeof options == 'string') {
		return options;
	}

	var source = options || {};
	var dialect = source.dialect || 'generic';
	var capabilities = sqlDialect.get_capabilities(dialect);
	var resolved = {};
	var key;

	for (key in capabilities) {
		if (Object.prototype.hasOwnProperty.call(capabilities, key)) {
			resolved[key] = capabilities[key];
		}
	}

	for (key in source) {
		if (Object.prototype.hasOwnProperty.call(source, key)) {
			resolved[key] = source[key];
		}
	}

	return resolved;
}

function split_lines_with_starts(source) {
	var lines = [];
	var start = 0;
	var i = 0;

	while (i < source.length) {
		if (source[i] == '\r' || source[i] == '\n') {
			lines.push({
				raw: source.slice(start, i),
				start: start
			});

			if (source[i] == '\r' && source[i + 1] == '\n') {
				i += 2;
			} else {
				i += 1;
			}

			start = i;
			continue;
		}

		i += 1;
	}

	lines.push({
		raw: source.slice(start),
		start: start
	});

	return lines;
}

function find_line_index(lineStarts, offset) {
	var low = 0;
	var high = lineStarts.length - 1;
	var found = 0;

	while (low <= high) {
		var mid = Math.floor((low + high) / 2);
		if (lineStarts[mid] <= offset) {
			found = mid;
			low = mid + 1;
		} else {
			high = mid - 1;
		}
	}

	return found;
}

function position_for_offset(lineStarts, offset) {
	var line = find_line_index(lineStarts, offset);
	return {
		line: line,
		column: offset - lineStarts[line]
	};
}

function is_comment_token(token) {
	return !!token && (token.type == 'line_comment' || token.type == 'block_comment');
}

function is_code_token(token) {
	return !!token
		&& token.type != 'newline'
		&& token.type != 'whitespace'
		&& !is_comment_token(token);
}

function is_structural_token(token) {
	return is_code_token(token)
		&& token.type != 'string_literal'
		&& token.type != 'quoted_identifier'
		&& token.type != 'placeholder';
}

function enrich_tokens(source, tokenizerOptions, lineStarts) {
	var rawTokens = sqlTokenizer.tokenize(source, tokenizerOptions);
	var tokens = [];

	for (var i = 0; i < rawTokens.length; i++) {
		var raw = rawTokens[i];
		var startPosition = position_for_offset(lineStarts, raw.start);
		var endPosition = position_for_offset(lineStarts, raw.end);
		var token = {
			id: i,
			index: i,
			type: raw.type,
			value: raw.value,
			start: raw.start,
			end: raw.end,
			line: startPosition.line,
			column: startPosition.column,
			endLine: endPosition.line,
			endColumn: endPosition.column
		};

		token.isComment = is_comment_token(token);
		token.isCode = is_code_token(token);
		token.isStructural = is_structural_token(token);
		tokens.push(token);
	}

	return tokens;
}

function create_line_record(index, raw, start) {
	return {
		index: index,
		raw: raw,
		start: start,
		end: start + raw.length,
		tokens: [],
		codeTokens: [],
		commentTokens: [],
		codeText: '',
		commentText: '',
		commentStart: -1,
		isBlank: false,
		isStandaloneComment: false,
		hasTrailingComment: false
	};
}

function attach_tokens_to_lines(lines, tokens) {
	for (var i = 0; i < tokens.length; i++) {
		var token = tokens[i];
		var line = lines[token.line];

		if (!line || token.type == 'newline') {
			continue;
		}

		line.tokens.push(token);
		if (is_comment_token(token)) {
			line.commentTokens.push(token);
		}
		if (is_code_token(token)) {
			line.codeTokens.push(token);
		}
	}
}

function first_line_comment_token(line) {
	for (var i = 0; i < line.tokens.length; i++) {
		if (line.tokens[i].type == 'line_comment') {
			return line.tokens[i];
		}
	}

	return null;
}

function finalize_line_record(line) {
	var commentToken = first_line_comment_token(line);
	var codeTrimmed;
	var commentTrimmed;

	if (commentToken) {
		line.commentStart = commentToken.column;
		line.codeText = line.raw.slice(0, commentToken.column).replace(/\s+$/g, '');
		line.commentText = line.raw.slice(commentToken.column).replace(/\s+$/g, '');
	} else {
		line.codeText = line.raw.replace(/\s+$/g, '');
		line.commentText = '';
		line.commentStart = -1;
	}

	codeTrimmed = line.codeText.replace(/^\s+|\s+$/g, '');
	commentTrimmed = line.commentText.replace(/^\s+|\s+$/g, '');

	line.isBlank = codeTrimmed == '' && commentTrimmed == '';
	line.isStandaloneComment = codeTrimmed == '' && /^(--|#)/.test(commentTrimmed);
	line.hasTrailingComment = codeTrimmed != '' && /^(--|#)/.test(commentTrimmed);
}

function get_line_code_text(line) {
	return line ? line.codeText : '';
}

function get_line_comment_text(line) {
	return line ? line.commentText : '';
}

function create_document_indexes(tokens, lines) {
	var tokenById = {};
	var tokenByIndex = {};
	var codeTokens = [];
	var codeTokenPositionByIndex = {};
	var lineByIndex = {};
	var i;

	for (i = 0; i < tokens.length; i++) {
		tokenById[String(tokens[i].id)] = tokens[i];
		tokenByIndex[String(tokens[i].index)] = tokens[i];
		if (tokens[i].isCode) {
			codeTokenPositionByIndex[String(tokens[i].index)] = codeTokens.length;
			codeTokens.push(tokens[i]);
		}
	}

	for (i = 0; i < lines.length; i++) {
		lineByIndex[String(lines[i].index)] = lines[i];
	}

	return {
		tokenById: tokenById,
		tokenByIndex: tokenByIndex,
		codeTokens: codeTokens,
		codeTokenPositionByIndex: codeTokenPositionByIndex,
		lineByIndex: lineByIndex
	};
}

function assign_document_indexes(document, indexes) {
	document.tokenById = indexes.tokenById;
	document.tokenByIndex = indexes.tokenByIndex;
	document.codeTokens = indexes.codeTokens;
	document.codeTokenPositionByIndex = indexes.codeTokenPositionByIndex;
	document.lineByIndex = indexes.lineByIndex;
	return document;
}

function from_text(text, tokenizerOptions) {
	var source = String(text || '');
	var options = resolve_tokenizer_options(tokenizerOptions);
	var rawLines = split_lines_with_starts(source);
	var lineStarts = [];
	var lines = [];
	var i;

	for (i = 0; i < rawLines.length; i++) {
		lineStarts.push(rawLines[i].start);
		lines.push(create_line_record(i, rawLines[i].raw, rawLines[i].start));
	}

	var tokens = enrich_tokens(source, options, lineStarts);
	attach_tokens_to_lines(lines, tokens);

	for (i = 0; i < lines.length; i++) {
		finalize_line_record(lines[i]);
	}

	return assign_document_indexes({
		source: source,
		tokenizerOptions: options,
		tokens: tokens,
		lines: lines,
		scopes: [],
		scopeById: {},
		nodes: null,
		diagnostics: []
	}, create_document_indexes(tokens, lines));
}

exports.from_text = from_text;
exports.is_code_token = is_code_token;
exports.is_comment_token = is_comment_token;
exports.get_line_code_text = get_line_code_text;
exports.get_line_comment_text = get_line_comment_text;
