'use strict';

var assert = require('assert');
var budgets = require('../../.tmp/v2-core/core/layout/resource-budget.js');

(function testEmptyInputUsesOneUnitFloor() {
    var budget = budgets.createLayoutResourceBudget(0, 0, 0);
    assert.ok(budget);
    assert.strictEqual(Object.isFrozen(budget), true);
    assert.deepStrictEqual(budget, {
        inputUnits: 1,
        sourceLength: 0,
        maxDocNodes: 88,
        maxPlanActions: 80,
        maxGraphNesting: 65,
        maxCumulativeIndentLevels: 33,
        maxPendingLineSuffixes: 1,
        maxGeneratedColumnsPerLine: 260,
        maxGeneratedWhitespaceCodeUnits: 4128,
        maxOutputCodeUnits: 4128
    });
})();

(function testFormulaUsesLeavesPlusNodes() {
    var budget = budgets.createLayoutResourceBudget(100, 2, 3);
    assert.ok(budget);
    assert.strictEqual(budget.inputUnits, 5);
    assert.strictEqual(budget.maxDocNodes, 184);
    assert.strictEqual(budget.maxPlanActions, 144);
    assert.strictEqual(budget.maxGeneratedColumnsPerLine, 276);
    assert.strictEqual(budget.maxGeneratedWhitespaceCodeUnits, 4456);
    assert.strictEqual(budget.maxOutputCodeUnits, 4556);
})();

(function testCapsAreDeterministic() {
    var budget = budgets.createLayoutResourceBudget(50000, 5000, 5000);
    assert.ok(budget);
    assert.strictEqual(budget.maxGraphNesting, 4096);
    assert.strictEqual(budget.maxCumulativeIndentLevels, 512);
    assert.strictEqual(budget.maxPendingLineSuffixes, 4096);
})();

(function testInvalidAndOverflowInputsFailClosed() {
    [
        [-1, 0, 0],
        [0, -1, 0],
        [0, 0, -1],
        [0.5, 0, 0],
        [0, NaN, 0],
        [0, 0, Infinity],
        [Number.MAX_SAFE_INTEGER, 1, 1],
        [0, Number.MAX_SAFE_INTEGER, 1],
        [0, Math.floor((Number.MAX_SAFE_INTEGER - 64) / 24) + 1, 0],
        [Math.floor(Number.MAX_SAFE_INTEGER / 3), 1, 0]
    ].forEach(function(args) {
        assert.strictEqual(
            budgets.createLayoutResourceBudget(args[0], args[1], args[2]),
            null,
            'invalid budget input must fail: ' + JSON.stringify(args)
        );
    });
})();

console.log('v2 Wave 3A layout resource budget tests passed');
