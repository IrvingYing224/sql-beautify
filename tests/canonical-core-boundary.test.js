var assert = require('assert');
var fs = require('fs');
var path = require('path');
var sqlFormatter = require('../lib/sql-formatter');

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

var liveFormatterSources = collect_live_formatter_sources('lib/sql-formatter.js');
var formatterSource = liveFormatterSources['lib/core/sql-formatter.js'] || liveFormatterSources['lib/sql-formatter.js'];
var selectFormatterSource = liveFormatterSources['lib/core/sql-select-formatter.js'] || liveFormatterSources['lib/sql-select-formatter.js'] || '';
var combinedLiveFormatterSource = Object.keys(liveFormatterSources).sort().map(function(relative_path) {
	return '\n/* ' + relative_path + ' */\n' + liveFormatterSources[relative_path];
}).join('\n');

assert.strictEqual(
	/\bto_legacy\b/.test(formatterSource),
	false,
	'format_sql live path must consume canonical options directly instead of calling to_legacy'
);
assert.strictEqual(
	/\blegacy\./.test(formatterSource),
	false,
	'format_sql live path must not pass legacy scalar fields into core formatters'
);
assert.strictEqual(
	/\b(case_when_then_wrap_length|as_loc_cnt|comma_location|bracket_char|uppercase)\b/.test(combinedLiveFormatterSource),
	false,
	'core live formatter source graph must not use legacy scalar option names'
);
assert.strictEqual(
	/\bconvert_comma_loaction\b/.test(selectFormatterSource),
	false,
	'select formatter must not expose the typo legacy comma API'
);

var formatted = sqlFormatter.format_sql('select a as c from t', {
	keywordCase: 'lower',
	commaStyle: 'leading',
	indentStyle: 'tab',
	maxAlignWidth: 150,
	caseWhenThenWrapLength: 80,
	dialect: 'generic'
});

assert.ok(
	/^select\b/.test(formatted),
	'canonical keywordCase option must drive the live formatter path\n--- actual ---\n' + formatted
);

console.log('canonical core boundary tests passed');
