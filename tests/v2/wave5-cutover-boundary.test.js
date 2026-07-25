'use strict';

var assert = require('assert');
var fs = require('fs');
var path = require('path');

var root = path.join(__dirname, '..', '..');
var packageJson = require(path.join(root, 'package.json'));
var lockText = fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8');

var expectedArtifacts = [
    'extension.cjs',
    'formatter-worker.cjs',
    'hive-ddl.cjs',
    'runtime.cjs',
    'sql-formatter.cjs'
];
var expectedFiles = [
    'dist/extension.cjs',
    'dist/runtime.cjs',
    'dist/sql-formatter.cjs',
    'dist/hive-ddl.cjs',
    'dist/formatter-worker.cjs',
    'images/icon.png',
    'README.md',
    'CHANGELOG.md',
    'LICENSE.txt'
];
var expectedCommands = [
    'sqlBeautify.copySafeDiagnosticReport',
    'sqlBeautify.extractHiveDdl',
    'sqlBeautify.formatHiveDdl',
    'sqlBeautify.formatSql'
];
var expectedConfigurationKeys = [
    'sqlBeautify.caseLayout',
    'sqlBeautify.caseWhenThenWrapLength',
    'sqlBeautify.commaStyle',
    'sqlBeautify.debugDiagnostics',
    'sqlBeautify.dialect',
    'sqlBeautify.indentStyle',
    'sqlBeautify.keywordCase',
    'sqlBeautify.maxAlignWidth',
    'sqlBeautify.unsupportedSyntaxPolicy'
];

assert.strictEqual(packageJson.version, '2.0.1');
assert.strictEqual(packageJson.main, './dist/extension.cjs');
assert.deepStrictEqual(packageJson.exports, {
    './formatter': './dist/sql-formatter.cjs',
    './experimental/ddl': './dist/hive-ddl.cjs',
    './package.json': './package.json'
});
assert.deepStrictEqual(packageJson.files, expectedFiles,
    'package files must be the explicit Wave 5 production allowlist');
assert.deepStrictEqual(fs.readdirSync(path.join(root, 'images')).sort(), ['icon.png'],
    'only the extension icon may remain in the production image directory');
assert.deepStrictEqual(packageJson.activationEvents.slice().sort(), [
    'onCommand:sqlBeautify.copySafeDiagnosticReport',
    'onCommand:sqlBeautify.extractHiveDdl',
    'onCommand:sqlBeautify.formatHiveDdl',
    'onCommand:sqlBeautify.formatSql',
    'onLanguage:hive-sql',
    'onLanguage:sql'
]);

var contributedCommands = packageJson.contributes.commands
    .map(function(value) { return value.command; }).sort();
assert.deepStrictEqual(contributedCommands, expectedCommands,
    'only canonical command ids may be contributed');
assert.deepStrictEqual(packageJson.contributes.keybindings.map(function(value) {
    return value.command;
}).sort(), expectedCommands.filter(function(value) {
    return value !== 'sqlBeautify.copySafeDiagnosticReport';
}).sort(), 'keybindings must target only canonical editing commands');
packageJson.contributes.keybindings.forEach(function(value) {
    assert.strictEqual(value.when,
        'editorTextFocus && !editorReadonly && (editorLangId == sql || editorLangId == hive-sql)',
        'keybindings must use the exact supported language ids');
});

var configuration = packageJson.contributes.configuration.properties;
assert.deepStrictEqual(Object.keys(configuration).sort(), expectedConfigurationKeys,
    'only canonical sqlBeautify.* configuration may be exposed');
assert.deepStrictEqual(configuration['sqlBeautify.dialect'].enum,
    ['generic', 'hive', 'postgresql', 'mysql']);
assert.strictEqual(configuration['sqlBeautify.dialect'].default, 'hive');
assert.strictEqual(configuration['sqlBeautify.unsupportedSyntaxPolicy'].default, 'warn',
    'VS Code and canonical core must share the fail-visible default policy');

