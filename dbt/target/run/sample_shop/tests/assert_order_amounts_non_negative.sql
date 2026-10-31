
    
    select
      count(*) as failures,
      count(*) != 0 as should_warn,
      count(*) != 0 as should_error
    from (
      
    
  -- Returns rows that fail: any order with a negative total amount.
select
    order_id,
    amount
from "sample_shop"."marts"."orders"
where amount < 0
  
  
      
    ) dbt_internal_test