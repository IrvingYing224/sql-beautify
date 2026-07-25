'use strict';

var assert = require('assert');
var path = require('path');
var fs = require('fs');

var root = path.join(__dirname, '..', '..');
var corePath = path.join(root, '.tmp', 'v2-core', 'core', 'index.js');
assert.ok(fs.existsSync(corePath), 'build:v2-core must produce .tmp/v2-core before running lexer tests');

var core = require(corePath);
var lexSql = core.lexSql;
var corpus = require('../fixtures/v2-sql-corpus-cases.js');

function assertConservesSource(source, output) {
    assert.ok(output && Array.isArray(output.leaves), 'output.leaves must be an array');
    assert.ok(Array.isArray(output.diagnostics), 'output.diagnostics must be an array');

    var joined = output.leaves.map(function(leaf) {
        return leaf.raw;
    }).join('');
    assert.strictEqual(joined, source, 'exact source reconstruction failed');

    if (source.length === 0) {
        assert.strictEqual(output.leaves.length, 0, 'empty source must produce no leaves');
        return;
    }

    assert.ok(output.leaves.length > 0, 'non-empty source must produce leaves');
    assert.strictEqual(output.leaves[0].span.start, 0, 'first leaf must start at 0');

    for (var i = 0; i < output.leaves.length; i++) {
        var leaf = output.leaves[i];
        assert.strictEqual(leaf.id, i, 'leaf id must match source order');
        assert.ok(leaf.span.end > leaf.span.start, 'leaf span must be non-empty');
        assert.strictEqual(
            leaf.raw.length,
            leaf.span.end - leaf.span.start,
            'raw length must equal span width for leaf ' + i
        );
        assert.strictEqual(
            leaf.raw,
            source.slice(leaf.span.start, leaf.span.end),
            'raw must equal source.slice(span) for leaf ' + i
        );
        if (i > 0) {
            assert.strictEqual(
                output.leaves[i - 1].span.end,
                leaf.span.start,
                'adjacent leaves must form a contiguous partition at index ' + i
            );
        }
    }

    assert.strictEqual(
        output.leaves[output.leaves.length - 1].span.end,
        source.length,
        'final leaf must end at source.length'
    );

    output.diagnostics.forEach(function(diagnostic, index) {
        assert.ok(diagnostic.span.start >= 0, 'diagnostic start in range #' + index);
        assert.ok(diagnostic.span.end <= source.length, 'diagnostic end in range #' + index);
        assert.ok(diagnostic.span.end >= diagnostic.span.start, 'diagnostic span ordered #' + index);
    });
}

function leafSignature(output) {
    return output.leaves.map(function(leaf) {
        return [leaf.id, leaf.kind, leaf.channel, leaf.raw, leaf.span.start, leaf.span.end].join('|');
    }).join('\n');
}

function assertSingleLeaf(source, dialect, raw, kind, channel) {
    var output = lexSql(source, dialect ? { dialect: dialect } : undefined);
    assertConservesSource(source, output);

    var matches = output.leaves.filter(function(leaf) {
        return leaf.raw === raw;
    });
    assert.strictEqual(
        matches.length,
        1,
        'expected exactly one leaf with raw ' + JSON.stringify(raw) +
            ' in ' + JSON.stringify(source) +
            ' but found ' + matches.length +
            '\n' + leafSignature(output)
    );
    var leaf = matches[0];
    if (kind) {
        assert.strictEqual(leaf.kind, kind, 'kind for ' + JSON.stringify(raw));
    }
    if (channel) {
        assert.strictEqual(leaf.channel, channel, 'channel for ' + JSON.stringify(raw));
    }
    return leaf;
}

function findLeaf(output, raw) {
    return output.leaves.find(function(leaf) {
        return leaf.raw === raw;
    });
}

function assertDeepEqualLex(a, b) {
    assert.deepStrictEqual(
        {
            leaves: a.leaves.map(function(leaf) {
                return {
                    id: leaf.id,
                    kind: leaf.kind,
                    channel: leaf.channel,
                    raw: leaf.raw,
                    span: leaf.span
                };
            }),
            diagnostics: a.diagnostics.map(function(d) {
                return {
                    code: d.code,
                    severity: d.severity,
                    message: d.message,
                    span: d.span,
                    recovery: d.recovery
                };
            })
        },
        {
            leaves: b.leaves.map(function(leaf) {
                return {
                    id: leaf.id,
                    kind: leaf.kind,
                    channel: leaf.channel,
                    raw: leaf.raw,
                    span: leaf.span
                };
            }),
            diagnostics: b.diagnostics.map(function(d) {
                return {
                    code: d.code,
                    severity: d.severity,
                    message: d.message,
                    span: d.span,
                    recovery: d.recovery
                };
            })
        }
    );
}

// --- Mulberry32 PRNG for deterministic fuzz ---
function mulberry32(seed) {
    var t = seed >>> 0;
    return function() {
        t += 0x6D2B79F5;
        var r = Math.imul(t ^ (t >>> 15), 1 | t);
        r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
        return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };
}

