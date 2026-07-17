'use strict';

var assert = require('assert');
var childProcess = require('child_process');
var fs = require('fs');
var path = require('path');

var root = path.join(__dirname, '..', '..');
var packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
var vscodeIgnore = fs.readFileSync(path.join(root, '.vscodeignore'), 'utf8');

function normalize(relativePath) {
    return relativePath.split(path.sep).join('/');
}

function collectFiles(relativeDirectory) {
    var absolute = path.join(root, relativeDirectory);
    if (!fs.existsSync(absolute)) {
        return [];
    }
    var output = [];
    fs.readdirSync(absolute, { withFileTypes: true }).forEach(function(entry) {
        var relative = path.join(relativeDirectory, entry.name);
        if (entry.isDirectory()) {
            output = output.concat(collectFiles(relative));
        } else {
            output.push(normalize(relative));
        }
    });
    return output.sort();
}

function moduleRequests(source) {
    var requests = [];
    [
        /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
        /\bfrom\s+['"]([^'"]+)['"]/g,
        /\bimport\s+['"]([^'"]+)['"]/g
    ].forEach(function(pattern) {
        var match;
        while ((match = pattern.exec(source)) !== null) {
            requests.push(match[1]);
        }
    });
    return requests;
}

function countBuildInvocations(scriptName, stack) {
    var script = packageJson.scripts[scriptName];
    assert.strictEqual(typeof script, 'string', 'missing npm script ' + scriptName);
    var active = stack || [];
    assert.strictEqual(active.indexOf(scriptName), -1,
        'npm script cycle at ' + active.concat(scriptName).join(' -> '));
    var count = (script.match(/npm run build:v2-core\b/g) || []).length;
    var nested = /npm run ([a-zA-Z0-9:_-]+)/g;
    var match;
    while ((match = nested.exec(script)) !== null) {
        if (match[1] !== 'build:v2-core') {
            count += countBuildInvocations(match[1], active.concat(scriptName));
        }
    }
    return count;
}

[
    'docs/superpowers/specs/2026-07-16-sql-formatter-v2-wave-3-layout-renderer-design.md',
    'docs/superpowers/plans/2026-07-16-sql-formatter-v2-wave-3-layout-renderer-plan.md',
    'src/core/analysis/artifact.ts',
    'src/core/config/resolve-options.ts',
    'src/core/dialects/capability-state.ts',
    'src/core/syntax/contextual-fact-contract.ts',
    'src/core/syntax/cst-contextual-invariants.ts',
    'src/core/syntax/cst-dialect-context.ts',
    'src/core/syntax/primitive-capability.ts',
    'src/core/layout/doc.ts',
    'src/core/layout/doc-factory.ts',
    'src/core/layout/artifact.ts',
    'src/core/layout/invariants.ts',
    'src/core/layout/resource-budget.ts',
    'src/core/layout/verbatim-claims.ts',
    'src/core/layout/plan.ts',
    'src/core/layout/compiler.ts',
    'src/core/layout/policy.ts',
    'src/core/source/source-map.ts',
    'src/core/renderer/unicode-width-data.ts',
    'src/core/renderer/display-width.ts',
    'src/core/renderer/keyword-case.ts',
    'src/core/renderer/metrics.ts',
    'src/core/renderer/render.ts',
    'src/core/renderer/types.ts',
    'src/core/api/format.ts',
    'scripts/generate-v2-unicode-width-data.js',
    'tests/v2/wave3a-analysis-artifact.test.js',
    'tests/v2/wave3a-config-options.test.js',
    'tests/v2/wave3a-contextual-facts.test.js',
    'tests/v2/wave3a-cst-invariants.test.js',
    'tests/v2/wave3a-layout-invariants.test.js',
    'tests/v2/wave3b-renderer.test.js',
    'tests/v2/wave3b-format-kernel.test.js',
    'tests/v2/wave3-performance.test.js',
    'tests/fixtures/v2-layout-cases.js'
].forEach(function(relativePath) {
    assert.ok(fs.existsSync(path.join(root, relativePath)),
        'Wave 3A requires ' + relativePath);
});

