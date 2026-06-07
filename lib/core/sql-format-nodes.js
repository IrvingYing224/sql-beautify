var scopeModel = require('./sql-scope-model');
var sqlFormatNavigation = require('./sql-format-navigation');
var sqlNodeUtils = require('./sql-node-utils');
var sqlListNodes = require('./sql-list-nodes');
var sqlSelectItemNodes = require('./sql-select-item-nodes');

function is_code_token(token) {
	return sqlNodeUtils.is_code_token(token);
}

function is_word(token, value) {
	return sqlNodeUtils.is_word(token, value);
}

function token_in_range(token, startIndex, endIndex) {
	return sqlNodeUtils.token_in_range(token, startIndex, endIndex);
}

function tokens_in_range(document, startIndex, endIndex) {
	return sqlNodeUtils.tokens_in_range(document, startIndex, endIndex);
}

function is_clause_start_token(token) {
	if (!is_word(token)) {
		return false;
	}
	return /^(SELECT|FROM|WHERE|GROUP|ORDER|HAVING|QUALIFY|LIMIT|UNION|JOIN|LEFT|RIGHT|INNER|FULL|CROSS|OUTER|BY)$/i.exec(token.value);
}

function create_list_spans(document, options) {
	return sqlListNodes.create_list_spans(document, options);
}

function find_separators(document, selectSpans) {
	return sqlListNodes.find_separators(document, selectSpans);
}

function find_select_items(document, selectSpans, separators) {
	return sqlSelectItemNodes.find_select_items(document, selectSpans, separators);
}

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

function find_condition_blocks(document) {
	var conditionScopes = scopeModel.find_scopes_by_kind(document.scopes || [], 'conditionBlock');
	function scope_by_id(scopeId) {
		return sqlFormatNavigation.scope_by_id(document, scopeId);
	}
	function is_inside_inline_query(scope) {
		var parent = scope_by_id(scope.parentScopeId);
		return parent
			&& parent.kind == 'query'
			&& parent.id != 0
			&& parent.openLine == parent.closeLine;
	}
	conditionScopes = conditionScopes.filter(function(scope) {
		return !is_inside_inline_query(scope);
	});
	return conditionScopes.map(function(scope, index) {
		var block = {
			id: 'conditionBlock:' + index,
			scopeId: scope.id,
			keyword: scope.keyword,
			comment: document.lines[scope.startLine] ? document.lines[scope.startLine].commentText : '',
			startLine: scope.startLine,
			endLine: scope.endLine,
			startTokenIndex: scope.startTokenIndex,
			endTokenIndex: scope.endTokenIndex,
			segments: [],
			continuationLines: [],
			closeLines: []
		};
			var nestedOwnerKinds = [
				'query',
				'inList',
				'functionCall',
				'parenList',
				'windowSpec'
			];
			var state = {
				parenDepth: 0,
				caseDepth: 0,
				betweenDepth: 0
			};

			function update_condition_state(token) {
				if (token.type == 'punctuation' && token.value == '(') {
					state.parenDepth += 1;
				} else if (token.type == 'punctuation' && token.value == ')' && state.parenDepth > 0) {
					state.parenDepth -= 1;
				}
				if (is_word(token, 'CASE')) {
					state.caseDepth += 1;
				} else if (is_word(token, 'END') && state.caseDepth > 0) {
					state.caseDepth -= 1;
				}
				if (is_word(token, 'BETWEEN')) {
					state.betweenDepth += 1;
				}
			}

			function is_top_level_condition_connector(token) {
				if (!is_word(token, 'AND') && !is_word(token, 'OR')) {
					return false;
				}
				if (is_word(token, 'AND') && state.betweenDepth > 0) {
					state.betweenDepth -= 1;
					return false;
				}
				return state.parenDepth == 0 && state.caseDepth == 0;
			}

			function should_ignore_nested_owner(nestedOwner) {
				if (!nestedOwner) {
					return false;
				}
				if (nestedOwner.kind == 'query') {
					return nestedOwner.id != scope.parentScopeId;
				}
				return true;
			}

			function is_owned_query_close(nestedOwner, token) {
				return nestedOwner
					&& nestedOwner.kind == 'query'
					&& nestedOwner.parentScopeId == scope.id
					&& nestedOwner.closeTokenIndex == token.index;
			}

		for (var lineIndex = scope.startLine; lineIndex <= scope.endLine; lineIndex++) {
			var line = document.lines[lineIndex];
			var lineTokens = line ? line.codeTokens.filter(function(token) {
				return token.index >= scope.startTokenIndex && token.index <= scope.endTokenIndex;
			}) : [];
			var emittedBoundary = false;

			for (var tokenIndex = 0; tokenIndex < lineTokens.length; tokenIndex++) {
				var firstToken = lineTokens[tokenIndex];
					if (tokenIndex == 0 && firstToken.type == 'punctuation' && firstToken.value == ')') {
						var nestedCloseOwner = scopeModel.find_owner_scope(document.scopes || [], firstToken, nestedOwnerKinds);
						if (is_owned_query_close(nestedCloseOwner, firstToken)) {
							emittedBoundary = true;
							break;
						}
						if (!nestedCloseOwner
							|| nestedCloseOwner.parentScopeId != scope.id
							|| nestedCloseOwner.closeIndentOwnerKind == 'conditionBlock') {
							block.closeLines.push({
								lineIndex: lineIndex,
								tokens: lineTokens.slice(tokenIndex),
								comment: line.commentText
							});
							emittedBoundary = true;
							break;
						}
						emittedBoundary = true;
						break;
					}

					var nestedOwner = scopeModel.find_owner_scope(document.scopes || [], firstToken, nestedOwnerKinds);
					if (should_ignore_nested_owner(nestedOwner)) {
						continue;
					}

					if (is_word(firstToken, scope.keyword) && firstToken.index == scope.startTokenIndex) {
						if (lineTokens.length > tokenIndex + 1) {
							block.segments.push({
							lineIndex: lineIndex,
							kind: 'clause',
							connector: scope.keyword,
							tokens: lineTokens.slice(tokenIndex),
							comment: line.commentText
							});
						}
						emittedBoundary = true;
						update_condition_state(firstToken);
						continue;
					}

					if (is_top_level_condition_connector(firstToken)) {
						block.segments.push({
							lineIndex: lineIndex,
							kind: 'connector',
						connector: firstToken.value.toUpperCase(),
						tokens: lineTokens.slice(tokenIndex),
							comment: line.commentText
						});
						emittedBoundary = true;
						update_condition_state(firstToken);
						continue;
					}

					update_condition_state(firstToken);

					if (!emittedBoundary && lineIndex != scope.startLine && !lineTokens.some(is_clause_start_token)) {
						block.continuationLines.push({
						lineIndex: lineIndex,
						kind: 'bare',
						tokens: lineTokens.slice(tokenIndex),
						comment: line.commentText
					});
					break;
				}
			}
		}

		return block;
	});
}

function extract(document, options) {
	if (!document.scopes) {
		document.scopes = [];
	}
	var selectSpans = create_list_spans(document, options);
	var separators = find_separators(document, selectSpans);
	var extracted = {
		selectItems: find_select_items(document, selectSpans, separators),
		caseExpressions: find_case_expressions(document),
		conditionBlocks: find_condition_blocks(document),
		separators: separators,
		selectSpans: selectSpans
	};
	document.nodes = extracted;
	return extracted;
}

exports.extract = extract;
exports.find_select_items = find_select_items;
exports.find_case_expressions = find_case_expressions;
exports.find_condition_blocks = find_condition_blocks;
exports.find_separators = find_separators;
