-- Returns rows that fail: any order with a negative total amount.
select
    order_id,
    amount
from "sample_shop"."marts"."orders"
where amount < 0