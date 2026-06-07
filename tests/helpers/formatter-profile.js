var path = require('path');
var sqlTokenizer = require('../../lib/core/sql-tokenizer');

function normalize_source(line) {
	var cwd = process.cwd();
	var text = String(line || '').replace(/^\s*at\s+/, '');
	text = text.replace(cwd + path.sep, '');
	text = text.replace(/\(?([^()]+):[0-9]+:[0-9]+\)?$/g, '$1');
	return text;
}

function caller_source() {
	var stack = String(new Error().stack || '').split('\n');
	for (var i = 2; i < stack.length; i++) {
		var source = normalize_source(stack[i]);
		if (source.indexOf('tests/helpers/formatter-profile.js') >= 0) {
			continue;
		}
		if (source.indexOf('lib/core/sql-tokenizer.js') >= 0) {
			continue;
		}
		return source;
	}
	return 'unknown';
}

function snapshot(state) {
	var ratio = state.originalChars > 0
		? state.totalChars / state.originalChars
		: 0;

	return {
		calls: state.calls,
		totalChars: state.totalChars,
		originalChars: state.originalChars,
		charRatio: ratio,
		callers: Object.assign({}, state.callers)
	};
}

function with_tokenizer_profile(originalChars, fn) {
	var originalTokenize = sqlTokenizer.tokenize;
	var state = {
		calls: 0,
		totalChars: 0,
		originalChars: originalChars || 0,
		callers: {}
	};

	sqlTokenizer.tokenize = function profiled_tokenize(text, options) {
		var source = String(text || '');
		var caller = caller_source();
		state.calls += 1;
		state.totalChars += source.length;
		if (!state.callers[caller]) {
			state.callers[caller] = {
				calls: 0,
				chars: 0
			};
		}
		state.callers[caller].calls += 1;
		state.callers[caller].chars += source.length;
		return originalTokenize.call(sqlTokenizer, text, options);
	};

	try {
		var value = fn();
		return {
			value: value,
			profile: snapshot(state)
		};
	} finally {
		sqlTokenizer.tokenize = originalTokenize;
	}
}

function top_callers(profile, limit) {
	var callers = [];
	var source;

	for (source in (profile && profile.callers || {})) {
		if (Object.prototype.hasOwnProperty.call(profile.callers, source)) {
			callers.push({
				source: source,
				calls: profile.callers[source].calls,
				chars: profile.callers[source].chars
			});
		}
	}

	callers.sort(function(a, b) {
		if (b.calls != a.calls) {
			return b.calls - a.calls;
		}
		return b.chars - a.chars;
	});

	return callers.slice(0, limit || callers.length);
}

exports.with_tokenizer_profile = with_tokenizer_profile;
exports.top_callers = top_callers;
