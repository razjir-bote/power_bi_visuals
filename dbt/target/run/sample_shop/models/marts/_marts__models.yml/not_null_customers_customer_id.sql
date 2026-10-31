
    
    select
      count(*) as failures,
      count(*) != 0 as should_warn,
      count(*) != 0 as should_error
    from (
      
    
  
    
    



select customer_id
from "sample_shop"."marts"."customers"
where customer_id is null



  
  
      
    ) dbt_internal_test