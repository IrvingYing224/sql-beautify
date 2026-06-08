SELECT  u.id
       ,payload->>'order_id'         AS order_id
       ,payload ? 'coupon'             AS has_coupon
       ,$$CASE WHEN -- keep raw text$$ AS raw_sql_text
FROM public.events u
WHERE payload->>'status' = 'paid'
  AND u.created_at >= now() - interval '1 day';
