var sqlGroupByExtension = require('./sql-group-by-extension');

function has_comment_token(tokens) {
	for (var i = 0; i < (tokens || []).length; i++) {
		if (tokens[i].type == 'line_comment' || tokens[i].type == 'block_comment') {
			return true;
		}
	}
	return false;
}

function assert_token_list_has_no_comments(tokens, label) {
	if (has_comment_token(tokens)) {
		throw new Error(label + ' must not contain comment tokens');
	}
}

function assert_comments_not_in_code_nodes(document, nodes) {
	var extracted = nodes || document.nodes || {};
	var i;
	var b;

	for (i = 0; i < (extracted.selectItems || []).length; i++) {
		assert_token_list_has_no_comments(extracted.selectItems[i].tokens, extracted.selectItems[i].id);
	}

	for (i = 0; i < (extracted.caseExpressions || []).length; i++) {
		var caseNode = extracted.caseExpressions[i];
		for (b = 0; b < caseNode.branches.length; b++) {
			assert_token_list_has_no_comments(caseNode.branches[b].whenTokens, caseNode.id + '.when');
			assert_token_list_has_no_comments(caseNode.branches[b].thenTokens, caseNode.id + '.then');
		}
		assert_token_list_has_no_comments(caseNode.elseTokens, caseNode.id + '.else');
		assert_token_list_has_no_comments(caseNode.suffixTokens, caseNode.id + '.suffix');
	}

	for (i = 0; i < (extracted.conditionBlocks || []).length; i++) {
		var block = extracted.conditionBlocks[i];
		for (b = 0; b < (block.segments || []).length; b++) {
			assert_token_list_has_no_comments(block.segments[b].tokens, block.id + '.segment');
		}
	}
}

function assert_literal_tokens_preserved(document) {
	var source = document.source || '';
	var protectedTypes = {
		string_literal: true,
		quoted_identifier: true,
		block_comment: true
	};

	for (var i = 0; i < document.tokens.length; i++) {
		var token = document.tokens[i];
		if (!protectedTypes[token.type]) {
			continue;
		}
		if (source.slice(token.start, token.end) != token.value) {
			throw new Error('protected token changed at token ' + token.index);
		}
	}
}

function is_movable_list_separator_kind(ownerKind) {
	return ownerKind == 'selectList'
		|| ownerKind == 'groupByList'
		|| ownerKind == 'orderByList';
}

function assert_separator_ownership(document, nodes) {
	var extracted = nodes || document.nodes || {};
	var separators = extracted.separators || [];

	for (var i = 0; i < separators.length; i++) {
		var separator = separators[i];
		if (separator.ownerScopeId === null || typeof separator.ownerKind != 'string') {
			throw new Error(separator.id + ' has no owner scope');
		}
		if (separator.mutationTarget == 'selectList'
			&& !is_movable_list_separator_kind(separator.ownerKind)) {
			throw new Error(separator.id + ' cannot be moved as a SELECT separator from ' + separator.ownerKind);
		}
	}
}

function separator_by_id(nodes, separatorId) {
	var separators = nodes && nodes.separators ? nodes.separators : [];

	for (var i = 0; i < separators.length; i++) {
		if (separators[i].id == separatorId) {
			return separators[i];
		}
	}

	return null;
}

function assert_separator_move_safe(nodes, move) {
	var separator = separator_by_id(nodes, move.separatorId);
	var target = move.target || {};

	if (!separator) {
		throw new Error('separator move references unknown separator ' + move.separatorId);
	}
	if (!is_movable_list_separator_kind(separator.ownerKind)) {
		throw new Error(separator.id + ' cannot be moved from ' + separator.ownerKind);
	}
	if (target.placement == 'linePrefix') {
		assert_prefix_text_safe(typeof target.text == 'string' ? target.text : ',', 'separator move text');
		assert_horizontal_whitespace_text(target.indentText || '', 'separator move indent');
	}
}

