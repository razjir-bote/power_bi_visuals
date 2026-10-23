"use strict";

import powerbi from "powerbi-visuals-api";
import { FormattingSettingsService } from "powerbi-visuals-utils-formattingmodel";
import { valueFormatter } from "powerbi-visuals-utils-formattingutils";
import "./../style/visual.less";

import VisualConstructorOptions = powerbi.extensibility.visual.VisualConstructorOptions;
import VisualUpdateOptions = powerbi.extensibility.visual.VisualUpdateOptions;
import IVisual = powerbi.extensibility.visual.IVisual;
import DataView = powerbi.DataView;
import DataViewMatrix = powerbi.DataViewMatrix;
import DataViewMatrixNode = powerbi.DataViewMatrixNode;
import DataViewMetadataColumn = powerbi.DataViewMetadataColumn;
import PrimitiveValue = powerbi.PrimitiveValue;

import { VisualFormattingSettingsModel } from "./settings";

/** One column across the top (e.g. a country), with its optional image. */
interface ColumnItem {
    name: string;
    image: string | null;
}

/** One row item down the side (e.g. an exporter) with its values per [measure][column]. */
interface RowItem {
    name: string | null;
    values: PrimitiveValue[][];
}

interface MatrixModel {
    rowsFieldName: string | null;
    columns: ColumnItem[];
    measures: DataViewMetadataColumn[];
    rows: RowItem[];
}

export class Visual implements IVisual {
    private readonly root: HTMLElement;
    private formattingSettings: VisualFormattingSettingsModel;
    private readonly formattingSettingsService: FormattingSettingsService;

    constructor(options: VisualConstructorOptions) {
        this.formattingSettingsService = new FormattingSettingsService();
        this.root = document.createElement("div");
        this.root.className = "fm-root";
        options.element.appendChild(this.root);
    }

    public update(options: VisualUpdateOptions): void {
        const dataView: DataView | undefined = options.dataViews && options.dataViews[0];
        this.formattingSettings = this.formattingSettingsService.populateFormattingSettingsModel(VisualFormattingSettingsModel, dataView);
        this.root.replaceChildren();

        const model = dataView && dataView.matrix ? Visual.buildModel(dataView.matrix) : null;
        if (!model || model.columns.length === 0 || model.measures.length === 0) {
            this.renderLandingPage();
            return;
        }
        this.render(model);
    }

    public getFormattingModel(): powerbi.visuals.FormattingModel {
        return this.formattingSettingsService.buildFormattingModel(this.formattingSettings);
    }

