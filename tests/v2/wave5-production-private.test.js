var sqlFormatter = require('../../dist/sql-formatter.cjs');
var corpus = require('./helpers/production-corpus');

var privateRoot = process.env.SQL_BEAUTIFY_CORPUS_DIR;

function safeFailure(reason) {
    console.log('private production corpus summary: ' + JSON.stringify({
        total: 0,
        passed: 0,
        failures: [{ reason: reason }]
    }));
    process.exitCode = 1;
}

function main() {
    if (!privateRoot) {
        console.log('private production corpus skipped: SQL_BEAUTIFY_CORPUS_DIR is not set');
        return;
    }
    var cases;
    try {
        cases = corpus.load_private_cases(privateRoot);
    } catch (error) {
        // File-system and JSON/schema errors can contain private paths or SQL.
        // Never print the underlying error, including its stack or cause.
        safeFailure('corpus-load-failed');
        return;
    }
    if (cases.length === 0) {
        safeFailure('empty-corpus');
        return;
    }
    var summary;
    try {
        summary = corpus.evaluate_private_cases(sqlFormatter, cases);
    } catch (error) {
        safeFailure('corpus-evaluation-failed');
        return;
    }
    console.log('private production corpus summary: ' + JSON.stringify(summary));
    if (summary.failures.length > 0) {
        process.exitCode = 1;
        return;
    }
    console.log('private production corpus tests passed (' + cases.length + ' cases)');
}

main();
