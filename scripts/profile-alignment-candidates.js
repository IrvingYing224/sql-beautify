'use strict';

var assert = require('assert');
var fs = require('fs');
var path = require('path');

function argument(name) {
    var index = process.argv.indexOf(name);
    if (index < 0 || !process.argv[index + 1]) {
        throw new Error('Missing required argument ' + name);
    }
    return path.resolve(process.argv[index + 1]);
}

function loadCore(root) {
    function moduleAt(relativePath) {
        return require(path.join(root, 'core', relativePath));
    }
    return {
        analysis: moduleAt('analysis/index.js'),
        alignment: moduleAt('layout/alignment-policy.js'),
        compiler: moduleAt('layout/compiler.js'),
        format: moduleAt('api/format.js'),
        options: moduleAt('config/resolve-options.js'),
        policy: moduleAt('layout/policy.js'),
        renderer: moduleAt('renderer/render.js')
    };
}

function prepare(core, source, rawOptions) {
    var resolved = core.options.resolveFormatOptions(rawOptions);
    assert.strictEqual(resolved.ok, true);
    var analysis = core.analysis.analyzeSql(source, {
        dialect: resolved.options.dialect,
        mode: 'document'
    });
    if (analysis.status !== 'analyzed') {
        return { status: analysis.status, analysis: analysis };
    }
    var planned = core.policy.buildLayoutPlan(analysis, resolved.options);
    assert.strictEqual(planned.ok, true);
    var compiled = core.compiler.compileLayoutPlan(planned.plan);
    assert.strictEqual(compiled.ok, true);
    var rendered = core.renderer.renderLayoutArtifact(compiled.artifact);
    assert.strictEqual(rendered.ok, true);
    return {
        status: analysis.status,
        analysis: analysis,
        options: resolved.options,
        rendered: rendered
    };
}

function targets(core, prepared) {
    if (prepared.status !== 'analyzed') {
        return null;
    }
    var plan = core.alignment.deriveLayoutAlignmentPlan(
        prepared.analysis,
        prepared.options,
        prepared.rendered
    );
    assert.ok(plan);
    return plan.targets.map(function(target) {
        return [target.leafId, target.targetColumn];
    });
}

function appendFixtureCases(output, prefix, fixturePath, optionsOf) {
    require(fixturePath).forEach(function(value) {
        output.push({
            id: prefix + '/' + value.id,
            source: value.source,
            options: optionsOf(value)
        });
    });
}

function appendDeterministicFuzzCases(output, count) {
    var state = 0x3f202607;
    function next() {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return state;
    }
    function pick(values) {
        return values[next() % values.length];
    }
    var dialects = ['hive', 'generic', 'postgresql', 'mysql'];
    var whitespace = [' ', '  ', '\n', '\t'];
    for (var index = 0; index < count; index++) {
        var dialect = pick(dialects);
        var quoted = dialect === 'hive' || dialect === 'mysql'
            ? '`Mixed Name`'
            : '"Mixed Name"';
        var keyword = pick(['select', 'SELECT', 'SeLeCt']);
        var from = pick(['from', 'FROM', 'FrOm']);
        var source = keyword + pick(whitespace) +
            pick(['a+1', "'FROM  x'", quoted,
                'case when a=1 then 2 else 3 end']) +
            pick(whitespace) + 'as x,' + pick(whitespace) +
            '/* fuzz ' + index + ' */' + pick(whitespace) +
            pick(['b*2', 'coalesce(b,0)', ':value', 'not flag']) +
            pick(whitespace) + 'as y' + pick(whitespace) +
            from + pick(whitespace) + 't where a=1 and b>2';
        output.push({
            id: 'fuzz/' + index,
            source: source,
            options: {
                dialect: dialect,
                keywordCase: pick(['upper', 'lower']),
                commaStyle: pick(['leading', 'trailing']),
                indentStyle: pick(['space', 'tab']),
                caseLayout: pick(['expanded', 'compactShort']),
                caseWhenThenWrapLength: 20 + next() % 80,
                maxAlignWidth: 40 + next() % 120,
                unsupportedSyntaxPolicy: pick([
                    'warn',
                    'preserve',
                    'bail_out'
                ])
            }
        });
    }
}

