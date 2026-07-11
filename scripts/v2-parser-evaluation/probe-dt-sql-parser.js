var fs = require('fs');
var os = require('os');
var path = require('path');
var zlib = require('zlib');
var childProcess = require('child_process');
var esbuild = require('esbuild');

function median(values) {
    var sorted = values.slice().sort(function(left, right) { return left - right; });
    return sorted[Math.floor(sorted.length / 2)] || 0;
}

function measure(action) {
    var started = process.hrtime.bigint();
    action();
    return Number(process.hrtime.bigint() - started) / 1000000;
}

function make_source(statementCount) {
    return new Array(statementCount + 1).join(
        "SELECT id, ROW_NUMBER() OVER (PARTITION BY id ORDER BY ts DESC) AS rn FROM src WHERE ds='2026-07-11';\n"
    );
}

function package_name_from_input(inputPath) {
    var marker = 'node_modules/';
    var index = inputPath.lastIndexOf(marker);
    if (index < 0) {
        return null;
    }
    var parts = inputPath.slice(index + marker.length).split('/');
    return parts[0] && parts[0].charAt(0) == '@'
        ? parts.slice(0, 2).join('/')
        : parts[0];
}

function bundled_packages(metafile) {
    var names = Object.create(null);
    Object.keys(metafile.inputs).forEach(function(inputPath) {
        var name = package_name_from_input(inputPath);
        if (name) {
            names[name] = true;
        }
    });
    return Object.keys(names).sort().map(function(name) {
        var packagePath = path.join(process.cwd(), 'node_modules', name, 'package.json');
        var value = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
        return { name: value.name, version: value.version, license: value.license || '' };
    });
}

function observe_direct_load() {
    try {
        require('dt-sql-parser');
        return {
            success: true,
            errorCode: null,
        };
    } catch (error) {
        var errorCode = error && typeof error.code == 'string'
            && /^[A-Z][A-Z0-9_]*$/.test(error.code)
            ? error.code
            : 'ERR_DIRECT_LOAD_FAILED';
        return {
            success: false,
            errorCode: errorCode,
        };
    }
}

function cold_start_samples(bundlePath) {
    var script = path.join(__dirname, 'cold-start.js');
    var samples = [];
    for (var i = 0; i < 5; i++) {
        var result = childProcess.spawnSync(process.execPath, [script, bundlePath], {
            cwd: process.cwd(),
            encoding: 'utf8',
        });
        if (result.status != 0) {
            throw new Error(result.stderr || 'cold-start probe failed');
        }
        samples.push(Number(result.stdout));
    }
    return samples;
}

function require_analysis_evidence(candidate, testCase, sampleName) {
    var result = candidate.analyze(testCase);
    var failures = [];
    if (!result || result.status !== 'accepted' || result.accepted !== true) {
        failures.push('status and accepted must describe success');
    }
    if (!result || !Array.isArray(result.errors) || result.errors.length > 0) {
        failures.push('errors must be empty');
    }
    if (!result || !Number.isInteger(result.nodeCount) || result.nodeCount <= 0) {
        failures.push('nodeCount must be greater than zero');
    }
    if (!result || result.nodeSpansValid !== true) {
        failures.push('nodeSpansValid must be true');
    }
    if (failures.length > 0) {
        throw new Error('invalid analysis evidence for ' + testCase.id + ' ' + sampleName
            + ': ' + failures.join('; '));
    }
    return result;
}

function parse_samples(candidate, count) {
    var testCase = {
        id: 'scale-' + count,
        dialect: 'hive',
        expectation: 'required',
        source: make_source(count),
        atomicLexemes: [],
        tags: ['performance'],
    };
    require_analysis_evidence(candidate, testCase, 'warm-up');
    return [
        measure(function() { require_analysis_evidence(candidate, testCase, 'timed sample 1'); }),
        measure(function() { require_analysis_evidence(candidate, testCase, 'timed sample 2'); }),
        measure(function() { require_analysis_evidence(candidate, testCase, 'timed sample 3'); }),
    ];
}

function probe_dt_sql_parser(candidate) {
    var directLoad = observe_direct_load();
    var outputDir = path.join(process.cwd(), '.tmp', 'v2-parser-evaluation');
    var outputFile = path.join(outputDir, 'dt-sql-parser.cjs');
    fs.mkdirSync(outputDir, { recursive: true });
    var build = esbuild.buildSync({
        entryPoints: [path.join(__dirname, 'candidates', 'dt-entry.js')],
        outfile: outputFile,
        bundle: true,
        minify: true,
        platform: 'node',
        format: 'cjs',
        target: 'node18',
        metafile: true,
    });
    var bundle = fs.readFileSync(outputFile);
    var samples100 = parse_samples(candidate, 100);
    var samples800 = parse_samples(candidate, 800);
    var samples1200 = parse_samples(candidate, 1200);
    var median100 = median(samples100);
    var median800 = median(samples800);
    return {
        bundleEntry: 'esm-named-hive',
        bundleBytes: bundle.length,
        gzipBytes: zlib.gzipSync(bundle).length,
        coldStartMedianMs: median(cold_start_samples(outputFile)),
        parse100MedianMs: median100,
        parse800MedianMs: median800,
        parse1200MedianMs: median(samples1200),
        scaleRatio: median800 / Math.max(0.001, median100),
        maxRssKb: process.resourceUsage().maxRSS,
        environment: {
            node: process.version,
            platform: process.platform,
            arch: process.arch,
            cpu: os.cpus()[0] ? os.cpus()[0].model : 'unknown',
        },
        directLoad: directLoad,
        bundledPackages: bundled_packages(build.metafile),
    };
}

exports.observe_direct_load = observe_direct_load;
exports.probe_dt_sql_parser = probe_dt_sql_parser;
