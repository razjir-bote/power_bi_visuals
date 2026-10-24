{#
    Profile the timestamped backups (from backup_to_int_backups) into one stats table per backed-up
    table, named like its backups with the _YYYYMMDD_HHMMSS suffix replaced by _stats:
    int_backups.fct_orders_20261024_150904 -> int_backups.fct_orders_stats.

        dbt run-operation collect_backup_stats --args '{dry_run: true}'
        dbt run-operation collect_backup_stats
        dbt run-operation collect_backup_stats --args '{tables: [fct_orders], full_refresh: true}'

    Also runs after every dbt run/build/seed via on-run-end in dbt_project.yml.

    - One row per backup per column: the backup's row count, and the column's null count, distinct
      count, min/max (as text, cut to 400 characters) and, for numeric columns, sum and average.
    - distinct: approx (default) uses approx_count_distinct, within about 2% of the exact count and much
      cheaper on large backups; exact uses count(distinct ...); none skips it. distinct_method records
      which was used, so don't read a ~2% change between approx counts as a real change.
    - Incremental: backups that already have rows in the stats table are skipped, so stats of backups
      since dropped by cleanup_int_backups are kept. full_refresh rebuilds each stats table from the
      backups that exist now.
    - Stats tables made by an older version of this macro get any missing columns added (null for
      rows collected before).
    - Each backup is scanned once: its aggregates go into a one-row temp table that is then unpivoted.
    - Stats tables sit next to the backups by default. They have no timestamp suffix, so this macro and
      cleanup_int_backups don't treat them as backups.
#}
{% macro collect_backup_stats(backup_schema='int_backups', stats_schema='int_backups', tables=none, full_refresh=false, distinct='approx', dry_run=false) %}
    {% if not execute %}
        {{ return('') }}
    {% endif %}

    {% set distinct_method = 'exact' if distinct is sameas true else ('none' if not distinct else distinct | lower) %}
    {% if distinct_method not in ['approx', 'exact', 'none'] %}
        {{ exceptions.raise_compiler_error("collect_backup_stats: distinct must be approx, exact or none, not '" ~ distinct ~ "'") }}
    {% endif %}
    {% if tables is string %}
        {% set tables = [tables] %}
    {% endif %}

    {% set backups = _backups_by_table(backup_schema, tables) %}
    {% if backups | length == 0 %}
        {{ log('collect_backup_stats: no backups found in [' ~ backup_schema ~ ']' ~ (' for ' ~ tables | join(', ') if tables else ''), info=true) }}
        {{ return('') }}
    {% endif %}

    {% set collected_at = modules.datetime.datetime.now(backup_timezone()).strftime('%Y-%m-%d %H:%M:%S') %}
    {% set prefix = 'collect_backup_stats: ' ~ ('would run: ' if dry_run else 'running: ') %}
    {% set totals = {'collected': 0, 'skipped': 0} %}

    {% set sql = "if not exists (select 1 from sys.schemas where name = '" ~ stats_schema ~ "') exec('create schema " ~ _bracket(stats_schema) ~ "')" %}
    {% if dry_run %}
        {{ log(prefix ~ sql, info=true) }}
    {% else %}
        {% do run_query(sql) %}
    {% endif %}

    {% for table, table_backups in backups.items() %}
        {% set stats_name = table ~ '_stats' %}
        {% set stats_table = _bracket(stats_schema) ~ '.' ~ _bracket(stats_name) %}
        {% set exists = _table_exists_now(stats_schema, stats_name) %}
        {% set statements = [] %}
        {% set done = [] %}

        {% if exists and full_refresh %}
            {% do statements.append('drop table ' ~ stats_table) %}
        {% elif exists %}
            {% do statements.extend(_backup_stats_upgrade(stats_schema, stats_name, stats_table)) %}
            {% for row in run_query('select distinct backup_table from ' ~ stats_table).rows %}
                {% do done.append(row['backup_table']) %}
            {% endfor %}
        {% endif %}
        {% if full_refresh or not exists %}
            {% do statements.append(_backup_stats_ddl(stats_table)) %}
        {% endif %}

        {% set todo = table_backups | rejectattr('name', 'in', done) | list %}
        {% for backup in todo %}
            {% do statements.extend(_backup_stats_statements(backup_schema, backup, stats_table, collected_at, distinct_method)) %}
        {% endfor %}

        {{ log('collect_backup_stats: ' ~ stats_table ~ ': ' ~ todo | length ~ ' backup(s) to profile'
               ~ (', ' ~ done | length ~ ' already done' if done else ''), info=true) }}
        {% for sql in statements %}
            {% if dry_run %}
                {{ log(prefix ~ sql, info=true) }}
            {% else %}
                {% do run_query(sql) %}
            {% endif %}
        {% endfor %}
        {% do totals.update({'collected': totals.collected + todo | length, 'skipped': totals.skipped + done | length}) %}
    {% endfor %}

    {{ log('collect_backup_stats: ' ~ ('would profile ' if dry_run else 'profiled ') ~ totals.collected ~ ' backup(s) into '
           ~ backups | length ~ ' table(s) in [' ~ stats_schema ~ '], ' ~ totals.skipped ~ ' already done', info=true) }}
    {{ return('') }}
{% endmacro %}

{# Backups in backup_schema grouped by the table they were taken from, oldest first:
   {table: [{name, ts, columns: [{id, name, type}]}]}. Optionally limited to the given table names. #}
{% macro _backups_by_table(backup_schema, tables=none) %}
    {% set result = run_query(
        "select t.name as backup_table, c.column_id, c.name as column_name, ty.name as data_type"
        ~ " from sys.tables t"
        ~ " inner join sys.schemas s on s.schema_id = t.schema_id"
        ~ " inner join sys.columns c on c.object_id = t.object_id"
        ~ " inner join sys.types ty on ty.user_type_id = c.user_type_id"
        ~ " where s.name = '" ~ backup_schema ~ "'"
        ~ " and t.name like '%[_][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][_][0-9][0-9][0-9][0-9][0-9][0-9]'"
        ~ " order by t.name, c.column_id") %}

    {% set by_table = {} %}
    {% set by_name = {} %}
    {% for row in result.rows %}
        {% set m = modules.re.match('^(.+)_([0-9]{4})([0-9]{2})([0-9]{2})_([0-9]{2})([0-9]{2})([0-9]{2})$', row['backup_table']) %}
        {% if m and (tables is none or m.group(1) in tables) %}
            {% if row['backup_table'] not in by_name %}
                {% set backup = {
                    'name': row['backup_table'],
                    'ts': m.group(2) ~ '-' ~ m.group(3) ~ '-' ~ m.group(4) ~ ' ' ~ m.group(5) ~ ':' ~ m.group(6) ~ ':' ~ m.group(7),
                    'columns': [],
                } %}
                {% do by_name.update({row['backup_table']: backup}) %}
                {% if m.group(1) not in by_table %}
                    {% do by_table.update({m.group(1): []}) %}
                {% endif %}
                {% do by_table[m.group(1)].append(backup) %}
            {% endif %}
            {% do by_name[row['backup_table']].columns.append({'id': row['column_id'], 'name': row['column_name'], 'type': row['data_type'] | lower}) %}
        {% endif %}
    {% endfor %}
    {{ return(by_table) }}
{% endmacro %}

{# Columns of a stats table, in order. Columns added after the first version must be nullable, so
   _backup_stats_upgrade can add them to existing tables. #}
{% macro _backup_stats_columns() %}
    {{ return([
        ['backup_table',    'nvarchar(128) not null'],
        ['backup_ts',       'datetime2(0) null'],
        ['row_count',       'bigint not null'],
        ['column_id',       'int not null'],
        ['column_name',     'nvarchar(128) not null'],
        ['data_type',       'nvarchar(128) not null'],
        ['null_count',      'bigint not null'],
        ['distinct_count',  'bigint null'],
        ['distinct_method', 'nvarchar(10) null'],
        ['min_value',       'nvarchar(400) null'],
        ['max_value',       'nvarchar(400) null'],
        ['sum_value',       'decimal(38, 4) null'],
        ['avg_value',       'float null'],
        ['collected_at',    'datetime2(0) not null'],
    ]) }}
{% endmacro %}

{% macro _backup_stats_ddl(stats_table) -%}
    {%- set cols = [] -%}
    {%- for col in _backup_stats_columns() -%}
        {%- do cols.append(col[0] ~ ' ' ~ col[1]) -%}
    {%- endfor -%}
    create table {{ stats_table }} ({{ cols | join(', ') }}) with (distribution = round_robin, heap)
{%- endmacro %}

{# alter table statements adding the columns an existing stats table is missing. #}
{% macro _backup_stats_upgrade(stats_schema, stats_name, stats_table) %}
    {% set result = run_query(
        "select c.name from sys.columns c"
        ~ " inner join sys.tables t on t.object_id = c.object_id"
        ~ " inner join sys.schemas s on s.schema_id = t.schema_id"
        ~ " where s.name = '" ~ stats_schema ~ "' and t.name = '" ~ stats_name ~ "'") %}
    {% set have = result.columns[0].values() | map('lower') | list %}
    {% set statements = [] %}
    {% for col in _backup_stats_columns() if col[0] not in have %}
        {% do statements.append('alter table ' ~ stats_table ~ ' add ' ~ col[0] ~ ' ' ~ col[1]) %}
    {% endfor %}
    {{ return(statements) }}
{% endmacro %}

{# Statements that profile one backup and append its rows to the stats table. No database access. #}
{% macro _backup_stats_statements(backup_schema, backup, stats_table, collected_at, distinct_method) %}
    {% set drop_tmp = "if object_id('tempdb..#backup_stats') is not null drop table #backup_stats" %}

    {% set aggregates = ['count_big(*) as row_count'] %}
    {% for col in backup.columns %}
        {% set q = _bracket(col.name) %}
        {% set i = loop.index %}
        {% do aggregates.append('count_big(*) - count_big(' ~ q ~ ') as n' ~ i) %}
        {% do aggregates.append(_distinct_count(q, col.type, distinct_method) ~ ' as d' ~ i) %}
        {% do aggregates.append(_min_max_text('min', q, col.type) ~ ' as mn' ~ i) %}
        {% do aggregates.append(_min_max_text('max', q, col.type) ~ ' as mx' ~ i) %}
        {% do aggregates.append(_sum_avg('sum', q, col.type) ~ ' as sm' ~ i) %}
        {% do aggregates.append(_sum_avg('avg', q, col.type) ~ ' as av' ~ i) %}
    {% endfor %}
    {% set create_tmp = 'create table #backup_stats with (distribution = round_robin, heap) as select '
                        ~ aggregates | join(', ') ~ ' from ' ~ _bracket(backup_schema) ~ '.' ~ _bracket(backup.name) %}

    {% set selects = [] %}
    {% for col in backup.columns %}
        {% set i = loop.index %}
        {% set method = 'null' if distinct_method == 'none' or col.type in _no_compare_types() else _nstr(distinct_method) %}
        {% do selects.append(
            'select ' ~ _nstr(backup.name) ~ ", try_convert(datetime2(0), '" ~ backup.ts ~ "', 120), a.row_count, "
            ~ col.id ~ ', ' ~ _nstr(col.name) ~ ', ' ~ _nstr(col.type) ~ ', '
            ~ 'a.n' ~ i ~ ', a.d' ~ i ~ ', ' ~ method ~ ', a.mn' ~ i ~ ', a.mx' ~ i ~ ', a.sm' ~ i ~ ', a.av' ~ i
            ~ ", convert(datetime2(0), '" ~ collected_at ~ "', 120) from #backup_stats a") %}
    {% endfor %}
    {% set insert = 'insert into ' ~ stats_table ~ ' (' ~ _backup_stats_columns() | map('first') | join(', ') ~ ') '
                    ~ selects | join(' union all ') %}

    {{ return([drop_tmp, create_tmp, insert, drop_tmp]) }}
{% endmacro %}

{% macro _distinct_count(q, type, distinct_method) -%}
    {%- if distinct_method == 'none' or type in _no_compare_types() -%}
        cast(null as bigint)
    {%- elif distinct_method == 'approx' -%}
        cast(approx_count_distinct({{ q }}) as bigint)
    {%- else -%}
        count_big(distinct {{ q }})
    {%- endif -%}
{%- endmacro %}

{# min()/max() of a column as nvarchar(400). bit can't be aggregated, so it goes through tinyint;
   uniqueidentifier through char(36); dates use ODBC canonical format (style 121). #}
{% macro _min_max_text(fn, q, type) -%}
    {%- if type in _no_compare_types() -%}
        cast(null as nvarchar(400))
    {%- elif type == 'bit' -%}
        convert(nvarchar(400), {{ fn }}(cast({{ q }} as tinyint)))
    {%- elif type == 'uniqueidentifier' -%}
        convert(nvarchar(400), {{ fn }}(convert(char(36), {{ q }})))
    {%- elif type in ['date', 'time', 'datetime', 'datetime2', 'smalldatetime', 'datetimeoffset'] -%}
        convert(nvarchar(400), {{ fn }}({{ q }}), 121)
    {%- else -%}
        convert(nvarchar(400), {{ fn }}({{ q }}))
    {%- endif -%}
{%- endmacro %}

{# sum() as decimal(38, 4) and avg() as float, for numeric columns only (null otherwise). Integers
   are summed as decimal(38, 0) so large tables can't overflow int; a sum too big for decimal(38, 4)
   comes out null rather than failing the run. #}
{% macro _sum_avg(fn, q, type) -%}
    {%- if type not in ['tinyint', 'smallint', 'int', 'bigint', 'decimal', 'numeric', 'money', 'smallmoney', 'float', 'real'] -%}
        {{ 'cast(null as decimal(38, 4))' if fn == 'sum' else 'cast(null as float)' }}
    {%- elif fn == 'avg' -%}
        avg(cast({{ q }} as float))
    {%- elif type in ['tinyint', 'smallint', 'int', 'bigint'] -%}
        try_convert(decimal(38, 4), sum(cast({{ q }} as decimal(38, 0))))
    {%- else -%}
        try_convert(decimal(38, 4), sum({{ q }}))
    {%- endif -%}
{%- endmacro %}

{# Types with no meaningful min/max or distinct count. #}
{% macro _no_compare_types() %}
    {{ return(['binary', 'varbinary', 'image', 'text', 'ntext', 'xml', 'geography', 'geometry', 'hierarchyid', 'sql_variant']) }}
{% endmacro %}

{% macro _bracket(name) -%}
    [{{ name | replace(']', ']]') }}]
{%- endmacro %}

{% macro _nstr(value) -%}
    N'{{ value | replace("'", "''") }}'
{%- endmacro %}
