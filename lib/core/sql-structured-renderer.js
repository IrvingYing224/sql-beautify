var sqlFormatMutations = require('./sql-format-mutations');
var sqlRenderIndent = require('./sql-render-indent');
var sqlRenderLine = require('./sql-render-line');
var sqlRenderMoveState = require('./sql-render-move-state');

function render(document, nodes, mutations, options) {
	var plan = mutations || sqlFormatMutations.create();
	var moveState = sqlRenderMoveState.build_move_state(nodes || {}, plan);
	var closeIndentByLine = sqlRenderIndent.build_close_indent_by_line(document, plan, moveState);
	var bodyIndentByLine = sqlRenderIndent.build_body_indent_by_line(document, plan, moveState);
	var lines = [];

	for (var i = 0; i < document.lines.length; i++) {
		var line = document.lines[i];
		var lineMutations = sqlFormatMutations.get_for_line(plan, i);
		if (lineMutations.omission) {
			continue;
		}
		var rendered = sqlRenderLine.render_line_from_tokens(document, line, plan, moveState, options);

		if (!lineMutations.indent) {
			rendered = sqlRenderIndent.apply_scope_body_indent(rendered, bodyIndentByLine[String(i)]);
		}
		rendered = sqlRenderIndent.apply_scope_close_indent(rendered, closeIndentByLine[String(i)]);
		rendered = sqlRenderIndent.apply_indent(rendered, lineMutations.indent);
		rendered = sqlRenderIndent.apply_line_prefix(rendered, moveState.prefixesByLine[String(i)]);
		rendered = sqlRenderLine.apply_comment_alignment(rendered, lineMutations.commentAlignment);
		sqlRenderLine.append_joined_line(lines, rendered, lineMutations.lineJoin);
	}

	return sqlRenderLine.normalize_output_whitespace(lines.join('\n'));
}

exports.render = render;
