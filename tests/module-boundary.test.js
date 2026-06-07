var assert = require('assert');
var fs = require('fs');
var path = require('path');

var sqlFormatter = require('../lib/sql-formatter');
var sqlSelectMutations = require('../lib/core/sql-select-mutations');
var sqlCaseMutations = require('../lib/core/sql-case-mutations');
var sqlCommentMutations = require('../lib/core/sql-comment-mutations');
var sqlConditionMutations = require('../lib/core/sql-condition-mutations');
var sqlCommentSpacing = require('../lib/core/sql-comment-spacing');
var sqlTokenRenderer = require('../lib/core/sql-token-renderer');
var sqlRenderWidth = require('../lib/core/sql-render-width');
var sqlNodeUtils = require('../lib/core/sql-node-utils');
var sqlListNodes = require('../lib/core/sql-list-nodes');
var sqlSelectItemNodes = require('../lib/core/sql-select-item-nodes');
var sqlCaseNodes = require('../lib/core/sql-case-nodes');
var sqlConditionNodes = require('../lib/core/sql-condition-nodes');
var sqlDdlFormatter = require('../lib/sql-ddl-formatter');

function format_core(sql, options) {
	return sqlFormatter.format_sql(sql, options).trim();
}

function read_source(relative_path) {
	return fs.readFileSync(path.join(__dirname, '..', relative_path), 'utf8');
}

function resolve_local_require(from_relative_path, request) {
	if (!/^\.\.?\//.test(request)) {
		return null;
	}

	var resolved = path.normalize(path.join(path.dirname(from_relative_path), request));
	if (!/\.js$/.test(resolved)) {
		resolved += '.js';
	}

	if (resolved.indexOf('lib' + path.sep) !== 0) {
		return null;
	}

	return resolved;
}

function collect_live_formatter_sources(entry_relative_path) {
	var pending = [entry_relative_path];
	var seen = {};
	var sources = {};

	while (pending.length > 0) {
		var current = pending.pop();
		if (seen[current]) {
			continue;
		}
		seen[current] = true;

		var source = read_source(current);
		sources[current] = source;

		source.replace(/require\(['"]([^'"]+)['"]\)/g, function(_, request) {
			var resolved = resolve_local_require(current, request);
			if (resolved && !seen[resolved]) {
				pending.push(resolved);
			}
			return _;
		});
	}

	return sources;
}

function obsolete_formatter_files() {
	return ['select', 'case', 'comment', 'condition'].reduce(function(paths, role) {
		paths.push('lib/core/sql-' + role + '-formatter.js');
		paths.push('lib/sql-' + role + '-formatter.js');
		return paths;
	}, []);
}

