var sqlRenderTokenSpacing = require('./sql-render-token-spacing');

function render_tokens(document, tokens, options) {
	return sqlRenderTokenSpacing.render_visible_tokens(document, tokens, options);
}

exports.render_tokens = render_tokens;
