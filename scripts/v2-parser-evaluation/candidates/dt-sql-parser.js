var fs = require('fs');
var path = require('path');
var esbuild = require('esbuild');
var utilTypes = require('util').types;

function load_dt_sql_parser() {
    var outputDir = path.join(process.cwd(), '.tmp', 'v2-parser-evaluation');
    var outputFile = path.join(outputDir, 'dt-sql-parser-api.cjs');
    fs.mkdirSync(outputDir, { recursive: true });
    esbuild.buildSync({
        entryPoints: [path.join(__dirname, 'dt-evaluation-entry.js')],
        outfile: outputFile,
        bundle: true,
        minify: true,
        platform: 'node',
        format: 'cjs',
        target: 'node18',
    });
    return require(outputFile);
}

var dtSqlParser = load_dt_sql_parser();
var constructors = {
    hive: dtSqlParser.HiveSQL,
    generic: dtSqlParser.GenericSQL,
    postgresql: dtSqlParser.PostgreSQL,
    mysql: dtSqlParser.MySQL,
};

function package_metadata() {
    var current = path.dirname(require.resolve('dt-sql-parser'));
    while (current != path.dirname(current)) {
        var packagePath = path.join(current, 'package.json');
        if (fs.existsSync(packagePath)) {
            var value = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
            if (value.name == 'dt-sql-parser') {
                return value;
            }
        }
        current = path.dirname(current);
    }
    throw new Error('dt-sql-parser package metadata not found');
}

function utf16_offsets_by_code_point(source) {
    var offsets = [0];
    var utf16Offset = 0;
    Array.from(source).forEach(function(character) {
        utf16Offset += character.length;
        offsets.push(utf16Offset);
    });
    return offsets;
}

function is_trivia_gap(raw) {
    return /^\s*$/.test(raw);
}

function synthetic_leaf(kind, raw, start, end) {
    return {
        kind: kind,
        origin: 'synthetic',
        raw: raw,
        span: { start: start, end: end },
    };
}

function leaves_from_tokens(source, tokens, utf16Offsets) {
    if (!Array.isArray(tokens)) {
        throw new TypeError('getAllTokens must return an array');
    }
    var usable = [];
    var invalidTokenCount = 0;
    var previousInputStart = -1;
    for (var tokenIndex = 0; tokenIndex < tokens.length; tokenIndex++) {
        if (!Object.prototype.hasOwnProperty.call(tokens, tokenIndex)) {
            invalidTokenCount++;
            continue;
        }
        var token = tokens[tokenIndex];
        var startIndex = token && token.start;
        var stopIndex = token && token.stop;
        var channel = token && token.channel;
        if (!Number.isInteger(startIndex)
            || !Number.isInteger(stopIndex)
            || !Number.isInteger(channel)
            || startIndex < 0
            || stopIndex < startIndex
            || channel < 0
            || utf16Offsets[startIndex] === undefined
            || utf16Offsets[stopIndex + 1] === undefined) {
            invalidTokenCount++;
            continue;
        }
        usable.push({
            start: utf16Offsets[startIndex],
            end: utf16Offsets[stopIndex + 1],
            channel: channel,
            inputIndex: tokenIndex,
        });
        if (startIndex < previousInputStart) {
            invalidTokenCount++;
        }
        previousInputStart = startIndex;
    }
    usable.sort(function(left, right) {
        return left.start - right.start || left.end - right.end || left.inputIndex - right.inputIndex;
    });

    var leaves = [];
    var cursor = 0;
    var overlapTokenCount = 0;
    var nonTriviaGapCount = 0;
    if (usable.length == 0 && source.length > 0) {
        if (!is_trivia_gap(source)) {
            nonTriviaGapCount++;
        }
        leaves.push(synthetic_leaf('opaque', source, 0, source.length));
    } else {
        usable.forEach(function(token) {
            if (token.start < cursor) {
                overlapTokenCount++;
                return;
            }
            if (token.start > cursor) {
                var gap = source.slice(cursor, token.start);
                if (!is_trivia_gap(gap)) {
                    nonTriviaGapCount++;
                }
                leaves.push(synthetic_leaf('gap', gap, cursor, token.start));
            }
            leaves.push({
                kind: token.channel == 0 ? 'token' : 'trivia',
                origin: 'candidate',
                raw: source.slice(token.start, token.end),
                span: { start: token.start, end: token.end },
            });
            cursor = token.end;
        });
        if (cursor < source.length) {
            var trailingGap = source.slice(cursor);
            if (!is_trivia_gap(trailingGap)) {
                nonTriviaGapCount++;
            }
            leaves.push(synthetic_leaf('gap', trailingGap, cursor, source.length));
        }
    }
    return {
        leaves: leaves,
        nativePartition: {
            valid: invalidTokenCount == 0 && overlapTokenCount == 0,
            invalidTokenCount: invalidTokenCount,
            overlapTokenCount: overlapTokenCount,
            nonTriviaGapCount: nonTriviaGapCount,
        },
    };
}