[
    'extension.js',
    'vkbeautify.js',
    'lib',
    'scripts/generate-support-matrix.js',
    'scripts/v2-parser-evaluation',
    'src/adapters/runtime/v2-format-bridge.ts',
    'tests/v2/v2-format-bridge.test.js',
    'tests/v2/parser-evaluation-harness.test.js',
    'tests/v2/parser-evaluation-report.test.js',
    'tests/v2/dt-sql-parser-candidate.test.js',
    'dist/v2-format-bridge.cjs',
    'docs/superpowers'
].forEach(function(relativePath) {
    assert.strictEqual(fs.existsSync(path.join(root, relativePath)), false,
        'legacy path must not exist: ' + relativePath);
});

assert.strictEqual(lockText.indexOf('dt-sql-parser'), -1,
    'package lock must not retain the rejected parser candidate');
assert.strictEqual(packageJson.devDependencies['dt-sql-parser'], undefined);
var parserAdr = fs.readFileSync(
    path.join(root, 'docs', 'technical', 'adr', '0001-v2-parser-backend.md'),
    'utf8'
);
var parserReport = fs.readFileSync(
    path.join(root, 'docs', 'technical', 'v2-parser-evaluation-report.md'),
    'utf8'
);
assert.doesNotMatch(parserAdr, /v2-parser-evidence-base64/,
    'ADR must link the full parser evidence instead of duplicating it');
assert.strictEqual(
    (parserReport.match(/v2-parser-evidence-base64/g) || []).length,
    1,
    'parser evaluation report must remain the single embedded evidence owner'
);
assert.strictEqual(fs.existsSync(path.join(root, '.vscodeignore')), false,
    'VSCE forbids combining .vscodeignore with the package files allowlist');

var distFiles = fs.readdirSync(path.join(root, 'dist')).filter(function(fileName) {
    return /\.cjs$/.test(fileName);
}).sort();
assert.deepStrictEqual(distFiles, expectedArtifacts,
    'dist must contain only the five Wave 5 production CommonJS artifacts');
var runtime = require(path.join(root, 'dist', 'runtime.cjs'));
var formatter = require(path.join(root, 'dist', 'sql-formatter.cjs'));
var ddl = require(path.join(root, 'dist', 'hive-ddl.cjs'));
assert.deepStrictEqual(Object.keys(formatter).sort(), ['formatSql', 'lexSql']);
assert.deepStrictEqual(Object.keys(ddl).sort(), ['extractDdl', 'formatHiveDdl']);
assert.strictEqual(formatter.formatSql, runtime.formatSql);
assert.strictEqual(formatter.lexSql, runtime.lexSql);
assert.strictEqual(ddl.formatHiveDdl, runtime.formatHiveDdl);
assert.strictEqual(ddl.extractDdl, runtime.extractDdl);

function walkTypeScript(directory) {
    return fs.readdirSync(directory).sort().reduce(function(files, entry) {
        var fullPath = path.join(directory, entry);
        return files.concat(fs.statSync(fullPath).isDirectory()
            ? walkTypeScript(fullPath)
            : (/\.ts$/.test(entry) ? [fullPath] : []));
    }, []);
}

walkTypeScript(path.join(root, 'src', 'core')).forEach(function(filePath) {
    var source = fs.readFileSync(filePath, 'utf8');
    var imports = source.matchAll(/(?:from\s+|require\s*\()(["'])([^"']+)\1/g);
    for (var match of imports) {
        assert.ok(!/(^|\/)(?:adapters|experimental)(?:\/|$)/.test(match[2]) &&
            match[2] !== 'vscode',
        path.relative(root, filePath) + ' must remain host and adapter independent');
    }
});

var extensionSource = fs.readFileSync(path.join(root, 'dist', 'extension.cjs'), 'utf8');
var workerSource = fs.readFileSync(path.join(root, 'dist', 'formatter-worker.cjs'), 'utf8');
assert.ok(extensionSource.indexOf('runtime.cjs') >= 0,
    'extension entry must load the shared runtime artifact');
assert.ok(extensionSource.indexOf('formatter-worker.cjs') >= 0,
    'extension entry must bind the production worker artifact');
assert.ok(workerSource.indexOf('runtimePath') >= 0,
    'worker artifact must load the runtime path supplied by the host');

console.log('v2 Wave 5 cutover boundary tests passed');
