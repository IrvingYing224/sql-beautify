with base_orders as (
select
o.order_id,
o.user_id,
o.city_id,
o.city_name,
o.region_name,
o.channel_id,
o.device_type,
o.payment_type,
o.order_status,
o.refund_status,
o.gross_amount,
o.discount_amount,
o.shipping_amount,
o.created_at,
o.paid_at,
o.ds
from dwd_order_detail o
where o.ds between '${start_date}' and '${end_date}'
), enriched_orders as (
select
b.order_id,
b.user_id,
case when b.city_id in (1001,1002,1003) then 'tier_one' when b.city_id in (2001,2002,2003) then 'tier_two' else 'other' end as city_tier,
case when b.channel_id in ('app','mini_app') then 'mobile' when b.channel_id in ('web','desktop') then 'desktop' else 'unknown' end as channel_group,
case when b.device_type in ('ios','android') then 'native' when b.device_type='browser' then 'web' else 'other' end as device_group,
case when b.payment_type in ('card','wallet') then 'online' when b.payment_type='cash' then 'offline' else 'unknown' end as payment_group,
case when b.order_status='paid' and b.refund_status='none' then 'completed' when b.refund_status in ('partial','full') then 'refunded' else 'open' end as lifecycle_group,
case when b.gross_amount >= 10000 then 'amount_10000_plus' when b.gross_amount >= 5000 then 'amount_5000_9999' when b.gross_amount >= 1000 then 'amount_1000_4999' else 'amount_below_1000' end as amount_band,
case when b.discount_amount = 0 then 'no_discount' when b.discount_amount < 50 then 'discount_small' when b.discount_amount < 200 then 'discount_medium' else 'discount_large' end as discount_band,
case when b.shipping_amount = 0 then 'free_shipping' when b.shipping_amount < 20 then 'shipping_low' when b.shipping_amount < 50 then 'shipping_medium' else 'shipping_high' end as shipping_band,
case when hour(b.created_at) between 0 and 5 then 'night' when hour(b.created_at) between 6 and 11 then 'morning' when hour(b.created_at) between 12 and 17 then 'afternoon' else 'evening' end as created_period,
case when datediff(b.paid_at,b.created_at)=0 then 'paid_same_day' when datediff(b.paid_at,b.created_at)=1 then 'paid_next_day' else 'paid_later' end as payment_delay,
case when b.region_name in ('华东','华南') then 'south_east' when b.region_name in ('华北','东北') then 'north' when b.region_name in ('西南','西北') then 'west' else 'unknown' end as region_group,
case when b.city_name like '%市' then regexp_replace(b.city_name,'市$','') else b.city_name end as normalized_city_name,
case when b.user_id is null then 'anonymous' when length(b.user_id)<8 then 'legacy_user' else 'registered_user' end as user_group,
case when b.order_id like 'TEST%' then 1 else 0 end as is_test_order,
case when b.order_id like 'RETRY%' then 1 else 0 end as is_retry_order,
case when b.order_status in ('cancelled','closed') then 1 else 0 end as is_closed_order,
case when b.refund_status='full' then b.gross_amount when b.refund_status='partial' then b.discount_amount else 0 end as estimated_refund_amount,
case when b.gross_amount-b.discount_amount+b.shipping_amount < 0 then 0 else b.gross_amount-b.discount_amount+b.shipping_amount end as net_amount,
row_number() over(partition by b.user_id order by b.paid_at desc,b.order_id desc) as user_order_rank,
dense_rank() over(partition by b.region_name order by b.gross_amount desc) as regional_amount_rank,
sum(b.gross_amount) over(partition by b.user_id order by b.paid_at rows between 6 preceding and current row) as rolling_seven_order_amount,
count(*) over(partition by b.user_id) as user_order_count,
max(b.paid_at) over(partition by b.user_id) as latest_paid_at,
b.ds
from base_orders b
), scored_orders as (
select
e.*,
case when e.lifecycle_group='completed' and e.amount_band in ('amount_10000_plus','amount_5000_9999') then 100 when e.lifecycle_group='completed' then 80 when e.lifecycle_group='refunded' then 20 else 40 end as lifecycle_score,
case when e.user_group='registered_user' and e.user_order_count>=20 then 100 when e.user_group='registered_user' and e.user_order_count>=5 then 70 when e.user_group='legacy_user' then 50 else 20 end as loyalty_score,
case when e.payment_delay='paid_same_day' then 100 when e.payment_delay='paid_next_day' then 70 else 40 end as payment_score,
case when e.is_test_order=1 then 0 when e.is_retry_order=1 then 30 when e.is_closed_order=1 then 50 else 100 end as quality_score,
case when e.net_amount>=5000 then 'high_value' when e.net_amount>=1000 then 'medium_value' when e.net_amount>=100 then 'standard_value' else 'low_value' end as value_segment,
case when e.rolling_seven_order_amount>=20000 then 'very_active' when e.rolling_seven_order_amount>=5000 then 'active' when e.rolling_seven_order_amount>0 then 'occasional' else 'inactive' end as activity_segment
from enriched_orders e
), final_orders as (
select
s.order_id,
s.user_id,
s.city_tier,
s.channel_group,
s.device_group,
s.payment_group,
s.lifecycle_group,
s.amount_band,
s.discount_band,
s.shipping_band,
s.created_period,
s.payment_delay,
s.region_group,
s.normalized_city_name,
s.user_group,
s.estimated_refund_amount,
s.net_amount,
s.user_order_rank,
s.regional_amount_rank,
s.rolling_seven_order_amount,
s.user_order_count,
s.latest_paid_at,
s.lifecycle_score+s.loyalty_score+s.payment_score+s.quality_score as total_score,
s.value_segment,
s.activity_segment,
s.ds
from scored_orders s
where s.is_test_order=0
)
select
order_id,
user_id,
city_tier,
channel_group,
device_group,
payment_group,
lifecycle_group,
amount_band,
discount_band,
shipping_band,
created_period,
payment_delay,
region_group,
normalized_city_name,
user_group,
estimated_refund_amount,
net_amount,
user_order_rank,
regional_amount_rank,
rolling_seven_order_amount,
user_order_count,
latest_paid_at,
total_score,
value_segment,
activity_segment,
ds
from final_orders
where user_order_rank<=10
order by ds,user_id,total_score desc;
