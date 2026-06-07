var scopeModel = require('./sql-scope-model');
var sqlNodeUtils = require('./sql-node-utils');

var is_word = sqlNodeUtils.is_word;
var tokens_in_range = sqlNodeUtils.tokens_in_range;

function line_has_word(line, word) {
	for (var i = 0; i < line.codeTokens.length; i++) {
		if (is_word(line.codeTokens[i], word)) {
			return true;
		}
	}
	return false;
}

function apply_case_comments(document, caseNode) {
	var branchIndex = -1;

	for (var lineIndex = caseNode.startLine; lineIndex <= caseNode.endLine; lineIndex++) {
		var line = document.lines[lineIndex];
		if (!line || !line.commentText) {
			if (line && line_has_word(line, 'WHEN')) {
				branchIndex += 1;
			}
			continue;
		}

		if (line_has_word(line, 'CASE')) {
			caseNode.caseComment = line.commentText;
		}
		if (line_has_word(line, 'WHEN')) {
			branchIndex += 1;
			if (caseNode.branches[branchIndex]) {
				caseNode.branches[branchIndex].whenComment = line.commentText;
			}
		} else if (line_has_word(line, 'THEN')) {
			if (caseNode.branches[branchIndex]) {
				caseNode.branches[branchIndex].thenComment = line.commentText;
			}
		} else if (line_has_word(line, 'ELSE')) {
			caseNode.elseComment = line.commentText;
		}
	}
}

function find_case_expressions(document) {
	var caseScopes = scopeModel.find_scopes_by_kind(document.scopes || [], 'caseExpr');
	var expressions = [];

	function is_nested_case_token(scope, token) {
		for (var n = 0; n < caseScopes.length; n++) {
			var nested = caseScopes[n];
			if (nested.id == scope.id) {
				continue;
			}
			if (nested.startTokenIndex > scope.startTokenIndex
				&& nested.endTokenIndex <= scope.endTokenIndex
				&& token.index >= nested.startTokenIndex
				&& token.index <= nested.endTokenIndex) {
				return true;
			}
		}
		return false;
	}

	function append_case_value_token(caseNode, currentBranch, mode, token) {
		if (mode == 'when' && currentBranch) {
			currentBranch.whenTokens.push(token);
		} else if (mode == 'then' && currentBranch) {
			currentBranch.thenTokens.push(token);
		} else if (mode == 'else') {
			caseNode.elseTokens.push(token);
		} else if (mode == 'suffix') {
			caseNode.suffixTokens.push(token);
		}
	}

	for (var i = 0; i < caseScopes.length; i++) {
		var scope = caseScopes[i];
		var tokens = tokens_in_range(document, scope.startTokenIndex, scope.endTokenIndex);
		var caseNode = {
			id: 'caseExpr:' + expressions.length,
			scopeId: scope.id,
			startLine: scope.startLine,
			endLine: scope.endLine,
			caseKeywordToken: null,
			endKeywordToken: null,
			caseComment: '',
			branches: [],
			elseTokens: [],
			elseKeywordToken: null,
			elseComment: '',
			suffixTokens: []
		};
		var currentBranch = null;
		var mode = '';

		for (var t = 0; t < tokens.length; t++) {
			var token = tokens[t];
			if (is_nested_case_token(scope, token)) {
				append_case_value_token(caseNode, currentBranch, mode, token);
				continue;
			}
			if (is_word(token, 'CASE')) {
				caseNode.caseKeywordToken = token;
				continue;
			}
			if (is_word(token, 'WHEN')) {
				currentBranch = {
					whenKeywordToken: token,
					whenTokens: [],
					whenComment: '',
					thenKeywordToken: null,
					thenTokens: [],
					thenComment: ''
				};
				caseNode.branches.push(currentBranch);
				mode = 'when';
				continue;
			}
			if (is_word(token, 'THEN')) {
				if (currentBranch) {
					currentBranch.thenKeywordToken = token;
				}
				mode = 'then';
				continue;
			}
			if (is_word(token, 'ELSE')) {
				caseNode.elseKeywordToken = token;
				mode = 'else';
				continue;
			}
			if (is_word(token, 'END')) {
				caseNode.endKeywordToken = token;
				mode = 'suffix';
				continue;
			}

			append_case_value_token(caseNode, currentBranch, mode, token);
		}

		apply_case_comments(document, caseNode);
		expressions.push(caseNode);
	}

	return expressions;
}

exports.find_case_expressions = find_case_expressions;