var passed = 0;
function test(name, fn) {
    fn();
    passed += 1;
    console.log('  ok - ' + name);
}

console.log('v2 lossless lexer tests');

// ---------------------------------------------------------------------------
// Task 3: basic conservation
// ---------------------------------------------------------------------------
test('empty source', function() {
    var output = lexSql('');
    assertConservesSource('', output);
    assert.deepStrictEqual(output.diagnostics, []);
});

test('SELECT 1', function() {
    var source = 'SELECT 1';
    var output = lexSql(source);
    assertConservesSource(source, output);
    assert.strictEqual(findLeaf(output, 'SELECT').kind, 'keyword');
    assert.strictEqual(findLeaf(output, '1').kind, 'number');
});

test('CRLF newlines are single leaves', function() {
    var source = 'SELECT 1\r\nFROM t\r\n';
    var output = lexSql(source);
    assertConservesSource(source, output);
    var newlines = output.leaves.filter(function(leaf) {
        return leaf.kind === 'newline';
    });
    assert.strictEqual(newlines.length, 2, 'expected two CRLF newline leaves');
    newlines.forEach(function(leaf) {
        assert.strictEqual(leaf.raw, '\r\n', 'CRLF must be one newline leaf');
    });
    assert.ok(
        !output.leaves.some(function(leaf) {
            return leaf.kind === 'newline' && leaf.raw === '\r';
        }),
        'CRLF must not produce a lone CR newline leaf'
    );
    assert.ok(
        !output.leaves.some(function(leaf) {
            return leaf.kind === 'newline' && leaf.raw === '\n';
        }),
        'CRLF must not produce a lone LF newline leaf'
    );
});

test('UTF-8 BOM is boundary trivia only at offset zero', function() {
    var source = '\uFEFFSELECT 1';
    var output = lexSql(source);
    assertConservesSource(source, output);
    assert.deepStrictEqual(
        [output.leaves[0].kind, output.leaves[0].channel, output.leaves[0].raw],
        ['byte-order-mark', 'trivia', '\uFEFF']
    );

    var interior = lexSql('SELECT\uFEFF1');
    assertConservesSource('SELECT\uFEFF1', interior);
    assert.strictEqual(findLeaf(interior, '\uFEFF').kind, 'unknown');
    assert.strictEqual(findLeaf(interior, '\uFEFF').channel, 'protected');
});

test('Chinese identifiers and comments conserve UTF-16 spans', function() {
    var source = "SELECT 用户 FROM t -- 中文注释";
    var output = lexSql(source);
    assertConservesSource(source, output);
});

test('emoji uses UTF-16 surrogate-aware spans', function() {
    var source = "SELECT '😀' -- 保留 FROM 😀";
    var output = lexSql(source);
    assertConservesSource(source, output);
    assertSingleLeaf(source, 'hive', "'😀'", 'string', 'protected');
    assertSingleLeaf(source, 'hive', '-- 保留 FROM 😀', 'line-comment', 'trivia');
    var emojiLeaf = findLeaf(output, "'😀'");
    assert.strictEqual(emojiLeaf.raw.length, 4); // quotes + surrogate pair
    assert.strictEqual(emojiLeaf.span.end - emojiLeaf.span.start, 4);
});

// ---------------------------------------------------------------------------
// Operators maximal-munch
// ---------------------------------------------------------------------------
test('Hive <=> and == are single operators', function() {
    assertSingleLeaf('SELECT a <=> b', 'hive', '<=>', 'operator', 'code');
    assertSingleLeaf('SELECT a == b', 'hive', '==', 'operator', 'code');
});

test('PostgreSQL multi-char operators maximal-munch', function() {
    [
        '!~*',
        '?|',
        '?&',
        '@?',
        '@@',
        '@>',
        '<@',
        '::'
    ].forEach(function(op) {
        assertSingleLeaf('SELECT x ' + op + ' y', 'postgresql', op, 'operator', 'code');
    });
});

test('MySQL <=> := ->> maximal-munch', function() {
    assertSingleLeaf('SELECT a <=> b', 'mysql', '<=>', 'operator', 'code');
    assertSingleLeaf('SET @a := 1', 'mysql', ':=', 'operator', 'code');
    assertSingleLeaf("SELECT col ->> 'k'", 'mysql', '->>', 'operator', 'code');
});

test('shared-prefix operators choose longest form', function() {
    var output = lexSql("SELECT payload @> 'x' AND payload @? 'y'", { dialect: 'postgresql' });
    assertConservesSource("SELECT payload @> 'x' AND payload @? 'y'", output);
    assert.ok(findLeaf(output, '@>'));
    assert.ok(findLeaf(output, '@?'));
    assert.ok(!findLeaf(output, '@'));
});

test('unregistered operator characters are not merged into generic runs', function() {
    // Hive profile does not register @@; each @ must remain a separate unknown leaf.
    var source = 'SELECT a @@ b';
    var output = lexSql(source, { dialect: 'hive' });
    assertConservesSource(source, output);
    assert.strictEqual(
        findLeaf(output, '@@'),
        undefined,
        'Hive must not emit a single @@ operator leaf'
    );
    var atLeaves = output.leaves.filter(function(leaf) {
        return leaf.raw === '@';
    });
    assert.strictEqual(atLeaves.length, 2, 'each @ must be its own leaf');
    atLeaves.forEach(function(leaf) {
        assert.strictEqual(leaf.kind, 'unknown');
        assert.strictEqual(leaf.channel, 'protected');
    });
});