    /** Turns the matrix data view into columns x measures x row items. */
    private static buildModel(matrix: DataViewMatrix): MatrixModel {
        const measures = matrix.valueSources || [];
        const columnLevels = matrix.columns.levels || [];
        // Columns role: the first field is the column name, an optional second field is the header image.
        // A trailing level holding the measures appears when there are several Values.
        const columnFieldLevels = columnLevels
            .map((level, index) => ({ index, isColumns: !!(level.sources[0] && level.sources[0].roles && level.sources[0].roles["columns"]) }))
            .filter(level => level.isColumns)
            .map(level => level.index);
        const levelRole = (level: number): string | null => {
            if (level === columnFieldLevels[0]) return "columns";
            if (level === columnFieldLevels[1]) return "columnImage";
            return null;
        };

        // Walk the column hierarchy (column -> image -> measure) in display order. Each leaf is one cell
        // index in the row nodes' `values`.
        const columns: ColumnItem[] = [];
        const columnIndexByKey = new Map<string, number>();
        const leafTargets: { column: number; measure: number }[] = [];
        const walk = (node: DataViewMatrixNode, name: string | null, image: string | null): void => {
            const role = node.level === undefined ? null : levelRole(node.level);
            if (role === "columns") name = Visual.formatValue(node.value, columnLevels[node.level].sources[0]);
            if (role === "columnImage") image = node.value == null ? null : String(node.value);
            const children = (node.children || []).filter(c => !c.isSubtotal);
            if (children.length > 0) {
                children.forEach(child => walk(child, name, image));
                return;
            }
            if (name === null) return;
            let column = columnIndexByKey.get(name);
            if (column === undefined) {
                column = columns.length;
                columns.push({ name, image });
                columnIndexByKey.set(name, column);
            }
            leafTargets.push({ column, measure: node.levelSourceIndex || 0 });
        };
        walk(matrix.columns.root, null, null);

        const rowLevels = matrix.rows.levels || [];
        const rowsSource = rowLevels[0] && rowLevels[0].sources[0];
        const hasRowsField = !!(rowsSource && rowsSource.roles && rowsSource.roles["rows"]);
        const rowNodes = hasRowsField
            ? (matrix.rows.root.children || []).filter(n => !n.isSubtotal)
            : [matrix.rows.root.children && matrix.rows.root.children.length ? matrix.rows.root.children[0] : matrix.rows.root];

        const rows: RowItem[] = rowNodes.map(node => {
            const values: PrimitiveValue[][] = measures.map(() => columns.map(() => null));
            const cells = node.values || {};
            leafTargets.forEach((target, leafIndex) => {
                const cell = cells[leafIndex];
                if (cell) values[target.measure][target.column] = cell.value;
            });
            return { name: hasRowsField ? Visual.formatValue(node.value, rowsSource) : null, values };
        });

        return { rowsFieldName: hasRowsField ? rowsSource.displayName : null, columns, measures, rows };
    }

    private static formatValue(value: PrimitiveValue, source: DataViewMetadataColumn | undefined): string {
        if (value === null || value === undefined) return "";
        return valueFormatter.format(value, source && source.format);
    }

    /** Alignment slice value as a CSS text-align keyword; anything unexpected falls back to right. */
    private static alignment(value: string | undefined): "left" | "center" | "right" {
        return value === "left" || value === "center" ? value : "right";
    }