function token_by_id(document, tokenId) {
	for (var i = 0; i < (document.tokens || []).length; i++) {
		if (document.tokens[i].id == tokenId) {
			return document.tokens[i];
		}
	}

	return null;
}

function is_horizontal_whitespace_text(value) {
	return /^[ \t]*$/.test(String(value || ''));
}

function assert_horizontal_whitespace_text(value, label) {
	if (!is_horizontal_whitespace_text(value)) {
		throw new Error(label + ' must contain horizontal whitespace only');
	}
}

function assert_prefix_text_safe(value, label) {
	if (value == '' || value == ',') {
		return;
	}
	throw new Error(label + ' must be empty or a comma');
}

function assert_token_mutation_safe(document, mutation, label) {
	var token = token_by_id(document, mutation.tokenId);

	if (!token) {
		throw new Error(label + ' references unknown token ' + mutation.tokenId);
	}
	if (token.type == 'string_literal' || token.type == 'quoted_identifier'
		|| token.type == 'line_comment' || token.type == 'block_comment') {
		throw new Error(label + ' cannot mutate protected token ' + token.id);
	}
	if (!token.isCode) {
		throw new Error(label + ' cannot mutate non-code token ' + token.id);
	}
}

function is_protected_token(token) {
	return !!token && (token.type == 'string_literal' || token.type == 'quoted_identifier'
		|| token.type == 'line_comment' || token.type == 'block_comment');
}

function assert_line_break_mutation_safe(document, mutation) {
	var token = token_by_id(document, mutation.tokenId);

	if (!token) {
		throw new Error('line break references unknown token ' + mutation.tokenId);
	}
	if (token.type == 'line_comment' || token.type == 'block_comment') {
		throw new Error('line break cannot mutate protected token ' + token.id);
	}
	if (!token.isCode) {
		throw new Error('line break cannot mutate non-code token ' + token.id);
	}
	assert_horizontal_whitespace_text(mutation.indentText, 'line break indent');
	assert_prefix_text_safe(mutation.prefixText || '', 'line break prefix');
}

function assert_line_indent_safe(document, mutation) {
	var line = document.lines && document.lines[mutation.lineIndex];

	if (!line) {
		throw new Error('line indent references unknown line');
	}
	assert_horizontal_whitespace_text(mutation.indentText, 'line indent');
}

function assert_spacing_mutation_safe(document, mutation) {
	assert_token_mutation_safe(document, mutation, 'spacing');
	assert_horizontal_whitespace_text(mutation.spacingText, 'spacing');
}

function assert_comment_alignment_safe(document, mutation) {
	var line = document.lines && document.lines[mutation.lineIndex];

	if (!line) {
		throw new Error('comment alignment references unknown line');
	}
	if (typeof mutation.column != 'number' || !isFinite(mutation.column) || mutation.column < 0) {
		throw new Error('comment alignment column must be a non-negative number');
	}
}

function select_item_for_line(nodes, lineIndex) {
	var items = nodes && nodes.selectItems ? nodes.selectItems : [];

	for (var i = 0; i < items.length; i++) {
		if (lineIndex >= items[i].startLine && lineIndex <= items[i].endLine) {
			return items[i];
		}
	}

	return null;
}

function assert_line_comment_move_safe(document, nodes, move) {
	var sourceLine = document.lines && document.lines[move.fromLineIndex];
	var targetLine = document.lines && document.lines[move.toLineIndex];
	var sourceItem = select_item_for_line(nodes, move.fromLineIndex);
	var targetItem = select_item_for_line(nodes, move.toLineIndex);

	if (!sourceLine || !targetLine) {
		throw new Error('comment move references unknown line');
	}
	if (!sourceLine.hasTrailingComment) {
		throw new Error('comment move source has no trailing comment');
	}
	if (!sourceItem || !targetItem || sourceItem.id != targetItem.id) {
		throw new Error('comment move must stay within the same select item');
	}
}