// ---------------------------------------------------------------------------
// Protected lexical units
// ---------------------------------------------------------------------------
test('single and double quoted strings', function() {
    assertSingleLeaf("SELECT 'a''b'", 'hive', "'a''b'", 'string', 'protected');
    assertSingleLeaf('SELECT "a\\"b"', 'hive', '"a\\"b"', 'string', 'protected');
});

test('backtick and double-quoted identifiers', function() {
    assertSingleLeaf('SELECT `a,b` FROM t', 'hive', '`a,b`', 'quoted-identifier', 'protected');
    assertSingleLeaf('SELECT "a b" FROM t', 'postgresql', '"a b"', 'quoted-identifier', 'protected');
});

test('line comments exclude newline', function() {
    var source = 'SELECT 1 -- c\nFROM t';
    var output = lexSql(source);
    assertConservesSource(source, output);
    assert.strictEqual(findLeaf(output, '-- c').kind, 'line-comment');
    assert.strictEqual(findLeaf(output, '\n').kind, 'newline');
});

test('MySQL hash line comments', function() {
    assertSingleLeaf('SELECT 1 # c', 'mysql', '# c', 'line-comment', 'trivia');
});

test('block comments normal and nested', function() {
    assertSingleLeaf('SELECT /* a * b */ 1', 'hive', '/* a * b */', 'block-comment', 'trivia');
    assertSingleLeaf(
        'SELECT /* outer /* inner */ still */ 1',
        'postgresql',
        '/* outer /* inner */ still */',
        'block-comment',
        'trivia'
    );
});

test('PostgreSQL dollar strings', function() {
    assertSingleLeaf(
        "SELECT $tag$line  \r\nkeep$tag$",
        'postgresql',
        '$tag$line  \r\nkeep$tag$',
        'string',
        'protected'
    );
    assertSingleLeaf('SELECT $$x$$', 'postgresql', '$$x$$', 'string', 'protected');
});

test('Hive template parameters', function() {
    assertSingleLeaf('SELECT ${db}.t', 'hive', '${db}', 'parameter', 'protected');
    assertSingleLeaf(
        'SELECT ${hivevar:day}',
        'hive',
        '${hivevar:day}',
        'parameter',
        'protected'
    );
});

test('named and positional parameters', function() {
    assertSingleLeaf('SELECT $1', 'postgresql', '$1', 'parameter', 'protected');
    assertSingleLeaf('SELECT :id', 'mysql', ':id', 'parameter', 'protected');
    assertSingleLeaf('SELECT :id', 'generic', ':id', 'parameter', 'protected');
    assertSingleLeaf('SELECT @user_id', 'mysql', '@user_id', 'parameter', 'protected');
    assertSingleLeaf('SELECT ?', 'mysql', '?', 'parameter', 'protected');

    ['hive', 'postgresql'].forEach(function(dialect) {
        var output = lexSql('SELECT :id', { dialect: dialect });
        assert.strictEqual(output.leaves.some(function(leaf) {
            return leaf.raw === ':id' && leaf.kind === 'parameter';
        }), false, dialect + ' must not claim non-native :id parameters');
        assertSingleLeaf('SELECT :id', dialect, ':', 'punctuation', 'code');
    });
});

test('parameter vs operator precedence', function() {
    assertSingleLeaf('SELECT a::text', 'postgresql', '::', 'operator', 'code');
    assertSingleLeaf('SET @a := 1', 'mysql', ':=', 'operator', 'code');
    assertSingleLeaf("SELECT x ?| ARRAY['a']", 'postgresql', '?|', 'operator', 'code');
    assertSingleLeaf('SELECT payload @> x', 'postgresql', '@>', 'operator', 'code');
});

test('prefixed literals', function() {
    assertSingleLeaf("SELECT E'abc'", 'postgresql', "E'abc'", 'string', 'protected');
    assertSingleLeaf("SELECT U&'d\\0061t'", 'postgresql', "U&'d\\0061t'", 'string', 'protected');
    assertSingleLeaf("SELECT _utf8mb4'abc'", 'mysql', "_utf8mb4'abc'", 'string', 'protected');
    assertSingleLeaf("SELECT X'AF'", 'hive', "X'AF'", 'string', 'protected');
    assertSingleLeaf("SELECT B'101'", 'hive', "B'101'", 'string', 'protected');
});

