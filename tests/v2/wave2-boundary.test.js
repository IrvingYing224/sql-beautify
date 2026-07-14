'use strict';

var fs = require('fs');
var path = require('path');
var assert = require('assert');
var childProcess = require('child_process');

var root = path.join(__dirname, '..', '..');
var packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
var packageLock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
var vscodeIgnore = fs.readFileSync(path.join(root, '.vscodeignore'), 'utf8');

function normalizeRelativePath(relativePath) {
    return relativePath.split(path.sep).join('/');
}

function collectFiles(relativeDirectory, predicate) {
    var absoluteDirectory = path.join(root, relativeDirectory);
    if (!fs.existsSync(absoluteDirectory)) {
        return [];
    }
    var files = [];
    fs.readdirSync(absoluteDirectory, { withFileTypes: true }).forEach(function(entry) {
        var relativePath = path.join(relativeDirectory, entry.name);
        if (entry.isDirectory()) {
            files = files.concat(collectFiles(relativePath, predicate));
        } else if (!predicate || predicate(entry.name, relativePath)) {
            files.push(normalizeRelativePath(relativePath));
        }
    });
    return files.sort();
}

function collectModuleRequests(source) {
    var requests = [];
    var patterns = [
        /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
        /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
        /\bfrom\s+['"]([^'"]+)['"]/g,
        /\bimport\s+['"]([^'"]+)['"]/g
    ];
    patterns.forEach(function(pattern) {
        source.replace(pattern, function(_, request) {
            requests.push(request);
            return _;
        });
    });
    return requests;
}

function listPackagedFiles() {
    var localVsce = require.resolve('@vscode/vsce/vsce');
    var output = childProcess.execFileSync(process.execPath, [localVsce, 'ls'], {
        cwd: root,
        encoding: 'utf8'
    });
    return output.split(/\r?\n/).filter(Boolean).map(function(relativePath) {
        return relativePath.replace(/\\/g, '/');
    });
}

function assertAbsent(packagedFiles, label, pattern) {
    var leaked = packagedFiles.filter(function(file) {
        return pattern.test(file);
    });
    assert.deepStrictEqual(leaked, [], 'VSIX must exclude ' + label + '\n' + leaked.join('\n'));
}

// package main unchanged
assert.strictEqual(packageJson.main, './extension.js');

// Wave 0/1/2 scripts present
assert.ok(packageJson.scripts['build:v2-core']);
assert.ok(packageJson.scripts['test:v2:wave0']);
assert.ok(packageJson.scripts['test:v2:wave1']);
assert.ok(packageJson.scripts['test:v2:wave2']);
assert.ok(packageJson.scripts['test:v2:wave2-foundation']);
assert.ok(packageJson.scripts['test:v2:hive-cst']);
assert.ok(packageJson.scripts['test:v2:wave2-corpus']);
assert.ok(packageJson.scripts['test:v2:wave2-performance']);
assert.ok(packageJson.scripts['test:v2:expression']);
assert.ok(
    packageJson.scripts['test:v2:expression'].indexOf('build:v2-core') >= 0 &&
        packageJson.scripts['test:v2:expression'].indexOf('expression-parser.test.js') >= 0,
    'standalone expression gate must build and run Wave 2C parser tests'
);
assert.ok(
    packageJson.scripts['test:v2:wave2'].indexOf('expression-parser.test.js') >= 0,
    'Wave 2 aggregate gate must include Wave 2C expression tests'
);
assert.ok(
    packageJson.scripts['test:v2:wave2-foundation'].indexOf('build:v2-core') >= 0 &&
        packageJson.scripts['test:v2:wave2-foundation'].indexOf('dialect-capability-registry.test.js') >= 0 &&
        packageJson.scripts['test:v2:wave2-foundation'].indexOf('syntax-token-table.test.js') >= 0 &&
        packageJson.scripts['test:v2:wave2-foundation'].indexOf('syntax-invariants.test.js') >= 0 &&
        packageJson.scripts['test:v2:wave2-foundation'].indexOf('wave2a-hardening.test.js') >= 0 &&
        packageJson.scripts['test:v2:wave2-foundation'].indexOf('wave2-boundary.test.js') >= 0,
    'wave2-foundation must build once then run registry/token-table/invariants/hardening/boundary'
);
assert.ok(
    packageJson.scripts['test:v2:hive-cst'].indexOf('build:v2-core') >= 0 &&
        packageJson.scripts['test:v2:hive-cst'].indexOf('hive-cst-parser.test.js') >= 0,
    'standalone Hive CST gate must build and run parser tests'
);
assert.ok(
    packageJson.scripts['test:v2:wave2-corpus'].indexOf('build:v2-core') >= 0 &&
        packageJson.scripts['test:v2:wave2-corpus'].indexOf('wave2-corpus.test.js') >= 0,
    'standalone Wave 2 corpus gate must build and run corpus tests'
);
assert.ok(
    packageJson.scripts['test:v2:wave2-performance'].indexOf('build:v2-core') >= 0 &&
        packageJson.scripts['test:v2:wave2-performance'].indexOf('wave2-performance.test.js') >= 0,
    'standalone Wave 2 performance gate must build and run performance tests'
);
[
    'test:v2:wave2-foundation',
    'hive-cst-parser.test.js',
    'wave2b-final-hardening.test.js',
    'expression-parser.test.js',
    'wave2-corpus.test.js',
    'wave2-performance.test.js'
].forEach(function(required) {
    assert.ok(packageJson.scripts['test:v2:wave2'].indexOf(required) >= 0,
        'test:v2:wave2 must include ' + required);
});

