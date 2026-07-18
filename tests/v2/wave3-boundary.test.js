'use strict';

var assert = require('assert');
var childProcess = require('child_process');
var fs = require('fs');
var path = require('path');
var ts = require('typescript');

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

function parseTypeScript(relativePath, source) {
    var sourceFile = ts.createSourceFile(
        relativePath,
        source,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS
    );
    assert.strictEqual(
        sourceFile.parseDiagnostics.length,
        0,
        relativePath + ' must be syntactically valid TypeScript: ' +
            (sourceFile.parseDiagnostics[0]
                ? ts.flattenDiagnosticMessageText(
                    sourceFile.parseDiagnostics[0].messageText,
                    '\n'
                )
                : '')
    );
    return sourceFile;
}

function nodeLocation(relativePath, sourceFile, node) {
    var value = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    return relativePath + ':' + (value.line + 1) + ':' + (value.character + 1);
}

function staticStringValue(node) {
    if (ts.isStringLiteralLike(node)) {
        return node.text;
    }
    if (ts.isParenthesizedExpression(node)) {
        return staticStringValue(node.expression);
    }
    if (ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
        var left = staticStringValue(node.left);
        var right = staticStringValue(node.right);
        return left === null || right === null ? null : left + right;
    }
    return null;
}

function staticPropertyName(node) {
    if (ts.isPropertyAccessExpression(node)) {
        return node.name.text;
    }
    if (ts.isElementAccessExpression(node) && node.argumentExpression) {
        return staticStringValue(node.argumentExpression);
    }
    return null;
}

function staticDeclarationName(node) {
    if (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) {
        return node.text;
    }
    if (ts.isComputedPropertyName(node)) {
        return staticStringValue(node.expression);
    }
    return null;
}

function moduleRequests(relativePath, source, failClosed) {
    var sourceFile = parseTypeScript(relativePath, source);
    var requests = [];
    function record(node, expression, kind, argumentCount) {
        var request = expression && ts.isStringLiteralLike(expression)
            ? expression.text
            : null;
        if (request === null || (argumentCount !== undefined && argumentCount !== 1)) {
            if (failClosed) {
                assert.fail(
                    nodeLocation(relativePath, sourceFile, node) + ' ' + kind +
                    ' module request must contain exactly one string literal'
                );
            }
            return;
        }
        requests.push(request);
    }
    function visit(node) {
        if (ts.isImportDeclaration(node)) {
            record(node, node.moduleSpecifier, 'import');
        } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
            record(node, node.moduleSpecifier, 'export');
        } else if (ts.isImportEqualsDeclaration(node) &&
            ts.isExternalModuleReference(node.moduleReference)) {
            record(
                node,
                node.moduleReference.expression,
                'import-equals'
            );
        } else if (ts.isCallExpression(node) &&
            ts.isIdentifier(node.expression) &&
            node.expression.text === 'require') {
            record(node, node.arguments[0], 'require', node.arguments.length);
        } else if (ts.isCallExpression(node) &&
            node.expression.kind === ts.SyntaxKind.ImportKeyword) {
            record(node, node.arguments[0], 'dynamic import', node.arguments.length);
        }
        ts.forEachChild(node, visit);
    }
    visit(sourceFile);
    return requests;
}

function hasModifier(node, kind) {
    return !!node.modifiers && node.modifiers.some(function(modifier) {
        return modifier.kind === kind;
    });
}

function bindingNames(name, output) {
    if (ts.isIdentifier(name)) {
        output.push(name.text);
        return;
    }
    name.elements.forEach(function(element) {
        if (!ts.isOmittedExpression(element)) {
            bindingNames(element.name, output);
        }
    });
}