function object_has_own(object, key) {
	return Object.prototype.hasOwnProperty.call(object || {}, key);
}

function line_has_comment(line) {
	return !!line && ((line.commentTokens && line.commentTokens.length > 0) || String(line.commentText || '') != '');
}

function line_has_block_comment(line) {
	var tokens = line && line.commentTokens ? line.commentTokens : [];

	for (var i = 0; i < tokens.length; i++) {
		if (tokens[i].type == 'block_comment') {
			return true;
		}
	}

	return false;
}

function line_comment_moved(plan, lineIndex) {
	return object_has_own(plan.lineCommentMoves, String(lineIndex));
}

function separator_move_removes_token(nodes, plan, token) {
	var moves = plan.separatorMoves || [];

	for (var i = 0; i < moves.length; i++) {
		var separator = separator_by_id(nodes, moves[i].separatorId);
		if (separator && separator.tokenId == token.id) {
			return true;
		}
	}

	return false;
}

function token_has_empty_replacement(plan, token) {
	var replacement = plan.tokenReplacements && plan.tokenReplacements[String(token.id)];
	return replacement && replacement.value == '';
}

function token_has_expanding_replacement(plan, token) {
	var replacement = plan.tokenReplacements && plan.tokenReplacements[String(token.id)];
	return replacement
		&& replacement.value != ''
		&& String(replacement.value).length > String(token.value || '').length;
}

function line_code_tokens_are_handled(nodes, plan, line) {
	var tokens = line && line.codeTokens ? line.codeTokens : [];

	for (var i = 0; i < tokens.length; i++) {
		if (object_has_own(plan.tokenOmissions, String(tokens[i].id))
			|| token_has_empty_replacement(plan, tokens[i])
			|| separator_move_removes_token(nodes, plan, tokens[i])) {
			continue;
		}
		return false;
	}

	return true;
}

function select_item_has_structural_replacement(document, plan, item) {
	var tokens = item && item.tokens ? item.tokens : [];

	for (var i = 0; i < tokens.length; i++) {
		var token = tokens[i];
		if (!token_has_expanding_replacement(plan, token)) {
			continue;
		}
		if (object_has_own(plan.lineOmissions, String(token.line))) {
			continue;
		}
		if (!document.lines || !document.lines[token.line]) {
			continue;
		}
		return true;
	}

	return false;
}

function line_code_omission_has_structural_replacement(document, nodes, plan, line) {
	var item = select_item_for_line(nodes, line.index);
	return select_item_has_structural_replacement(document, plan, item);
}

function token_omission_has_structural_replacement(document, nodes, plan, token) {
	var item = select_item_for_line(nodes, token.line);
	return select_item_has_structural_replacement(document, plan, item);
}

function token_is_moved_separator(nodes, plan, token) {
	return !!token
		&& token.type == 'punctuation'
		&& token.value == ','
		&& separator_move_removes_token(nodes, plan, token);
}

function active_code_tokens(document) {
	var tokens = [];
	for (var i = 0; i < (document.tokens || []).length; i++) {
		if (document.tokens[i].isCode) {
			tokens.push(document.tokens[i]);
		}
	}
	return tokens;
}

function token_is_group_by_extension_leading_comma(document, token) {
	if (!token || token.type != 'punctuation' || token.value != ',') {
		return false;
	}

	var tokens = active_code_tokens(document);
	for (var i = 0; i < tokens.length; i++) {
		if (tokens[i].id != token.id) {
			continue;
		}
		return sqlGroupByExtension.is_start(tokens, i + 1);
	}

	return false;
}

