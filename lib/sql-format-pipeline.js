function run(text, passes) {
    var current = text;

    for (var i = 0; i < passes.length; i++) {
        current = passes[i](current);
    }

    return current;
}

exports.run = run;
