{# Shared by backup_to_prior_run, backup_to_int_backups, cleanup_int_backups and restore_backup.
   Renders a T-SQL exists (...) predicate that is true when the table exists. #}
{% macro _table_exists(schema, identifier) -%}
    exists (
        select 1 from sys.tables t
        inner join sys.schemas s on s.schema_id = t.schema_id
        where s.name = '{{ schema }}' and t.name = '{{ identifier }}'
    )
{%- endmacro %}
