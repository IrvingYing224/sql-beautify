'use strict';

// Bundles src modules for unit tests with esbuild, the same way tests/golden/run.js does.
// `bundle({ name: 'core/api/format', ... })` returns the module namespaces keyed by name.

var path = require('path');

var root = path.join(__dirname, '..', '..', '..');

module.exports = function bundle(modules) {
    var names = Object.keys(modules);
    var outfile = path.join(root, '.tmp', 'tests', 'unit-' + names.join('-') + '.cjs');
    require('esbuild').buildSync({
        stdin: {
            contents: names.map(function(name) {
                return 'export * as ' + name + ' from "./' + modules[name] + '";';
            }).join('\n'),
            resolveDir: path.join(root, 'src'),
            loader: 'ts'
        },
        bundle: true,
        platform: 'node',
        format: 'cjs',
        target: 'node20',
        outfile: outfile,
        tsconfig: path.join(root, 'tsconfig.json'),
        logLevel: 'warning'
    });
    return require(outfile);
};