test('numbers: exponent hex binary leading/trailing dot', function() {
    assertSingleLeaf('SELECT 1.5e-3', 'hive', '1.5e-3', 'number', 'code');
    assertSingleLeaf('SELECT 0xAF', 'hive', '0xAF', 'number', 'code');
    assertSingleLeaf('SELECT 0b101', 'mysql', '0b101', 'number', 'code');
    assertSingleLeaf('SELECT .5', 'hive', '.5', 'number', 'code');
    assertSingleLeaf('SELECT 5.', 'hive', '5.', 'number', 'code');
    // signs remain operators
    var signed = lexSql('SELECT -5');
    assertConservesSource('SELECT -5', signed);
    assert.strictEqual(findLeaf(signed, '-').kind, 'operator');
    assert.strictEqual(findLeaf(signed, '5').kind, 'number');
});

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------
function assertUnterminated(source, dialect, code, rawPrefix) {
    var output = lexSql(source, { dialect: dialect });
    assertConservesSource(source, output);
    assert.strictEqual(output.diagnostics.length, 1, 'exactly one diagnostic for ' + code);
    var d = output.diagnostics[0];
    assert.strictEqual(d.code, code);
    assert.strictEqual(d.severity, 'error');
    assert.strictEqual(d.recovery, 'preserve-target');
    assert.strictEqual(d.span.start, source.indexOf(rawPrefix));
    assert.strictEqual(d.span.end, source.length);
    var leaf = output.leaves.find(function(item) {
        return item.span.start === d.span.start && item.span.end === d.span.end;
    });
    assert.ok(leaf, 'unterminated unit must still form a leaf covering the diagnostic span');
    assert.ok(leaf.raw.indexOf(rawPrefix) === 0 || leaf.raw === source.slice(d.span.start));
}

test('unterminated string diagnostic', function() {
    assertUnterminated("SELECT 'unterminated FROM t", 'hive', 'LEX_UNTERMINATED_STRING', "'");
});

test('unterminated quoted identifier diagnostic', function() {
    assertUnterminated('SELECT `open FROM t', 'hive', 'LEX_UNTERMINATED_QUOTED_IDENTIFIER', '`');
});

test('unterminated block comment diagnostic', function() {
    assertUnterminated('SELECT /* open', 'hive', 'LEX_UNTERMINATED_BLOCK_COMMENT', '/*');
});

test('unterminated dollar string diagnostic', function() {
    assertUnterminated('SELECT $tag$open', 'postgresql', 'LEX_UNTERMINATED_DOLLAR_STRING', '$tag$');
});

test('unterminated template diagnostic', function() {
    assertUnterminated('SELECT ${open', 'hive', 'LEX_UNTERMINATED_TEMPLATE', '${');
});

test('unknown leaf does not produce diagnostic', function() {
    var output = lexSql('SELECT \\');
    assertConservesSource('SELECT \\', output);
    assert.strictEqual(output.diagnostics.length, 0);
    assert.ok(output.leaves.some(function(leaf) {
        return leaf.kind === 'unknown';
    }));
});

test('invalid dialect rejects clearly at runtime', function() {
    assert.throws(
        function() {
            lexSql('SELECT 1', { dialect: 'postgres' });
        },
        function(error) {
            return (
                error instanceof Error &&
                /Unsupported dialect "postgres"/.test(error.message) &&
                /hive, generic, postgresql, mysql/.test(error.message)
            );
        }
    );
    assert.throws(
        function() {
            lexSql('SELECT 1', { dialect: 'oracle' });
        },
        /Unsupported dialect "oracle"/
    );
    // Empty source must not bypass dialect validation.
    assert.throws(
        function() {
            lexSql('', { dialect: 'oracle' });
        },
        function(error) {
            return (
                error instanceof Error &&
                /Unsupported dialect "oracle"/.test(error.message) &&
                /hive, generic, postgresql, mysql/.test(error.message)
            );
        }
    );
    assert.throws(
        function() {
            lexSql('', { dialect: 'postgres' });
        },
        /Unsupported dialect "postgres"/
    );
    var emptyOk = lexSql('', { dialect: 'hive' });
    assertConservesSource('', emptyOk);
    assert.deepStrictEqual(emptyOk.diagnostics, []);
});

// ---------------------------------------------------------------------------
// MySQL -- comment boundary
// ---------------------------------------------------------------------------
test('MySQL -- requires whitespace or control after dashes', function() {
    // Not a comment: second - is followed by digit.
    var noComment = lexSql('SELECT 1--2', { dialect: 'mysql' });
    assertConservesSource('SELECT 1--2', noComment);
    assert.strictEqual(findLeaf(noComment, '--2'), undefined, '1--2 must not form a line-comment leaf');
    assert.strictEqual(findLeaf(noComment, '1').kind, 'number');
    // Operators consume -- as two minus operators under mysql policy.
    var minusLeaves = noComment.leaves.filter(function(leaf) {
        return leaf.raw === '-';
    });
    assert.ok(minusLeaves.length >= 2, '1--2 should expose minus operators, got ' + leafSignature(noComment));

    // Comment when followed by space.
    assertSingleLeaf('SELECT 1-- 2', 'mysql', '-- 2', 'line-comment', 'trivia');

    // Tab after -- starts comment; newline remains a separate leaf.
    var tabSource = 'SELECT 1--\ttext\nFROM t';
    var tabOut = lexSql(tabSource, { dialect: 'mysql' });
    assertConservesSource(tabSource, tabOut);
    assert.strictEqual(findLeaf(tabOut, '--\ttext').kind, 'line-comment');
    assert.strictEqual(findLeaf(tabOut, '\n').kind, 'newline');

    var crlfSource = 'SELECT 1--\r\nFROM t';
    var crlfOut = lexSql(crlfSource, { dialect: 'mysql' });
    assertConservesSource(crlfSource, crlfOut);
    assert.strictEqual(findLeaf(crlfOut, '--').kind, 'line-comment');
    assert.strictEqual(findLeaf(crlfOut, '\r\n').kind, 'newline');

    // Hive / PostgreSQL / generic keep standard -- comments without follower requirement.
    assertSingleLeaf('SELECT 1--2', 'hive', '--2', 'line-comment', 'trivia');
    assertSingleLeaf('SELECT 1--2', 'postgresql', '--2', 'line-comment', 'trivia');
    assertSingleLeaf('SELECT 1--2', 'generic', '--2', 'line-comment', 'trivia');
});

