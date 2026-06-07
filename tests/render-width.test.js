var assert = require('assert');
var formatDocument = require('../lib/core/sql-format-document');
var scopeModel = require('../lib/core/sql-scope-model');
var formatNodes = require('../lib/core/sql-format-nodes');
var navigation = require('../lib/core/sql-format-navigation');
var mutations = require('../lib/core/sql-format-mutations');
var renderWidth = require('../lib/core/sql-render-width');

function build_context(sql) {
	var config = {
		keywordCase: 'upper',
		commaStyle: 'leading',
		indentStyle: 'space',
		maxAlignWidth: 150,
		caseWhenThenWrapLength: 80,
		dialect: 'generic',
		unsupportedSyntaxPolicy: 'preserve'
	};
	var doc = formatDocument.from_text(sql, config);
	doc.scopes = scopeModel.build(doc, config);
	navigation.attach_scope_index(doc);
	var nodes = formatNodes.extract(doc, config);
	doc.nodes = nodes;
	return {
		document: doc,
		nodes: nodes,
		mutations: mutations.create(),
		config: config
	};
}

var base = build_context('select a as col -- first\nfrom t\n');
var width = renderWidth.create_width_context(base.document, base.nodes, base.mutations, base.config);
assert.strictEqual(width.planned_code_width(base.document.lines[0]), 'select a as col'.length, 'plain planned code width ignores trailing comment');
assert.strictEqual(width.planned_alignment_width(base.document.lines[0]), 'select a'.length, 'alignment width stops before top-level AS');
assert.strictEqual(width.planned_join_prefix_width(base.document.lines[0]), 0, 'unjoined line has no join prefix width');

mutations.add_line_indent(base.mutations, 0, '    ');
width = renderWidth.create_width_context(base.document, base.nodes, base.mutations, base.config);
assert.strictEqual(width.planned_code_width(base.document.lines[0]), 4 + 'select a as col'.length, 'line indent mutation contributes to code width');
assert.strictEqual(width.planned_code_segment(base.document.lines[0]), '    select a as col', 'planned code segment includes effective indent');

var joined = build_context('select a as col -- first\nwhere b = 1 -- second\n');
mutations.add_line_join(joined.mutations, 1, ' ');
width = renderWidth.create_width_context(joined.document, joined.nodes, joined.mutations, joined.config);
assert.strictEqual(width.planned_join_prefix_width(joined.document.lines[1]), 'select a as col '.length, 'joined line reports non-zero join prefix width');

console.log('render width tests passed');
