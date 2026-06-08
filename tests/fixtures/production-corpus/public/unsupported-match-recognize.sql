select *
from event_stream
match_recognize (partition by user_id order by event_time measures match_number() as match_id one row per match pattern (A B+) define A as event_name='view', B as event_name='pay')
where ds='2026-06-08';