// ---------------------------------------------------------------------------
// PostgreSQL operator / parameter classification
// ---------------------------------------------------------------------------
test('PostgreSQL ? is operator not parameter; => := # are atomic', function() {
    assertSingleLeaf("SELECT payload ? 'id'", 'postgresql', '?', 'operator', 'code');
    assertSingleLeaf('SELECT f(a => 1)', 'postgresql', '=>', 'operator', 'code');
    assertSingleLeaf('SELECT f(a := 1)', 'postgresql', ':=', 'operator', 'code');
    assertSingleLeaf('SELECT 5 # 3', 'postgresql', '#', 'operator', 'code');
    assertSingleLeaf('SELECT $1', 'postgresql', '$1', 'parameter', 'protected');

    // Shared-prefix: longest operators win over bare ?
    assertSingleLeaf("SELECT x ?| ARRAY['a']", 'postgresql', '?|', 'operator', 'code');
    assertSingleLeaf("SELECT x ?& ARRAY['a']", 'postgresql', '?&', 'operator', 'code');
    var q = lexSql("SELECT payload ? 'id' AND x ?| y", { dialect: 'postgresql' });
    assertConservesSource("SELECT payload ? 'id' AND x ?| y", q);
    assert.strictEqual(findLeaf(q, '?').kind, 'operator');
    assert.strictEqual(findLeaf(q, '?|').kind, 'operator');
    assert.ok(!q.leaves.some(function(leaf) {
        return leaf.raw === '?' && leaf.kind === 'parameter';
    }), 'PostgreSQL must not classify bare ? as parameter');

    // Other dialects keep ? placeholder
    assertSingleLeaf('SELECT ?', 'mysql', '?', 'parameter', 'protected');
    assertSingleLeaf('SELECT ?', 'hive', '?', 'parameter', 'protected');
    assertSingleLeaf('SELECT ?', 'generic', '?', 'parameter', 'protected');
});

test('Hive STRUCT member colons stay code across trivia and quoted names', function() {
    var source = [
        'SELECT STRUCT<a:INT>',
        ', STRUCT<a :INT>',
        ', STRUCT<a: INT>',
        ', STRUCT<a : INT>',
        ', STRUCT<`a`:BIGINT>',
        ', STRUCT<`a` :BIGINT>'
    ].join('');
    var output = lexSql(source, { dialect: 'hive' });
    assertConservesSource(source, output);
    assert.strictEqual(output.leaves.some(function(leaf) {
        return leaf.kind === 'parameter' && /^:(?:INT|BIGINT)$/.test(leaf.raw);
    }), false, 'Hive type-member colons must never become protected parameters');
    assert.strictEqual(output.leaves.filter(function(leaf) {
        return leaf.raw === ':' && leaf.kind === 'punctuation' && leaf.channel === 'code';
    }).length, 6, 'every Hive STRUCT member colon must remain code punctuation');
});

