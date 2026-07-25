var fs = require('fs');
var path = require('path');
var assert = require('assert');

var corpusRoot = path.join(__dirname, '..', '..', 'fixtures', 'production-corpus');
var publicRoot = path.join(corpusRoot, 'public');

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

function build_case(root, sqlPath) {
	var relativePath = normalize_slashes(path.relative(root, sqlPath));
	var optionsPath = sqlPath.replace(/\.sql$/i, '.options.json');
	var options = Object.assign({}, DEFAULT_OPTIONS, read_options(optionsPath));
	return {
		name: relativePath.replace(/\.sql$/i, ''),
		sqlPath: sqlPath,
		relativePath: relativePath,
		optionsPath: fs.existsSync(optionsPath) ? optionsPath : null,
		sql: read_text(sqlPath),
		options: options
	};
}

function load_public_cases() {
	return list_sql_files(publicRoot).map(function(sqlPath) {
		return build_case(publicRoot, sqlPath);
	});
}

function load_private_cases(root) {
	return list_sql_files(root).map(function(sqlPath) {
		return build_case(root, sqlPath);
	});
}

function format_case(sqlFormatter, testCase) {
	return sqlFormatter.formatSql(testCase.sql, testCase.options);
}

function assert_diagnostics_shape(diagnostics, caseName) {
	assert.ok(Array.isArray(diagnostics), caseName + ' diagnostics must be an array');
	diagnostics.forEach(function(item, index) {
		assert.ok(item.severity, caseName + ' diagnostic ' + index + ' must include severity');
		assert.ok(item.code, caseName + ' diagnostic ' + index + ' must include code');
		assert.ok(item.message, caseName + ' diagnostic ' + index + ' must include message');
	});
}

function assert_formatted_contract(sqlFormatter, testCase, result) {
	assert.strictEqual(typeof result.text, 'string', testCase.name + ' formatter result text must be a string');
	assert_diagnostics_shape(result.diagnostics, testCase.name);
	var editable = result.status === 'formatted' || result.status === 'unchanged';
	if (!editable) {
		assert.strictEqual(result.text, testCase.sql,
			testCase.name + ' non-editable result must preserve source bytes');
		return;
	}
	assert.ok(/\n$/.test(result.text), testCase.name + ' formatted output must end with one newline');

	var idempotentCase = Object.assign({}, testCase, { sql: result.text });
	var second = format_case(sqlFormatter, idempotentCase);
	assert.strictEqual(second.text, result.text, testCase.name + ' formatted output must be idempotent');
}

exports.DEFAULT_OPTIONS = DEFAULT_OPTIONS;
exports.publicRoot = publicRoot;
exports.load_public_cases = load_public_cases;
exports.load_private_cases = load_private_cases;
exports.format_case = format_case;
exports.assert_diagnostics_shape = assert_diagnostics_shape;
exports.assert_formatted_contract = assert_formatted_contract;