assert.ok(packageJson.scripts['test:v2:wave0']);
assert.ok(packageJson.scripts['test:v2:wave1']);
assert.ok(packageJson.scripts['test:v2:wave2']);
assert.ok(packageJson.scripts['test:v2:wave3-foundation']);
assert.ok(packageJson.scripts['test:v2:wave3']);
assert.strictEqual(countBuildInvocations('test:v2:wave3'), 1,
    'Wave 3 aggregate must build the v2 core exactly once');
[
    'wave3a-config-options.test.js',
    'wave3a-analysis-artifact.test.js',
    'wave3a-contextual-facts.test.js',
    'wave3a-cst-invariants.test.js',
    'wave3a-layout-resource-budget.test.js',
    'wave3a-layout-invariants.test.js',
    'wave3-boundary.test.js'
].forEach(function(required) {
    assert.ok(packageJson.scripts['test:v2:wave3-foundation'].indexOf(required) >= 0,
        'Wave 3 foundation must include ' + required);
});
[
    'wave3b-renderer.test.js',
    'wave3b-format-kernel.test.js',
    'wave3-performance.test.js',
    'dialect-capability-registry.test.js',
    'v2-support-matrix.test.js',
    'generate-v2-support-matrix.js --check'
].forEach(function(required) {
    assert.ok(packageJson.scripts['test:v2:wave3'].indexOf(required) >= 0,
        'Wave 3 aggregate must include ' + required);
});

var verify = packageJson.scripts['test:verify'];
['wave0', 'wave1', 'wave2', 'wave3'].forEach(function(wave) {
    var pattern = new RegExp('npm run test:v2:' + wave + '\\b', 'g');
    assert.strictEqual((verify.match(pattern) || []).length, 1,
        'test:verify must include ' + wave + ' exactly once');
});

var core = require('../../.tmp/v2-core/core/index.js');
assert.deepStrictEqual(Object.keys(core).sort(), ['lexSql'],
    'Wave 3 must not expose a root runtime formatting value API');

var forbiddenRequest = /^(?:vscode|dt-sql-parser|esbuild)(?:\/|$)/;
collectFiles('src/core/layout').filter(function(file) {
    return /\.ts$/.test(file);
}).forEach(function(relativePath) {
    var source = fs.readFileSync(path.join(root, relativePath), 'utf8');
    moduleRequests(source).forEach(function(request) {
        assert.ok(!forbiddenRequest.test(request),
            relativePath + ' must not import ' + request);
        assert.strictEqual(request.indexOf('lib/'), -1,
            relativePath + ' must not import current runtime lib code');
        assert.strictEqual(request.indexOf('adapters'), -1,
            relativePath + ' must not import adapters');
        assert.strictEqual(request.indexOf('experimental'), -1,
            relativePath + ' must not import experimental code');
        assert.strictEqual(request.indexOf('parser-evaluation'), -1,
            relativePath + ' must not import evaluation code');
    });
    assert.strictEqual(source.indexOf('.raw.toLowerCase()'), -1,
        relativePath + ' must not rediscover SQL grammar from raw words');
    assert.strictEqual(source.indexOf('normalizedWord('), -1,
        relativePath + ' must consume contextual facts rather than lexical lookup');
    assert.strictEqual(/\bleaf\.raw\b/.test(source), false,
        relativePath + ' must not scan protected or contextual leaf raw');
    assert.strictEqual(source.indexOf('analysis.source.slice('), -1,
        relativePath + ' must consume index line facts rather than rescan source ranges');
    assert.strictEqual(source.indexOf('/^[A-Za-z]+(?:_[A-Za-z]+)*$/'), -1,
        relativePath + ' must not rebuild keyword authority with a raw regex');
    moduleRequests(source).forEach(function(request) {
        assert.strictEqual(/syntax\/(?:.*-)?parser(?:$|\/)/.test(request), false,
            relativePath + ' must not import parser helpers: ' + request);
        assert.strictEqual(/dialects\/registry$/.test(request), false,
            relativePath + ' must not import dialect registry: ' + request);
    });
});