// ---------------------------------------------------------------------------
// Prefixed literal / U& quoted identifier boundaries
// ---------------------------------------------------------------------------
test('prefixed literals use single quotes; U& double is quoted-identifier', function() {
    // Positive single-quote forms
    assertSingleLeaf("SELECT E'abc'", 'postgresql', "E'abc'", 'string', 'protected');
    assertSingleLeaf("SELECT U&'d\\0061t'", 'postgresql', "U&'d\\0061t'", 'string', 'protected');
    assertSingleLeaf("SELECT N'abc'", 'generic', "N'abc'", 'string', 'protected');
    assertSingleLeaf("SELECT X'AF'", 'postgresql', "X'AF'", 'string', 'protected');
    assertSingleLeaf("SELECT B'101'", 'postgresql', "B'101'", 'string', 'protected');
    assertSingleLeaf("SELECT _utf8mb4'abc'", 'mysql', "_utf8mb4'abc'", 'string', 'protected');

    // PostgreSQL U&"..." is one quoted-identifier leaf
    assertSingleLeaf('SELECT U&"d\\0061t"', 'postgresql', 'U&"d\\0061t"', 'quoted-identifier', 'protected');

    // Unterminated U&"
    var open = 'SELECT U&"open';
    var openOut = lexSql(open, { dialect: 'postgresql' });
    assertConservesSource(open, openOut);
    assert.strictEqual(openOut.diagnostics.length, 1);
    assert.strictEqual(openOut.diagnostics[0].code, 'LEX_UNTERMINATED_QUOTED_IDENTIFIER');
    assert.strictEqual(openOut.diagnostics[0].severity, 'error');
    assert.strictEqual(openOut.diagnostics[0].recovery, 'preserve-target');
    assert.strictEqual(findLeaf(openOut, 'U&"open').kind, 'quoted-identifier');

    // Double-quote after N/X/B must NOT form a single string leaf on PG/generic
    ['postgresql', 'generic'].forEach(function(dialect) {
        [
            ['SELECT N"abc"', 'N"abc"'],
            ['SELECT X"AF"', 'X"AF"'],
            ['SELECT B"101"', 'B"101"']
        ].forEach(function(pair) {
            var source = pair[0];
            var bad = pair[1];
            var output = lexSql(source, { dialect: dialect });
            assertConservesSource(source, output);
            assert.strictEqual(
                findLeaf(output, bad),
                undefined,
                dialect + ' must not emit single string leaf for ' + bad + '\n' + leafSignature(output)
            );
            // Double-quoted body remains a quoted-identifier leaf under doubleQuote=identifier.
            assert.ok(
                output.leaves.some(function(leaf) {
                    return leaf.kind === 'quoted-identifier' && leaf.raw.charAt(0) === '"';
                }),
                dialect + ' should keep double-quoted segment as quoted-identifier for ' + source
            );
        });
    });

    // Hive/MySQL double-quoted strings still work as ordinary strings
    assertSingleLeaf('SELECT "abc"', 'hive', '"abc"', 'string', 'protected');
    assertSingleLeaf('SELECT "abc"', 'mysql', '"abc"', 'string', 'protected');
});

// ---------------------------------------------------------------------------
// Profile lookup immutability (ordinary use, not adversarial Proxy)
// ---------------------------------------------------------------------------
test('profile lookups do not expose mutators and cannot alter lexSql', function() {
    // Profile API is internal; load the built module directly, not root public core.
    var profileModule = require(path.join(root, '.tmp', 'v2-core', 'core', 'lexer', 'lexical-profile.js'));
    var profile = profileModule.getLexicalProfile('hive');
    assert.strictEqual(typeof profile.keywords.has, 'function');
    assert.strictEqual(typeof profile.keywords.add, 'undefined');
    assert.strictEqual(typeof profile.keywords.delete, 'undefined');
    assert.strictEqual(typeof profile.keywords.clear, 'undefined');
    assert.strictEqual(typeof profile.parameters.add, 'undefined');
    assert.strictEqual(typeof profile.prefixedLiterals.add, 'undefined');
    assert.ok(Object.isFrozen(profile.operators), 'operators array must be frozen');

    // Attempt ordinary mutation if a Set were leaked; should throw or be no-op on frozen lookup.
    var before = lexSql('SELECT NOT_A_REAL_KEYWORD_XYZ');
    assert.strictEqual(findLeaf(before, 'NOT_A_REAL_KEYWORD_XYZ').kind, 'identifier');

    var mutated = false;
    try {
        profile.keywords.add('NOT_A_REAL_KEYWORD_XYZ');
        mutated = true;
    } catch (error) {
        mutated = false;
    }
    assert.strictEqual(
        typeof profile.keywords.add,
        'undefined',
        'keywords lookup must not expose add'
    );
    assert.strictEqual(mutated, false, 'keywords.add must not be callable');

    var after = lexSql('SELECT NOT_A_REAL_KEYWORD_XYZ');
    assert.strictEqual(
        findLeaf(after, 'NOT_A_REAL_KEYWORD_XYZ').kind,
        'identifier',
        'external mutation must not reclassify identifiers as keywords'
    );
    assert.ok(profile.keywords.has('SELECT'));
    assert.ok(!profile.keywords.has('NOT_A_REAL_KEYWORD_XYZ'));
});

test('root public API only exposes approved value exports', function() {
    var runtimeKeys = Object.keys(core).sort();
    assert.deepStrictEqual(
        runtimeKeys,
        ['formatSql', 'lexSql'],
        'compiled core/index.js must only expose public values at runtime, got ' + runtimeKeys.join(',')
    );
    assert.strictEqual(typeof core.lexSql, 'function');
    assert.strictEqual(typeof core.formatSql, 'function');
    assert.strictEqual(core.getLexicalProfile, undefined);
    assert.strictEqual(core.listLexicalProfiles, undefined);
});

