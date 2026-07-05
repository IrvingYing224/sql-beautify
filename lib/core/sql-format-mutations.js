function create() {
	return {
			lineIndents: {},
			lineJoins: {},
			lineOmissions: {},
			separatorMoves: [],
			commentAlignments: {},
			lineCommentMoves: {},
		tokenOmissions: {},
		tokenReplacements: {},
		lineBreaksBeforeToken: {},
		spacingBeforeToken: {}
	};
}

	function add_line_indent(plan, lineIndex, indentText) {
		plan.lineIndents[String(lineIndex)] = {
			lineIndex: lineIndex,
			indentText: String(indentText || '')
		};
	}

	function add_line_join(plan, lineIndex, separatorText) {
		plan.lineJoins[String(lineIndex)] = {
			lineIndex: lineIndex,
			separatorText: typeof separatorText == 'string' ? separatorText : ' '
		};
	}

	function add_line_omission(plan, lineIndex) {
		plan.lineOmissions[String(lineIndex)] = {
			lineIndex: lineIndex
		};
	}

function add_separator_move(plan, separatorId, target) {
	plan.separatorMoves.push({
		separatorId: separatorId,
		target: target || {}
	});
}

function add_comment_alignment(plan, lineIndex, column, facts) {
	var mutation = {
		lineIndex: lineIndex,
		column: column
	};
	var source = facts || {};
	if (typeof source.codeWidth == 'number') {
		mutation.plannedCodeWidth = source.codeWidth;
	}
	if (typeof source.alignmentWidth == 'number') {
		mutation.plannedAlignmentWidth = source.alignmentWidth;
	}
	if (typeof source.joinPrefixWidth == 'number') {
		mutation.plannedJoinPrefixWidth = source.joinPrefixWidth;
	}
	plan.commentAlignments[String(lineIndex)] = mutation;
}

function add_line_comment_move(plan, fromLineIndex, toLineIndex) {
	plan.lineCommentMoves[String(fromLineIndex)] = {
		fromLineIndex: fromLineIndex,
		toLineIndex: toLineIndex
	};
}

function add_token_replacement(plan, tokenId, value) {
	plan.tokenReplacements[String(tokenId)] = {
		tokenId: tokenId,
		value: String(value)
	};
}

function add_token_omission(plan, tokenId) {
	plan.tokenOmissions[String(tokenId)] = {
		tokenId: tokenId
	};
}

function add_line_break_before_token(plan, tokenId, indentText, prefixText) {
	plan.lineBreaksBeforeToken[String(tokenId)] = {
		tokenId: tokenId,
		indentText: String(indentText || ''),
		prefixText: String(prefixText || '')
	};
}

function add_spacing_before_token(plan, tokenId, spacingText) {
	plan.spacingBeforeToken[String(tokenId)] = {
		tokenId: tokenId,
		spacingText: String(spacingText || '')
	};
}

function get_for_line(plan, lineIndex) {
	var key = String(lineIndex);
	var separatorMoves = [];

	for (var i = 0; i < plan.separatorMoves.length; i++) {
		var move = plan.separatorMoves[i];
		if (move.target && move.target.lineIndex == lineIndex) {
			separatorMoves.push(move);
		}
	}

		return {
			indent: plan.lineIndents[key] || null,
			lineJoin: plan.lineJoins[key] || null,
			omission: plan.lineOmissions[key] || null,
			separatorMoves: separatorMoves,
			commentAlignment: plan.commentAlignments[key] || null,
			lineCommentMove: plan.lineCommentMoves[key] || null
		};
}

function get_for_token(plan, tokenId) {
	var key = String(tokenId);
	return {
		omission: plan.tokenOmissions[key] || null,
		replacement: plan.tokenReplacements[key] || null,
		lineBreakBefore: plan.lineBreaksBeforeToken[key] || null,
		spacingBefore: plan.spacingBeforeToken[key] || null
	};
}

	exports.create = create;
	exports.add_line_indent = add_line_indent;
	exports.add_line_join = add_line_join;
exports.add_line_omission = add_line_omission;
exports.add_separator_move = add_separator_move;
exports.add_comment_alignment = add_comment_alignment;
exports.add_line_comment_move = add_line_comment_move;
exports.add_token_replacement = add_token_replacement;
exports.add_token_omission = add_token_omission;
exports.add_line_break_before_token = add_line_break_before_token;
exports.add_spacing_before_token = add_spacing_before_token;
exports.get_for_line = get_for_line;
exports.get_for_token = get_for_token;
