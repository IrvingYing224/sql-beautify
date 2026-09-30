#!/usr/bin/env node
'use strict';

var assert = require('assert');
var childProcess = require('child_process');
var fs = require('fs');
var os = require('os');
var path = require('path');
var manifestApi = require('./package-manifest');
var packageTools = require('./package-tools');

var root = path.join(__dirname, '..');
var excludedNames = new Set(['.git', '.tmp', 'dist', 'node_modules']);

function copySource(sourceRoot, targetRoot) {
    fs.cpSync(sourceRoot, targetRoot, {
        recursive: true,
        filter: function(source) {
            var relative = path.relative(sourceRoot, source);
            if (relative === '') {
                return true;
            }
            var segments = relative.split(path.sep);
            if (segments.some(function(segment) { return excludedNames.has(segment); })) {
                return false;
            }
            return !/\.vsix$|\.tgz$/.test(relative);
        }
    });
}

function run(command, args, options) {
    try {
        return childProcess.execFileSync(command, args, Object.assign({
            encoding: 'utf8',
            maxBuffer: 32 * 1024 * 1024
        }, options || {}));
    } catch (error) {
        if (error && error.stdout) {
            process.stderr.write(String(error.stdout));
        }
        throw error;
    }
}

function verifyInstalledConsumer(consumerRoot) {
    var probe = [
        "const formatter = require('vscode-sql-beautify/formatter');",
        "const ddl = require('vscode-sql-beautify/experimental/ddl');",
        "if (Object.keys(formatter).sort().join(',') !== 'formatSql,lexSql') throw new Error('formatter exports');",
        "if (Object.keys(ddl).sort().join(',') !== 'extractDdl,formatHiveDdl') throw new Error('ddl exports');",
        "const result = formatter.formatSql('select a from t', { dialect: 'hive' });",
        "if (result.status !== 'formatted' && result.status !== 'unchanged') throw new Error('formatter smoke');",
        "const ddlResult = ddl.formatHiveDdl('CREATE TABLE t (id INT)');",
        "if (ddlResult.status !== 'formatted' && ddlResult.status !== 'unchanged') throw new Error('ddl smoke');"
    ].join('\n');
    run(process.execPath, ['-e', probe], { cwd: consumerRoot });
    run(process.execPath, ['--input-type=module', '-e', [
        "import { formatSql, lexSql } from 'vscode-sql-beautify/formatter';",
        "import { formatHiveDdl, extractDdl } from 'vscode-sql-beautify/experimental/ddl';",
        "if (formatSql('select a from t').status !== 'formatted') throw new Error('ESM formatter');",
        "if (!lexSql('select a from t').leaves.length) throw new Error('ESM lexer');",
        "if (formatHiveDdl('CREATE TABLE t (a INT)').status !== 'formatted') throw new Error('ESM DDL');",
        "if (extractDdl('SELECT a FROM t').status !== 'extracted') throw new Error('ESM extract');"
    ].join('\n')], { cwd: consumerRoot });
    var installedManifest = require.resolve('vscode-sql-beautify/package.json', {
        paths: [consumerRoot]
    });
    var installedVersion = require(installedManifest).version;
    var migrationVersion = installedVersion.split('.').slice(0, 2).join('.');
    var installedReadme = fs.readFileSync(
        path.join(path.dirname(installedManifest), 'README.md'),
        'utf8'
    );
    assert.ok(
        installedReadme.indexOf('/blob/v' + installedVersion +
            '/docs/migration-to-' + migrationVersion + '.md') >= 0,
        'installed README migration link must be pinned to the package version'
    );
}