// ---------------------------------------------------------------------------
// PostgreSQL U& quote boundary (backslash is Unicode escape, not quote escape)
// ---------------------------------------------------------------------------
test('PostgreSQL U& does not treat backslash as quote escape', function() {
    // Single backslash immediately before closing quote must still close the leaf.
    var single = "SELECT U&'foo\\' AS x";
    var singleOut = lexSql(single, { dialect: 'postgresql' });
    assertConservesSource(single, singleOut);
    assert.strictEqual(findLeaf(singleOut, "U&'foo\\'").kind, 'string');
    assert.strictEqual(findLeaf(singleOut, 'AS').kind, 'keyword');
    assert.strictEqual(findLeaf(singleOut, 'x').kind, 'identifier');
    assert.strictEqual(singleOut.diagnostics.length, 0, 'must not unterminate on U&\\\'');

    var dbl = 'SELECT U&"foo\\" FROM t';
    var dblOut = lexSql(dbl, { dialect: 'postgresql' });
    assertConservesSource(dbl, dblOut);
    assert.strictEqual(findLeaf(dblOut, 'U&"foo\\"').kind, 'quoted-identifier');
    assert.strictEqual(findLeaf(dblOut, 'FROM').kind, 'keyword');
    assert.strictEqual(findLeaf(dblOut, 't').kind, 'identifier');
    assert.strictEqual(dblOut.diagnostics.length, 0, 'must not unterminate on U&\\"');

    // Legal Unicode escapes remain single leaves.
    assertSingleLeaf("SELECT U&'d\\0061t'", 'postgresql', "U&'d\\0061t'", 'string', 'protected');
    assertSingleLeaf('SELECT U&"d\\0061t"', 'postgresql', 'U&"d\\0061t"', 'quoted-identifier', 'protected');

    // Doubled delimiters remain single leaves.
    assertSingleLeaf("SELECT U&'a''b'", 'postgresql', "U&'a''b'", 'string', 'protected');
    assertSingleLeaf('SELECT U&"a""b"', 'postgresql', 'U&"a""b"', 'quoted-identifier', 'protected');

    // Doubled backslash then closing quote ends normally.
    var bs2s = "SELECT U&'foo\\\\' AS x";
    var bs2sOut = lexSql(bs2s, { dialect: 'postgresql' });
    assertConservesSource(bs2s, bs2sOut);
    assert.strictEqual(findLeaf(bs2sOut, "U&'foo\\\\'").kind, 'string');
    assert.strictEqual(findLeaf(bs2sOut, 'AS').kind, 'keyword');
    assert.strictEqual(bs2sOut.diagnostics.length, 0);

    var bs2d = 'SELECT U&"foo\\\\" FROM t';
    var bs2dOut = lexSql(bs2d, { dialect: 'postgresql' });
    assertConservesSource(bs2d, bs2dOut);
    assert.strictEqual(findLeaf(bs2dOut, 'U&"foo\\\\"').kind, 'quoted-identifier');
    assert.strictEqual(findLeaf(bs2dOut, 'FROM').kind, 'keyword');
    assert.strictEqual(bs2dOut.diagnostics.length, 0);

    // Three backslashes then closing quote still closes (no swallowed AS/FROM).
    var bs3s = "SELECT U&'foo\\\\\\' AS x";
    var bs3sOut = lexSql(bs3s, { dialect: 'postgresql' });
    assertConservesSource(bs3s, bs3sOut);
    assert.strictEqual(findLeaf(bs3sOut, "U&'foo\\\\\\'").kind, 'string');
    assert.strictEqual(findLeaf(bs3sOut, 'AS').kind, 'keyword');
    assert.strictEqual(bs3sOut.diagnostics.length, 0);

    var bs3d = 'SELECT U&"foo\\\\\\" FROM t';
    var bs3dOut = lexSql(bs3d, { dialect: 'postgresql' });
    assertConservesSource(bs3d, bs3dOut);
    assert.strictEqual(findLeaf(bs3dOut, 'U&"foo\\\\\\"').kind, 'quoted-identifier');
    assert.strictEqual(findLeaf(bs3dOut, 'FROM').kind, 'keyword');
    assert.strictEqual(bs3dOut.diagnostics.length, 0);

    // E'...' still supports C-style backslash quote escape (does not close early).
    var eSource = "SELECT E'foo\\'bar' AS x";
    var eOut = lexSql(eSource, { dialect: 'postgresql' });
    assertConservesSource(eSource, eOut);
    assert.strictEqual(findLeaf(eOut, "E'foo\\'bar'").kind, 'string');
    assert.strictEqual(findLeaf(eOut, 'AS').kind, 'keyword');
    assert.strictEqual(eOut.diagnostics.length, 0);
});