function is_own_data_descriptor(descriptor) {
    return !!descriptor
        && Object.prototype.hasOwnProperty.call(descriptor, 'value')
        && typeof descriptor.get != 'function'
        && typeof descriptor.set != 'function';
}

function empty_children_failure() {
    return {
        ok: false,
        empty: false,
        items: [],
        container: null,
        length: 0,
        baseline: null,
        propertyBaseline: null,
    };
}

// Capture node.children binding without invoking accessors.
// Missing own property => legal empty TerminalNode style.
// Own data property => snapshot value/flags.
// Own accessor or inherited property => fail closed.
function capture_children_property_baseline(node) {
    var ownDescriptor = Object.getOwnPropertyDescriptor(node, 'children');
    if (ownDescriptor === undefined) {
        if (Object.prototype.hasOwnProperty.call(node, 'children')) {
            return { ok: false, propertyBaseline: null, children: undefined };
        }
        // Inherited children cannot be re-verified without re-reading; fail closed.
        if ('children' in node) {
            return { ok: false, propertyBaseline: null, children: undefined };
        }
        return {
            ok: true,
            propertyBaseline: { present: false },
            children: undefined,
        };
    }
    if (!is_own_data_descriptor(ownDescriptor)) {
        return { ok: false, propertyBaseline: null, children: undefined };
    }
    return {
        ok: true,
        propertyBaseline: {
            present: true,
            value: ownDescriptor.value,
            writable: ownDescriptor.writable,
            enumerable: ownDescriptor.enumerable,
            configurable: ownDescriptor.configurable,
        },
        children: ownDescriptor.value,
    };
}

// Re-check node.children property descriptor without reading node.children.
function verify_children_property_binding(node, propertyBaseline) {
    try {
        if (!propertyBaseline) {
            return false;
        }
        var current = Object.getOwnPropertyDescriptor(node, 'children');
        if (!propertyBaseline.present) {
            return current === undefined
                && !Object.prototype.hasOwnProperty.call(node, 'children')
                && !('children' in node);
        }
        if (!is_own_data_descriptor(current)) {
            return false;
        }
        return current.value === propertyBaseline.value
            && current.writable === propertyBaseline.writable
            && current.enumerable === propertyBaseline.enumerable
            && current.configurable === propertyBaseline.configurable;
    } catch (error) {
        return false;
    }
}

// Compare container length/descriptors against a previously captured baseline.
function verify_children_baseline(container, length, baseline) {
    try {
        if (utilTypes.isProxy(container) || !Array.isArray(container)) {
            return false;
        }
        if (container.length !== length) {
            return false;
        }
        for (var checkIndex = 0; checkIndex < length; checkIndex++) {
            var checkDescriptor = Object.getOwnPropertyDescriptor(container, checkIndex);
            if (!is_own_data_descriptor(checkDescriptor)
                || checkDescriptor.value !== baseline[checkIndex].value
                || checkDescriptor.writable !== baseline[checkIndex].writable
                || checkDescriptor.enumerable !== baseline[checkIndex].enumerable
                || checkDescriptor.configurable !== baseline[checkIndex].configurable) {
                return false;
            }
        }
        if (Object.prototype.hasOwnProperty.call(container, length)) {
            return false;
        }
        return true;
    } catch (error) {
        return false;
    }
}