function verifyTypedConsumer(consumerRoot) {
    var source = [
        "import { formatSql, lexSql, type FormatOptions, type FormatResult, type SourceMap } from 'vscode-sql-beautify/formatter';",
        "import { formatHiveDdl, extractDdl, type ExtractDdlResult } from 'vscode-sql-beautify/experimental/ddl';",
        "const options: FormatOptions = { dialect: 'postgresql', keywordCase: 'lower' };",
        "const result: FormatResult = formatSql('select a from t', options);",
        "const leaves = lexSql('select a', { dialect: 'hive' }).leaves;",
        "const raw: string | undefined = leaves[0]?.raw;",
        "if (result.status === 'formatted' || result.status === 'unchanged') {",
        '    const map: SourceMap = result.sourceMap;',
        '    map.entries.forEach(entry => entry.output.start);',
        '} else {',
        '    // @ts-expect-error preserved/failed results do not contain a source map',
        '    const map: SourceMap = result.sourceMap;',
        '}',
        "formatHiveDdl('CREATE TABLE t (a INT)', { commaStyle: 'trailing' });",
        "const extracted: ExtractDdlResult = extractDdl('select a from t', { defaultType: 'STRING' });",
        "if (extracted.status === 'extracted') { const empty: readonly [] = extracted.diagnostics; }",
        '// @ts-expect-error unsupported dialect alias',
        "formatSql('select a', { dialect: 'postgres' });",
        '// @ts-expect-error render environment is not a public formatter option',
        "formatSql('select a', { tabSize: 2 });",
        '// @ts-expect-error public formatter is document-only',
        "formatSql('select a', {}, 'fragment');",
        '// @ts-expect-error DDL options expose only their modeled subset',
        "formatHiveDdl('CREATE TABLE t (a INT)', { dialect: 'hive' });",
        '// @ts-expect-error extract default type must be a string',
        "extractDdl('select a', { defaultType: 1 });",
        '// @ts-expect-error package root remains private',
        "import * as root from 'vscode-sql-beautify';",
        '// @ts-expect-error internal runtime paths remain private',
        "import * as internal from 'vscode-sql-beautify/dist/runtime.cjs';",
        '// @ts-expect-error syntax implementation is not a public facade value',
        "import { parseSql } from 'vscode-sql-beautify/formatter';",
        'void raw; void leaves;'
    ].join('\n');
    ['consumer.cts', 'consumer.mts'].forEach(function(fileName) {
        fs.writeFileSync(path.join(consumerRoot, fileName), source, 'utf8');
    });
    fs.writeFileSync(path.join(consumerRoot, 'tsconfig.json'), JSON.stringify({
        compilerOptions: {
            target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext',
            strict: true, exactOptionalPropertyTypes: true, noEmit: true,
            skipLibCheck: false, types: []
        },
        files: ['consumer.cts', 'consumer.mts']
    }), 'utf8');
    run(process.execPath, [require.resolve('typescript/bin/tsc'), '-p', 'tsconfig.json'], {
        cwd: consumerRoot
    });
}

function verifyCleanPackage() {
    var temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sql-beautify-clean-package-'));
    var sourceRoot = path.join(temporaryRoot, 'source');
    var packageOutput = path.join(temporaryRoot, 'package-output');
    var consumerRoot = path.join(temporaryRoot, 'consumer');
    var npmEnvironment = Object.assign({}, process.env, {
        npm_config_cache: path.join(temporaryRoot, 'npm-cache')
    });
    try {
        copySource(root, sourceRoot);
        fs.symlinkSync(path.join(root, 'node_modules'), path.join(sourceRoot, 'node_modules'),
            process.platform === 'win32' ? 'junction' : 'dir');
        fs.mkdirSync(packageOutput, { recursive: true });
        assert.strictEqual(fs.existsSync(path.join(sourceRoot, 'dist')), false,
            'clean package probe must begin without dist artifacts');

        var packOutput = run(process.execPath, [packageTools.npmCliPath(),
            'pack',
            '--json',
            '--pack-destination',
            packageOutput
        ], { cwd: sourceRoot, env: npmEnvironment });
        var jsonStart = packOutput.search(/^\s*\[/m);
        assert.ok(jsonStart >= 0, 'npm pack must emit a JSON result array');
        var packResult = JSON.parse(packOutput.slice(jsonStart))[0];
        var packedFiles = packResult.files.map(function(file) { return file.path; }).sort();
        var packageManifest = manifestApi.loadPackageManifest(sourceRoot);
        assert.deepStrictEqual(packedFiles, packageManifest.npmFiles,
            'npm package must contain the exact production allowlist');

        var sourcePackage = require(path.join(sourceRoot, 'package.json'));
        var sourceLock = require(path.join(sourceRoot, 'package-lock.json'));
        assert.strictEqual(packResult.version, sourcePackage.version);
        assert.strictEqual(sourceLock.version, sourcePackage.version);
        assert.strictEqual(sourceLock.packages[''].version, sourcePackage.version);

        var tarball = path.join(packageOutput, packResult.filename);
        fs.mkdirSync(consumerRoot, { recursive: true });
        fs.writeFileSync(path.join(consumerRoot, 'package.json'), JSON.stringify({
            private: true
        }), 'utf8');
        run(process.execPath, [packageTools.npmCliPath(),
            'install',
            '--ignore-scripts',
            '--no-audit',
            '--no-fund',
            tarball
        ], { cwd: consumerRoot, env: npmEnvironment });
        verifyInstalledConsumer(consumerRoot);
        verifyTypedConsumer(consumerRoot);
        console.log('Clean npm package verified: ' + packResult.filename +
            ' (' + packedFiles.length + ' files)');
    } finally {
        fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
}

if (require.main === module) {
    try {
        verifyCleanPackage();
    } catch (error) {
        console.error(error && error.stack ? error.stack : error);
        process.exitCode = 1;
    }
}

module.exports = Object.freeze({ verifyCleanPackage: verifyCleanPackage });