assert.strictEqual(typeof sqlFormatter.format_sql, 'function', 'sql-formatter must export format_sql');
assert.strictEqual(typeof sqlSelectMutations.apply_select_list_mutations, 'function', 'structured select mutations must export apply_select_list_mutations');
assert.strictEqual(typeof sqlCaseMutations.apply_case_mutations, 'function', 'structured case mutations must export apply_case_mutations');
assert.strictEqual(typeof sqlCommentMutations.apply_comment_alignment_mutations, 'function', 'structured comment mutations must export apply_comment_alignment_mutations');
assert.strictEqual(typeof sqlConditionMutations.apply_condition_mutations, 'function', 'structured condition mutations must export apply_condition_mutations');
assert.strictEqual(typeof sqlCommentSpacing.normalize_line_comment_spacing, 'function', 'comment spacing module must export normalize_line_comment_spacing');
assert.deepStrictEqual(
	Object.keys(sqlSelectMutations).sort(),
	['apply_select_list_mutations'],
	'structured select mutations must expose only apply_select_list_mutations'
);
assert.deepStrictEqual(
	Object.keys(sqlCaseMutations).sort(),
	['apply_case_mutations'],
	'structured case mutations must expose only apply_case_mutations'
);
assert.deepStrictEqual(
	Object.keys(sqlCommentMutations).sort(),
	['apply_comment_alignment_mutations'],
	'structured comment mutations must expose only apply_comment_alignment_mutations'
);
assert.deepStrictEqual(
	Object.keys(sqlConditionMutations).sort(),
	['apply_condition_mutations'],
	'structured condition mutations must expose only apply_condition_mutations'
);
assert.deepStrictEqual(
	Object.keys(sqlCommentSpacing).sort(),
	['normalize_line_comment_spacing'],
	'comment spacing module must expose only normalize_line_comment_spacing'
);
assert.deepStrictEqual(
	Object.keys(sqlTokenRenderer).sort(),
	['render_tokens'],
	'token renderer must expose only render_tokens'
);
assert.deepStrictEqual(
	Object.keys(sqlRenderWidth).sort(),
	['create_width_context'],
	'render width helper must expose only create_width_context'
);
assert.deepStrictEqual(
	Object.keys(sqlNodeUtils).sort(),
	['is_code_token', 'is_word', 'token_in_range', 'tokens_in_range'],
	'node utils must expose only shared token helpers'
);
assert.deepStrictEqual(
	Object.keys(sqlListNodes).sort(),
	['create_list_spans', 'find_separators'],
	'list node extractor must expose only list span and separator extraction'
);
assert.deepStrictEqual(
	Object.keys(sqlSelectItemNodes).sort(),
	['find_select_items'],
	'select item node extractor must expose only find_select_items'
);
assert.deepStrictEqual(
	Object.keys(sqlCaseNodes).sort(),
	['find_case_expressions'],
	'case node extractor must expose only find_case_expressions'
);
assert.deepStrictEqual(
	Object.keys(sqlConditionNodes).sort(),
	['find_condition_blocks'],
	'condition node extractor must expose only find_condition_blocks'
);
assert.strictEqual(typeof sqlDdlFormatter.ddl, 'function', 'DDL formatter must export ddl');
assert.strictEqual(typeof sqlDdlFormatter.extractddl, 'function', 'DDL formatter must export extractddl');
assert.strictEqual(typeof ''.times, 'undefined', 'formatter modules must not pollute String.prototype');
assert.ok(
	fs.existsSync(path.join(__dirname, '..', 'lib/core/sql-format-document.js')),
	'structured formatter must expose sql-format-document.js'
);
assert.ok(
	fs.existsSync(path.join(__dirname, '..', 'lib/core/sql-format-navigation.js')),
	'structured formatter must expose sql-format-navigation.js'
);

[
	'lib/core/sql-render-move-state.js',
	'lib/core/sql-render-indent.js',
	'lib/core/sql-render-token-spacing.js',
	'lib/core/sql-render-line.js'
].forEach(function(relativePath) {
	assert.ok(
		fs.existsSync(path.join(__dirname, '..', relativePath)),
		'structured renderer split module must exist: ' + relativePath
	);
});
[
	'lib/core/sql-node-utils.js',
	'lib/core/sql-list-nodes.js',
	'lib/core/sql-select-item-nodes.js',
	'lib/core/sql-case-nodes.js',
	'lib/core/sql-condition-nodes.js'
].forEach(function(relativePath) {
	assert.ok(
		fs.existsSync(path.join(__dirname, '..', relativePath)),
		'structured node extractor split module must exist: ' + relativePath
	);
});
assert.ok(
	fs.existsSync(path.join(__dirname, '..', 'lib/core/sql-select-mutations.js')),
	'structured SELECT mutation module must exist'
);
assert.ok(
	fs.existsSync(path.join(__dirname, '..', 'lib/core/sql-case-mutations.js')),
	'structured CASE mutation module must exist'
);
assert.ok(
	fs.existsSync(path.join(__dirname, '..', 'lib/core/sql-comment-mutations.js')),
	'structured comment mutation module must exist'
);
assert.ok(
	fs.existsSync(path.join(__dirname, '..', 'lib/core/sql-condition-mutations.js')),
	'structured condition mutation module must exist'
);
assert.ok(
	fs.existsSync(path.join(__dirname, '..', 'lib/core/sql-comment-spacing.js')),
	'comment spacing module must exist'
);
assert.ok(
	fs.existsSync(path.join(__dirname, '..', 'lib/core/sql-token-renderer.js')),
	'structured token renderer module must exist'
);
assert.ok(
	fs.existsSync(path.join(__dirname, '..', 'lib/core/sql-render-width.js')),
	'structured render width module must exist'
);

