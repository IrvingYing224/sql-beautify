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
		throw new Error('Invalid corpus options JSON: ' + filePath);
	}
}

function validate_private_expectation(value, label) {
    assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value),
        label + ' must be an expectation object');
    assert.ok(Object.keys(value).sort().join(',') === 'codes,status',
        label + ' must contain exactly status and codes');
    assert.ok(['formatted', 'unchanged', 'preserved'].indexOf(value.status) >= 0,
        label + ' status must be formatted, unchanged or preserved; failed is never allowed');
    assert.ok(Array.isArray(value.codes) && value.codes.every(function(code) {
        return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,127}$/.test(code);
    }), label + ' codes must be an array of diagnostic codes');
    return Object.freeze({ status: value.status, codes: Object.freeze(value.codes.slice()) });
}

function read_private_expectation(filePath) {
    if (!fs.existsSync(filePath)) {
        return null;
    }
    var parsed;
    try {
        parsed = JSON.parse(read_text(filePath));
    } catch (error) {
        throw new Error('Invalid private corpus expectation JSON: ' + filePath);
    }
    return validate_private_expectation(parsed, 'Private corpus expectation ' + filePath);
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
	var expectationPath = sqlPath.replace(/\.sql$/i, '.expected.json');
	var options = Object.assign({}, DEFAULT_OPTIONS, read_options(optionsPath));
	return {
		name: relativePath.replace(/\.sql$/i, ''),
		sqlPath: sqlPath,
		relativePath: relativePath,
		optionsPath: fs.existsSync(optionsPath) ? optionsPath : null,
		sql: read_text(sqlPath),
		options: options,
		privateExpectation: read_private_expectation(expectationPath)
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
		assert.ok(
			entry.operation === undefined ||
				entry.operation === 'formatSql' ||
				entry.operation === 'formatHiveDdl',
			entry.id + ' public operation'
		);
		assert.ok(entry.expected && typeof entry.expected === 'object',
			entry.id + ' expected contract');
		assert.ok(['formatted', 'unchanged', 'preserved', 'failed']
			.indexOf(entry.expected.status) >= 0, entry.id + ' expected status');
		assert.ok(Array.isArray(entry.expected.codes), entry.id + ' expected codes');
		assert.ok(Array.isArray(entry.expected.capabilities),
			entry.id + ' expected capabilities');
		if (entry.expected.diagnostics !== undefined) {
			assert.ok(Array.isArray(entry.expected.diagnostics),
				entry.id + ' expected diagnostic facts');
		}
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
		var operation = entry.operation || 'formatSql';
		return {
			name: entry.id,
			sqlPath: sqlPath,
			relativePath: entry.file,
			optionsPath: publicManifestPath,
			sql: read_text(sqlPath),
			operation: operation,
			options: operation === 'formatHiveDdl'
				? Object.assign({}, entry.options)
				: Object.assign({}, DEFAULT_OPTIONS, entry.options),
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
	var operation = testCase.operation || 'formatSql';
	assert.strictEqual(typeof sqlFormatter[operation], 'function',
		testCase.name + ' public operation must exist');
	return sqlFormatter[operation](testCase.sql, testCase.options);
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

function assert_formatted_contract(sqlFormatter, testCase, result, validateSecondResult) {
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
		if (testCase.expected.diagnostics) {
			assert.strictEqual(result.diagnostics.length,
				testCase.expected.diagnostics.length,
				testCase.name + ' exact diagnostic fact count');
			testCase.expected.diagnostics.forEach(function(expected, index) {
				Object.keys(expected).forEach(function(key) {
					assert.deepStrictEqual(result.diagnostics[index][key], expected[key],
						testCase.name + ' diagnostic ' + index + ' ' + key);
				});
			});
		}
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
	if (testCase.operation === 'formatHiveDdl') {
		assert.ok(/[\r\n]$/.test(result.text),
			testCase.name + ' generated DDL must end with a newline');
	} else {
		assert.strictEqual(/[\r\n]$/.test(result.text), /[\r\n]$/.test(testCase.sql),
			testCase.name + ' query formatting must preserve the final newline boundary');
	}
	assert.deepStrictEqual(
		token_fingerprint(sqlFormatter, result.text, testCase.options.dialect),
		token_fingerprint(sqlFormatter, testCase.sql, testCase.options.dialect),
		testCase.name + ' token equivalence'
	);
	assert_eol_and_bom_contract(testCase.sql, result.text, testCase.name);

	var idempotentCase = Object.assign({}, testCase, { sql: result.text });
	var second = format_case(sqlFormatter, idempotentCase);
	if (validateSecondResult !== undefined) {
		validateSecondResult(second);
	}
	assert.strictEqual(second.text, result.text, testCase.name + ' formatted output must be idempotent');
	assert.strictEqual(second.status, 'unchanged', testCase.name + ' second pass status');
}

function private_assert(condition, reason) {
    if (!condition) {
        var error = new Error('Private corpus rejected: ' + reason);
        error.privateCorpusReason = reason;
        throw error;
    }
}

function assert_private_result_health(result) {
    private_assert(result !== null && typeof result === 'object' &&
        typeof result.text === 'string' && Array.isArray(result.diagnostics), 'invalid-result');
    private_assert(result.status !== 'failed', 'formatter-failed');
    private_assert(['formatted', 'unchanged', 'preserved'].indexOf(result.status) >= 0,
        'invalid-result');
    private_assert(result.diagnostics.every(function(item) {
        return item !== null && typeof item === 'object' &&
            typeof item.code === 'string' && /^[A-Z][A-Z0-9_]{0,127}$/.test(item.code) &&
            ['info', 'warning', 'error'].indexOf(item.severity) >= 0;
    }), 'invalid-diagnostics');
    private_assert(result.diagnostics.every(function(item) {
        return item.severity !== 'error' &&
            !/(?:^|_)(?:INTERNAL|CONTRACT|INVARIANT)(?:_|$)/.test(item.code);
    }), 'internal-or-error-diagnostic');
}

function assert_private_formatted_contract(sqlFormatter, testCase, result) {
    assert_private_result_health(result);
    var expected = testCase.privateExpectation;
    if (expected !== null && expected !== undefined) {
        expected = validate_private_expectation(expected, 'Private corpus expectation');
        private_assert(result.status === expected.status, 'unexpected-status');
        private_assert(JSON.stringify(result.diagnostics.map(function(item) {
            return item.code;
        })) === JSON.stringify(expected.codes), 'unexpected-diagnostics');
    } else {
        private_assert(result.status === 'formatted' || result.status === 'unchanged',
            'undeclared-preservation');
    }
    assert_formatted_contract(sqlFormatter, testCase, result, assert_private_result_health);
}

/** Aggregate only safe status/code facts; assertion details can contain private SQL. */
function evaluate_private_cases(sqlFormatter, cases) {
    var summary = {
        total: cases.length,
        passed: 0,
        statuses: { formatted: 0, unchanged: 0, preserved: 0, failed: 0, invalid: 0, threw: 0 },
        diagnosticCodes: Object.create(null),
        failures: []
    };
    cases.forEach(function(testCase, index) {
        var result;
        try {
            result = format_case(sqlFormatter, testCase);
        } catch (error) {
            summary.statuses.threw += 1;
            summary.failures.push({ caseIndex: index, reason: 'formatter-threw' });
            return;
        }
        var status = result && ['formatted', 'unchanged', 'preserved', 'failed']
            .indexOf(result.status) >= 0 ? result.status : 'invalid';
        summary.statuses[status] += 1;
        if (result && Array.isArray(result.diagnostics)) {
            result.diagnostics.forEach(function(item) {
                var code = item && typeof item.code === 'string' &&
                    /^[A-Z][A-Z0-9_]{0,127}$/.test(item.code) ? item.code : 'INVALID_DIAGNOSTIC';
                summary.diagnosticCodes[code] = (summary.diagnosticCodes[code] || 0) + 1;
            });
        }
        try {
            assert_private_formatted_contract(sqlFormatter, testCase, result);
            summary.passed += 1;
        } catch (error) {
            summary.failures.push({
                caseIndex: index,
                reason: error.privateCorpusReason || 'contract-mismatch'
            });
        }
    });
    return summary;
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
exports.assert_private_formatted_contract = assert_private_formatted_contract;
exports.evaluate_private_cases = evaluate_private_cases;
