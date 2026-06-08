SELECT  *
FROM sales_source
pivot(SUM(amount) for quarter IN ('Q1', 'Q2')) p
WHERE pivot = 'safe_name'
  AND QUALIFY(pivot) = 1;

SELECT  QUALIFY AS c
       ,pivot   AS p
FROM keyword_named_columns
WHERE pivot(p) = 1;
