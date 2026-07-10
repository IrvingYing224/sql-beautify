var fs = require('fs');
var path = require('path');
var assert = require('assert');
var childProcess = require('child_process');

var root = path.join(__dirname, '..', '..');
var packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

function normalizeRelativePath(relativePath) {
    return relativePath.split(path.sep).join('/');
}

function collectJavaScriptFiles(relativeDirectory) {
    var absoluteDirectory = path.join(root, relativeDirectory);
    var files = [];

    fs.readdirSync(absoluteDirectory, { withFileTypes: true }).forEach(function(entry) {
        var relativePath = path.join(relativeDirectory, entry.name);
        if (entry.isDirectory()) {
            files = files.concat(collectJavaScriptFiles(relativePath));
        } else if (/\.js$/.test(entry.name)) {
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

function resolvesToV2Source(fromRelativePath, request) {
    var normalizedRequest = request.replace(/\\/g, '/');
    if (/^src(?:\/|$)/.test(normalizedRequest)) {
        return true;
    }
    if (!/^\.\.?\//.test(normalizedRequest)) {
        return false;
    }

    var sourceRoot = path.resolve(root, 'src');
    var resolvedRequest = path.resolve(root, path.dirname(fromRelativePath), request);
    return resolvedRequest === sourceRoot || resolvedRequest.indexOf(sourceRoot + path.sep) === 0;
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

function assertPackagedFilesAbsent(packagedFiles, label, pattern) {
    var leakedFiles = packagedFiles.filter(function(relativePath) {
        return pattern.test(relativePath);
    });
    assert.deepStrictEqual(
        leakedFiles,
        [],
        'VSIX must exclude ' + label + '\n--- leaked files ---\n' + leakedFiles.join('\n')
    );
}

assert.strictEqual(packageJson.main, './extension.js', 'Wave 0 must not replace entrypoint');

['dt-sql-parser', 'typescript', 'esbuild'].forEach(function(dependencyName) {
    assert.strictEqual(
        (packageJson.dependencies || {})[dependencyName],
        undefined,
        dependencyName + ' must not be a runtime dependency'
    );
});
assert.strictEqual(packageJson.devDependencies['dt-sql-parser'], '4.5.0', 'candidate version');
assert.strictEqual(packageJson.devDependencies.typescript, '6.0.3', 'TypeScript version');
assert.strictEqual(packageJson.devDependencies.esbuild, '0.28.1', 'esbuild version');

var libRuntimeFiles = collectJavaScriptFiles('lib');
var activeRuntimeFiles = ['extension.js'].concat(libRuntimeFiles);
var packagedFiles = listPackagedFiles();
var packagedFileSet = {};
packagedFiles.forEach(function(relativePath) {
    packagedFileSet[relativePath] = true;
});

assert.ok(packagedFileSet['extension.js'], 'VSIX must include extension.js');
assert.ok(libRuntimeFiles.length > 0, 'runtime lib file list must not be empty');
libRuntimeFiles.forEach(function(relativePath) {
    assert.ok(packagedFileSet[relativePath], 'VSIX must include runtime file ' + relativePath);
});

[
    ['Wave 0 TypeScript configuration', /^tsconfig\.v2\.json$/],
    ['TypeScript source', /^src(?:\/|$)/],
    ['evaluation scripts', /^scripts(?:\/|$)/],
    ['tests', /^tests(?:\/|$)/],
    ['docs', /^docs(?:\/|$)/],
    ['evaluation output', /^\.tmp(?:\/|$)/],
    ['local task ledger and scratch files', /^\.superpowers(?:\/|$)/],
    ['dt-sql-parser runtime files', /^node_modules\/dt-sql-parser(?:\/|$)/]
].forEach(function(deniedBoundary) {
    assertPackagedFilesAbsent(packagedFiles, deniedBoundary[0], deniedBoundary[1]);
});

activeRuntimeFiles.forEach(function(relativePath) {
    var source = fs.readFileSync(path.join(root, relativePath), 'utf8');
    var takeoverRequests = collectModuleRequests(source).filter(function(request) {
        return resolvesToV2Source(relativePath, request);
    });
    assert.deepStrictEqual(
        takeoverRequests,
        [],
        relativePath + ' must not import or require Wave 0 src/ modules'
    );
});

console.log('v2 Wave 0 boundary tests passed');
