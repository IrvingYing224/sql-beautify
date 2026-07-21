#!/usr/bin/env node
'use strict';

var fs = require('fs');
var path = require('path');
var esbuild = require('esbuild');

var root = path.join(__dirname, '..');
var outDir = path.join(root, 'dist');
var artifacts = {
    runtime: path.join(outDir, 'runtime.cjs'),
    formatter: path.join(outDir, 'sql-formatter.cjs'),
    ddl: path.join(outDir, 'hive-ddl.cjs'),
    worker: path.join(outDir, 'formatter-worker.cjs'),
    extension: path.join(outDir, 'extension.cjs')
};
var obsoleteArtifacts = [
    'v2-core.cjs',
    'v2-ddl.cjs',
    'v2-worker.cjs',
    'v2-format-bridge.cjs'
].map(function(fileName) { return path.join(outDir, fileName); });

function temporary(file) {
    return file + '.tmp';
}

function removeFiles(files) {
    var firstError = null;
    for (var index = 0; index < files.length; index++) {
        try {
            fs.rmSync(files[index], { force: true });
        } catch (error) {
            firstError = firstError || error;
        }
    }
    if (firstError) {
        throw firstError;
    }
}

function sharedRuntimePlugin() {
    return {
        name: 'wave5-shared-runtime',
        setup: function(build) {
            build.onResolve({ filter: /^\.\/internal$/ }, function() {
                return { path: './runtime.cjs', external: true };
            });
        }
    };
}

async function build(entryPoint, outfile, extra) {
    await esbuild.build(Object.assign({
        entryPoints: [entryPoint],
        bundle: true,
        platform: 'node',
        format: 'cjs',
        target: 'node20',
        outfile: temporary(outfile),
        sourcemap: false,
        minify: false,
        legalComments: 'none',
        logLevel: 'warning'
    }, extra || {}));
}

var allFiles = Object.keys(artifacts).map(function(key) { return artifacts[key]; });
var tempFiles = allFiles.map(temporary);

async function main() {
    try {
        fs.mkdirSync(outDir, { recursive: true });
        removeFiles(allFiles.concat(tempFiles, obsoleteArtifacts));

        await build(path.join(root, 'src', 'runtime', 'internal.ts'), artifacts.runtime);
        await build(path.join(root, 'src', 'runtime', 'index.ts'), artifacts.formatter, {
            plugins: [sharedRuntimePlugin()]
        });
        await build(path.join(root, 'src', 'runtime', 'experimental-ddl.ts'), artifacts.ddl, {
            plugins: [sharedRuntimePlugin()]
        });
        await build(path.join(root, 'src', 'adapters', 'executor', 'worker-entry.ts'), artifacts.worker);
        await build(path.join(root, 'src', 'extension.ts'), artifacts.extension, {
            external: ['vscode']
        });

        Object.keys(artifacts).forEach(function(key) {
            fs.renameSync(temporary(artifacts[key]), artifacts[key]);
        });
    } catch (error) {
        removeFiles(allFiles.concat(tempFiles, obsoleteArtifacts));
        throw error;
    } finally {
        removeFiles(tempFiles);
    }

    console.log('Built Wave 5 runtime artifacts: ' + [
        path.relative(root, artifacts.runtime),
        path.relative(root, artifacts.formatter),
        path.relative(root, artifacts.ddl),
        path.relative(root, artifacts.worker),
        path.relative(root, artifacts.extension)
    ].join(', '));
}

main().catch(function(error) {
    console.error(error);
    process.exitCode = 1;
});
