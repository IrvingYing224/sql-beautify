#!/usr/bin/env node
'use strict';

var childProcess = require('child_process');
var path = require('path');
var manifest = require('./v2-suite-manifest');

var root = path.join(__dirname, '..');

function printableStep(step) {
    return [step.command].concat(step.args).join(' ');
}

function run(plan) {
    plan.steps.forEach(function(step, index) {
        console.log('[v2 suite ' + plan.name + ' ' + (index + 1) + '/' +
            plan.steps.length + '] ' + printableStep(step));
        var result = childProcess.spawnSync(step.command, step.args, {
            cwd: root,
            stdio: 'inherit',
            env: Object.assign({}, process.env, step.environment)
        });
        if (result.error) {
            throw result.error;
        }
        if (result.status !== 0) {
            throw new Error(
                'v2 suite step failed with status ' + String(result.status) +
                ': ' + printableStep(step)
            );
        }
    });
}

function main(args) {
    var name = args.filter(function(value) { return value.indexOf('--') !== 0; })[0];
    if (name === undefined) {
        throw new Error('Usage: node scripts/run-v2-suite.js <suite> [--plan] [--json]');
    }
    var plan = manifest.buildPlan(name);
    if (args.indexOf('--plan') >= 0) {
        var summary = {
            name: plan.name,
            counts: plan.steps.reduce(function(counts, step) {
                counts[step.category] = (counts[step.category] || 0) + 1;
                return counts;
            }, {}),
            steps: plan.steps.map(function(step) {
                return {
                    category: step.category,
                    command: step.command,
                    args: step.args,
                    environment: step.environment
                };
            })
        };
        if (args.indexOf('--json') >= 0) {
            process.stdout.write(JSON.stringify(summary, null, 4) + '\n');
        } else {
            console.log(JSON.stringify(summary, null, 4));
        }
        return;
    }
    run(plan);
}

try {
    main(process.argv.slice(2));
} catch (error) {
    console.error(error && error.stack ? error.stack : error);
    process.exitCode = 1;
}