// test:verify includes each wave aggregate once
var verify = packageJson.scripts['test:verify'];
assert.ok(verify.indexOf('npm run test:v2:wave0') >= 0, 'test:verify must keep wave0');
assert.ok(verify.indexOf('npm run test:v2:wave1') >= 0, 'test:verify must keep wave1');
assert.ok(verify.indexOf('npm run test:v2:wave2') >= 0, 'test:verify must include wave2');
assert.strictEqual(
    (verify.match(/npm run test:v2:wave2\b/g) || []).length,
    1,
    'test:verify must include wave2 aggregate exactly once'
);

// no new dependencies
assert.strictEqual(packageJson.dependencies, undefined);
assert.deepStrictEqual(
    Object.keys(packageJson.devDependencies).sort(),
    ['@types/vscode', '@vscode/vsce', 'dt-sql-parser', 'esbuild', 'typescript'].sort()
);
assert.strictEqual(packageLock.lockfileVersion, 3);

// vscodeignore excludes v2 build configs and source
assert.ok(
    /tsconfig\.v2\*\.json/.test(vscodeIgnore) || /tsconfig\.v2\.build\.json/.test(vscodeIgnore),
    '.vscodeignore must exclude tsconfig.v2*.json'
);
assert.ok(/src\/\*\*/.test(vscodeIgnore) || /src\/\*\*/.test(vscodeIgnore.replace(/\s/g, '')), '.vscodeignore must exclude src');
assert.ok(/scripts\/\*\*/.test(vscodeIgnore), '.vscodeignore must exclude scripts');
assert.ok(/tests\/\*\*/.test(vscodeIgnore), '.vscodeignore must exclude tests');
assert.ok(/docs\/\*\*/.test(vscodeIgnore), '.vscodeignore must exclude docs');
assert.ok(/\.tmp\/\*\*/.test(vscodeIgnore), '.vscodeignore must exclude .tmp');

// Root runtime keys remain only lexSql
var corePath = path.join(root, '.tmp', 'v2-core', 'core', 'index.js');
assert.ok(fs.existsSync(corePath), 'build:v2-core must produce root runtime before boundary tests');
var core = require(corePath);
assert.deepStrictEqual(Object.keys(core).sort(), ['lexSql']);

// syntax / dialects isolation
var wave2SourceDirs = ['src/core/syntax', 'src/core/dialects'];
wave2SourceDirs.forEach(function(dir) {
    var files = collectFiles(dir, function(name) {
        return /\.ts$/.test(name);
    });
    assert.ok(files.length > 0, dir + ' sources must exist');
    files.forEach(function(relativePath) {
        var source = fs.readFileSync(path.join(root, relativePath), 'utf8');
        var requests = collectModuleRequests(source);
        requests.forEach(function(request) {
            assert.ok(
                !/^(?:lib|dt-sql-parser|esbuild|vscode)(?:\/|$)/.test(request),
                relativePath + ' must not import ' + request
            );
            assert.ok(
                request.indexOf('lib/') !== 0 &&
                    request.indexOf('/lib/') === -1 &&
                    request.indexOf('adapters') === -1 &&
                    request.indexOf('experimental') === -1 &&
                    request.indexOf('parser-evaluation') === -1 &&
                    request.indexOf('layout') === -1 &&
                    request.indexOf('renderer') === -1,
                relativePath + ' must stay isolated: ' + request
            );
        });
        assert.ok(source.indexOf('dt-sql-parser') === -1, relativePath + ' must not mention dt-sql-parser');
        if (/\bparseSql\b/.test(source)) {
            assert.ok(
                relativePath === 'src/core/syntax/parser.ts' ||
                    relativePath === 'src/core/syntax/index.ts',
                relativePath + ' must not define or re-export parseSql'
            );
        }
    });
});

