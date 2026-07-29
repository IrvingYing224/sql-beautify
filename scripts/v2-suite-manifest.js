#!/usr/bin/env node
'use strict';

function nodeStep(relativePath, args, environment) {
    return Object.freeze({
        id: [relativePath].concat(args || []).join(' '),
        command: process.execPath,
        args: Object.freeze([relativePath].concat(args || [])),
        environment: Object.freeze(environment || {})
    });
}

function tests(names) {
    return names.map(function(name) {
        return nodeStep('tests/v2/' + name + '.test.js');
    });
}

var wave1 = tests([
    'sql-corpus-contract',
    'lossless-lexer',
    'lossless-lexer-performance'
]);

var wave2Foundation = [
    nodeStep('scripts/check-syntax-node-registry.js')
].concat(tests([
    'dialect-capability-registry',
    'syntax-token-table',
    'syntax-invariants',
    'wave2a-hardening',
    'wave2a-cst-hardening',
    'wave2a-token-table-hardening',
    'syntax-invariants-performance'
]));

var wave2 = wave2Foundation.concat(tests([
    'hive-cst-parser',
    'hive-statement-commands',
    'wave2b-final-hardening',
    'expression-parser',
    'recovery-opaque',
    'parser-depth',
    'trivia-binding',
    'recovery-fuzz',
    'analysis-index',
    'v2-support-matrix'
]), [
    nodeStep('scripts/generate-v2-support-matrix.js', ['--check'])
], tests([
    'wave2-corpus',
    'wave2-performance'
]));

var wave3Foundation = tests([
    'wave3a-config-options',
    'wave3a-analysis-artifact',
    'wave3a-contextual-facts',
    'wave3a-cst-invariants',
    'wave3a-layout-resource-budget',
    'wave3a-layout-invariants'
]);

var wave3 = wave3Foundation.concat(tests([
    'wave3b-renderer',
    'display-width-performance',
    'wave3b-format-kernel',
    'wave3c-plan-scopes',
    'wave3c-hive-query-layout',
    'wave3c-resource-closure',
    'wave3d-expression-layout',
    'wave3d-resource-closure',
    'wave3e-trivia-layout',
    'wave3e-alignment-options',
    'wave3e-dialect-layout',
    'wave3e-option-matrix',
    'wave3-properties',
    'perf-baseline-contract',
    'wave3-alignment-performance',
    'wave3-performance',
    'wave3-performance-relative'
]), [
    nodeStep('scripts/profile-source-map-memory.js', ['--summary'])
], tests([
    'dialect-capability-registry',
    'v2-support-matrix'
]), [
    nodeStep('scripts/generate-v2-support-matrix.js', ['--check'])
]);

var wave4 = tests([
    'v2-runtime-boundary',
    'wave4a-public-api',
    'wave4a-source-map',
    'source-map-performance',
    'wave4a-transaction',
    'wave4b-range-transaction',
    'wave4b-cancellation-diagnostics',
    'wave4b-multiselection',
    'wave4b-cursor',
    'wave4b-language-registry',
    'wave4c-executor',
    'wave4c-worker-lifecycle',
    'wave4c-performance',
    'wave4d-ddl',
    'wave4d-extract-ddl',
    'wave4d-transaction',
    'wave4d-performance',
    'wave4-properties',
    'wave4-performance'
]);

var wave5StageA = tests([
    'build-suite-infrastructure',
    'wave4a-transaction',
    'wave4d-transaction',
    'wave5-runtime-artifact',
    'wave5-vscode-adapter'
]);

