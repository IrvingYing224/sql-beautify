'use strict';

var assert = require('assert');
var childProcess = require('child_process');
var fs = require('fs');
var os = require('os');
var path = require('path');
var sqlFormatter = require('../../dist/sql-formatter.cjs');
var corpus = require('./helpers/production-corpus');

var root = path.join(__dirname, '..', '..');
var temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sql-beautify-private-contract-'));

function writeCase(name, source, options, expected) {
    var sqlPath = path.join(temporaryRoot, name + '.sql');
    fs.writeFileSync(sqlPath, source, 'utf8');
    if (options !== undefined) {
        fs.writeFileSync(sqlPath.replace(/\.sql$/, '.options.json'), JSON.stringify(options));
    }
    if (expected !== undefined) {
        fs.writeFileSync(sqlPath.replace(/\.sql$/, '.expected.json'), JSON.stringify(expected));
    }
}

function diagnostic(code, severity) {
    return { code: code, severity: severity || 'warning', message: 'Private diagnostic text' };
}

function privateCase(source, expected) {
    return {
        name: 'private-probe',
        sql: source,
        options: { dialect: 'hive' },
        privateExpectation: expected === undefined ? null : expected
    };
}

try {
    writeCase('no-final-newline', 'select a from t');
    writeCase('crlf', 'select a,b\r\nfrom t\r\n');
    writeCase('preserved', 'select a collate "C" from t', {
        dialect: 'postgresql', unsupportedSyntaxPolicy: 'bail_out'
    }, { status: 'preserved', codes: ['SYN_UNEXPECTED_TOKEN', 'FMT_UNSUPPORTED_BAIL_OUT'] });
    var loaded = corpus.load_private_cases(temporaryRoot);
    var summary = corpus.evaluate_private_cases(sqlFormatter, loaded);
    assert.strictEqual(summary.total, 3);
    assert.strictEqual(summary.passed, 3);
    assert.deepStrictEqual(summary.failures, []);
    assert.strictEqual(summary.statuses.formatted, 2);
    assert.strictEqual(summary.statuses.preserved, 1);
    assert.strictEqual(summary.diagnosticCodes.SYN_UNEXPECTED_TOKEN, 1);
    assert.strictEqual(summary.diagnosticCodes.FMT_UNSUPPORTED_BAIL_OUT, 1);

    var expectationPath = path.join(temporaryRoot, 'no-final-newline.expected.json');
    [
        null,
        [],
        {},
        { status: 'failed', codes: [] },
        { status: 'preserved' },
        { status: 'preserved', codes: [], code: [] },
        { status: 'preserved', codes: 'SYN_UNEXPECTED_TOKEN' },
        { status: 'preserved', codes: [null] },
        { status: 'preserved', codes: ['private SQL content'] }
    ].forEach(function(value) {
        fs.writeFileSync(expectationPath, JSON.stringify(value));
        assert.throws(function() { corpus.load_private_cases(temporaryRoot); },
            /expectation/, 'invalid private expectation must fail closed');
    });
    fs.writeFileSync(expectationPath, '{"status": private SQL content');
    assert.throws(function() { corpus.load_private_cases(temporaryRoot); }, function(error) {
        return /Invalid private corpus expectation JSON/.test(error.message) &&
            !error.message.includes('private SQL content');
    });
    fs.rmSync(expectationPath);

    var source = 'select private_secret_9812 from private_table';
    var failedFormatter = { formatSql: function(sql) {
        return { status: 'failed', text: sql, diagnostics: [diagnostic('FMT_INTERNAL', 'error')] };
    } };
    var allFailed = corpus.evaluate_private_cases(failedFormatter, [privateCase(source), privateCase(source)]);
    assert.strictEqual(allFailed.passed, 0, 'complete formatter failure must never pass a private corpus');
    assert.strictEqual(allFailed.statuses.failed, 2);
    assert.strictEqual(allFailed.diagnosticCodes.FMT_INTERNAL, 2);
    assert.deepStrictEqual(allFailed.failures, [
        { caseIndex: 0, reason: 'formatter-failed' },
        { caseIndex: 1, reason: 'formatter-failed' }
    ]);
    assert.ok(!JSON.stringify(allFailed).includes('private_secret_9812'), 'summary must not contain SQL');
    assert.ok(!JSON.stringify(allFailed).includes('Private diagnostic text'),
        'summary must not contain diagnostic messages');

    var preservedFormatter = { formatSql: function(sql) {
        return { status: 'preserved', text: sql, diagnostics: [diagnostic('SYN_UNEXPECTED_TOKEN')] };
    } };
    var undeclared = corpus.evaluate_private_cases(preservedFormatter, [privateCase(source)]);
    assert.strictEqual(undeclared.failures[0].reason, 'undeclared-preservation');
    var declared = corpus.evaluate_private_cases(preservedFormatter, [privateCase(source, {
        status: 'preserved', codes: ['SYN_UNEXPECTED_TOKEN']
    })]);
    assert.strictEqual(declared.passed, 1);
    var mismatched = corpus.evaluate_private_cases(preservedFormatter, [privateCase(source, {
        status: 'preserved', codes: []
    })]);
    assert.strictEqual(mismatched.failures[0].reason, 'unexpected-diagnostics');
    ['error', 'warning'].forEach(function(severity) {
        var internalFormatter = { formatSql: function(sql) {
            return { status: 'preserved', text: sql, diagnostics: [diagnostic('FMT_INTERNAL', severity)] };
        } };
        var internal = corpus.evaluate_private_cases(internalFormatter, [privateCase(source, {
            status: 'preserved', codes: ['FMT_INTERNAL']
        })]);
        assert.strictEqual(internal.failures[0].reason, 'internal-or-error-diagnostic',
            'expectations cannot bless internal failures');
    });
    var throwing = corpus.evaluate_private_cases({ formatSql: function() {
        throw new Error(source);
    } }, [privateCase(source)]);
    assert.strictEqual(throwing.statuses.threw, 1);
    assert.strictEqual(throwing.failures[0].reason, 'formatter-threw');
    assert.ok(!JSON.stringify(throwing).includes(source));

    var secondPassCalls = 0;
    var secondPassFailure = Object.assign({}, sqlFormatter, { formatSql: function(sql, options) {
        secondPassCalls += 1;
        return secondPassCalls === 1 ? sqlFormatter.formatSql(sql, options) : {
            status: 'unchanged', text: sql, diagnostics: [diagnostic('FMT_INTERNAL', 'warning')]
        };
    } });
    var secondPassSummary = corpus.evaluate_private_cases(secondPassFailure, [privateCase(source)]);
    assert.strictEqual(secondPassSummary.passed, 0);
    assert.strictEqual(secondPassSummary.failures[0].reason, 'internal-or-error-diagnostic');

    var sensitiveDirectory = path.join(temporaryRoot, 'PRIVATE_PROJECT_PATH_4621');
    fs.mkdirSync(sensitiveDirectory);
    var sensitiveSqlPath = path.join(sensitiveDirectory, 'private_statement.sql');
    var sensitiveExpectedPath = sensitiveSqlPath.replace(/\.sql$/, '.expected.json');
    var sensitiveOptionsPath = sensitiveSqlPath.replace(/\.sql$/, '.options.json');
    fs.writeFileSync(sensitiveSqlPath, 'select PRIVATE_SQL_CONTENT_4621 from t');
    function assertSafeLoadFailure(corpusDirectory, reason) {
        var failedRun = childProcess.spawnSync(process.execPath, [
            'tests/v2/wave5-production-private.test.js'
        ], {
            cwd: root,
            encoding: 'utf8',
            env: Object.assign({}, process.env, { SQL_BEAUTIFY_CORPUS_DIR: corpusDirectory })
        });
        assert.notStrictEqual(failedRun.status, 0, 'invalid private input must fail the runner');
        assert.match(failedRun.stdout, new RegExp('"reason":"' + reason + '"'));
        assert.strictEqual(failedRun.stderr, '', 'load failures must not print underlying stacks');
        assert.ok(!failedRun.stdout.includes('PRIVATE_PROJECT_PATH_4621') &&
            !failedRun.stdout.includes('PRIVATE_SQL_CONTENT_4621') &&
            !failedRun.stdout.includes(temporaryRoot), 'safe summaries must omit private paths and SQL');
    }
    fs.writeFileSync(sensitiveExpectedPath, '{"status": PRIVATE_SQL_CONTENT_4621');
    assertSafeLoadFailure(sensitiveDirectory, 'corpus-load-failed');
    fs.writeFileSync(sensitiveExpectedPath, JSON.stringify({ status: 'failed', codes: [] }));
    assertSafeLoadFailure(sensitiveDirectory, 'corpus-load-failed');
    fs.rmSync(sensitiveExpectedPath);
    fs.writeFileSync(sensitiveOptionsPath, '{"dialect": PRIVATE_SQL_CONTENT_4621');
    assertSafeLoadFailure(sensitiveDirectory, 'corpus-load-failed');
    fs.rmSync(sensitiveOptionsPath);
    assertSafeLoadFailure(sensitiveSqlPath, 'corpus-load-failed');
    fs.rmSync(sensitiveSqlPath);
    assertSafeLoadFailure(sensitiveDirectory, 'empty-corpus');
    fs.symlinkSync(path.join(sensitiveDirectory, 'missing-private-file'), sensitiveSqlPath);
    assertSafeLoadFailure(sensitiveDirectory, 'corpus-load-failed');
    fs.rmSync(sensitiveDirectory, { recursive: true, force: true });

    var runnerProbe = [
        "var Module = require('module');",
        'var originalLoad = Module._load;',
        'Module._load = function(request, parent, isMain) {',
        "    if (request === '../../dist/sql-formatter.cjs') return { formatSql: function(source) {",
        "        return { status: 'failed', text: source, diagnostics: [{",
        "            code: 'FMT_INTERNAL', severity: 'error', message: source",
        '        }] };',
        '    } };',
        '    return originalLoad.call(this, request, parent, isMain);',
        '};',
        "require('./tests/v2/wave5-production-private.test.js');"
    ].join('\n');
    var runner = childProcess.spawnSync(process.execPath, ['-e', runnerProbe], {
        cwd: root,
        encoding: 'utf8',
        env: Object.assign({}, process.env, { SQL_BEAUTIFY_CORPUS_DIR: temporaryRoot })
    });
    assert.notStrictEqual(runner.status, 0, 'private runner must fail when every format request fails');
    assert.match(runner.stdout, /"failed":3/);
    assert.ok(!runner.stdout.includes('select a') && !runner.stderr.includes('select a'),
        'failed private runner must not print source or diagnostic messages');
} finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
}

console.log('Private production corpus availability contract tests passed');