function runtimeExportNames(relativePath, source) {
    var sourceFile = parseTypeScript(relativePath, source);
    var names = [];
    sourceFile.statements.forEach(function(statement) {
        if (ts.isExportAssignment(statement)) {
            names.push(statement.isExportEquals ? 'export=' : 'default');
            return;
        }
        if (ts.isExportDeclaration(statement)) {
            if (statement.isTypeOnly) {
                return;
            }
            if (!statement.exportClause) {
                names.push('*');
                return;
            }
            if (ts.isNamespaceExport(statement.exportClause)) {
                names.push(statement.exportClause.name.text);
                return;
            }
            statement.exportClause.elements.forEach(function(element) {
                if (!element.isTypeOnly) {
                    names.push(element.name.text);
                }
            });
            return;
        }
        if (!hasModifier(statement, ts.SyntaxKind.ExportKeyword)) {
            return;
        }
        if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) {
            return;
        }
        if (hasModifier(statement, ts.SyntaxKind.DefaultKeyword)) {
            names.push('default');
            return;
        }
        if (ts.isVariableStatement(statement)) {
            statement.declarationList.declarations.forEach(function(declaration) {
                bindingNames(declaration.name, names);
            });
            return;
        }
        if (statement.name && ts.isIdentifier(statement.name)) {
            names.push(statement.name.text);
            return;
        }
        names.push('<anonymous-runtime-export>');
    });
    return names.sort();
}

function assertContextualInvariantEntryIsOrchestrator(relativePath, source) {
    var sourceFile = parseTypeScript(relativePath, source);
    var entry = sourceFile.statements.find(function(statement) {
        return ts.isFunctionDeclaration(statement) &&
            statement.name &&
            statement.name.text === 'validateContextualNodeFacts';
    });
    assert.ok(entry && entry.body, relativePath + ' must define its entry function');
    assert.strictEqual(entry.asteriskToken, undefined,
        relativePath + ' entry must not be a generator');
    assert.strictEqual(hasModifier(entry, ts.SyntaxKind.AsyncKeyword), false,
        relativePath + ' entry must not be async');
    assert.ok(entry.type && entry.type.kind === ts.SyntaxKind.VoidKeyword,
        relativePath + ' entry must retain an explicit void return type');
    function callShape(value) {
        assert.ok(value && ts.isCallExpression(value),
            relativePath + ' entry step must be a direct call');
        assert.ok(ts.isIdentifier(value.expression),
            relativePath + ' entry calls must target focused validators');
        return [value.expression.text, value.arguments.map(function(argument) {
            assert.ok(ts.isIdentifier(argument),
                relativePath + ' entry call arguments must be direct identifiers');
            return argument.text;
        })];
    }
    function variableCall(statement, name) {
        assert.ok(ts.isVariableStatement(statement),
            relativePath + ' entry must declare ' + name);
        assert.strictEqual(statement.declarationList.declarations.length, 1);
        var declaration = statement.declarationList.declarations[0];
        assert.ok(ts.isIdentifier(declaration.name));
        assert.strictEqual(declaration.name.text, name);
        return callShape(declaration.initializer);
    }
    function expressionCall(statement) {
        assert.ok(ts.isExpressionStatement(statement),
            relativePath + ' validator step must be an expression statement');
        return callShape(statement.expression);
    }
    assert.strictEqual(entry.body.statements.length, 5,
        relativePath + ' entry must contain exactly five orchestration steps');
    assert.deepStrictEqual(variableCall(entry.body.statements[0], 'context'), [
        'createContextualInvariantContext',
        ['raw', 'directChildren', 'leaves', 'failures', 'dialectContext',
            'trustedCanonicalShape', 'scratch']
    ]);
    var guard = entry.body.statements[1];
    assert.ok(ts.isIfStatement(guard) && !guard.elseStatement,
        relativePath + ' entry must contain only the null-context guard');
    assert.ok(ts.isBinaryExpression(guard.expression));
    assert.strictEqual(guard.expression.operatorToken.kind,
        ts.SyntaxKind.EqualsEqualsEqualsToken);
    assert.ok(ts.isIdentifier(guard.expression.left));
    assert.strictEqual(guard.expression.left.text, 'context');
    assert.strictEqual(guard.expression.right.kind, ts.SyntaxKind.NullKeyword);
    assert.ok(ts.isBlock(guard.thenStatement));
    assert.strictEqual(guard.thenStatement.statements.length, 1);
    var guardReturn = guard.thenStatement.statements[0];
    assert.ok(ts.isReturnStatement(guardReturn));
    assert.strictEqual(guardReturn.expression, undefined,
        relativePath + ' null-context guard must use a bare return');
    assert.deepStrictEqual(expressionCall(entry.body.statements[2]), [
        'validateCapabilityAllowlist', ['context']
    ]);
    assert.deepStrictEqual(variableCall(entry.body.statements[3], 'facts'), [
        'validateContextualFactShape', ['context']
    ]);
    assert.deepStrictEqual(expressionCall(entry.body.statements[4]), [
        'validateExactMarkerClosure', ['context', 'facts']
    ]);
}

