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

// scripts order and presence
assert.ok(packageJson.scripts['build:v2-core']);
assert.ok(packageJson.scripts['test:v2:lexer']);
assert.ok(packageJson.scripts['test:v2:lexer-performance']);
assert.ok(packageJson.scripts['test:v2:wave1']);
assert.ok(packageJson.scripts['test:v2:wave0']);
assert.ok(
    packageJson.scripts['test:verify'].indexOf('npm run test:v2:wave0') >= 0,
    'test:verify must keep wave0'
);
assert.ok(
    packageJson.scripts['test:verify'].indexOf('npm run test:v2:wave1') >= 0,
    'test:verify must include wave1'
);
assert.ok(
    packageJson.scripts['test:v2:wave1'].indexOf('build:v2-core') >= 0 &&
        packageJson.scripts['test:v2:wave1'].indexOf('lossless-lexer.test.js') >= 0 &&
        packageJson.scripts['test:v2:wave1'].indexOf('lossless-lexer-performance.test.js') >= 0 &&
        packageJson.scripts['test:v2:wave1'].indexOf('wave1-boundary.test.js') >= 0,
    'test:v2:wave1 must build once then run runtime/performance/boundary'
);

// no new dependencies
assert.strictEqual(packageJson.dependencies, undefined);
assert.deepStrictEqual(
    Object.keys(packageJson.devDependencies).sort(),
    ['@types/vscode', '@vscode/vsce', 'dt-sql-parser', 'esbuild', 'typescript'].sort()
);
assert.strictEqual(packageLock.lockfileVersion, 3);

// vscodeignore excludes build configs
assert.ok(
    /tsconfig\.v2\*\.json/.test(vscodeIgnore) || /tsconfig\.v2\.build\.json/.test(vscodeIgnore),
    '.vscodeignore must exclude tsconfig.v2*.json'
);

// lexer source isolation
var lexerFiles = collectFiles('src/core/lexer', function(name) {
    return /\.ts$/.test(name);
});
assert.ok(lexerFiles.length > 0, 'lexer sources must exist');
lexerFiles.forEach(function(relativePath) {
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
                request.indexOf('parser-evaluation') === -1,
            relativePath + ' must stay isolated from lib/adapters/experimental/parser-evaluation: ' + request
        );
    });
    assert.ok(
        source.indexOf('dt-sql-parser') === -1,
        relativePath + ' must not reference dt-sql-parser'
    );
});

// current runtime must not import src or .tmp/v2-core
var runtimeFiles = ['extension.js', 'vkbeautify.js'].concat(
    collectFiles('lib', function(name) {
        return /\.js$/.test(name);
    })
);
runtimeFiles.forEach(function(relativePath) {
    var source = fs.readFileSync(path.join(root, relativePath), 'utf8');
    assert.ok(source.indexOf('src/') === -1 || !/\brequire\s*\(\s*['"][^'"]*src\//.test(source));
    assert.ok(source.indexOf('.tmp/v2-core') === -1);
    collectModuleRequests(source).forEach(function(request) {
        assert.ok(
            !/^src(?:\/|$)/.test(request) && request.indexOf('.tmp/v2-core') === -1,
            relativePath + ' must not import v2 source/build: ' + request
        );
    });
});

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

console.log('v2 Wave 1 boundary tests passed');
