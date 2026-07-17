#!/usr/bin/env node
'use strict';

var fs = require('fs');
var path = require('path');
var crypto = require('crypto');

var UNICODE_VERSION = '15.1.0';
var SOURCE_MANIFEST = Object.freeze([
    Object.freeze({
        label: 'GraphemeBreakProperty.txt',
        sha256: 'a7e52eee647e52dc210b8719b4d7037276f4b353810293d69377fc46374cec3f',
        versionPattern: /^# GraphemeBreakProperty-15\.1\.0\.txt$/m
    }),
    Object.freeze({
        label: 'DerivedCoreProperties.txt',
        sha256: 'f55d0db69123431a7317868725b1fcbf1eab6b265d756d1bd7f0f6d9f9ee108b',
        versionPattern: /^# DerivedCoreProperties-15\.1\.0\.txt$/m
    }),
    Object.freeze({
        label: 'emoji-data.txt',
        sha256: 'd7aef489c8fe4c14f09ea5695200277c6b93ac82ac60845cdd2161b0d6835cc1',
        versionPattern: /^# Used with Emoji Version 15\.1 and subsequent minor revisions \(if any\)$/m
    }),
    Object.freeze({
        label: 'EastAsianWidth.txt',
        sha256: 'b08191401dc125f4e84ef262a95754faae6b737c79538e17ea9664a63434e94e',
        versionPattern: /^# EastAsianWidth-15\.1\.0\.txt$/m
    })
]);

var PROPERTY_ORDER = Object.freeze([
    'GCB_CONTROL',
    'GCB_EXTEND',
    'GCB_PREPEND',
    'GCB_SPACING_MARK',
    'GCB_ZWJ',
    'GCB_REGIONAL_INDICATOR',
    'GCB_L',
    'GCB_V',
    'GCB_T',
    'GCB_LV',
    'GCB_LVT',
    'INCB_CONSONANT',
    'INCB_EXTEND',
    'INCB_LINKER',
    'EXTENDED_PICTOGRAPHIC',
    'EMOJI',
    'EMOJI_PRESENTATION',
    'EMOJI_MODIFIER',
    'EMOJI_MODIFIER_BASE',
    'EAST_ASIAN_WIDE_OR_FULLWIDTH'
]);

function parseRange(value) {
    var pieces = value.trim().split('..');
    var start = parseInt(pieces[0], 16);
    var end = pieces.length === 1 ? start : parseInt(pieces[1], 16);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) ||
        start < 0 || end < start || end > 0x10FFFF) {
        throw new Error('Invalid Unicode range: ' + value);
    }
    return [start, end];
}

function verifiedSource(file, manifest) {
    var raw = fs.readFileSync(file);
    var actualSha256 = crypto.createHash('sha256').update(raw).digest('hex');
    var text = raw.toString('utf8');
    if (actualSha256 !== manifest.sha256) {
        throw new Error(
            manifest.label + ' SHA-256 mismatch: expected ' +
                manifest.sha256 + ', got ' + actualSha256
        );
    }
    if (!manifest.versionPattern.test(text)) {
        throw new Error(
            manifest.label + ' does not declare Unicode ' + UNICODE_VERSION
        );
    }
    return text;
}