function assert_line_omission_safe(document, nodes, plan, omission) {
	var line = document.lines && document.lines[omission.lineIndex];

	if (!line) {
		throw new Error('line omission references unknown line');
	}
	if (line.isBlank) {
		return;
	}
	if (line_has_active_code(line) && !line_code_tokens_are_handled(nodes, plan, line)) {
		throw new Error('line omission cannot omit unhandled code on line ' + line.index);
	}
	if (line_has_active_code(line) && !line_code_omission_has_structural_replacement(document, nodes, plan, line)) {
		throw new Error('line omission cannot omit code without structural replacement on line ' + line.index);
	}
	if (!line_has_comment(line)) {
		return;
	}
	if (line.hasTrailingComment && !line_has_block_comment(line) && line_comment_moved(plan, line.index)) {
		return;
	}

	throw new Error('line omission cannot omit comments on line ' + line.index);
}

function previous_rendered_line_index(document, plan, lineIndex) {
	for (var i = lineIndex - 1; i >= 0; i--) {
		if (!object_has_own(plan.lineOmissions, String(i))) {
			return i;
		}
	}

	return -1;
}

function line_is_omitted(plan, lineIndex) {
	return object_has_own(plan.lineOmissions, String(lineIndex));
}

function assert_no_omitted_line_conflicts(plan) {
	var key;
	var i;

	for (key in (plan.lineOmissions || {})) {
		if (!Object.prototype.hasOwnProperty.call(plan.lineOmissions, key)) {
			continue;
		}
		if (object_has_own(plan.lineIndents, key)
			|| object_has_own(plan.lineJoins, key)
			|| object_has_own(plan.commentAlignments, key)) {
			throw new Error('line mutation conflict on omitted line ' + key);
		}
	}

	for (i = 0; i < (plan.separatorMoves || []).length; i++) {
		var target = plan.separatorMoves[i].target || {};
		if (typeof target.lineIndex == 'number' && line_is_omitted(plan, target.lineIndex)) {
			throw new Error('separator move cannot target omitted line ' + target.lineIndex);
		}
	}

	for (key in (plan.lineCommentMoves || {})) {
		if (!Object.prototype.hasOwnProperty.call(plan.lineCommentMoves, key)) {
			continue;
		}
		var move = plan.lineCommentMoves[key];
		if (line_is_omitted(plan, move.toLineIndex)) {
			throw new Error('comment move cannot target omitted line ' + move.toLineIndex);
		}
	}
}

function line_has_active_code(line) {
	return !!line && line.codeTokens && line.codeTokens.length > 0;
}

function line_is_comment_only(line) {
	return !!line && !line_has_active_code(line) && line_has_comment(line);
}

function assert_line_join_safe(document, plan, join) {
	var line = document.lines && document.lines[join.lineIndex];
	var previousLineIndex;
	var previousLine;

	if (!line) {
		throw new Error('line join references unknown line');
	}
	assert_horizontal_whitespace_text(join.separatorText, 'line join separator');
	if (line.isStandaloneComment || line_is_comment_only(line)) {
		throw new Error('line join cannot join standalone comment line ' + line.index);
	}
	if (!line_has_active_code(line)) {
		throw new Error('line join requires active code on line ' + line.index);
	}

	previousLineIndex = previous_rendered_line_index(document, plan, join.lineIndex);
	if (previousLineIndex < 0) {
		throw new Error('line join has no previous rendered line');
	}

	previousLine = document.lines[previousLineIndex];
	if (previousLine.hasTrailingComment || previousLine.isStandaloneComment || line_is_comment_only(previousLine)) {
		throw new Error('line join cannot append after comment line ' + previousLine.index);
	}
}

function assert_token_omission_safe(document, nodes, plan, mutation) {
	var token = token_by_id(document, mutation.tokenId);

	if (!token) {
		throw new Error('token omission references unknown token ' + mutation.tokenId);
	}
	if (!token.isCode) {
		throw new Error('token omission cannot mutate non-code token ' + token.id);
	}
	if (token_is_moved_separator(nodes, plan, token)) {
		return;
	}
	if (token_is_group_by_extension_leading_comma(document, token)) {
		return;
	}
	if (token_omission_has_structural_replacement(document, nodes, plan, token)) {
		return;
	}
	if (is_protected_token(token)) {
		throw new Error('token omission cannot mutate protected token ' + token.id);
	}

	throw new Error('token omission cannot omit active SQL token ' + token.id);
}

