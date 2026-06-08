SELECT  a.user_id
       ,'${bizdate}'                                       AS bizdate
       ,'${env}'                                           AS run_env
       ,CASE
            WHEN a.event_name = 'select from where' THEN 1
            ELSE 0
        END                                                AS has_sql_text
       ,concat_ws('|',a.app_id,a.channel,'${bizdate}')     AS compound_key -- output key
FROM ods_event_log a
WHERE a.ds = '${bizdate}'
  AND a.hour BETWEEN '${start_hour}' AND '${end_hour}'
  AND a.extra_json LIKE '%case when%'
  AND a.comment_text <> '-- not a real comment';