function appendDeterministicMalformedCases(output, count) {
    var dialects = ['hive', 'generic', 'postgresql', 'mysql'];
    var categories = [
        'unterminated-string',
        'unterminated-block-comment',
        'unmatched-parentheses',
        'unterminated-quoted-identifier'
    ];
    for (var index = 0; index < count; index++) {
        var dialect = dialects[index % dialects.length];
        var category = categories[
            Math.floor(index / dialects.length) % categories.length
        ];
        var source;
        if (category === 'unterminated-string') {
            source = "SELECT 'unterminated " + index;
        } else if (category === 'unterminated-block-comment') {
            source = 'SELECT /* unterminated ' + index;
        } else if (category === 'unmatched-parentheses') {
            source = 'SELECT ' + '('.repeat(1 + index % 24) + 'x';
        } else {
            source = dialect === 'hive' || dialect === 'mysql'
                ? 'SELECT `unterminated ' + index
                : 'SELECT "unterminated ' + index;
        }
        output.push({
            id: 'malformed/' + index,
            source: source,
            options: { dialect: dialect }
        });
    }
}

function comparisonCases(repositoryRoot) {
    var output = [];
    var fixtureRoot = path.join(repositoryRoot, 'tests', 'fixtures');
    appendFixtureCases(
        output,
        'layout',
        path.join(fixtureRoot, 'v2-layout-cases.js'),
        function(value) { return value.options; }
    );
    appendFixtureCases(
        output,
        'query',
        path.join(fixtureRoot, 'v2-wave3c-hive-query-cases.js'),
        function(value) { return value.options; }
    );
    appendFixtureCases(
        output,
        'expression',
        path.join(fixtureRoot, 'v2-wave3d-expression-cases.js'),
        function(value) { return value.options; }
    );
    appendFixtureCases(
        output,
        'parser',
        path.join(fixtureRoot, 'v2-sql-corpus-cases.js'),
        function(value) { return { dialect: value.dialect }; }
    );
    appendFixtureCases(
        output,
        'closure',
        path.join(fixtureRoot, 'v2-wave3-corpus-cases.js'),
        function(value) { return value.options; }
    );

    var publicRoot = path.join(fixtureRoot, 'production-corpus', 'public');
    fs.readdirSync(publicRoot).filter(function(fileName) {
        return fileName.endsWith('.sql');
    }).sort().forEach(function(fileName) {
        var baseName = fileName.slice(0, -4);
        var optionsPath = path.join(publicRoot, baseName + '.options.json');
        output.push({
            id: 'production/' + baseName,
            source: fs.readFileSync(path.join(publicRoot, fileName), 'utf8'),
            options: fs.existsSync(optionsPath)
                ? JSON.parse(fs.readFileSync(optionsPath, 'utf8'))
                : { dialect: 'hive' }
        });
    });

    var alignmentSource = [
        'select a as x -- one',
        ', longer_name as y -- two',
        ', case when c=1 then 1 else 2 end as z',
        ', d as q from t'
    ].join('\n');
    ['leading', 'trailing'].forEach(function(commaStyle) {
        ['space', 'tab'].forEach(function(indentStyle) {
            [16, 80, 150].forEach(function(maxAlignWidth) {
                output.push({
                    id: 'alignment-matrix/' + [
                        commaStyle,
                        indentStyle,
                        maxAlignWidth
                    ].join('-'),
                    source: alignmentSource,
                    options: {
                        dialect: 'hive',
                        commaStyle: commaStyle,
                        indentStyle: indentStyle,
                        maxAlignWidth: maxAlignWidth
                    }
                });
            });
        });
    });
    appendDeterministicFuzzCases(output, 128);
    appendDeterministicMalformedCases(output, 48);
    return output;
}