function assert_token_replacement_safe(document, nodes, plan, mutation) {
	var token = token_by_id(document, mutation.tokenId);

	assert_token_mutation_safe(document, mutation, 'token replacement');
	if (mutation.value != '') {
		return;
	}
	if (token_omission_has_structural_replacement(document, nodes, plan, token)) {
		return;
	}

	throw new Error('token replacement cannot delete active SQL token ' + token.id);
}

function assert_mutation_plan_safe(document, nodes, mutations) {
	var plan = mutations || {};
	var extractedNodes = nodes || document.nodes || {};
	var i;
	var key;

	assert_no_omitted_line_conflicts(plan);

	for (i = 0; i < (plan.separatorMoves || []).length; i++) {
		assert_separator_move_safe(extractedNodes, plan.separatorMoves[i]);
	}
	for (key in (plan.lineIndents || {})) {
		if (Object.prototype.hasOwnProperty.call(plan.lineIndents, key)) {
			assert_line_indent_safe(document, plan.lineIndents[key]);
		}
	}
	for (key in (plan.tokenReplacements || {})) {
		if (Object.prototype.hasOwnProperty.call(plan.tokenReplacements, key)) {
			assert_token_replacement_safe(document, extractedNodes, plan, plan.tokenReplacements[key]);
		}
	}
	for (key in (plan.lineBreaksBeforeToken || {})) {
		if (Object.prototype.hasOwnProperty.call(plan.lineBreaksBeforeToken, key)) {
			assert_line_break_mutation_safe(document, plan.lineBreaksBeforeToken[key]);
		}
	}
	for (key in (plan.tokenOmissions || {})) {
		if (Object.prototype.hasOwnProperty.call(plan.tokenOmissions, key)) {
			assert_token_omission_safe(document, extractedNodes, plan, plan.tokenOmissions[key]);
		}
	}
	for (key in (plan.spacingBeforeToken || {})) {
		if (Object.prototype.hasOwnProperty.call(plan.spacingBeforeToken, key)) {
			assert_spacing_mutation_safe(document, plan.spacingBeforeToken[key]);
		}
	}
	for (key in (plan.commentAlignments || {})) {
		if (Object.prototype.hasOwnProperty.call(plan.commentAlignments, key)) {
			assert_comment_alignment_safe(document, plan.commentAlignments[key]);
		}
	}
	for (key in (plan.lineCommentMoves || {})) {
		if (Object.prototype.hasOwnProperty.call(plan.lineCommentMoves, key)) {
			assert_line_comment_move_safe(document, extractedNodes, plan.lineCommentMoves[key]);
		}
	}
	for (key in (plan.lineOmissions || {})) {
		if (Object.prototype.hasOwnProperty.call(plan.lineOmissions, key)) {
			assert_line_omission_safe(document, extractedNodes, plan, plan.lineOmissions[key]);
		}
	}
	for (key in (plan.lineJoins || {})) {
		if (Object.prototype.hasOwnProperty.call(plan.lineJoins, key)) {
			assert_line_join_safe(document, plan, plan.lineJoins[key]);
		}
	}
}

function assert_document_safe(document, nodes) {
	assert_comments_not_in_code_nodes(document, nodes);
	assert_literal_tokens_preserved(document);
	assert_separator_ownership(document, nodes);
}

exports.assert_document_safe = assert_document_safe;
exports.assert_comments_not_in_code_nodes = assert_comments_not_in_code_nodes;
exports.assert_literal_tokens_preserved = assert_literal_tokens_preserved;
exports.assert_separator_ownership = assert_separator_ownership;
exports.assert_mutation_plan_safe = assert_mutation_plan_safe;
