-- Returns rows that fail: any order with a negative total amount.
select
    order_id,
    amount
from {{ ref('orders') }}
where amount < 0
