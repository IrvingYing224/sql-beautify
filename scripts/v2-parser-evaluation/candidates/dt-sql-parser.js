var fs = require('fs');
var path = require('path');
var esbuild = require('esbuild');

function load_dt_sql_parser() {
    var outputDir = path.join(process.cwd(), '.tmp', 'v2-parser-evaluation');
    var outputFile = path.join(outputDir, 'dt-sql-parser-api.cjs');
    fs.mkdirSync(outputDir, { recursive: true });
    esbuild.buildSync({
        entryPoints: [require.resolve('dt-sql-parser')],
        outfile: outputFile,
        bundle: true,
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
var instances = Object.create(null);

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

function parser_for(dialect) {
    if (!instances[dialect]) {
        var Constructor = constructors[dialect];
        if (!Constructor) {
            throw new Error('unsupported evaluation dialect: ' + dialect);
        }
        instances[dialect] = new Constructor();
    }
    return instances[dialect];
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

function leaves_from_tokens(source, tokens, utf16Offsets) {
    var usable = tokens.filter(function(token) {
        return Number.isInteger(token.start)
            && Number.isInteger(token.stop)
            && token.start >= 0
            && token.stop >= token.start
            && token.stop + 1 < utf16Offsets.length;
    }).sort(function(left, right) {
        return left.start - right.start || left.stop - right.stop;
    });
    var leaves = [];
    var cursor = 0;
    usable.forEach(function(token) {
        var start = utf16Offsets[token.start];
        var end = utf16Offsets[token.stop + 1];
        if (start < cursor) {
            return;
        }
        if (start > cursor) {
            leaves.push({
                kind: 'gap',
                raw: source.slice(cursor, start),
                span: { start: cursor, end: start },
            });
        }
        leaves.push({
            kind: token.channel == 0 ? 'token' : 'trivia',
            raw: source.slice(start, end),
            span: { start: start, end: end },
        });
        cursor = end;
    });
    if (cursor < source.length) {
        leaves.push({
            kind: 'gap',
            raw: source.slice(cursor),
            span: { start: cursor, end: source.length },
        });
    }
    if (leaves.length == 0 && source.length > 0) {
        leaves.push({
            kind: 'opaque',
            raw: source,
            span: { start: 0, end: source.length },
        });
    }
    return leaves;
}

function inspect_nodes(root, utf16Offsets) {
    var count = 0;
    var invalidSpanCount = 0;
    var stack = root ? [root] : [];
    var seen = new Set();
    while (stack.length > 0) {
        var node = stack.pop();
        if (!node || typeof node != 'object' || seen.has(node)) {
            continue;
        }
        seen.add(node);
        if (Number.isInteger(node.ruleIndex) && node.ruleIndex >= 0) {
            count++;
            if (!node.start || !node.stop
                || !Number.isInteger(node.start.start)
                || !Number.isInteger(node.stop.stop)) {
                invalidSpanCount++;
            } else {
                var startIndex = node.start.start;
                var endIndex = node.stop.stop + 1;
                var start = utf16Offsets[startIndex];
                var end = utf16Offsets[endIndex];
                if (startIndex < 0 || endIndex < startIndex
                    || start === undefined || end === undefined) {
                    invalidSpanCount++;
                }
            }
        }
        if (Array.isArray(node.children)) {
            node.children.forEach(function(child) {
                stack.push(child);
            });
        }
    }
    return {
        count: count,
        valid: count > 0 && invalidSpanCount == 0,
    };
}

function analyze(testCase) {
    var parser = parser_for(testCase.dialect);
    var utf16Offsets = utf16_offsets_by_code_point(testCase.source);
    var errors = [];
    var tokens = [];
    var root = null;
    try {
        errors = parser.validate(testCase.source).map(function(error) {
            return error.message || String(error);
        });
    } catch (error) {
        errors.push(error && error.message ? error.message : String(error));
    }
    try {
        tokens = parser.getAllTokens(testCase.source);
    } catch (error) {
        errors.push(error && error.message ? error.message : String(error));
    }
    if (errors.length == 0) {
        try {
            root = parser.parse(testCase.source);
        } catch (error) {
            errors.push(error && error.message ? error.message : String(error));
        }
    }
    var inspection = inspect_nodes(root, utf16Offsets);
    return {
        accepted: errors.length == 0,
        errors: errors,
        leaves: leaves_from_tokens(testCase.source, tokens, utf16Offsets),
        nodeCount: inspection.count,
        nodeSpansValid: inspection.valid,
    };
}

var metadata = package_metadata();
exports.metadata = {
    name: metadata.name,
    version: metadata.version,
    license: metadata.license,
};
exports.analyze = analyze;