var SUITES = Object.freeze({
    lexer: Object.freeze({ needs: ['core'], steps: tests(['lossless-lexer']) }),
    'lexer-performance': Object.freeze({
        needs: ['core'],
        steps: tests(['lossless-lexer-performance'])
    }),
    wave1: Object.freeze({ needs: ['core'], steps: wave1 }),
    'wave2-foundation': Object.freeze({ needs: ['core'], steps: wave2Foundation }),
    'hive-cst': Object.freeze({
        needs: ['core'],
        steps: tests(['hive-cst-parser', 'hive-statement-commands'])
    }),
    'wave2-corpus': Object.freeze({ needs: ['core'], steps: tests(['wave2-corpus']) }),
    'wave2-performance': Object.freeze({
        needs: ['core'],
        steps: tests(['wave2-performance'])
    }),
    expression: Object.freeze({ needs: ['core'], steps: tests(['expression-parser']) }),
    recovery: Object.freeze({
        needs: ['core'],
        steps: tests(['recovery-opaque', 'parser-depth', 'recovery-fuzz'])
    }),
    trivia: Object.freeze({ needs: ['core'], steps: tests(['trivia-binding']) }),
    analysis: Object.freeze({ needs: ['core'], steps: tests(['analysis-index']) }),
    'support-matrix': Object.freeze({
        needs: ['core'],
        steps: tests(['v2-support-matrix']).concat([
            nodeStep('scripts/generate-v2-support-matrix.js', ['--check'])
        ])
    }),
    wave2: Object.freeze({ needs: ['core'], steps: wave2 }),
    'wave3-foundation': Object.freeze({
        needs: ['typecheck', 'core'],
        steps: wave3Foundation
    }),
    'source-map-memory': Object.freeze({
        needs: ['core'],
        steps: [nodeStep('scripts/profile-source-map-memory.js', ['--summary'])]
    }),
    wave3: Object.freeze({ needs: ['typecheck', 'core'], steps: wave3 }),
    wave4: Object.freeze({ needs: ['core', 'runtime'], steps: wave4 }),
    'wave5-stage-a': Object.freeze({
        needs: ['typecheck', 'core', 'runtime'],
        steps: wave5StageA
    }),
    corpus: Object.freeze({ needs: ['core'], steps: tests(['sql-corpus-contract']) }),
    'wave5-stage-b': Object.freeze({
        needs: ['typecheck', 'core', 'runtime'],
        steps: wave5StageA.concat(tests([
            'wave5-production-corpus',
            'wave5-cutover-boundary'
        ]))
    }),
    wave5: Object.freeze({
        needs: ['typecheck', 'core', 'runtime'],
        steps: wave5StageA.concat(tests([
            'wave5-production-corpus',
            'wave5-cutover-boundary',
            'wave5-release-boundary'
        ]), [nodeStep('scripts/verify-clean-package.js')])
    }),
    verify: Object.freeze({
        includes: ['wave1', 'wave2', 'wave3', 'wave4', 'wave5']
    }),
    'performance-relative': Object.freeze({
        needs: ['core'],
        steps: [
            nodeStep('tests/v2/wave2-performance.test.js', [], {
                SQL_BEAUTIFY_STRICT_RELATIVE_PERF: '1'
            }),
            nodeStep('tests/v2/wave3-performance-relative.test.js', [], {
                SQL_BEAUTIFY_STRICT_RELATIVE_PERF: '1'
            })
        ]
    }),
    'node-smoke': Object.freeze({
        needs: ['typecheck', 'core', 'runtime'],
        steps: tests([
            'lossless-lexer',
            'wave4a-public-api',
            'wave5-runtime-artifact'
        ])
    }),
    infrastructure: Object.freeze({
        needs: ['core', 'runtime'],
        steps: tests(['build-suite-infrastructure'])
    }),
    'production-private': Object.freeze({
        needs: ['runtime'],
        steps: tests(['wave5-production-private'])
    })
});

var PREREQUISITES = Object.freeze({
    typecheck: nodeStep(require.resolve('typescript/bin/tsc'), [
        '-p', 'tsconfig.v2.json'
    ]),
    core: nodeStep('scripts/build-v2-core.js'),
    runtime: nodeStep('scripts/build-v2-runtime.js')
});

function unique(values) {
    return values.filter(function(value, index) {
        return values.indexOf(value) === index;
    });
}

function resolveSuite(name, active) {
    var suite = SUITES[name];
    if (suite === undefined) {
        throw new Error('Unknown v2 suite: ' + name);
    }
    var stack = active || [];
    if (stack.indexOf(name) >= 0) {
        throw new Error('Cyclic v2 suite include: ' + stack.concat([name]).join(' -> '));
    }
    var needs = [];
    var steps = [];
    (suite.includes || []).forEach(function(included) {
        var resolved = resolveSuite(included, stack.concat([name]));
        needs = needs.concat(resolved.needs);
        steps = steps.concat(resolved.steps);
    });
    needs = needs.concat(suite.needs || []);
    steps = steps.concat(suite.steps || []);
    var seen = new Set();
    return Object.freeze({
        name: name,
        needs: Object.freeze(unique(needs)),
        steps: Object.freeze(steps.filter(function(step) {
            if (seen.has(step.id)) {
                return false;
            }
            seen.add(step.id);
            return true;
        }))
    });
}

function buildPlan(name) {
    var resolved = resolveSuite(name);
    var prerequisiteOrder = ['typecheck', 'core', 'runtime'];
    var steps = prerequisiteOrder.filter(function(key) {
        return resolved.needs.indexOf(key) >= 0;
    }).map(function(key) {
        return Object.freeze({ ...PREREQUISITES[key], category: key });
    }).concat(resolved.steps.map(function(step) {
        return Object.freeze({ ...step, category: 'test' });
    }));
    return Object.freeze({ name: name, steps: Object.freeze(steps) });
}

module.exports = Object.freeze({
    buildPlan: buildPlan,
    suiteNames: Object.freeze(Object.keys(SUITES).sort())
});
