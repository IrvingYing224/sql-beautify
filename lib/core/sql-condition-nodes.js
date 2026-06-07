var scopeModel = require('./sql-scope-model');
var sqlFormatNavigation = require('./sql-format-navigation');
var sqlNodeUtils = require('./sql-node-utils');

var is_word = sqlNodeUtils.is_word;

function is_clause_start_token(token) {
	if (!is_word(token)) {
		return false;
	}
	return /^(SELECT|FROM|WHERE|GROUP|ORDER|HAVING|QUALIFY|LIMIT|UNION|JOIN|LEFT|RIGHT|INNER|FULL|CROSS|OUTER|BY)$/i.exec(token.value);
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

exports.find_condition_blocks = find_condition_blocks;