function compareCores(repositoryRoot, baseline, candidate) {
    var cases = comparisonCases(repositoryRoot);
    var targetBearingCases = 0;
    var targetCount = 0;
    cases.forEach(function(testCase) {
        var leftPrepared = prepare(
            baseline,
            testCase.source,
            testCase.options
        );
        var rightPrepared = prepare(
            candidate,
            testCase.source,
            testCase.options
        );
        var leftTargets = targets(baseline, leftPrepared);
        var rightTargets = targets(candidate, rightPrepared);
        assert.deepStrictEqual(
            rightTargets,
            leftTargets,
            testCase.id + ' alignment targets'
        );
        var leftResult = baseline.format.formatSql(
            testCase.source,
            testCase.options
        );
        var rightResult = candidate.format.formatSql(
            testCase.source,
            testCase.options
        );
        assert.deepStrictEqual(
            rightResult,
            leftResult,
            testCase.id + ' complete format result'
        );
        if (leftTargets !== null && leftTargets.length > 0) {
            targetBearingCases += 1;
            targetCount += leftTargets.length;
        }
    });
    return {
        caseCount: cases.length,
        targetBearingCases: targetBearingCases,
        targetCount: targetCount
    };
}

function sparseTrueSource(count) {
    var items = ['a as x', 'long_column_name as y'];
    for (var index = 2; index < count; index++) {
        items.push('column_' + index);
    }
    return 'select ' + items.join(', ') + ' from t';
}

function sparseFalsePositiveSource(count) {
    var items = [
        'case when a=1 then 1 else 2 end as x',
        'case when b=1 then 1 else 2 end as y'
    ];
    for (var index = 2; index < count; index++) {
        items.push('column_' + index);
    }
    return 'select ' + items.join(', ') + ' from t';
}

function denseTrueSource(count) {
    var items = [];
    for (var index = 0; index < count; index++) {
        items.push('column_' + index + ' as alias_' + (index % 31));
    }
    return 'select ' + items.join(', ') + ' from t';
}

function median(values) {
    var sorted = values.slice().sort(function(left, right) {
        return left - right;
    });
    return sorted[Math.floor(sorted.length / 2)];
}

function measure(core, prepared) {
    var iterations = 20;
    var samples = [];
    for (var warmup = 0; warmup < 25; warmup++) {
        targets(core, prepared);
    }
    for (var sample = 0; sample < 15; sample++) {
        var started = process.hrtime.bigint();
        for (var iteration = 0; iteration < iterations; iteration++) {
            targets(core, prepared);
        }
        samples.push(
            Number(process.hrtime.bigint() - started) / 1e6 / iterations
        );
    }
    var derivedTargets = targets(core, prepared);
    return {
        medianMs: median(samples),
        samplesMs: samples,
        targetCount: derivedTargets === null ? null : derivedTargets.length
    };
}

function profile(baseline, candidate) {
    var options = {
        dialect: 'hive',
        commaStyle: 'leading',
        maxAlignWidth: 150,
        keywordCase: 'upper'
    };
    var sources = {
        sparseFalsePositive: sparseFalsePositiveSource(2000),
        sparseTrueTarget: sparseTrueSource(2000),
        denseTrueTarget: denseTrueSource(2000)
    };
    var report = {};
    Object.keys(sources).forEach(function(kind) {
        var source = sources[kind];
        var baselinePrepared = prepare(baseline, source, options);
        var candidatePrepared = prepare(candidate, source, options);
        assert.deepStrictEqual(
            targets(candidate, candidatePrepared),
            targets(baseline, baselinePrepared),
            kind + ' benchmark targets'
        );
        var baselineResult = measure(baseline, baselinePrepared);
        var candidateResult = measure(candidate, candidatePrepared);
        report[kind] = {
            sourceCodeUnits: source.length,
            leafCount: candidatePrepared.analysis.leaves.length,
            baseline: baselineResult,
            candidate: candidateResult,
            candidateToBaselineRatio:
                candidateResult.medianMs / baselineResult.medianMs
        };
    });
    return report;
}

var repositoryRoot = path.resolve(__dirname, '..');
var baselineRoot = argument('--baseline-root');
var candidateRoot = argument('--candidate-root');
var baseline = loadCore(baselineRoot);
var candidate = loadCore(candidateRoot);
var report = {
    equivalence: compareCores(repositoryRoot, baseline, candidate),
    performance: profile(baseline, candidate),
    environment: {
        node: process.version,
        platform: process.platform,
        arch: process.arch
    }
};
process.stdout.write(JSON.stringify(report, null, 2) + '\n');
