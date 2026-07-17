'use strict';

var assert = require('assert');
var fs = require('fs');
var path = require('path');

var root = path.join(__dirname, '..', '..');
var corePath = path.join(root, '.tmp', 'v2-core', 'core', 'index.js');
var dialectsPath = path.join(root, '.tmp', 'v2-core', 'core', 'dialects', 'index.js');
var lexicalProfilePath = path.join(root, '.tmp', 'v2-core', 'core', 'lexer', 'lexical-profile.js');

assert.ok(fs.existsSync(corePath), 'build:v2-core must produce root runtime before registry tests');
assert.ok(fs.existsSync(dialectsPath), 'dialects module must exist after build');

var core = require(corePath);
var dialects = require(dialectsPath);
var lexicalProfile = require(lexicalProfilePath);

var CANONICAL = ['generic', 'hive', 'mysql', 'postgresql'];
var CAPABILITY_STATES = {
    recognized: true,
    structured: true,
    formatted: true,
    verbatim: true,
    diagnostic: true
};

var HIVE_STRUCTURED_QUERY_CONSTRUCTS = [
    'multi-statement',
    'with-cte',
    'from',
    'join',
    'subquery',
    'table-function',
    'lateral-view',
    'where',
    'group-by',
    'having',
    'window',
    'order-by',
    'cluster-by',
    'distribute-by',
    'sort-by',
    'limit',
    'set-operations',
    'insert-overwrite-partition-select'
];

var HIVE_STRUCTURED_EXPRESSION_CONSTRUCTS = [
    'case-expression',
    'function-call',
    'collection-expression',
    'cast-type',
    'subquery-expression',
    'window-expression',
    'template-parameter'
];

var HIVE_PRESERVATION_CAPABILITIES = {
    'hive-ddl': 'verbatim',
    'merge': 'diagnostic',
    'match-recognize': 'diagnostic',
    'pivot': 'diagnostic',
    'qualify': 'diagnostic',
    'unpivot': 'diagnostic'
};
var formattedPairs = [];

/**
 * Real frozen arrays may still expose push/splice as functions that throw.
 * Contract: runtime is a real Array, frozen, and mutations do not change content.
 */
function assertImmutableArray(value, label) {
    assert.ok(Array.isArray(value), label + ' must be a real Array');
    assert.strictEqual(Object.isFrozen(value), true, label + ' must be frozen');
    var before = value.length;
    try {
        value.push({ forged: true });
    } catch (_err) { /* ok */ }
    assert.strictEqual(value.length, before, label + ' must not grow after push');
    if (value.length > 0) {
        value.forEach(function(_v, _i, arr) {
            var len = arr.length;
            try {
                arr.push('x');
            } catch (_e) { /* ok */ }
            try {
                arr.length = 0;
            } catch (_e2) { /* ok */ }
            assert.strictEqual(arr.length, len, label + ' callback array immutable');
            assert.strictEqual(Object.isFrozen(arr), true);
        });
    }
}

