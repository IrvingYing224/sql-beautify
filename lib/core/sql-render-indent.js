var sqlFormatMutations = require('./sql-format-mutations');
var sqlFormatNavigation = require('./sql-format-navigation');

function line_prefix_indent(moveState, lineIndex) {
	var prefixes = moveState && moveState.prefixesByLine
		? moveState.prefixesByLine[String(lineIndex)]
		: null;

	if (!prefixes || prefixes.length == 0) {
		return null;
	}

	for (var i = 0; i < prefixes.length; i++) {
		if (prefixes[i] && typeof prefixes[i].indentText == 'string') {
			return prefixes[i].indentText;
		}
	}

	return null;
}

function effective_token_indent(document, token, mutations, moveState) {
	if (!token) {
		return '';
	}

	var line = document.lines[token.line];
	var lineMutations = sqlFormatMutations.get_for_line(mutations, token.line);
	var prefixIndent = line_prefix_indent(moveState, token.line);
	var indent = lineMutations.indent
		? lineMutations.indent.indentText
		: (prefixIndent != null)
			? prefixIndent
		: (line ? String(line.raw || '').match(/^\s*/)[0] : '');

	if (!line) {
		return indent;
	}

	for (var i = 0; i < line.tokens.length; i++) {
		var current = line.tokens[i];
		if (current.index > token.index) {
			break;
		}
		if (current.type == 'whitespace' || current.type == 'newline') {
			continue;
		}

		var tokenMutation = sqlFormatMutations.get_for_token(mutations, current.id);
		if (tokenMutation.lineBreakBefore) {
			indent = tokenMutation.lineBreakBefore.indentText;
		}
	}

	return indent;
}

function suffix_after_prefix(value, prefix) {
	value = String(value || '');
	prefix = String(prefix || '');

	if (value.slice(0, prefix.length) == prefix) {
		return value.slice(prefix.length);
	}

	return '';
}

function effective_scope_start_indent(document, scope, mutations, moveState) {
	if (!scope) {
		return '';
	}

	var token = sqlFormatNavigation.token_by_index(document, scope.startTokenIndex);
	return effective_token_indent(document, token, mutations, moveState);
}

function effective_scope_body_indent(document, scope, mutations, moveState) {
	if (scope && scope.kind == 'inList' && scope.closeIndentOwnerKind == 'conditionBlock') {
		return scope.bodyIndent || '';
	}
	var openToken = sqlFormatNavigation.token_by_index(document, scope.openTokenIndex);
	var openIndent = effective_token_indent(document, openToken, mutations, moveState);
	return openIndent + suffix_after_prefix(scope.bodyIndent, scope.openIndent);
}

function effective_scope_close_indent(document, scope, mutations, moveState) {
	if (scope && scope.closeIndentOwnerKind == 'conditionBlock') {
		return scope.closeIndent;
	}

	if (scope && scope.kind == 'query') {
		return effective_scope_start_indent(document, scope, mutations, moveState)
			+ suffix_after_prefix(scope.closeIndent, scope.openIndent);
	}

	var parent = sqlFormatNavigation.scope_by_id(document, scope.parentScopeId);

	if (parent) {
		return effective_scope_start_indent(document, parent, mutations, moveState)
			+ suffix_after_prefix(scope.closeIndent, String(scope.closeIndent || ''));
	}

	return scope.closeIndent;
}

function build_close_indent_by_line(document, mutations, moveState) {
	var lookup = {};
	var scopes = document.scopes || [];

	for (var i = 0; i < scopes.length; i++) {
		var scope = scopes[i];
		if (typeof scope.closeLine != 'number' || typeof scope.closeIndent != 'string') {
			continue;
		}
		var closeIndent = effective_scope_close_indent(document, scope, mutations, moveState);
		var key = String(scope.closeLine);
		if (typeof lookup[key] == 'undefined'
			|| closeIndent.length < lookup[key].length) {
			lookup[key] = closeIndent;
		}
	}

	return lookup;
}

function build_body_indent_by_line(document, mutations, moveState) {
	var lookup = {};
	var scopes = document.scopes || [];

	for (var i = 0; i < scopes.length; i++) {
		var scope = scopes[i];
		if (typeof scope.openLine != 'number'
			|| typeof scope.closeLine != 'number'
				|| typeof scope.bodyIndent != 'string'
				|| scope.closeLine <= scope.openLine) {
			continue;
		}
		var bodyIndent = effective_scope_body_indent(document, scope, mutations, moveState);

		for (var lineIndex = scope.openLine + 1; lineIndex < scope.closeLine; lineIndex++) {
			var key = String(lineIndex);
			if (typeof lookup[key] == 'undefined'
				|| bodyIndent.length > lookup[key].length) {
				lookup[key] = bodyIndent;
			}
		}
	}

	return lookup;
}

function apply_scope_close_indent(lineText, closeIndent) {
	if (typeof closeIndent != 'string') {
		return lineText;
	}

	var trimmed = String(lineText || '').replace(/^\s+/g, '');
	if (!/^\)/.test(trimmed)) {
		return lineText;
	}

	return closeIndent + trimmed;
}

function apply_scope_body_indent(lineText, bodyIndent) {
	if (typeof bodyIndent != 'string') {
		return lineText;
	}

	if (String(lineText || '').replace(/^\s+|\s+$/g, '') == '') {
		return lineText;
	}

	var currentIndent = String(lineText || '').match(/^\s*/)[0];
	if (currentIndent.length >= bodyIndent.length) {
		return lineText;
	}

	return bodyIndent + String(lineText || '').replace(/^\s+/g, '');
}

function apply_indent(lineText, indentMutation) {
	if (!indentMutation) {
		return lineText;
	}
	return indentMutation.indentText + String(lineText || '').replace(/^\s+/g, '');
}

function apply_line_prefix(lineText, prefixes) {
	if (!prefixes || prefixes.length == 0) {
		return lineText;
	}
	var originalIndent = String(lineText || '').match(/^\s*/)[0];
	var indent = typeof prefixes[0].indentText == 'string'
		? prefixes[0].indentText
		: originalIndent;
	var body = String(lineText || '').slice(originalIndent.length);
	var text = '';
	for (var i = 0; i < prefixes.length; i++) {
		text += typeof prefixes[i] == 'string' ? prefixes[i] : prefixes[i].text;
	}
	return indent + text + body.replace(/^\s+/g, '');
}

exports.build_close_indent_by_line = build_close_indent_by_line;
exports.build_body_indent_by_line = build_body_indent_by_line;
exports.apply_scope_close_indent = apply_scope_close_indent;
exports.apply_scope_body_indent = apply_scope_body_indent;
exports.apply_indent = apply_indent;
exports.apply_line_prefix = apply_line_prefix;
