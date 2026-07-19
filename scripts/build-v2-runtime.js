#!/usr/bin/env node
'use strict';

var fs = require('fs');
var path = require('path');
var esbuild = require('esbuild');

var root = path.join(__dirname, '..');
var outDir = path.join(root, 'dist');
var coreOutFile = path.join(outDir, 'v2-core.cjs');
var bridgeOutFile = path.join(outDir, 'v2-format-bridge.cjs');
var coreTempFile = coreOutFile + '.tmp';
var bridgeTempFile = bridgeOutFile + '.tmp';

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
    remove_files([coreOutFile, bridgeOutFile, coreTempFile, bridgeTempFile]);

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

    fs.renameSync(coreTempFile, coreOutFile);
    fs.renameSync(bridgeTempFile, bridgeOutFile);
} catch (error) {
    try {
        remove_files([coreOutFile, bridgeOutFile]);
    } catch (cleanupError) {
        console.error(cleanupError);
    }
    throw error;
} finally {
    try {
        remove_files([coreTempFile, bridgeTempFile]);
    } catch (cleanupError) {
        console.error(cleanupError);
    }
}

console.log('Built v2 runtime: ' + path.relative(root, coreOutFile));
console.log('Built v2 bridge: ' + path.relative(root, bridgeOutFile));
