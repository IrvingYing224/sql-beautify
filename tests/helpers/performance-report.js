function percentile(sortedNumbers, percentileValue) {
	if (sortedNumbers.length == 0) {
		return 0;
	}
	var index = Math.ceil((percentileValue / 100) * sortedNumbers.length) - 1;
	index = Math.max(0, Math.min(sortedNumbers.length - 1, index));
	return sortedNumbers[index];
}

function round(value) {
	return Math.round(value * 100) / 100;
}

function summarize(samples) {
	var elapsedValues = samples.map(function(sample) {
		return sample.elapsedMs;
	}).sort(function(a, b) {
		return a - b;
	});

	var normalizedValues = samples.map(function(sample) {
		return sample.msPer10kChars;
	}).sort(function(a, b) {
		return a - b;
	});

	var totalElapsed = samples.reduce(function(total, sample) {
		return total + sample.elapsedMs;
	}, 0);

	var totalChars = samples.reduce(function(total, sample) {
		return total + sample.inputChars;
	}, 0);

	return {
		count: samples.length,
		totalChars: totalChars,
		totalElapsedMs: round(totalElapsed),
		p50Ms: round(percentile(elapsedValues, 50)),
		p95Ms: round(percentile(elapsedValues, 95)),
		maxMs: round(elapsedValues.length ? elapsedValues[elapsedValues.length - 1] : 0),
		p95MsPer10kChars: round(percentile(normalizedValues, 95)),
		maxMsPer10kChars: round(normalizedValues.length ? normalizedValues[normalizedValues.length - 1] : 0)
	};
}

function format_summary(summary) {
	return [
		'production performance budget',
		'cases=' + summary.count,
		'chars=' + summary.totalChars,
		'totalMs=' + summary.totalElapsedMs,
		'p50Ms=' + summary.p50Ms,
		'p95Ms=' + summary.p95Ms,
		'maxMs=' + summary.maxMs,
		'p95MsPer10kChars=' + summary.p95MsPer10kChars,
		'maxMsPer10kChars=' + summary.maxMsPer10kChars
	].join(' ');
}

exports.summarize = summarize;
exports.format_summary = format_summary;