// ---------------------------------------------------------------------------
// MySQL -- control-character followers (NUL/DEL/EOF; U+0080 is not control)
// ---------------------------------------------------------------------------
test('MySQL -- control followers include NUL and DEL but not U+0080', function() {
    // NUL and DEL after -- start a comment.
    var nulSource = 'SELECT 1--\u0000text';
    var nulOut = lexSql(nulSource, { dialect: 'mysql' });
    assertConservesSource(nulSource, nulOut);
    assert.strictEqual(findLeaf(nulOut, '--\u0000text').kind, 'line-comment');
    assert.ok(!nulOut.leaves.some(function(leaf) {
        return leaf.raw === '-' && leaf.kind === 'operator';
    }), 'NUL follower must not split into minus operators');

    var delSource = 'SELECT 1--\u007ftext';
    var delOut = lexSql(delSource, { dialect: 'mysql' });
    assertConservesSource(delSource, delOut);
    assert.strictEqual(findLeaf(delOut, '--\u007ftext').kind, 'line-comment');

    // U+0080 is not an ASCII control; must not start a MySQL -- comment.
    var u80Source = 'SELECT 1--\u0080text';
    var u80Out = lexSql(u80Source, { dialect: 'mysql' });
    assertConservesSource(u80Source, u80Out);
    assert.strictEqual(findLeaf(u80Out, '--\u0080text'), undefined);
    var minusCount = u80Out.leaves.filter(function(leaf) {
        return leaf.raw === '-' && leaf.kind === 'operator';
    }).length;
    assert.strictEqual(minusCount, 2, 'U+0080 must not be a comment follower');

    // EOF after -- remains an empty line comment.
    var eofSource = 'SELECT 1--';
    var eofOut = lexSql(eofSource, { dialect: 'mysql' });
    assertConservesSource(eofSource, eofOut);
    assert.strictEqual(findLeaf(eofOut, '--').kind, 'line-comment');

    // Existing boundaries stay correct.
    assertSingleLeaf('SELECT 1-- 2', 'mysql', '-- 2', 'line-comment', 'trivia');
    var noComment = lexSql('SELECT 1--2', { dialect: 'mysql' });
    assertConservesSource('SELECT 1--2', noComment);
    assert.strictEqual(findLeaf(noComment, '--2'), undefined);
});

// ---------------------------------------------------------------------------
// Wave 0 corpus
// ---------------------------------------------------------------------------
test('Wave 0 corpus source conservation and atomic lexemes', function() {
    assert.strictEqual(corpus.length, 16, 'corpus must remain 16 cases');
    corpus.forEach(function(entry) {
        var output = lexSql(entry.source, { dialect: entry.dialect });
        assertConservesSource(entry.source, output);
        entry.atomicLexemes.forEach(function(lexeme) {
            var matches = output.leaves.filter(function(leaf) {
                return leaf.raw === lexeme;
            });
            assert.strictEqual(
                matches.length,
                1,
                entry.id + ' atomic lexeme must be a single leaf: ' + JSON.stringify(lexeme) +
                    '\n' + leafSignature(output)
            );
        });
    });
});

// ---------------------------------------------------------------------------
// Deterministic fuzz
// ---------------------------------------------------------------------------
test('deterministic fuzz 500 inputs', function() {
    var rng = mulberry32(0xC0FFEE42);
    var fragments = [
        'SELECT', 'FROM', 'WHERE', 'AND', 'OR', 'JOIN', 'ON', 'AS', 'CASE', 'WHEN', 'THEN', 'END',
        'user_id', 'fact_orders', 'src', 'dst', 'id', 'ts', 'ds',
        '用户', '订单', '😀', '🚀', '中文',
        ' ', '  ', '\t', '\n', '\r\n', '\r',
        "'abc'", "'a''b'", '"x"', '`a,b`', '`t(`',
        '-- comment', '/* block */', '/* a /* b */ c */',
        '${db}', '${hivevar:day}', '$1', ':id', '@user_id', '?',
        '<=>', '==', '!=', '<=', '>=', '<>', '::', ':=', '->>', '->', '@>', '<@', '?|', '?&', '@?', '@@', '!~*',
        '1', '0', '42', '1.5', '.5', '5.', '1e10', '1.5e-3', '0xAF', '0b101',
        "E'abc'", "U&'d\\0061t'", "_utf8mb4'abc'", "X'AF'", "B'101'",
        '(', ')', ',', ';', '.', '[', ']',
        '\\', '§', '©',
        "'unterminated", '/* open', '${open', '`open', '$tag$open'
    ];
    var dialects = ['hive', 'generic', 'postgresql', 'mysql'];

    for (var i = 0; i < 500; i++) {
        var partCount = 1 + Math.floor(rng() * 12);
        var parts = [];
        for (var p = 0; p < partCount; p++) {
            parts.push(fragments[Math.floor(rng() * fragments.length)]);
        }
        var source = parts.join('');
        var dialect = dialects[Math.floor(rng() * dialects.length)];
        var first = lexSql(source, { dialect: dialect });
        var second = lexSql(source, { dialect: dialect });
        assertConservesSource(source, first);
        assertDeepEqualLex(first, second);
    }
});

// ---------------------------------------------------------------------------
// Default dialect is hive
// ---------------------------------------------------------------------------
test('default dialect is hive', function() {
    var withDefault = lexSql('SELECT ${db}');
    var withHive = lexSql('SELECT ${db}', { dialect: 'hive' });
    assertDeepEqualLex(withDefault, withHive);
});

test('leaf ids start at 0 and increase', function() {
    var output = lexSql('SELECT 1');
    output.leaves.forEach(function(leaf, index) {
        assert.strictEqual(leaf.id, index);
    });
});

console.log(
    'v2 lossless lexer tests passed (' +
        passed +
        ' test blocks; includes 1 corpus block over 16 cases and 1 fuzz block over 500 inputs)'
);