[
    'src/core/lexer',
    'src/core/dialects',
    'src/core/syntax',
    'src/core/analysis',
    'src/core/config',
    'src/core/source'
].forEach(function(relativeDirectory) {
    collectFiles(relativeDirectory).filter(function(file) {
        return /\.ts$/.test(file);
    }).forEach(function(relativePath) {
        var source = fs.readFileSync(path.join(root, relativePath), 'utf8');
        moduleRequests(source).forEach(function(request) {
            assert.strictEqual(
                /(?:^|\/)(?:layout|renderer)(?:\/|$)/.test(request),
                false,
                relativePath + ' must not depend on downstream ' + request
            );
        });
    });
});

var docSource = fs.readFileSync(path.join(root, 'src/core/layout/doc.ts'), 'utf8');
assert.strictEqual(/kind:\s*["']text["']/.test(docSource), false,
    'LayoutDoc must not contain arbitrary text nodes');
assert.strictEqual(/interface\s+VerbatimDoc[\s\S]*?readonly\s+span\s*:/.test(docSource), false,
    'verbatim docs must not accept naked source spans');
assert.ok(/ownerNodeId/.test(docSource) && /leafRange/.test(docSource) && /trigger/.test(docSource),
    'verbatim docs must retain owner, exact range and trigger identity');

var rendererFiles = collectFiles('src/core/renderer').filter(function(file) {
    return /\.ts$/.test(file);
});
rendererFiles.forEach(function(relativePath) {
    var source = fs.readFileSync(path.join(root, relativePath), 'utf8');
    assert.strictEqual(source.indexOf('Intl.Segmenter'), -1,
        relativePath + ' must not depend on host ICU grapheme segmentation');
    assert.strictEqual(/\\p\{/.test(source), false,
        relativePath + ' must not depend on host Unicode property escapes');
    moduleRequests(source).forEach(function(request) {
        assert.ok(request.indexOf('/syntax/') === -1 &&
            request.indexOf('/dialects/') === -1 &&
            request.indexOf('/api/') === -1 &&
            request.indexOf('registry') === -1,
        relativePath + ' renderer must stay SQL-agnostic: ' + request);
    });
});

var unicodeGenerator = fs.readFileSync(path.join(
    root,
    'scripts/generate-v2-unicode-width-data.js'
), 'utf8');
assert.ok(unicodeGenerator.indexOf("require('crypto')") >= 0);
assert.ok(unicodeGenerator.indexOf('SOURCE_MANIFEST') >= 0);
assert.ok(unicodeGenerator.indexOf("args[0] === '--check'") >= 0);
[
    'a7e52eee647e52dc210b8719b4d7037276f4b353810293d69377fc46374cec3f',
    'f55d0db69123431a7317868725b1fcbf1eab6b265d756d1bd7f0f6d9f9ee108b',
    'd7aef489c8fe4c14f09ea5695200277c6b93ac82ac60845cdd2161b0d6835cc1',
    'b08191401dc125f4e84ef262a95754faae6b737c79538e17ea9664a63434e94e'
].forEach(function(sha256) {
    assert.ok(unicodeGenerator.indexOf(sha256) >= 0,
        'Unicode generator must pin official source ' + sha256);
});

assert.ok(/src\/\*\*/.test(vscodeIgnore));
assert.ok(/tests\/\*\*/.test(vscodeIgnore));
assert.ok(/docs\/\*\*/.test(vscodeIgnore));
assert.ok(/\.tmp\/\*\*/.test(vscodeIgnore));

var localVsce = require.resolve('@vscode/vsce/vsce');
var packagedFiles = childProcess.execFileSync(process.execPath, [localVsce, 'ls'], {
    cwd: root,
    encoding: 'utf8'
}).split(/\r?\n/).filter(Boolean).map(function(file) {
    return file.replace(/\\/g, '/');
});
assert.ok(packagedFiles.indexOf('extension.js') >= 0);
assert.ok(packagedFiles.indexOf('vkbeautify.js') >= 0);
[
    /^src(?:\/|$)/,
    /^scripts(?:\/|$)/,
    /^tests(?:\/|$)/,
    /^docs(?:\/|$)/,
    /^\.tmp(?:\/|$)/,
    /^tsconfig\.v2(?:\..+)?\.json$/
].forEach(function(pattern) {
    assert.deepStrictEqual(packagedFiles.filter(function(file) {
        return pattern.test(file);
    }), []);
});

console.log('v2 Wave 3 boundary tests passed');
