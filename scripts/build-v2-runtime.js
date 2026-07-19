#!/usr/bin/env node
'use strict';

var fs = require('fs');
var path = require('path');
var esbuild = require('esbuild');

var root = path.join(__dirname, '..');
var outDir = path.join(root, 'dist');
var coreOutFile = path.join(outDir, 'v2-core.cjs');
var ddlOutFile = path.join(outDir, 'v2-ddl.cjs');
var bridgeOutFile = path.join(outDir, 'v2-format-bridge.cjs');
var workerOutFile = path.join(outDir, 'v2-worker.cjs');
var coreTempFile = coreOutFile + '.tmp';
var ddlTempFile = ddlOutFile + '.tmp';
var bridgeTempFile = bridgeOutFile + '.tmp';
var workerTempFile = workerOutFile + '.tmp';

function remove_files(files) {
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

try {
    fs.mkdirSync(outDir, { recursive: true });
    remove_files([
        coreOutFile,
        ddlOutFile,
        bridgeOutFile,
        workerOutFile,
        coreTempFile,
        ddlTempFile,
        bridgeTempFile,
        workerTempFile
    ]);

    esbuild.buildSync({
        entryPoints: [path.join(root, 'src', 'runtime', 'index.ts')],
        bundle: true,
        platform: 'node',
        format: 'cjs',
        target: 'node20',
        outfile: coreTempFile,
        sourcemap: false,
        minify: false,
        legalComments: 'none',
        logLevel: 'warning'
    });

    esbuild.buildSync({
        entryPoints: [path.join(root, 'src', 'runtime', 'experimental-ddl.ts')],
        bundle: true,
        platform: 'node',
        format: 'cjs',
        target: 'node20',
        outfile: ddlTempFile,
        sourcemap: false,
        minify: false,
        legalComments: 'none',
        logLevel: 'warning'
    });

    esbuild.buildSync({
        entryPoints: [path.join(root, 'src', 'adapters', 'runtime', 'v2-format-bridge.ts')],
        bundle: true,
        platform: 'node',
        format: 'cjs',
        target: 'node20',
        outfile: bridgeTempFile,
        sourcemap: false,
        minify: false,
        legalComments: 'none',
        logLevel: 'warning'
    });

    esbuild.buildSync({
        entryPoints: [path.join(root, 'src', 'adapters', 'executor', 'worker-entry.ts')],
        bundle: true,
        platform: 'node',
        format: 'cjs',
        target: 'node20',
        outfile: workerTempFile,
        sourcemap: false,
        minify: false,
        legalComments: 'none',
        logLevel: 'warning'
    });

    fs.renameSync(coreTempFile, coreOutFile);
    fs.renameSync(ddlTempFile, ddlOutFile);
    fs.renameSync(bridgeTempFile, bridgeOutFile);
    fs.renameSync(workerTempFile, workerOutFile);
} catch (error) {
    try {
        remove_files([coreOutFile, ddlOutFile, bridgeOutFile, workerOutFile]);
    } catch (cleanupError) {
        console.error(cleanupError);
    }
    throw error;
} finally {
    try {
        remove_files([coreTempFile, ddlTempFile, bridgeTempFile, workerTempFile]);
    } catch (cleanupError) {
        console.error(cleanupError);
    }
}

console.log('Built v2 runtime: ' + path.relative(root, coreOutFile));
console.log('Built v2 DDL runtime: ' + path.relative(root, ddlOutFile));
console.log('Built v2 bridge: ' + path.relative(root, bridgeOutFile));
console.log('Built v2 worker: ' + path.relative(root, workerOutFile));
