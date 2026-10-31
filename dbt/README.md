# sample_shop

A small sample dbt project modelling a shop's customers, orders and payments. It runs locally on DuckDB, so no warehouse credentials are needed.

## Layout

- `seeds/` - raw CSV data loaded into the `raw` schema
- `models/staging/` - one view per raw table: renaming, casting, cents to dollars
- `models/marts/` - `orders` and `customers` tables for analysis
- `macros/` - `cents_to_dollars` helper and a `generate_schema_name` override so schemas are named `raw`, `staging`, `marts`
- `tests/` - singular data tests (generic tests live in the model YAML files)
- `snapshots/` - SCD type 2 snapshot of customers
- `analyses/` - ad-hoc SQL compiled by dbt but not materialized

## Getting started

dbt needs Python 3.10-3.13. A `.venv` (Python 3.12, created with `uv`) is already set up with dbt installed, so you can just activate it:

```powershell
.\.venv\Scripts\Activate.ps1

# To recreate it from scratch instead (uv downloads Python 3.12 into .python/):
#   $env:UV_PYTHON_INSTALL_DIR = "$PWD\.python"
#   uv venv --python 3.12 .venv
#   uv pip install --python .venv\Scripts\python.exe -r requirements.txt uv

# profiles.yml is in the project root, so point dbt at it
$env:DBT_PROFILES_DIR = (Get-Location).Path

dbt debug      # check the connection
dbt build      # seed, run, snapshot and test everything
dbt docs generate; dbt docs serve
```

The database is written to `sample_shop.duckdb` in the project root.