obsolete_formatter_files().forEach(function(relativePath) {
	assert.strictEqual(
		fs.existsSync(path.join(__dirname, '..', relativePath)),
		false,
		'obsolete formatter facade must not exist: ' + relativePath
	);
});

[
	'lib/core/sql-structured-renderer.js',
	'lib/core/sql-render-indent.js',
	'lib/core/sql-render-token-spacing.js',
	'lib/core/sql-select-mutations.js',
	'lib/core/sql-case-mutations.js',
	'lib/core/sql-layout-formatter.js',
	'lib/core/sql-condition-mutations.js',
	'lib/core/sql-format-nodes.js',
	'lib/core/sql-list-nodes.js',
	'lib/core/sql-select-item-nodes.js',
	'lib/core/sql-case-nodes.js',
	'lib/core/sql-condition-nodes.js'
].forEach(function(relativePath) {
	var source = read_source(relativePath);
	[
		'token_by_index',
		'previous_code_token',
		'next_code_token',
		'active_tokens'
	].forEach(function(helperName) {
		assert.strictEqual(
			new RegExp('function\\s+' + helperName + '\\s*\\(').test(source),
			false,
			relativePath + ' must use sql-format-navigation for ' + helperName
		);
	});
});

[
	'lib/core/sql-structured-renderer.js',
	'lib/core/sql-render-indent.js',
	'lib/core/sql-render-token-spacing.js',
	'lib/core/sql-select-mutations.js',
	'lib/core/sql-case-mutations.js',
	'lib/core/sql-condition-mutations.js',
	'lib/core/sql-format-nodes.js',
	'lib/core/sql-list-nodes.js',
	'lib/core/sql-select-item-nodes.js',
	'lib/core/sql-case-nodes.js',
	'lib/core/sql-condition-nodes.js'
].forEach(function(relativePath) {
	var source = read_source(relativePath);
	assert.strictEqual(
		/function\s+scope_by_id\s*\(\s*document\s*,/.test(source),
		false,
		relativePath + ' must use sql-format-navigation for document scope lookup'
	);
});

var structuredRendererSource = read_source('lib/core/sql-structured-renderer.js');
[
	'build_move_state',
	'build_close_indent_by_line',
	'build_body_indent_by_line',
	'append_visible_token',
	'render_line_from_tokens',
	'apply_comment_alignment',
	'normalize_output_whitespace'
].forEach(function(functionName) {
	assert.strictEqual(
		new RegExp('function\\s+' + functionName + '\\s*\\(').test(structuredRendererSource),
		false,
		'sql-structured-renderer.js must delegate helper implementation: ' + functionName
	);
});

var formatNodesSource = read_source('lib/core/sql-format-nodes.js');
[
	'is_list_boundary_token',
	'list_boundary_end_token',
	'span_contains_token',
	'select_span_for_token',
	'owner_scope_for_separator',
	'line_has_word',
	'apply_case_comments',
	'is_clause_start_token'
].forEach(function(functionName) {
	assert.strictEqual(
		new RegExp('function\\s+' + functionName + '\\s*\\(').test(formatNodesSource),
		false,
		'sql-format-nodes.js must delegate extractor helper implementation: ' + functionName
	);
});
[
	"require('./sql-list-nodes')",
	"require('./sql-select-item-nodes')",
	"require('./sql-case-nodes')",
	"require('./sql-condition-nodes')"
].forEach(function(requireText) {
	assert.ok(
		formatNodesSource.indexOf(requireText) >= 0,
		'sql-format-nodes.js must delegate to focused extractor module: ' + requireText
	);
});

[
	'lib/core/sql-case-mutations.js',
	'lib/core/sql-select-mutations.js'
].forEach(function(relativePath) {
	var source = read_source(relativePath);
	assert.strictEqual(
		/function\s+render_tokens\s*\(/.test(source),
		false,
		relativePath + ' must delegate shared token rendering to sql-token-renderer'
	);
});

var commentMutationSource = read_source('lib/core/sql-comment-mutations.js');
[
	'planned_code_width',
	'planned_alignment_width',
	'planned_join_prefix_width',
	'planned_code_segment'
].forEach(function(functionName) {
	assert.strictEqual(
		new RegExp('function\\s+' + functionName + '\\s*\\(').test(commentMutationSource),
		false,
		'sql-comment-mutations.js must delegate width helper implementation: ' + functionName
	);
});

var packageJson = JSON.parse(read_source('package.json'));
var verifyScript = packageJson.scripts && packageJson.scripts['test:verify'] || '';
[
	'tests/format-document-model.test.js',
	'tests/format-scope-model.test.js',
	'tests/format-navigation.test.js',
	'tests/format-invariants.test.js',
	'tests/structured-pipeline-regression.test.js',
	'tests/structured-differential.test.js',
	'tests/window-function-spacing.test.js',
	'tests/pipeline-idempotency.test.js',
	'tests/generated-support-matrix.test.js',
	'tests/unsupported-safety.test.js',
	'tests/tokenizer-profile.test.js',
	'tests/sql-token-renderer.test.js',
	'tests/render-width.test.js'
].forEach(function(testFile) {
	assert.ok(
		verifyScript.indexOf(testFile) >= 0,
		'test:verify must include structured pipeline guard: ' + testFile
	);
});

var ddlFormatSource = read_source('lib/experimental/ddl/sql-ddl-format.js');
assert.ok(
	/split_top_level_items/.test(ddlFormatSource),
	'experimental DDL formatter must reuse token-aware top-level splitter'
);
assert.strictEqual(
	/function\s+split_ddl_items[\s\S]+quote\s*=/.test(ddlFormatSource),
	false,
	'experimental DDL formatter must not maintain a private quote-scanning splitter'
);

var liveFormatterSources = collect_live_formatter_sources('lib/sql-formatter.js');
var formatterSource = liveFormatterSources['lib/core/sql-formatter.js'] || liveFormatterSources['lib/sql-formatter.js'];
var lexicalNormalizerSource = liveFormatterSources['lib/core/sql-lexical-normalizer.js'] || liveFormatterSources['lib/sql-lexical-normalizer.js'];
var combinedLiveFormatterSource = Object.keys(liveFormatterSources).sort().map(function(relative_path) {
	return '\n/* ' + relative_path + ' */\n' + liveFormatterSources[relative_path];
}).join('\n');
var obsoleteFormatterFiles = obsolete_formatter_files();
var forbiddenLiveFormatterPatterns = [
	{
		pattern: /\bto_legacy\b/,
		message: 'live formatter source graph must not bridge canonical options back to to_legacy'
	},
	{
		pattern: /\breshape_comment\b/,
		message: 'live formatter source graph must not use reshape_comment marker protocol'
	},
	{
		pattern: /\brestore_reshaped_comment_markers\b/,
		message: 'live formatter source graph must not restore reshaped comment markers'
	},
	{
		pattern: /\bconvert_comma_loaction\b/,
		message: 'live formatter source graph must not call the typo legacy comma API'
	},
	{
		pattern: /WHEREiscomment/,
		message: 'live formatter source graph must not contain WHEREiscomment marker cleanup'
	},
	{
		pattern: /shouldhavenbehind/,
		message: 'live formatter source graph must not contain shouldhavenbehind marker cleanup'
	},
	{
		pattern: /\{comma\}/,
		message: 'live formatter source graph must not contain {comma} marker cleanup'
	},
	{
		pattern: /UNIONALLALL/,
		message: 'live formatter source graph must not contain UNIONALLALL marker cleanup'
	}
];

assert.ok(
	combinedLiveFormatterSource.indexOf('sql-format-model') >= 0,
	'live formatter graph should include shared format model after pipeline coupling cleanup'
);
[
	"require('./sql-select-mutations')",
	"require('./sql-case-mutations')",
	"require('./sql-comment-mutations')",
	"require('./sql-condition-mutations')",
	"require('./sql-comment-spacing')"
].forEach(function(requireText) {
	assert.ok(
		formatterSource.indexOf(requireText) >= 0,
		'sql-formatter must directly import focused live module: ' + requireText
	);
});

obsoleteFormatterFiles.forEach(function(relativePath) {
	assert.strictEqual(
		Object.prototype.hasOwnProperty.call(liveFormatterSources, relativePath),
		false,
		'live formatter dependency graph must not include obsolete formatter facade: ' + relativePath
	);
});
[
	'format_case_blocks',
	'render_case_node',
	'align_as_in_select_blocks',
	'format_select_clause_lists',
	'split_same_line_select_separators',
	'wrap_condition_clauses',
	'align_condition_clauses',
	'order_comment',
	'protect_standalone_comments',
	'protect_inline_comments',
	'restore_comments',
	'repair_orphan_leading_commas',
	'apply_trailing_comma_style'
].forEach(function(functionName) {
	assert.strictEqual(
		new RegExp('exports\\.' + functionName + '\\b').test(combinedLiveFormatterSource),
		false,
		'live formatter dependency graph must not export obsolete formatter API ' + functionName
	);
});
Object.keys(liveFormatterSources).forEach(function(relative_path) {
	assert.strictEqual(
		/^lib[\/\\]adapters[\/\\]/.test(relative_path),
		false,
		'core formatter live graph must not depend on adapter modules: ' + relative_path
	);
	assert.strictEqual(
		/^lib[\/\\]experimental[\/\\]/.test(relative_path),
		false,
		'core formatter live graph must not depend on experimental modules: ' + relative_path
	);
});

assert.strictEqual(
	/replace_char\s*\(/.test(formatterSource + lexicalNormalizerSource),
	false,
	'live formatter path must not call replace_char string furnace'
);
assert.strictEqual(
	/\bcondition_wrap\s*\(/.test(combinedLiveFormatterSource),
	false,
	'live formatter dependency graph must not call condition_wrap state machine'
);
assert.strictEqual(
	/\bfunction\s+condition_wrap\b|\bcondition_wrap\s*[:=]|exports\.condition_wrap\b/.test(combinedLiveFormatterSource),
	false,
	'live formatter dependency graph must not retain the legacy condition_wrap state machine'
);
assert.strictEqual(
	/except_subquery\s*\(/.test(formatterSource),
	false,
	'live formatter path must not call except_subquery state machine'
);
assert.strictEqual(
	/sqlNormalizePasses\.(bracket_deep|extra)\b/.test(formatterSource),
	false,
	'live formatter path must not call legacy normalize layout helpers'
);
assert.strictEqual(
	/\bformatterEngine\b/.test(formatterSource),
	false,
	'core formatter default path must not keep the undocumented formatterEngine pipeline branch'
);
assert.strictEqual(
	/\bsqlFormatPipeline\.run\s*\(/.test(formatterSource),
	false,
	'core formatter default path must not run the legacy string pipeline after structured migration'
);
for (let i = 0; i < forbiddenLiveFormatterPatterns.length; i++) {
	assert.strictEqual(
		forbiddenLiveFormatterPatterns[i].pattern.test(combinedLiveFormatterSource),
		false,
		forbiddenLiveFormatterPatterns[i].message
	);
}
assert.strictEqual(
	/currentStep\s*=\s*currentStep\.replace\(\s*\/\\t\//.test(formatterSource),
	false,
	'live formatter path must not render tabs first and replace them with spaces later'
);
assert.strictEqual(
	/var\s+deep\s*=\s*["']\\t["']/.test(combinedLiveFormatterSource),
	false,
	'live formatter source graph must not hard-code tab as the layout renderer indent unit'
);

var restoreCommentsIndex = formatterSource.indexOf('restore_comments');
[
	'repair_orphan_leading_commas',
	'format_case_blocks',
	'align_as_in_select_blocks',
	'align_condition_clauses',
	'apply_trailing_comma_style',
	'order_comment'
].forEach(function(functionName) {
	assert.strictEqual(
		new RegExp('\\b' + functionName + '\\s*\\(').test(formatterSource),
		false,
		'sql-formatter structured default path must not directly call legacy structure function ' + functionName
	);
	if (restoreCommentsIndex < 0) {
		return;
	}
	assert.strictEqual(
		formatterSource.indexOf(functionName, restoreCommentsIndex),
		-1,
		'sql-formatter must not run ' + functionName + ' after comment restore'
	);
});

var documentInvariantIndex = formatterSource.indexOf('sqlFormatInvariants.assert_document_safe');
var mutationInvariantIndex = formatterSource.indexOf('sqlFormatInvariants.assert_mutation_plan_safe');
var structuredRenderIndex = formatterSource.indexOf('sqlStructuredRenderer.render');

assert.ok(
	documentInvariantIndex >= 0,
	'sql-formatter structured path must assert document invariants before rendering'
);
assert.ok(
	mutationInvariantIndex >= 0,
	'sql-formatter structured path must assert mutation plan invariants before rendering'
);
assert.ok(
	structuredRenderIndex >= 0,
	'sql-formatter structured path must render through StructuredRenderer'
);
assert.ok(
	documentInvariantIndex < structuredRenderIndex,
	'sql-formatter must assert document invariants before StructuredRenderer.render'
);
assert.ok(
	mutationInvariantIndex < structuredRenderIndex,
	'sql-formatter must assert mutation plan invariants before StructuredRenderer.render'
);

var placeholderFormatted = sqlFormatter.format_sql('select NEEDReplace as c from t', {
	keywordCase: 'upper',
	commaStyle: 'leading',
	indentStyle: 'space',
	maxAlignWidth: 150,
	caseWhenThenWrapLength: 80,
	dialect: 'generic'
});

assert.ok(
	placeholderFormatted.indexOf('NEEDReplace') >= 0,
	'sql-formatter must preserve placeholder-like user text\n--- actual ---\n' + placeholderFormatted
);
assert.strictEqual(
	placeholderFormatted.indexOf('undefined'),
	-1,
	'sql-formatter must not convert placeholder-like user text to undefined'
);

var postgresFormatted = sqlFormatter.format_sql("select data->>'name' as name from t", {
	keywordCase: 'upper',
	commaStyle: 'leading',
	indentStyle: 'space',
	maxAlignWidth: 150,
	caseWhenThenWrapLength: 80,
	dialect: 'postgres'
});

assert.ok(
	postgresFormatted.indexOf("data->>'name'") >= 0,
	"sql-formatter must preserve PostgreSQL JSON text operator\n--- actual ---\n" + postgresFormatted
);
assert.strictEqual(
	postgresFormatted.indexOf('->  >'),
	-1,
	'sql-formatter must not split PostgreSQL JSON operator'
);

var nestedSpaceConditionFormatted = format_core([
	'select *',
	'from (',
	'select a',
	'from t',
	'where b=1 and c=2',
	') x'
].join('\n'), {
	keywordCase: 'upper',
	commaStyle: 'leading',
	indentStyle: 'space',
	maxAlignWidth: 150,
	caseWhenThenWrapLength: 80,
	dialect: 'generic'
});

assert.strictEqual(
	nestedSpaceConditionFormatted,
	[
		'SELECT  *',
		'FROM',
		'(',
		'    SELECT  a',
		'    FROM t',
		'    WHERE b = 1',
		'      AND c = 2',
		') x'
	].join('\n').trim(),
	'sql-formatter must preserve nested condition indentation for space indent style'
);

var multilineInlineQueryFormatted = format_core([
	'select *',
	'from t',
	'where a.id in (',
	'select id',
	'from t2',
	'where flag=1',
	')'
].join('\n'), {
	keywordCase: 'upper',
	commaStyle: 'leading',
	indentStyle: 'tab',
	maxAlignWidth: 150,
	caseWhenThenWrapLength: 80,
	dialect: 'generic'
});

assert.strictEqual(
	multilineInlineQueryFormatted,
	[
		'SELECT  *',
		'FROM t',
		'WHERE a.id IN (',
		'\tSELECT  id',
		'\tFROM t2',
		'\tWHERE flag = 1',
		')'
	].join('\n').trim(),
	'sql-formatter must indent multiline inline subqueries from the canonical core path'
);

console.log('module boundary tests passed');
