{# Time zone used by backup_to_int_backups and cleanup_int_backups. Falls back to Brisbane when
   the backup_timezone var is missing or empty. #}
{% macro backup_timezone() -%}
    {{ return(modules.pytz.timezone(var('backup_timezone', none) or 'Australia/Brisbane')) }}
{%- endmacro %}
