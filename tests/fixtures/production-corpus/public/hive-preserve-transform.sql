SELECT TRANSFORM(payload) USING 'python3 normalize.py' AS (normalized string) FROM raw_events WHERE ds='${bizdate}';