function assertNoRawGrammarOrSourceSlice(relativePath, source) {
    var sourceFile = parseTypeScript(relativePath, source);
    function visit(node) {
        if ((ts.isPropertyAccessExpression(node) ||
            ts.isElementAccessExpression(node)) &&
            staticPropertyName(node) === 'raw') {
            assert.fail(nodeLocation(relativePath, sourceFile, node) +
                ' layout must not read token raw');
        }
        if (ts.isBindingElement(node)) {
            var boundName = node.propertyName || node.name;
            if (staticDeclarationName(boundName) === 'raw') {
                assert.fail(nodeLocation(relativePath, sourceFile, node) +
                    ' layout must not destructure token raw');
            }
        }
        if (ts.isCallExpression(node) &&
            (ts.isPropertyAccessExpression(node.expression) ||
                ts.isElementAccessExpression(node.expression)) &&
            ['slice', 'substring', 'substr'].indexOf(
                staticPropertyName(node.expression)
            ) >= 0) {
            var receiver = node.expression.expression.getText(sourceFile);
            if (/(?:^|\.)source(?:$|\[|\.)/.test(receiver)) {
                assert.fail(nodeLocation(relativePath, sourceFile, node) +
                    ' layout must not re-scan source substrings');
            }
        }
        ts.forEachChild(node, visit);
    }
    visit(sourceFile);
}

function assertNoPolicyRawOrSourceAccess(relativePath, source) {
    var sourceFile = parseTypeScript(relativePath, source);
    var forbidden = new Set(['raw', 'source']);
    function visit(node) {
        if ((ts.isPropertyAccessExpression(node) ||
            ts.isElementAccessExpression(node)) &&
            forbidden.has(staticPropertyName(node))) {
            assert.fail(nodeLocation(relativePath, sourceFile, node) +
                ' query policy must not access source or token raw');
        }
        if (ts.isBindingElement(node)) {
            var boundName = node.propertyName || node.name;
            if (forbidden.has(staticDeclarationName(boundName))) {
                assert.fail(nodeLocation(relativePath, sourceFile, node) +
                    ' query policy must not destructure source or token raw');
            }
        }
        ts.forEachChild(node, visit);
    }
    visit(sourceFile);
}

function assertPolicyUsesNarrowContext(relativePath, source) {
    var sourceFile = parseTypeScript(relativePath, source);
    var importedNarrowContext = false;
    var forbiddenImports = new Set([
        'AnalyzedArtifact',
        'LayoutPlanBuilder',
        'DominatingVerbatimClaims'
    ]);
    function visitForbiddenType(node) {
        if (ts.isIdentifier(node) && forbiddenImports.has(node.text)) {
            assert.fail(nodeLocation(relativePath, sourceFile, node) +
                ' query policy must use the narrow context instead of ' +
                node.text);
        }
        ts.forEachChild(node, visitForbiddenType);
    }
    sourceFile.statements.forEach(function(statement) {
        if ((ts.isInterfaceDeclaration(statement) ||
            ts.isTypeAliasDeclaration(statement) ||
            ts.isClassDeclaration(statement)) &&
            statement.name && statement.name.text === 'QueryLayoutContext') {
            assert.fail(nodeLocation(relativePath, sourceFile, statement) +
                ' query policy must not redeclare QueryLayoutContext');
        }
        if (!ts.isImportDeclaration(statement) ||
            !ts.isStringLiteralLike(statement.moduleSpecifier) ||
            !statement.importClause ||
            !statement.importClause.namedBindings ||
            !ts.isNamedImports(statement.importClause.namedBindings)) {
            return;
        }
        statement.importClause.namedBindings.elements.forEach(function(specifier) {
            var importedName = specifier.propertyName
                ? specifier.propertyName.text
                : specifier.name.text;
            if (statement.moduleSpecifier.text === './query-layout-context' &&
                importedName === 'QueryLayoutContext') {
                importedNarrowContext = true;
            }
        });
    });
    visitForbiddenType(sourceFile);
    assert.strictEqual(importedNarrowContext, true,
        relativePath + ' must import QueryLayoutContext from query-layout-context');
}

function assertInterfaceSurface(relativePath, interfaceName, expectedNames) {
    var source = fs.readFileSync(path.join(root, relativePath), 'utf8');
    var sourceFile = parseTypeScript(relativePath, source);
    var matches = sourceFile.statements.filter(function(statement) {
        return ts.isInterfaceDeclaration(statement) &&
            statement.name.text === interfaceName;
    });
    assert.strictEqual(matches.length, 1,
        relativePath + ' must declare exactly one ' + interfaceName);
    var declaration = matches[0];
    assert.strictEqual(
        declaration.modifiers && declaration.modifiers.some(function(modifier) {
            return modifier.kind === ts.SyntaxKind.ExportKeyword;
        }),
        true,
        interfaceName + ' must be exported'
    );
    assert.strictEqual(declaration.heritageClauses, undefined,
        interfaceName + ' must not widen its surface through inheritance');
    var names = declaration.members.map(function(member) {
        assert.ok(
            (ts.isPropertySignature(member) || ts.isMethodSignature(member)) &&
                member.name,
            interfaceName + ' must expose only named properties or methods'
        );
        if (ts.isIdentifier(member.name) || ts.isStringLiteralLike(member.name)) {
            return member.name.text;
        }
        if (ts.isComputedPropertyName(member.name)) {
            var value = staticStringValue(member.name.expression);
            assert.notStrictEqual(value, null,
                interfaceName + ' must not expose a computed property');
            return value;
        }
        assert.fail(interfaceName + ' contains an unsupported property name');
    }).sort();
    assert.deepStrictEqual(names, expectedNames.slice().sort(),
        interfaceName + ' public surface must stay narrow');
}

(function testModuleRequestAstCoverageAndFailClosedBehavior() {
    var source = [
        'import defaultValue from "imported";',
        'import "side-effect";',
        'export { value } from "exported";',
        'import alias = require("import-equals");',
        'const required = require("required");',
        'const dynamic = import("dynamic");'
    ].join('\n');
    assert.deepStrictEqual(moduleRequests('module-request-probe.ts', source, true), [
        'imported',
        'side-effect',
        'exported',
        'import-equals',
        'required',
        'dynamic'
    ]);
    [
        'const request = require(moduleName);',
        'const request = require("prefix/" + moduleName);',
        'const request = import(moduleName);',
        'const request = import(`prefix/${moduleName}`);'
    ].forEach(function(nonLiteralSource) {
        assert.throws(function() {
            moduleRequests('query-policy-probe.ts', nonLiteralSource, true);
        }, /module request must contain exactly one string literal/);
    });
})();

(function testPolicyPropertyGuardCoversStaticAndComputedSyntax() {
    [
        'value.source;',
        'value["source"];',
        'value.raw;',
        'value["r" + "aw"];',
        'const { source: sql } = value;',
        'const { raw } = value;',
        'const { ["r" + "aw"]: token } = value;'
    ].forEach(function(forbiddenSource) {
        assert.throws(function() {
            assertNoPolicyRawOrSourceAccess(
                'query-policy-property-probe.ts',
                forbiddenSource
            );
        }, /must not (?:access|destructure) source or token raw/);
    });
})();

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

var queryPolicyManifest = [
    'src/core/layout/query-policy.ts',
    'src/core/layout/query-list-policy.ts',
    'src/core/layout/query-relation-policy.ts'
];
var queryPolicyFiles = collectFiles('src/core/layout').filter(function(relativePath) {
    return /^src\/core\/layout\/query-(?:.*-)?policy\.ts$/.test(relativePath);
});
assert.deepStrictEqual(
    queryPolicyFiles,
    queryPolicyManifest.slice().sort(),
    'every query-*-policy module must be reviewed and declared explicitly'
);
var expressionPolicyManifest = [
    'src/core/layout/expression-policy.ts',
    'src/core/layout/expression-case-policy.ts',
    'src/core/layout/expression-container-policy.ts',
    'src/core/layout/expression-operator-policy.ts'
];
var expressionPolicyFiles = collectFiles('src/core/layout').filter(function(relativePath) {
    return /^src\/core\/layout\/expression-(?:.*-)?policy\.ts$/.test(relativePath);
});
assert.deepStrictEqual(
    expressionPolicyFiles,
    expressionPolicyManifest.slice().sort(),
    'every expression-*-policy module must be reviewed and declared explicitly'
);
var hivePolicyManifest = [
    'src/core/layout/dialect-policy.ts',
    'src/core/layout/keyword-policy.ts',
    'src/core/layout/trivia-policy.ts'
];
var narrowPolicyFiles = queryPolicyFiles.concat(
    expressionPolicyFiles,
    hivePolicyManifest
).sort();
var queryLayoutBoundaryFiles = [
    'src/core/layout/query-layout-context.ts'
].concat(narrowPolicyFiles);
var policyRawGuardFiles = new Set(
    ['src/core/layout/policy.ts'].concat(narrowPolicyFiles)
);
var failClosedModuleRequestFiles = new Set(
    ['src/core/layout/policy.ts'].concat(queryLayoutBoundaryFiles)
);

var wave3BoundaryManifest = [
    'docs/superpowers/specs/2026-07-16-sql-formatter-v2-wave-3-layout-renderer-design.md',
    'docs/superpowers/plans/2026-07-16-sql-formatter-v2-wave-3-layout-renderer-plan.md',
    'src/core/analysis/artifact.ts',
    'src/core/config/resolve-options.ts',
    'src/core/dialects/capability-state.ts',
    'src/core/syntax/contextual-fact-contract.ts',
    'src/core/syntax/cst-capability-allowlist-invariants.ts',
    'src/core/syntax/cst-contextual-fact-invariants.ts',
    'src/core/syntax/cst-contextual-invariant-context.ts',
    'src/core/syntax/cst-contextual-invariant-support.ts',
    'src/core/syntax/cst-contextual-invariants.ts',
    'src/core/syntax/cst-dialect-context.ts',
    'src/core/syntax/cst-marker-closure-invariants.ts',
    'src/core/syntax/primitive-capability.ts',
    'src/core/layout/doc.ts',
    'src/core/layout/doc-factory.ts',
    'src/core/layout/artifact.ts',
    'src/core/layout/invariants.ts',
    'src/core/layout/resource-budget.ts',
    'src/core/layout/verbatim-claims.ts',
    'src/core/layout/alignment-policy.ts',
    'src/core/layout/plan.ts',
    'src/core/layout/compiler.ts',
    'src/core/layout/policy.ts',
    'src/core/layout/expression-policy.ts',
    'src/core/layout/expression-case-policy.ts',
    'src/core/layout/expression-container-policy.ts',
    'src/core/layout/expression-operator-policy.ts',
    'src/core/layout/dialect-policy.ts',
    'src/core/layout/keyword-policy.ts',
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
    'tests/v2/wave3c-plan-scopes.test.js',
    'tests/v2/wave3c-hive-query-layout.test.js',
    'tests/v2/wave3c-resource-closure.test.js',
    'tests/fixtures/v2-wave3c-hive-query-cases.js',
    'tests/v2/wave3d-expression-layout.test.js',
    'tests/v2/wave3d-resource-closure.test.js',
    'tests/fixtures/v2-wave3d-expression-cases.js',
    'tests/fixtures/v2-wave3-corpus-cases.js',
    'tests/v2/wave3e-trivia-layout.test.js',
    'tests/v2/wave3e-alignment-options.test.js',
    'tests/v2/wave3e-dialect-layout.test.js',
    'tests/v2/wave3e-option-matrix.test.js',
    'tests/v2/wave3-properties.test.js',
    'tests/v2/wave3-alignment-performance.test.js',
    'tests/v2/wave3-performance.test.js',
    'tests/v2/wave3-performance-relative.test.js',
    'tests/fixtures/v2-layout-cases.js'
].concat(queryLayoutBoundaryFiles);

wave3BoundaryManifest.forEach(function(relativePath) {
    assert.ok(fs.existsSync(path.join(root, relativePath)),
        'Wave 3A requires ' + relativePath);
});

var contextualInvariantManifest = [
    'src/core/syntax/cst-capability-allowlist-invariants.ts',
    'src/core/syntax/cst-contextual-fact-invariants.ts',
    'src/core/syntax/cst-contextual-invariant-context.ts',
    'src/core/syntax/cst-contextual-invariant-support.ts',
    'src/core/syntax/cst-contextual-invariants.ts',
    'src/core/syntax/cst-marker-closure-invariants.ts'
].sort();
var contextualInvariantFiles = collectFiles('src/core/syntax').filter(function(file) {
    return /^src\/core\/syntax\/cst-(?:contextual(?:-|$)|capability-allowlist-|marker-closure-)/
        .test(file);
});
assert.deepStrictEqual(
    contextualInvariantFiles,
    contextualInvariantManifest,
    'every contextual invariant module must be explicitly reviewed and declared'
);

var contextualInternalRequests = Object.freeze({
    'src/core/syntax/cst-contextual-invariants.ts': Object.freeze([
        './cst-capability-allowlist-invariants',
        './cst-contextual-fact-invariants',
        './cst-contextual-invariant-context',
        './cst-marker-closure-invariants'
    ]),
    'src/core/syntax/cst-contextual-invariant-context.ts': Object.freeze([]),
    'src/core/syntax/cst-contextual-invariant-support.ts': Object.freeze([]),
    'src/core/syntax/cst-capability-allowlist-invariants.ts': Object.freeze([
        './cst-contextual-invariant-context',
        './cst-contextual-invariant-support'
    ]),
    'src/core/syntax/cst-contextual-fact-invariants.ts': Object.freeze([
        './cst-contextual-invariant-context',
        './cst-contextual-invariant-support'
    ]),
    'src/core/syntax/cst-marker-closure-invariants.ts': Object.freeze([
        './cst-contextual-invariant-context',
        './cst-contextual-invariant-support'
    ])
});
var forbiddenContextualBehavior = [
    'LayoutDoc',
    'LayoutPlan',
    'RenderSuccess',
    'QueryLayoutContext',
    'measureDisplayText',
    'keywordCase',
    'commaStyle',
    'indentStyle',
    'caseLayout',
    'maxAlignWidth',
    'maxLineLength',
    'unsupportedSyntaxPolicy'
];
contextualInvariantManifest.forEach(function(relativePath) {
    var source = fs.readFileSync(path.join(root, relativePath), 'utf8');
    var internalRequests = moduleRequests(relativePath, source, true)
        .filter(function(request) {
            return request.indexOf('./cst-contextual-') === 0 ||
                request.indexOf('./cst-capability-allowlist-') === 0 ||
                request.indexOf('./cst-marker-closure-') === 0;
        }).sort();
    assert.deepStrictEqual(
        internalRequests,
        contextualInternalRequests[relativePath].slice().sort(),
        relativePath + ' must follow the acyclic contextual invariant dependency graph'
    );
    moduleRequests(relativePath, source, true).forEach(function(request) {
        assert.strictEqual(
            /(?:^|\/)(?:layout|renderer)(?:\/|$)/.test(request),
            false,
            relativePath + ' must not depend on downstream ' + request
        );
    });
    forbiddenContextualBehavior.forEach(function(identifier) {
        assert.strictEqual(
            new RegExp('\\b' + identifier + '\\b').test(source),
            false,
            relativePath + ' must not contain layout, renderer or option behavior ' +
                identifier
        );
    });
});

var contextualEntryPath = 'src/core/syntax/cst-contextual-invariants.ts';
var contextualEntrySource = fs.readFileSync(
    path.join(root, contextualEntryPath),
    'utf8'
);
assert.deepStrictEqual(
    runtimeExportNames(contextualEntryPath, contextualEntrySource),
    ['validateContextualNodeFacts'],
    'contextual invariant entry must expose only its stable public validator'
);
assertContextualInvariantEntryIsOrchestrator(
    contextualEntryPath,
    contextualEntrySource
);
[
    'export const extraRuntime = 1;',
    'export class ExtraRuntime {}',
    'const hiddenRuntime = 1; export { hiddenRuntime };',
    'export default 1;',
    "export * from './cst-contextual-invariant-context';"
].forEach(function(extraExport) {
    assert.notDeepStrictEqual(
        runtimeExportNames(
            contextualEntryPath,
            contextualEntrySource + '\n' + extraExport
        ),
        ['validateContextualNodeFacts'],
        'runtime export probe must detect ' + extraExport
    );
});
var contextualFastPathProbe = contextualEntrySource.replace(
    'if (context === null) {',
    'if (context === null || raw.kind === "expression") {'
);
assert.notStrictEqual(contextualFastPathProbe, contextualEntrySource,
    'orchestrator fast-path probe must alter the entry guard');
assert.throws(function() {
    assertContextualInvariantEntryIsOrchestrator(
        contextualEntryPath,
        contextualFastPathProbe
    );
}, 'entry boundary must reject raw-dependent fast paths');
var contextualReturnExpressionProbe = contextualEntrySource.replace(
    '        return;',
    '        return validateContextualNodeFacts(raw, directChildren, leaves, ' +
        'failures, dialectContext, trustedCanonicalShape);'
);
assert.notStrictEqual(contextualReturnExpressionProbe, contextualEntrySource,
    'orchestrator return-expression probe must alter the bare return');
assert.throws(function() {
    assertContextualInvariantEntryIsOrchestrator(
        contextualEntryPath,
        contextualReturnExpressionProbe
    );
}, 'entry boundary must reject return-expression fast paths');

collectFiles('src/core/syntax').filter(function(file) {
    return /\.ts$/.test(file) && contextualInvariantManifest.indexOf(file) < 0;
}).forEach(function(relativePath) {
    var source = fs.readFileSync(path.join(root, relativePath), 'utf8');
    var contextualRequests = moduleRequests(relativePath, source, false)
        .filter(function(request) {
            return request.indexOf('./cst-contextual-') === 0 ||
                request.indexOf('./cst-capability-allowlist-') === 0 ||
                request.indexOf('./cst-marker-closure-') === 0;
        });
    assert.deepStrictEqual(
        contextualRequests,
        relativePath === 'src/core/syntax/cst-invariants.ts'
            ? [
                './cst-contextual-invariant-context',
                './cst-contextual-invariants'
            ]
            : [],
        relativePath + ' must not bypass the contextual invariant orchestrator'
    );
});
[
    'src/core/layout/query-layout-context.ts',
    'src/core/layout/query-policy.ts',
    'src/core/layout/query-list-policy.ts',
    'src/core/layout/query-relation-policy.ts',
    'src/core/layout/trivia-policy.ts'
].forEach(function(relativePath) {
    assert.ok(queryLayoutBoundaryFiles.indexOf(relativePath) >= 0,
        'Wave 3C boundary manifest must include ' + relativePath);
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
    'wave3c-plan-scopes.test.js',
    'wave3c-hive-query-layout.test.js',
    'wave3c-resource-closure.test.js',
    'wave3d-expression-layout.test.js',
    'wave3d-resource-closure.test.js',
    'wave3e-trivia-layout.test.js',
    'wave3e-alignment-options.test.js',
    'wave3e-dialect-layout.test.js',
    'wave3e-option-matrix.test.js',
    'wave3-properties.test.js',
    'wave3-alignment-performance.test.js',
    'wave3-performance.test.js',
    'wave3-performance-relative.test.js',
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

assertInterfaceSurface(
    'src/core/layout/query-layout-context.ts',
    'LayoutAnalysisView',
    ['leafCount', 'root', 'index', 'leafKind', 'leafChannel']
);
assertInterfaceSurface(
    'src/core/layout/query-layout-context.ts',
    'QueryPlanRegistration',
    ['options', 'setKeywordCase', 'replaceGap', 'wrapRange']
);

var forbiddenRequest = /^(?:vscode|dt-sql-parser|esbuild)(?:\/|$)/;
collectFiles('src/core/layout').filter(function(file) {
    return /\.ts$/.test(file);
}).forEach(function(relativePath) {
    var source = fs.readFileSync(path.join(root, relativePath), 'utf8');
    assertNoRawGrammarOrSourceSlice(relativePath, source);
    var requests = moduleRequests(
        relativePath,
        source,
        failClosedModuleRequestFiles.has(relativePath)
    );
    requests.forEach(function(request) {
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
    requests.forEach(function(request) {
        assert.strictEqual(/syntax\/(?:.*-)?parser(?:$|\/)/.test(request), false,
            relativePath + ' must not import parser helpers: ' + request);
        assert.strictEqual(/dialects\/registry$/.test(request), false,
            relativePath + ' must not import dialect registry: ' + request);
    });
    if (policyRawGuardFiles.has(relativePath)) {
        assertNoPolicyRawOrSourceAccess(relativePath, source);
    }
    if (narrowPolicyFiles.indexOf(relativePath) >= 0) {
        assertPolicyUsesNarrowContext(relativePath, source);
    }
});

(function testRuntimeQueryPolicyViewsExposeOnlyNarrowCapabilities() {
    var analysisApi = require('../../.tmp/v2-core/core/analysis/index.js');
    var contextApi = require(
        '../../.tmp/v2-core/core/layout/query-layout-context.js'
    );
    var optionsApi = require('../../.tmp/v2-core/core/config/resolve-options.js');
    var planApi = require('../../.tmp/v2-core/core/layout/plan.js');
    var claimsApi = require('../../.tmp/v2-core/core/layout/verbatim-claims.js');
    var analysis = analysisApi.analyzeSql('select 1', {
        dialect: 'hive',
        mode: 'document'
    });
    assert.strictEqual(analysis.status, 'analyzed');
    var resolved = optionsApi.resolveFormatOptions({ dialect: 'hive' });
    assert.strictEqual(resolved.ok, true);
    var builder = planApi.createLayoutPlanBuilder(analysis, resolved.options);
    var claims = claimsApi.dominatingVerbatimClaims(analysis);
    assert.ok(builder);
    assert.ok(claims);
    var context = contextApi.createQueryLayoutContext(builder, claims);
    assert.ok(context);
    assert.strictEqual(Object.isFrozen(context.analysis), true);
    assert.strictEqual(Object.isFrozen(context.plan), true);
    assert.deepStrictEqual(
        Object.getOwnPropertyNames(context.analysis).sort(),
        ['index', 'leafChannel', 'leafCount', 'leafKind', 'root']
    );
    assert.deepStrictEqual(
        Object.getOwnPropertyNames(context.plan).sort(),
        ['options', 'replaceGap', 'setKeywordCase', 'wrapRange']
    );
    ['source', 'leaves', 'raw'].forEach(function(forbiddenName) {
        assert.strictEqual(forbiddenName in context.analysis, false,
            'analysis view must not expose ' + forbiddenName);
    });
    assert.strictEqual('analysis' in context.plan, false,
        'plan registration view must not expose the full analysis');
})();

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
        moduleRequests(relativePath, source, false).forEach(function(request) {
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
    moduleRequests(relativePath, source, false).forEach(function(request) {
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
assert.deepStrictEqual(packagedFiles.filter(function(file) {
    return /\.ts$/.test(file);
}), [], 'VSIX must not contain any TypeScript source');

console.log('v2 Wave 3 boundary tests passed');
