with source_orders as (
select
o.user_id,
o.order_id,
case when o.city_id in (
1001, -- city one
1002 -- city two
) then concat_ws(',', o.city_name, o.region_name)
else 'unknown'
end as city_label,
row_number() over(partition by o.user_id order by o.pay_time desc,o.order_id desc) as rn
from dwd_order_detail o
left join dim_user_profile u
on -- user join
o.user_id = u.user_id
and u.ds='${bizdate}'
where o.ds='${bizdate}'
and o.status in (1,2,3)
)
select user_id,order_id,city_label
from source_orders
where rn=1;