// Single children snapshot used by epsilon checks and tree traversal.
// missing/null/undefined => empty; dense non-Proxy Array of non-null objects => snapshot;
// node.children accessors/inherited bindings, indexed accessors, Proxies fail closed.
function snapshot_children(node) {
    try {
        var propertyCapture = capture_children_property_baseline(node);
        if (!propertyCapture.ok) {
            return empty_children_failure();
        }
        var propertyBaseline = propertyCapture.propertyBaseline;
        var children = propertyCapture.children;
        if (children === null || children === undefined) {
            return {
                ok: true,
                empty: true,
                items: [],
                container: null,
                length: 0,
                baseline: null,
                propertyBaseline: propertyBaseline,
            };
        }
        if (utilTypes.isProxy(children)) {
            return empty_children_failure();
        }
        if (!Array.isArray(children)) {
            return empty_children_failure();
        }
        var length = children.length;
        if (!Number.isInteger(length) || length < 0) {
            return empty_children_failure();
        }
        var baseline = [];
        for (var index = 0; index < length; index++) {
            var descriptor = Object.getOwnPropertyDescriptor(children, index);
            if (!is_own_data_descriptor(descriptor)) {
                return empty_children_failure();
            }
            if (descriptor.value === null || typeof descriptor.value != 'object') {
                return empty_children_failure();
            }
            baseline.push({
                value: descriptor.value,
                writable: descriptor.writable,
                enumerable: descriptor.enumerable,
                configurable: descriptor.configurable,
            });
        }
        if (!verify_children_baseline(children, length, baseline)) {
            return empty_children_failure();
        }
        if (!verify_children_property_binding(node, propertyBaseline)) {
            return empty_children_failure();
        }
        var items = [];
        for (var itemIndex = 0; itemIndex < baseline.length; itemIndex++) {
            items.push(baseline[itemIndex].value);
        }
        return {
            ok: true,
            empty: items.length == 0,
            items: items,
            container: children,
            length: length,
            baseline: baseline,
            propertyBaseline: propertyBaseline,
        };
    } catch (error) {
        return empty_children_failure();
    }
}

function is_epsilon_context(childrenSnapshot, node) {
    if (!childrenSnapshot.ok || !childrenSnapshot.empty) {
        return false;
    }
    if (typeof node.getText != 'function') {
        return false;
    }
    try {
        return node.getText() === '';
    } catch (error) {
        return false;
    }
}

function children_snapshot_still_stable(node, childrenSnapshot) {
    if (!verify_children_property_binding(node, childrenSnapshot.propertyBaseline)) {
        return false;
    }
    if (childrenSnapshot.container) {
        return verify_children_baseline(
            childrenSnapshot.container,
            childrenSnapshot.length,
            childrenSnapshot.baseline
        );
    }
    return true;
}

function inspect_nodes(root, utf16Offsets) {
    try {
        var count = 0;
        var epsilonCount = 0;
        var invalidSpanCount = 0;
        var stack = root ? [root] : [];
        var seen = new Set();
        while (stack.length > 0) {
            var node = stack.pop();
            if (!node || typeof node != 'object') {
                continue;
            }
            if (seen.has(node)) {
                // Cycles and shared parse-tree node references are invalid.
                invalidSpanCount++;
                continue;
            }
            seen.add(node);
            var childrenSnapshot = snapshot_children(node);
            if (!childrenSnapshot.ok) {
                // Non-array / sparse / unstable / illegal child container fails closed.
                if (Number.isInteger(node.ruleIndex) && node.ruleIndex >= 0) {
                    count++;
                    invalidSpanCount++;
                } else {
                    // Terminal or non-rule node with illegal children still invalidates the tree.
                    invalidSpanCount++;
                }
                continue;
            }
            var countedEpsilon = false;
            if (Number.isInteger(node.ruleIndex) && node.ruleIndex >= 0) {
                count++;
                if (!node.start || !node.stop
                    || !Number.isInteger(node.start.start)
                    || !Number.isInteger(node.stop.stop)) {
                    invalidSpanCount++;
                } else {
                    var startIndex = node.start.start;
                    var stopIndex = node.stop.stop;
                    // Raw endpoints must be non-negative integers before +1.
                    if (startIndex < 0 || stopIndex < 0) {
                        invalidSpanCount++;
                    } else {
                        var endIndex = stopIndex + 1;
                        var start = utf16Offsets[startIndex];
                        var end = utf16Offsets[endIndex];
                        var indexesValid = startIndex < utf16Offsets.length
                            && endIndex < utf16Offsets.length;
                        if (!indexesValid) {
                            invalidSpanCount++;
                        } else if (endIndex <= startIndex) {
                            if (is_epsilon_context(childrenSnapshot, node)) {
                                epsilonCount++;
                                countedEpsilon = true;
                            } else {
                                invalidSpanCount++;
                            }
                        } else if (start === undefined || end === undefined || end < start) {
                            invalidSpanCount++;
                        }
                    }
                }
            }
            // Re-verify binding + container after endpoint/getText and before stacking children.
            // Do not re-read node.children; descriptor identity detects whole-array replacement.
            if (!children_snapshot_still_stable(node, childrenSnapshot)) {
                invalidSpanCount++;
                if (countedEpsilon) {
                    epsilonCount--;
                }
                continue;
            }
            for (var childIndex = 0; childIndex < childrenSnapshot.items.length; childIndex++) {
                stack.push(childrenSnapshot.items[childIndex]);
            }
        }
        return {
            count: count,
            epsilonCount: epsilonCount,
            valid: count > 0 && invalidSpanCount == 0,
        };
    } catch (error) {
        return {
            count: 0,
            epsilonCount: 0,
            valid: false,
        };
    }
}

