'use strict';

// Bundles src modules for unit tests with esbuild, the same way tests/golden/run.js does.
// `bundle({ name: 'core/api/format', ... })` returns the module namespaces keyed by name;
// `bundle.file(...)` only writes that bundle and returns its path;
// `bundle.entry('edits/worker.ts', 'name.cjs')` bundles an entry point and returns its path;
// `bundle.options(options)` adds the defaults, for an async esbuild build with plugins.

var path = require('path');

var root = path.join(__dirname, '..', '..', '..');

function options(values) {
    return Object.assign({
        bundle: true,
        platform: 'node',
        format: 'cjs',
        target: 'node20',
        tsconfig: path.join(root, 'tsconfig.json'),
        logLevel: 'warning'
    }, values);
}

function build(values) {
    require('esbuild').buildSync(options(values));
    return values.outfile;
}

function file(modules) {
    var names = Object.keys(modules);
    return build({
        stdin: {
            contents: names.map(function(name) {
                return 'export * as ' + name + ' from "./' + modules[name] + '";';
            }).join('\n'),
            resolveDir: path.join(root, 'src'),
            loader: 'ts'
        },
        outfile: path.join(root, '.tmp', 'tests', 'unit-' + names.join('-') + '.cjs')
    });
}

module.exports = function bundle(modules) {
    return require(file(modules));
};

module.exports.options = options;
module.exports.file = file;

module.exports.entry = function entry(source, name) {
    return build({
        entryPoints: [path.join(root, 'src', source)],
        outfile: path.join(root, '.tmp', 'tests', name)
    });
};
