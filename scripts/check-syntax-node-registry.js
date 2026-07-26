#!/usr/bin/env node
'use strict';

var assert = require('assert');
var fs = require('fs');
var path = require('path');

var root = path.join(__dirname, '..');
var nodeSource = fs.readFileSync(
    path.join(root, 'src', 'core', 'syntax', 'node.ts'),
    'utf8'
);
var invariantRuntime = require(path.join(
    root,
    '.tmp',
    'v2-core',
    'core',
    'syntax',
    'invariants.js'
));
var declaredKinds = Array.from(nodeSource.matchAll(
    /extends\s+SyntaxNodeBase<"([^"]+)">/g
)).map(function(match) { return match[1]; }).sort();
var registry = invariantRuntime.NODE_KIND_REGISTRY;
var registryKinds = Object.keys(registry).sort();
var expectedFamilies = [
    'shape',
    'relationship',
    'container',
    'contextual-facts',
    'capability',
    'marker-closure'
];

assert.deepStrictEqual(registryKinds, declaredKinds,
    'every SyntaxNode kind must have exactly one registry entry');
assert.deepStrictEqual(Array.from(invariantRuntime.SYNTAX_KINDS).sort(), declaredKinds,
    'SYNTAX_KINDS must be derived from the node registry');
registryKinds.forEach(function(kind) {
    var entry = registry[kind];
    assert.strictEqual(entry.kind, kind, kind + ' registry identity');
    assert.strictEqual(entry.relationship.kind, kind,
        kind + ' relationship contract identity');
    assert.deepStrictEqual(entry.validatorFamilies, expectedFamilies,
        kind + ' must explicitly participate in every invariant family');
    assert.strictEqual(Object.isFrozen(entry), true, kind + ' registry entry');
    assert.strictEqual(Object.isFrozen(entry.validatorFamilies), true,
        kind + ' validator family list');
});

console.log('syntax node invariant registry check passed');