    /** Accepts a data: URI, an http(s) URL, or bare base64 PNG data. */
    private static imageSource(value: string | null): string | null {
        if (!value) return null;
        const v = value.trim();
        if (v.startsWith("data:") || /^https?:\/\//i.test(v)) return v;
        return "data:image/png;base64," + v;
    }

    private render(model: MatrixModel): void {
        const s = this.formattingSettings;
        const header = s.header, groups = s.rowGroups, cells = s.cells;
        const headerAlign = Visual.alignment(header.alignment.value);
        const cellAlign = Visual.alignment(cells.alignment.value);
        const firstColumnWidth = Math.max(0, Math.round(Number(s.firstColumn.width.value) || 0));
        // Every first-column cell gets the same width, so the frozen column lines up in all rows.
        const sizeFirstColumn = (cell: HTMLElement): void => {
            if (firstColumnWidth > 0) {
                cell.style.width = cell.style.minWidth = cell.style.maxWidth = `${firstColumnWidth}px`;
                cell.classList.add("fm-fixed");
                if (cell.textContent) cell.title = cell.textContent;
            } else {
                // A 1px width shrinks the column to its longest label; the spare width goes to the value columns.
                cell.style.width = "1px";
            }
        };

        const scroll = document.createElement("div");
        scroll.className = "fm-scroll";
        const table = document.createElement("table");
        table.className = "fm-table";
        table.style.fontSize = `${cells.fontSize.value}pt`;
        table.style.color = cells.fontColor.value.value;

        // Header row: corner + one cell per column item (image then name).
        const thead = document.createElement("thead");
        const headRow = document.createElement("tr");
        const corner = document.createElement("th");
        corner.className = "fm-corner";
        corner.textContent = model.rowsFieldName || "";
        sizeFirstColumn(corner);
        headRow.appendChild(corner);
        model.columns.forEach(column => {
            const th = document.createElement("th");
            th.className = "fm-col";
            th.style.minWidth = `${cells.columnWidth.value}px`;
            th.style.textAlign = headerAlign;
            const wrap = document.createElement("div");
            wrap.className = "fm-col-head";
            wrap.style.justifyContent = headerAlign === "right" ? "flex-end" : headerAlign === "center" ? "center" : "flex-start";
            const src = Visual.imageSource(column.image);
            if (src) {
                const img = document.createElement("img");
                img.src = src;
                img.alt = "";
                img.style.height = `${header.imageHeight.value}px`;
                wrap.appendChild(img);
            }
            const label = document.createElement("span");
            label.textContent = column.name;
            wrap.appendChild(label);
            th.appendChild(wrap);
            headRow.appendChild(th);
        });
        [corner, ...Array.from(headRow.querySelectorAll<HTMLElement>("th.fm-col"))].forEach(th => {
            th.style.fontSize = `${header.fontSize.value}pt`;
            th.style.color = header.fontColor.value.value;
            th.style.backgroundColor = header.backColor.value.value;
        });
        thead.appendChild(headRow);
        table.appendChild(thead);

        // Body. With a Rows field and several measures: a group row per item, then one indented row per measure.
        // With a Rows field and one measure: one row per item. Without a Rows field: one row per measure.
        const tbody = document.createElement("tbody");
        let band = 0;
        const addValueRow = (labelText: string, indent: boolean, values: PrimitiveValue[], format: string | undefined) => {
            const tr = document.createElement("tr");
            tr.className = "fm-value-row";
            if (band++ % 2 === 1) tr.style.backgroundColor = cells.bandColor.value.value;
            const th = document.createElement("th");
            th.className = indent ? "fm-label fm-indent" : "fm-label";
            th.scope = "row";
            th.textContent = labelText;
            sizeFirstColumn(th);
            tr.appendChild(th);
            values.forEach(value => {
                const td = document.createElement("td");
                td.className = "fm-cell";
                td.style.textAlign = cellAlign;
                td.textContent = value === null || value === undefined ? "" : valueFormatter.format(value, format);
                if (typeof value === "number" && value < 0) td.style.color = cells.negativeColor.value.value;
                tr.appendChild(td);
            });
            tbody.appendChild(tr);
        };

        const grouped = model.rowsFieldName !== null && model.measures.length > 1;
        model.rows.forEach(row => {
            if (grouped) {
                // The name sits in the frozen first column; a spanning filler carries the band across the
                // value columns. A single colspan cell can't stay pinned while scrolling horizontally.
                const tr = document.createElement("tr");
                tr.className = "fm-group-row";
                tr.style.backgroundColor = groups.backColor.value.value;
                const th = document.createElement("th");
                th.className = "fm-group";
                th.scope = "rowgroup";
                th.textContent = row.name || "";
                th.style.fontSize = `${groups.fontSize.value}pt`;
                th.style.color = groups.fontColor.value.value;
                th.style.backgroundColor = groups.backColor.value.value;
                sizeFirstColumn(th);
                tr.appendChild(th);
                const filler = document.createElement("td");
                filler.className = "fm-group-fill";
                filler.colSpan = model.columns.length;
                tr.appendChild(filler);
                tbody.appendChild(tr);
                band = 0;
            }
            model.measures.forEach((measure, m) => {
                const label = model.rowsFieldName !== null && !grouped ? (row.name || "") : measure.displayName;
                addValueRow(label, grouped, row.values[m], measure.format);
            });
        });
        table.appendChild(tbody);
        scroll.appendChild(table);
        this.root.appendChild(scroll);
    }

    private renderLandingPage(): void {
        const div = document.createElement("div");
        div.className = "fm-landing";
        const title = document.createElement("strong");
        title.textContent = "Flag Matrix";
        const text = document.createElement("p");
        text.textContent = "Add a field to Columns (e.g. country name) and one or more measures to Values. "
            + "Optionally add a second Columns field with an image (flag as base64, data: URI or URL) and a Rows field (e.g. exporter).";
        div.appendChild(title);
        div.appendChild(text);
        this.root.appendChild(div);
    }
}
