select
a.user_id,
'${bizdate}' as bizdate,
'${env}' as run_env,
case when a.event_name='select from where' then 1 else 0 end as has_sql_text,
concat_ws('|', a.app_id, a.channel, '${bizdate}') as compound_key -- output key
from ods_event_log a
where a.ds='${bizdate}'
and a.hour between '${start_hour}' and '${end_hour}'
and a.extra_json like '%case when%'
and a.comment_text <> '-- not a real comment';
