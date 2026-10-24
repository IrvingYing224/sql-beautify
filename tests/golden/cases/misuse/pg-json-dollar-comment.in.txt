select
u.id,
payload->>'order_id' as order_id,
payload ? 'coupon' as has_coupon,
$$CASE WHEN -- keep raw text$$ as raw_sql_text
from public.events u
where payload->>'status' = 'paid'
and u.created_at >= now() - interval '1 day';
