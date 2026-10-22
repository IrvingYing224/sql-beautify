with source_rows as (
select order_id,user_id,ds
from dwd_order_detail
where ds='${bizdate}'
)
insert into table ads_daily_orders partition(ds='${bizdate}')
select order_id,user_id
from source_rows;