function collectModuleRequests(source) {
    var requests = [];
    var patterns = [
        /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
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

function collectDialectSources() {
    var dir = path.join(root, 'src', 'core', 'dialects');
    return fs.readdirSync(dir).filter(function(name) {
        return /\.ts$/.test(name);
    }).map(function(name) {
        return path.join(dir, name);
    });
}

// ---------------------------------------------------------------------------
// Root runtime must not leak registry API
// ---------------------------------------------------------------------------
assert.deepStrictEqual(
    Object.keys(core).sort(),
    ['lexSql'],
    'src/core/index runtime keys must remain only lexSql'
);
assert.strictEqual(typeof core.getDialectCapabilityRegistry, 'undefined');
assert.strictEqual(typeof core.getDialect, 'undefined');
assert.strictEqual(typeof core.listDialects, 'undefined');

// ---------------------------------------------------------------------------
// Public registry API
// ---------------------------------------------------------------------------
assert.strictEqual(typeof dialects.getDialectCapabilityRegistry, 'function');
assert.strictEqual(typeof dialects.listDialects, 'function');
assert.strictEqual(typeof dialects.getDialect, 'function');
assert.strictEqual(typeof dialects.isRecognizedCapabilityState, 'function');
assert.strictEqual(typeof dialects.isParserStructuredCapabilityState, 'function');

[
    ['recognized', true, false],
    ['structured', true, true],
    ['formatted', true, true],
    ['verbatim', false, false],
    ['diagnostic', false, false],
    [null, false, false],
    [undefined, false, false]
].forEach(function(row) {
    assert.strictEqual(
        dialects.isRecognizedCapabilityState(row[0]),
        row[1],
        String(row[0]) + ' recognized-state classification'
    );
    assert.strictEqual(
        dialects.isParserStructuredCapabilityState(row[0]),
        row[2],
        String(row[0]) + ' parser-structured classification'
    );
});

var registry = dialects.getDialectCapabilityRegistry();
assert.ok(registry, 'registry must be returned');

var listed = dialects.listDialects();
assert.deepStrictEqual(listed.slice().sort(), CANONICAL);
assertImmutableArray(listed, 'listDialects result');
assert.strictEqual(dialects.listDialects(), listed, 'listDialects cached snapshot');

// Case-sensitive exact match only; no postgres alias
assert.throws(
    function() {
        dialects.getDialect('postgres');
    },
    function(error) {
        return error instanceof Error && /Unsupported dialect "postgres"/.test(error.message);
    },
    'postgres alias must be rejected'
);
assert.throws(
    function() {
        dialects.getDialect('HIVE');
    },
    function(error) {
        return error instanceof Error && /Unsupported dialect "HIVE"/.test(error.message);
    },
    'uppercase dialect must be rejected (case-sensitive exact match)'
);
assert.throws(
    function() {
        dialects.getDialect('oracle');
    },
    function(error) {
        return (
            error instanceof Error &&
            /Unsupported dialect "oracle"/.test(error.message) &&
            /hive, generic, postgresql, mysql/.test(error.message)
        );
    },
    'unknown dialect must reject without falling back to generic'
);

CANONICAL.forEach(function(dialectId) {
    var view = dialects.getDialect(dialectId);
    assert.strictEqual(view.id, dialectId);

    var caps = view.listCapabilities();
    assertImmutableArray(caps, 'capabilities for ' + dialectId);
    assert.strictEqual(view.listCapabilities(), caps, 'capabilities cached for ' + dialectId);

    caps.forEach(function(entry) {
        assert.ok(typeof entry.id === 'string' && entry.id.length > 0, 'capability id required');
        assert.ok(/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry.id), 'capability id must be kebab-case: ' + entry.id);
        assert.ok(CAPABILITY_STATES[entry.state], 'unknown capability state: ' + entry.state);
        if (entry.state === 'formatted') {
            formattedPairs.push(dialectId + '/' + entry.id);
        }
    });

    // Operator semantics: multi-fixity; symbol keys in lexical view
    var operators = view.listOperatorSemantics();
    assertImmutableArray(operators, 'operator semantics for ' + dialectId);
    var lexical = lexicalProfile.getLexicalProfile(dialectId);
    var lexicalOps = {};
    lexical.operators.forEach(function(op) {
        lexicalOps[op] = true;
    });
    operators.forEach(function(op) {
        assert.ok(typeof op.id === 'string' && op.id.length > 0,
            'stable operator id required');
        assert.ok(typeof op.key === 'string' && op.key.length > 0, 'operator key required');
        assert.ok(
            op.fixity === 'prefix' || op.fixity === 'infix' || op.fixity === 'postfix',
            'fixity required for ' + op.key
        );
        assert.ok(
            op.form === 'symbol' || op.form === 'keyword' || op.form === 'compound' || op.form === 'special',
            'form required for ' + op.key
        );
        assert.ok(
            /^(?:prefix|infix|postfix)-(?:word|symbol)$/.test(op.formatClass) ||
                op.formatClass === 'attached',
            'format class required for ' + op.id
        );
        assert.ok(op.capabilityId === null || view.getCapability(op.capabilityId),
            'operator capability must exist when present: ' + dialectId + '/' + op.id);
        if (op.form === 'symbol') {
            assert.ok(
                lexicalOps[op.key],
                'symbol operator key must exist in lexical operator view: ' + dialectId + ' ' + op.key
            );
        }
        // Lookup by key+fixity
        var looked = view.getOperatorSemantics(op.key, op.fixity);
        assert.ok(looked, 'getOperatorSemantics(' + op.key + ',' + op.fixity + ')');
        assert.strictEqual(looked.fixity, op.fixity);
    });

    var clauses = view.listQueryClauseSyntax();
    var clauseIds = Object.create(null);
    var lastOrder = -1;
    assertImmutableArray(clauses, 'query clause syntax for ' + dialectId);
    assert.strictEqual(view.listQueryClauseSyntax(), clauses);
    clauses.forEach(function(clause) {
        assert.ok(Object.isFrozen(clause), 'clause entry frozen: ' + dialectId + '/' + clause.id);
        assertImmutableArray(clause.words, 'clause words for ' + dialectId + '/' + clause.id);
        assert.ok(!clauseIds[clause.id], 'duplicate clause id: ' + dialectId + '/' + clause.id);
        clauseIds[clause.id] = true;
        assert.ok(clause.order > lastOrder, 'clause order must be strictly increasing: ' + dialectId);
        lastOrder = clause.order;
        if (clause.id === 'select') {
            assert.strictEqual(clause.capabilityId, null,
                'SELECT clause is intrinsic; query node owns no-FROM/FROM authority');
        } else {
            assert.ok(view.getCapability(clause.capabilityId),
                'clause capability must exist: ' + dialectId + '/' + clause.capabilityId);
        }
    });

    var setOperators = view.listSetOperatorSyntax();
    var setIds = Object.create(null);
    assertImmutableArray(setOperators, 'set operator syntax for ' + dialectId);
    assert.strictEqual(view.listSetOperatorSyntax(), setOperators);
    setOperators.forEach(function(operator) {
        assert.ok(Object.isFrozen(operator),
            'set operator entry frozen: ' + dialectId + '/' + operator.id);
        assert.ok(!setIds[operator.id], 'duplicate set operator id: ' + dialectId + '/' + operator.id);
        setIds[operator.id] = true;
        assert.ok(view.getCapability(operator.capabilityId),
            'set operator capability must exist: ' + dialectId + '/' + operator.capabilityId);
    });

    var joins = view.listJoinSyntax();
    var joinIds = Object.create(null);
    assertImmutableArray(joins, 'join syntax for ' + dialectId);
    assert.strictEqual(view.listJoinSyntax(), joins);
    joins.forEach(function(join) {
        assert.ok(Object.isFrozen(join), 'join entry frozen: ' + dialectId + '/' + join.id);
        assertImmutableArray(join.words, 'join words for ' + dialectId + '/' + join.id);
        assert.ok(!joinIds[join.id], 'duplicate join id: ' + dialectId + '/' + join.id);
        joinIds[join.id] = true;
        assert.strictEqual(join.words[join.words.length - 1], 'join');
        assert.ok(view.getCapability(join.capabilityId));
    });

    var unsupported = view.listUnsupportedSyntax();
    assertImmutableArray(unsupported, 'unsupported syntax for ' + dialectId);
    assert.strictEqual(view.listUnsupportedSyntax(), unsupported);
    unsupported.forEach(function(signature) {
        assert.ok(Object.isFrozen(signature), 'unsupported signature frozen');
        assertImmutableArray(signature.words, 'unsupported signature words');
        assert.ok(['statement-start', 'query-clause', 'relation-suffix']
            .indexOf(signature.context) >= 0);
        var capability = view.getCapability(signature.capabilityId);
        assert.ok(capability, 'unsupported signature capability must exist');
        assert.ok(capability.state === 'verbatim' || capability.state === 'diagnostic');
        assert.strictEqual(
            signature.context === 'query-clause',
            Number.isInteger(signature.order),
            'only query-clause signatures own an order slot'
        );
        if (signature.context === 'relation-suffix') {
            assertImmutableArray(signature.bodyEvidence, 'relation body evidence');
            assert.ok(signature.bodyEvidence.length > 0);
            signature.bodyEvidence.forEach(function(sequence) {
                assertImmutableArray(sequence, 'relation body evidence sequence');
                assert.ok(sequence.length > 0);
            });
        } else {
            assert.strictEqual(signature.bodyEvidence, null);
        }
    });
});

assert.deepStrictEqual(
    formattedPairs.sort(),
    ['hive/select-without-from'],
    'Wave 3B must expose exactly one proven formatted capability'
);

assert.ok(dialects.getDialect('hive').listJoinSyntax().some(function(join) {
    return join.id === 'left-anti-join' && join.words.join(' ') === 'left anti join';
}), 'Hive registry must own LEFT ANTI JOIN syntax');

// Wave 2C structures Hive statement/query/clause and expression boundaries.
var hive = dialects.getDialect('hive');
assert.strictEqual(
    hive.getCapability('select-without-from').state,
    'formatted',
    'Hive no-FROM SELECT must transition only after Wave 3B behavior evidence'
);
HIVE_STRUCTURED_QUERY_CONSTRUCTS.forEach(function(id) {
    var entry = hive.getCapability(id);
    assert.ok(entry, 'Hive must declare capability ' + id);
    assert.strictEqual(
        entry.state,
        'structured',
        'Hive ' + id + ' must be structured in Wave 2B'
    );
});

HIVE_STRUCTURED_EXPRESSION_CONSTRUCTS.forEach(function(id) {
    var entry = hive.getCapability(id);
    assert.ok(entry, 'Hive must declare expression capability ' + id);
    assert.strictEqual(
        entry.state,
        'structured',
        'Hive expression ' + id + ' must be structured in Wave 2C'
    );
});

Object.keys(HIVE_PRESERVATION_CAPABILITIES).forEach(function(id) {
    var entry = hive.getCapability(id);
    assert.ok(entry, 'Hive must declare capability ' + id);
    assert.strictEqual(
        entry.state,
        HIVE_PRESERVATION_CAPABILITIES[id],
        'Hive ' + id + ' capability must match its current recovery boundary'
    );
});

// Keyword-shaped function/identifier must not auto-become construct via registry alone.
assert.strictEqual(typeof hive.isKeywordConstruct, 'undefined');
assert.strictEqual(typeof hive.classifyToken, 'undefined');

// Multi-fixity for + / -
assert.ok(hive.getOperatorSemantics('+', 'prefix'));
assert.ok(hive.getOperatorSemantics('+', 'infix'));
assert.ok(hive.getOperatorSemantics('-', 'prefix'));
assert.ok(hive.getOperatorSemantics('-', 'infix'));
var plusEntries = hive.listOperatorSemanticsForKey('+');
assert.ok(plusEntries.length >= 2, '+ must have multiple fixity entries');

// Shared operator keys known in 2A
var sharedKeys = ['+', '-', '*', '/', '%', '=', '<', '>', '<=', '>=', '<>', '!=', '||', '&&'];
sharedKeys.forEach(function(key) {
    var entries = hive.listOperatorSemanticsForKey(key);
    assert.ok(entries.length >= 1, 'Hive must declare operator semantics for ' + key);
});

// Isolation: dialects sources must not import lib or parser evaluation
collectDialectSources().forEach(function(filePath) {
    var source = fs.readFileSync(filePath, 'utf8');
    collectModuleRequests(source).forEach(function(request) {
        assert.ok(
            !/^(?:lib|dt-sql-parser|vscode)(?:\/|$)/.test(request),
            path.basename(filePath) + ' must not import ' + request
        );
        assert.ok(
            request.indexOf('lib/') !== 0 &&
                request.indexOf('/lib/') === -1 &&
                request.indexOf('adapters') === -1 &&
                request.indexOf('experimental') === -1 &&
                request.indexOf('parser-evaluation') === -1,
            path.basename(filePath) + ' must stay isolated: ' + request
        );
    });
    assert.ok(source.indexOf('dt-sql-parser') === -1, path.basename(filePath) + ' must not mention dt-sql-parser');
    assert.ok(source.indexOf('lib/core') === -1, path.basename(filePath) + ' must not reference lib/core');
});

// Registry static surface must not expose Map/Set mutators on internal exports
assert.strictEqual(typeof dialects.CAPABILITIES, 'undefined');
assert.strictEqual(typeof dialects.REGISTRY, 'undefined');

console.log('v2 dialect capability registry tests passed');