function collect(text, classify, output) {
    text.split(/\r?\n/).forEach(function(line) {
        var body = line.replace(/#.*/, '').trim();
        if (!body) {
            return;
        }
        var fields = body.split(';').map(function(value) {
            return value.trim();
        });
        var property = classify(fields);
        if (property === null) {
            return;
        }
        output[property].push(parseRange(fields[0]));
    });
}

function mergeRanges(ranges) {
    ranges.sort(function(left, right) {
        return left[0] - right[0] || left[1] - right[1];
    });
    var merged = [];
    ranges.forEach(function(range) {
        var previous = merged[merged.length - 1];
        if (previous && range[0] <= previous[1] + 1) {
            previous[1] = Math.max(previous[1], range[1]);
        } else {
            merged.push(range.slice());
        }
    });
    return merged;
}

function hex(value) {
    return '0x' + value.toString(16).toUpperCase();
}

function renderArray(name, ranges) {
    var values = [];
    ranges.forEach(function(range) {
        values.push(hex(range[0]), hex(range[1]));
    });
    var lines = ['export const ' + name + ': readonly number[] = Object.freeze(['];
    for (var index = 0; index < values.length; index += 8) {
        lines.push('    ' + values.slice(index, index + 8).join(', ') +
            (index + 8 < values.length ? ',' : ''));
    }
    lines.push(']);');
    return lines.join('\n');
}

function main(args) {
    var check = args[0] === '--check';
    var values = check ? args.slice(1) : args;
    if (values.length !== 5) {
        throw new Error(
            'Usage: generate-v2-unicode-width-data.js ' +
            '[--check] ' +
            '<GraphemeBreakProperty> <DerivedCoreProperties> ' +
            '<emoji-data> <EastAsianWidth> <output>'
        );
    }
    var properties = Object.create(null);
    PROPERTY_ORDER.forEach(function(name) {
        properties[name] = [];
    });

    var sources = SOURCE_MANIFEST.map(function(manifest, index) {
        return verifiedSource(values[index], manifest);
    });

    collect(sources[0], function(fields) {
        var map = {
            Control: 'GCB_CONTROL',
            Extend: 'GCB_EXTEND',
            Prepend: 'GCB_PREPEND',
            SpacingMark: 'GCB_SPACING_MARK',
            ZWJ: 'GCB_ZWJ',
            Regional_Indicator: 'GCB_REGIONAL_INDICATOR',
            L: 'GCB_L',
            V: 'GCB_V',
            T: 'GCB_T',
            LV: 'GCB_LV',
            LVT: 'GCB_LVT'
        };
        return map[fields[1]] || null;
    }, properties);

    collect(sources[1], function(fields) {
        if (fields[1] !== 'InCB') {
            return null;
        }
        var map = {
            Consonant: 'INCB_CONSONANT',
            Extend: 'INCB_EXTEND',
            Linker: 'INCB_LINKER'
        };
        return map[fields[2]] || null;
    }, properties);

    collect(sources[2], function(fields) {
        var map = {
            Extended_Pictographic: 'EXTENDED_PICTOGRAPHIC',
            Emoji: 'EMOJI',
            Emoji_Presentation: 'EMOJI_PRESENTATION',
            Emoji_Modifier: 'EMOJI_MODIFIER',
            Emoji_Modifier_Base: 'EMOJI_MODIFIER_BASE'
        };
        return map[fields[1]] || null;
    }, properties);

    collect(sources[3], function(fields) {
        return fields[1] === 'W' || fields[1] === 'F'
            ? 'EAST_ASIAN_WIDE_OR_FULLWIDTH'
            : null;
    }, properties);

    var output = [
        '/*',
        ' * Generated from Unicode 15.1.0 data files:',
        ' * GraphemeBreakProperty.txt, DerivedCoreProperties.txt,',
        ' * emoji-data.txt and EastAsianWidth.txt.',
        ' * Inputs are pinned by SHA-256 in the generator.',
        ' * Unicode data files are licensed under the Unicode Data Files',
        ' * and Software License: https://www.unicode.org/license.txt',
        ' * Do not edit this file by hand.',
        ' */',
        '',
        'export const UNICODE_VERSION = "' + UNICODE_VERSION + '";',
        ''
    ];
    PROPERTY_ORDER.forEach(function(name) {
        output.push(renderArray(name, mergeRanges(properties[name])), '');
    });
    output.push(
        'export function codePointInRanges(',
        '    codePoint: number,',
        '    ranges: readonly number[]',
        '): boolean {',
        '    let low = 0;',
        '    let high = ranges.length / 2 - 1;',
        '    while (low <= high) {',
        '        const middle = (low + high) >>> 1;',
        '        const start = ranges[middle * 2]!;',
        '        const end = ranges[middle * 2 + 1]!;',
        '        if (codePoint < start) {',
        '            high = middle - 1;',
        '        } else if (codePoint > end) {',
        '            low = middle + 1;',
        '        } else {',
        '            return true;',
        '        }',
        '    }',
        '    return false;',
        '}',
        ''
    );
    var rendered = output.join('\n');
    var outputPath = values[4];
    if (check) {
        if (fs.readFileSync(outputPath, 'utf8') !== rendered) {
            throw new Error('Generated Unicode width data is stale: ' + outputPath);
        }
        return;
    }
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, rendered, 'utf8');
}

try {
    main(process.argv.slice(2));
} catch (error) {
    process.stderr.write(String(error && error.message ? error.message : error) + '\n');
    process.exitCode = 1;
}