function stable_error_message(error) {
    if (error instanceof Error) {
        return error.name + ': ' + error.message;
    }
    return String(error);
}

function create_analyzer(candidateConstructors) {
    var instances = Object.create(null);

    function parser_for(dialect) {
        if (!instances[dialect]) {
            var Constructor = candidateConstructors[dialect];
            if (!Constructor) {
                throw new Error('unsupported evaluation dialect: ' + dialect);
            }
            instances[dialect] = new Constructor();
        }
        return instances[dialect];
    }

    return function analyze(testCase) {
        var parser;
        var utf16Offsets = utf16_offsets_by_code_point(testCase.source);
        var errors = [];
        var tokens = [];
        var root = null;
        var analysisFailure = null;
        try {
            parser = parser_for(testCase.dialect);
            var diagnostics = parser.validate(testCase.source);
            if (!Array.isArray(diagnostics)) {
                throw new TypeError('validate must return an array');
            }
            errors = diagnostics.map(function(error) {
                return error && error.message ? error.message : String(error);
            });
        } catch (error) {
            analysisFailure = {
                stage: 'validate',
                message: stable_error_message(error),
            };
        }
        if (parser) {
            try {
                tokens = parser.getAllTokens(testCase.source);
            } catch (error) {
                if (!analysisFailure) {
                    analysisFailure = {
                        stage: 'tokenize',
                        message: stable_error_message(error),
                    };
                }
            }
        }
        var tokenEvidence;
        try {
            tokenEvidence = leaves_from_tokens(testCase.source, tokens, utf16Offsets);
        } catch (error) {
            if (!analysisFailure) {
                analysisFailure = {
                    stage: 'tokenize',
                    message: stable_error_message(error),
                };
            }
            tokenEvidence = leaves_from_tokens(testCase.source, [], utf16Offsets);
        }
        if (!analysisFailure && errors.length == 0) {
            try {
                root = parser.parse(testCase.source);
            } catch (error) {
                analysisFailure = {
                    stage: 'parse',
                    message: stable_error_message(error),
                };
            }
        }
        var inspection = { count: 0, epsilonCount: 0, valid: false };
        if (root && !analysisFailure) {
            try {
                inspection = inspect_nodes(root, utf16Offsets);
            } catch (error) {
                analysisFailure = {
                    stage: 'parse',
                    message: stable_error_message(error),
                };
            }
        }
        var status = analysisFailure
            ? 'analysis-failed'
            : errors.length > 0 ? 'syntax-rejected' : 'accepted';
        return {
            status: status,
            accepted: status == 'accepted',
            errors: status == 'analysis-failed' ? [] : errors,
            analysisFailure: analysisFailure,
            leaves: tokenEvidence.leaves,
            nativePartition: tokenEvidence.nativePartition,
            nodeCount: inspection.count,
            nodeSpansValid: inspection.valid,
        };
    };
}

var metadata = package_metadata();
exports.metadata = {
    name: metadata.name,
    version: metadata.version,
    license: metadata.license,
};
exports.analyze = create_analyzer(constructors);
exports.create_analyzer = create_analyzer;
exports.inspect_nodes = inspect_nodes;
