var fs = require('fs');
var path = require('path');
var assert = require('assert');

var corpusRoot = path.join(__dirname, '..', 'fixtures', 'production-corpus');
var publicRoot = path.join(corpusRoot, 'public');
var snapshotRoot = path.join(corpusRoot, 'snapshots');

var DEFAULT_OPTIONS = {
	keywordCase: 'upper',
	commaStyle: 'leading',
	indentStyle: 'space',
	maxAlignWidth: 150,
	caseWhenThenWrapLength: 80,
	dialect: 'hive',
	unsupportedSyntaxPolicy: 'preserve'
};

function normalize_slashes(value) {
	return String(value || '').replace(/\\/g, '/');
}

function ensure_dir(dir) {
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true });
	}
}

function read_text(filePath) {
	return fs.readFileSync(filePath, 'utf8').replace(/\r\n|\r/g, '\n');
}

function read_options(filePath) {
	if (!fs.existsSync(filePath)) {
		return {};
	}
	try {
		return JSON.parse(fs.readFileSync(filePath, 'utf8'));
	} catch (error) {
		throw new Error('Invalid corpus options JSON: ' + filePath + ': ' + error.message);
	}
}

function list_sql_files(root) {
	var output = [];
	if (!root || !fs.existsSync(root)) {
		return output;
	}

	fs.readdirSync(root).sort().forEach(function(entry) {
		var fullPath = path.join(root, entry);
		var stat = fs.statSync(fullPath);
		if (stat.isDirectory()) {
			output = output.concat(list_sql_files(fullPath));
			return;
		}
		if (/\.sql$/i.test(entry)) {
			output.push(fullPath);
		}
	});

	return output;
}

function snapshot_name_for(relativePath) {
	return normalize_slashes(relativePath).replace(/\//g, '__').replace(/\.sql$/i, '.formatted.sql');
}

function build_case(root, sqlPath, hasSnapshot) {
	var relativePath = normalize_slashes(path.relative(root, sqlPath));
	var optionsPath = sqlPath.replace(/\.sql$/i, '.options.json');
	var options = Object.assign({}, DEFAULT_OPTIONS, read_options(optionsPath));
	var testCase = {
		name: relativePath.replace(/\.sql$/i, ''),
		sqlPath: sqlPath,
		relativePath: relativePath,
		optionsPath: fs.existsSync(optionsPath) ? optionsPath : null,
		sql: read_text(sqlPath),
		options: options
	};

	if (hasSnapshot) {
		testCase.snapshotPath = path.join(snapshotRoot, snapshot_name_for(relativePath));
	}

	return testCase;
}

function load_public_cases() {
	return list_sql_files(publicRoot).map(function(sqlPath) {
		return build_case(publicRoot, sqlPath, true);
	});
}

function load_private_cases(root) {
	return list_sql_files(root).map(function(sqlPath) {
		return build_case(root, sqlPath, false);
	});
}

function format_case(sqlFormatter, testCase) {
	if (typeof sqlFormatter.format_sql_detailed == 'function') {
		return sqlFormatter.format_sql_detailed(testCase.sql, testCase.options);
	}

	return {
		text: sqlFormatter.format_sql(testCase.sql, testCase.options),
		diagnostics: []
	};
}

function read_snapshot(testCase) {
	if (!testCase.snapshotPath || !fs.existsSync(testCase.snapshotPath)) {
		return null;
	}
	return read_text(testCase.snapshotPath);
}

function write_snapshot(testCase, text) {
	ensure_dir(path.dirname(testCase.snapshotPath));
	fs.writeFileSync(testCase.snapshotPath, String(text || '').replace(/\r\n|\r/g, '\n'));
}

function assert_diagnostics_shape(diagnostics, caseName) {
	assert.ok(Array.isArray(diagnostics), caseName + ' diagnostics must be an array');
	diagnostics.forEach(function(item, index) {
		assert.ok(item.level, caseName + ' diagnostic ' + index + ' must include level');
		assert.ok(item.code, caseName + ' diagnostic ' + index + ' must include code');
		assert.ok(item.message, caseName + ' diagnostic ' + index + ' must include message');
		if (item.unsupportedSegments) {
			assert.ok(Array.isArray(item.unsupportedSegments), caseName + ' unsupportedSegments must be an array');
		}
	});
}

function assert_formatted_contract(sqlFormatter, testCase, result) {
	assert.strictEqual(typeof result.text, 'string', testCase.name + ' formatter result text must be a string');
	assert.ok(/\n$/.test(result.text), testCase.name + ' formatted output must end with one newline');
	assert_diagnostics_shape(result.diagnostics, testCase.name);

	var idempotentCase = Object.assign({}, testCase, { sql: result.text });
	var second = format_case(sqlFormatter, idempotentCase);
	assert.strictEqual(second.text, result.text, testCase.name + ' formatted output must be idempotent');
}

exports.DEFAULT_OPTIONS = DEFAULT_OPTIONS;
exports.publicRoot = publicRoot;
exports.snapshotRoot = snapshotRoot;
exports.load_public_cases = load_public_cases;
exports.load_private_cases = load_private_cases;
exports.format_case = format_case;
exports.read_snapshot = read_snapshot;
exports.write_snapshot = write_snapshot;
exports.assert_diagnostics_shape = assert_diagnostics_shape;
exports.assert_formatted_contract = assert_formatted_contract;
