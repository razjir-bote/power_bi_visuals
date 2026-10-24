{#
    Drop timestamped backups (from backup_to_int_backups) whose name suffix is older than `days`.

        dbt run-operation cleanup_int_backups
        dbt run-operation cleanup_int_backups --args '{days: 30, dry_run: true}'

    Can also run after every build:  on-run-end: "{{ cleanup_int_backups() }}"

    - Only tables ending in _YYYYMMDD_HHMMSS are considered; anything else in the schema is ignored.
    - The suffix is read in var('backup_timezone'), matching backup_to_int_backups. The cutoff is
      computed here rather than from the database clock so both macros use the same time zone.
#}
{% macro cleanup_int_backups(backup_schema='int_backups', days=90, dry_run=false) %}
    {% if not execute %}
        {{ return('') }}
    {% endif %}

    {% set tz = backup_timezone() %}
    {% set cutoff = (modules.datetime.datetime.now(tz) - modules.datetime.timedelta(days=days | int)).strftime('%Y-%m-%d %H:%M:%S') %}
    {% set expired = run_query(_expired_backups_sql(backup_schema, cutoff)) %}

    {% if expired.rows | length == 0 %}
        {{ log('cleanup_int_backups: no backups in [' ~ backup_schema ~ '] older than ' ~ days ~ ' days (before ' ~ cutoff ~ ')', info=true) }}
        {{ return('') }}
    {% endif %}

    {% for row in expired.rows %}
        {% set table = '[' ~ backup_schema ~ '].[' ~ row['name'] | replace(']', ']]') ~ ']' %}
        {% if dry_run %}
            {{ log('cleanup_int_backups: would drop ' ~ table ~ ' (' ~ row['backup_ts'] ~ ')', info=true) }}
        {% else %}
            {{ log('cleanup_int_backups: dropping ' ~ table ~ ' (' ~ row['backup_ts'] ~ ')', info=true) }}
            {% do run_query('drop table ' ~ table) %}
        {% endif %}
    {% endfor %}

    {{ log('cleanup_int_backups: ' ~ ('would drop ' if dry_run else 'dropped ') ~ expired.rows | length ~ ' table(s)', info=true) }}
    {{ return('') }}
{% endmacro %}

{% macro _expired_backups_sql(backup_schema, cutoff) -%}
    with backups as (
        select
            t.name,
            -- 'name_20261024_143015' -> '20261024 14:30:15'
            try_convert(datetime2(0),
                substring(right(t.name, 15), 1, 8) + ' '
                + substring(right(t.name, 15), 10, 2) + ':'
                + substring(right(t.name, 15), 12, 2) + ':'
                + substring(right(t.name, 15), 14, 2)
            ) as backup_ts
        from sys.tables t
        inner join sys.schemas s on s.schema_id = t.schema_id
        where s.name = '{{ backup_schema }}'
          and t.name like '%[_][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][_][0-9][0-9][0-9][0-9][0-9][0-9]'
    )
    select name, backup_ts
    from backups
    where backup_ts < convert(datetime2(0), '{{ cutoff }}', 120)
{%- endmacro %}
