var fs = require('fs');
var path = require('path');
var assert = require('assert');

var corpusRoot = path.join(__dirname, '..', '..', 'fixtures', 'production-corpus');
var publicRoot = path.join(corpusRoot, 'public');
var publicManifestPath = path.join(publicRoot, 'manifest.json');

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
	return fs.readFileSync(filePath, 'utf8');
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

function read_public_manifest() {
	var parsed = JSON.parse(fs.readFileSync(publicManifestPath, 'utf8'));
	assert.strictEqual(parsed.version, 1, 'public corpus manifest version');
	assert.ok(Array.isArray(parsed.cases), 'public corpus manifest cases');
	var ids = Object.create(null);
	var files = Object.create(null);
	parsed.cases.forEach(function(entry, index) {
		assert.ok(entry && typeof entry === 'object', 'manifest case ' + index);
		assert.ok(typeof entry.id === 'string' && /^[a-z0-9-]+$/.test(entry.id),
			'manifest case id ' + index);
		assert.ok(typeof entry.file === 'string' && /^[a-z0-9-]+\.sql$/.test(entry.file),
			'manifest case file ' + index);
		assert.strictEqual(ids[entry.id], undefined, 'duplicate manifest id ' + entry.id);
		assert.strictEqual(files[entry.file], undefined, 'duplicate manifest file ' + entry.file);
		ids[entry.id] = true;
		files[entry.file] = true;
		assert.ok(entry.options && typeof entry.options === 'object' && !Array.isArray(entry.options),
			entry.id + ' options');
		assert.ok(entry.expected && typeof entry.expected === 'object',
			entry.id + ' expected contract');
		assert.ok(['formatted', 'unchanged', 'preserved', 'failed']
			.indexOf(entry.expected.status) >= 0, entry.id + ' expected status');
		assert.ok(Array.isArray(entry.expected.codes), entry.id + ' expected codes');
		assert.ok(Array.isArray(entry.expected.capabilities),
			entry.id + ' expected capabilities');
	});
	var actualFiles = list_sql_files(publicRoot).map(function(sqlPath) {
		return normalize_slashes(path.relative(publicRoot, sqlPath));
	}).sort();
	var manifestFiles = parsed.cases.map(function(entry) { return entry.file; }).sort();
	assert.deepStrictEqual(actualFiles, manifestFiles,
		'public corpus SQL files must exactly match manifest');
	return parsed;
}

function load_public_cases() {
	return read_public_manifest().cases.map(function(entry) {
		var sqlPath = path.join(publicRoot, entry.file);
		return {
			name: entry.id,
			sqlPath: sqlPath,
			relativePath: entry.file,
			optionsPath: publicManifestPath,
			sql: read_text(sqlPath),
			options: Object.assign({}, DEFAULT_OPTIONS, entry.options),
			expected: entry.expected,
			minimumBytes: entry.minimumBytes || null
		};
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

function token_fingerprint(sqlFormatter, source, dialect) {
	return sqlFormatter.lexSql(source, { dialect: dialect }).leaves.filter(function(leaf) {
		return leaf.kind !== 'whitespace' &&
			leaf.kind !== 'newline' &&
			leaf.kind !== 'byte-order-mark';
	}).map(function(leaf) {
		return [
			leaf.kind,
			leaf.kind === 'keyword' ? leaf.raw.toLowerCase() : leaf.raw
		];
	});
}

function newline_profile(source) {
	var crlf = (source.match(/\r\n/g) || []).length;
	var withoutCrlf = source.replace(/\r\n/g, '');
	return {
		crlf: crlf,
		lf: (withoutCrlf.match(/\n/g) || []).length,
		cr: (withoutCrlf.match(/\r/g) || []).length
	};
}

function assert_eol_and_bom_contract(source, output, caseName) {
	assert.strictEqual(output.charAt(0) === '\uFEFF', source.charAt(0) === '\uFEFF',
		caseName + ' leading BOM contract');
	assert.strictEqual((output.match(/\uFEFF/g) || []).length,
		(source.match(/\uFEFF/g) || []).length, caseName + ' BOM count');
	var sourceEol = newline_profile(source);
	var outputEol = newline_profile(output);
	if (sourceEol.crlf > 0 && sourceEol.lf === 0 && sourceEol.cr === 0) {
		assert.ok(outputEol.crlf > 0, caseName + ' must retain CRLF output');
		assert.strictEqual(outputEol.lf, 0, caseName + ' must not introduce lone LF');
		assert.strictEqual(outputEol.cr, 0, caseName + ' must not introduce lone CR');
	}
	if (sourceEol.lf > 0 && sourceEol.crlf === 0 && sourceEol.cr === 0) {
		assert.strictEqual(outputEol.crlf, 0, caseName + ' must not introduce CRLF');
		assert.strictEqual(outputEol.cr, 0, caseName + ' must not introduce CR');
	}
}

function assert_formatted_contract(sqlFormatter, testCase, result) {
	assert.strictEqual(typeof result.text, 'string', testCase.name + ' formatter result text must be a string');
	assert_diagnostics_shape(result.diagnostics, testCase.name);
	if (testCase.expected) {
		assert.strictEqual(result.status, testCase.expected.status,
			testCase.name + ' exact status');
		assert.deepStrictEqual(result.diagnostics.map(function(item) { return item.code; }),
			testCase.expected.codes, testCase.name + ' exact diagnostic codes');
		assert.deepStrictEqual(result.diagnostics.map(function(item) {
			return item.capabilityId;
		}).filter(Boolean), testCase.expected.capabilities,
			testCase.name + ' exact diagnostic capabilities');
		if (testCase.expected.exactText) {
			assert.strictEqual(result.text, testCase.sql,
				testCase.name + ' must preserve exact source bytes');
		}
	}
	var editable = result.status === 'formatted' || result.status === 'unchanged';
	if (!editable) {
		assert.strictEqual(result.text, testCase.sql,
			testCase.name + ' non-editable result must preserve source bytes');
		return;
	}
	assert.ok(/(?:\r\n|\r|\n)$/.test(result.text),
		testCase.name + ' formatted output must end with one newline');
	assert.deepStrictEqual(
		token_fingerprint(sqlFormatter, result.text, testCase.options.dialect),
		token_fingerprint(sqlFormatter, testCase.sql, testCase.options.dialect),
		testCase.name + ' token equivalence'
	);
	assert_eol_and_bom_contract(testCase.sql, result.text, testCase.name);

	var idempotentCase = Object.assign({}, testCase, { sql: result.text });
	var second = format_case(sqlFormatter, idempotentCase);
	assert.strictEqual(second.text, result.text, testCase.name + ' formatted output must be idempotent');
	assert.strictEqual(second.status, 'unchanged', testCase.name + ' second pass status');
}

exports.DEFAULT_OPTIONS = DEFAULT_OPTIONS;
exports.publicRoot = publicRoot;
exports.publicManifestPath = publicManifestPath;
exports.read_public_manifest = read_public_manifest;
exports.load_public_cases = load_public_cases;
exports.load_private_cases = load_private_cases;
exports.format_case = format_case;
exports.assert_diagnostics_shape = assert_diagnostics_shape;
exports.assert_formatted_contract = assert_formatted_contract;
