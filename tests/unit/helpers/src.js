'use strict';

// Bundles src modules for unit tests with esbuild, the same way tests/golden/run.js does.
// `bundle({ name: 'core/api/format', ... })` returns the module namespaces keyed by name;
// `bundle.entry('edits/worker.ts', 'name.cjs')` bundles an entry point and returns its path.

var path = require('path');

var root = path.join(__dirname, '..', '..', '..');

function build(options) {
    require('esbuild').buildSync(Object.assign({
        bundle: true,
        platform: 'node',
        format: 'cjs',
        target: 'node20',
        tsconfig: path.join(root, 'tsconfig.json'),
        logLevel: 'warning'
    }, options));
    return options.outfile;
}

module.exports = function bundle(modules) {
    var names = Object.keys(modules);
    return require(build({
        stdin: {
            contents: names.map(function(name) {
                return 'export * as ' + name + ' from "./' + modules[name] + '";';
            }).join('\n'),
            resolveDir: path.join(root, 'src'),
            loader: 'ts'
        },
        outfile: path.join(root, '.tmp', 'tests', 'unit-' + names.join('-') + '.cjs')
    }));
};

module.exports.entry = function entry(source, name) {
    return build({
        entryPoints: [path.join(root, 'src', source)],
        outfile: path.join(root, '.tmp', 'tests', name)
    });
};