// Wave 2C parser files exist, while later recovery/analysis files remain absent.
[
    'src/core/syntax/parser.ts',
    'src/core/syntax/statement-parser.ts',
    'src/core/syntax/query-parser.ts',
    'src/core/syntax/relation-parser.ts',
    'src/core/syntax/list-parser.ts',
    'src/core/syntax/list-role-contract.ts',
    'src/core/syntax/cst-container-invariants.ts',
    'src/core/syntax/parser-context.ts',
    'src/core/syntax/node-factory.ts',
    'src/core/syntax/expression-parser.ts',
    'src/core/syntax/type-parser.ts',
    'src/core/syntax/window-parser.ts'
].forEach(function(relativePath) {
    assert.ok(
        fs.existsSync(path.join(root, relativePath)),
        'Wave 2C requires ' + relativePath
    );
});

[
    'src/core/syntax/recovery.ts',
    'src/core/analysis/analyze.ts',
    'src/core/analysis/structural-index.ts',
    'src/core/analysis/trivia-binding.ts'
].forEach(function(relativePath) {
    assert.ok(
        !fs.existsSync(path.join(root, relativePath)),
        'Wave 2C must not create later-wave file ' + relativePath
    );
});

var parserSource = fs.readFileSync(path.join(root, 'src/core/syntax/parser.ts'), 'utf8');
assert.ok(/from\s+["']\.\.\/lexer\/lossless-lexer["']/.test(parserSource),
    'Wave 2C parser must consume the canonical lossless lexer');
[
    'src/core/syntax/list-parser.ts',
    'src/core/syntax/query-parser.ts',
    'src/core/syntax/relation-parser.ts',
    'src/core/syntax/statement-parser.ts',
    'src/core/syntax/expression-parser.ts',
    'src/core/syntax/type-parser.ts',
    'src/core/syntax/window-parser.ts'
].forEach(function(relativePath) {
    var source = fs.readFileSync(path.join(root, relativePath), 'utf8');
    assert.strictEqual(source.indexOf('context.source.slice'), -1,
        relativePath + ' must use leaf spans instead of scanning protected/trivia source content');
    assert.strictEqual(source.indexOf('.raw.toLowerCase()'), -1,
        relativePath + ' must normalize code words through StructuralTokenTable');
});

// current runtime must not import src or .tmp/v2-core
var runtimeFiles = ['extension.js', 'vkbeautify.js'].concat(
    collectFiles('lib', function(name) {
        return /\.js$/.test(name);
    })
);
runtimeFiles.forEach(function(relativePath) {
    var source = fs.readFileSync(path.join(root, relativePath), 'utf8');
    collectModuleRequests(source).forEach(function(request) {
        assert.ok(
            !/^src(?:\/|$)/.test(request) && request.indexOf('.tmp/v2-core') === -1,
            relativePath + ' must not import v2 source/build: ' + request
        );
    });
});

// src must not grow layout/renderer/adapter/DDL product implementations
var layoutFiles = collectFiles('src/core/layout', function(name) {
    return /\.ts$/.test(name);
});
assert.deepStrictEqual(
    layoutFiles,
    ['src/core/layout/doc.ts'],
    'Wave 2C must not expand layout beyond doc contract'
);

// VSIX content
var packagedFiles = listPackagedFiles();
var packagedSet = {};
packagedFiles.forEach(function(file) {
    packagedSet[file] = true;
});
assert.ok(packagedSet['extension.js']);
assert.ok(packagedSet['vkbeautify.js']);

[
    ['TypeScript source', /^src(?:\/|$)/],
    ['scripts', /^scripts(?:\/|$)/],
    ['tests', /^tests(?:\/|$)/],
    ['docs', /^docs(?:\/|$)/],
    ['tmp build', /^\.tmp(?:\/|$)/],
    ['v2 tsconfig', /^tsconfig\.v2(?:\..+)?\.json$/],
    ['typescript package', /^node_modules\/typescript(?:\/|$)/],
    ['esbuild package', /^node_modules\/esbuild(?:\/|$)/],
    ['dt-sql-parser package', /^node_modules\/dt-sql-parser(?:\/|$)/]
].forEach(function(entry) {
    assertAbsent(packagedFiles, entry[0], entry[1]);
});

console.log('v2 Wave 2 boundary tests passed');
