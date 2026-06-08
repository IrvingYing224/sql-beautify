select *
from sales_source
pivot (sum(amount) for quarter in ('Q1','Q2')) p
where pivot = 'safe_name'
and qualify(pivot) = 1;

select qualify as c, pivot as p
from keyword_named_columns
where pivot(p) = 1;
