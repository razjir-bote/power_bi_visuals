"use strict";

import powerbi from "powerbi-visuals-api";
import { FormattingSettingsService } from "powerbi-visuals-utils-formattingmodel";
import { valueFormatter } from "powerbi-visuals-utils-formattingutils";
import { geoPath, geoNaturalEarth1, geoEqualEarth, geoMercator, GeoProjection } from "d3-geo";
import { feature } from "topojson-client";
import type { Topology, GeometryCollection } from "topojson-specification";
import type { Feature, FeatureCollection, Geometry } from "geojson";
import * as isoCountries from "i18n-iso-countries";
import enLocale from "i18n-iso-countries/langs/en.json";
import worldTopology from "world-atlas/countries-50m.json";
import gazetteer from "./data/cities.json";
import "./../style/visual.less";

import VisualConstructorOptions = powerbi.extensibility.visual.VisualConstructorOptions;
import VisualUpdateOptions = powerbi.extensibility.visual.VisualUpdateOptions;
import IVisual = powerbi.extensibility.visual.IVisual;
import IVisualHost = powerbi.extensibility.visual.IVisualHost;
import ISelectionManager = powerbi.extensibility.ISelectionManager;
import ISelectionId = powerbi.visuals.ISelectionId;
import DataView = powerbi.DataView;
import DataViewCategoryColumn = powerbi.DataViewCategoryColumn;
import DataViewMetadataColumn = powerbi.DataViewMetadataColumn;
import VisualTooltipDataItem = powerbi.extensibility.VisualTooltipDataItem;
import PrimitiveValue = powerbi.PrimitiveValue;

import { VisualFormattingSettingsModel } from "./settings";

isoCountries.registerLocale(enLocale);

const SVG_NS = "http://www.w3.org/2000/svg";
const MAX_ZOOM = 24;
const DRAG_THRESHOLD_PX = 4;

interface CountryShape {
    iso2: string | null;
    feature: Feature<Geometry>;
}

/** One row of data: a located city with its measure values. */
interface CityPoint {
    label: string;
    iso2: string | null;
    lon: number;
    lat: number;
    value: number | null;
    highlighted: boolean;
    selectionId: ISelectionId;
    tooltips: VisualTooltipDataItem[];
}

interface CityModel {
    rowCount: number;
    blankCityRows: number;
    points: CityPoint[];
    unmatched: string[];
    sizeSource: DataViewMetadataColumn | null;
}

/** A column's label box relative to the city point, used to hide labels that would overlap. */
interface LabelBox {
    el: SVGTextElement;
    left: number;
    top: number;
    width: number;
    height: number;
}

interface ZoomState {
    k: number;
    x: number;
    y: number;
}

// world-atlas keys shapes by ISO 3166-1 numeric code; a few disputed areas have no code.
const NAME_TO_ISO2: Record<string, string> = { "Kosovo": "XK" };

const SHAPES: CountryShape[] = (() => {
    const topology = worldTopology as unknown as Topology<{ countries: GeometryCollection<{ name: string }> }>;
    const collection = feature(topology, topology.objects.countries) as FeatureCollection<Geometry, { name: string }>;
    return collection.features.map(f => ({
        iso2: (f.id !== undefined ? isoCountries.numericToAlpha2(f.id) : undefined) || NAME_TO_ISO2[f.properties.name] || null,
        feature: f,
    }));
})();

// Common codes that are not ISO 3166-1 alpha-2.
const ISO2_ALIASES: Record<string, string> = { "UK": "GB", "EL": "GR" };

/** Resolves an alpha-2, alpha-3 or numeric code, or an English name, to an ISO alpha-2 code. */
function toIso2(raw: PrimitiveValue): string | null {
    if (raw === null || raw === undefined) return null;
    const text = String(raw).trim();
    if (!text) return null;
    const upper = text.toUpperCase();
    if (/^[A-Z]{2}$/.test(upper)) return ISO2_ALIASES[upper] || (isoCountries.isValid(upper) || upper === "XK" ? upper : null);
    if (/^[A-Z]{3}$/.test(upper)) return isoCountries.alpha3ToAlpha2(upper) || null;
    if (/^\d{1,3}$/.test(text)) return isoCountries.numericToAlpha2(text) || null;
    return isoCountries.getAlpha2Code(text, "en") || (text.toLowerCase() === "kosovo" ? "XK" : null);
}

/** Case-, accent- and punctuation-insensitive key for city names. */
function normalizeName(name: string): string {
    return name.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

type LatLon = [number, number];

/** City lookup built on first use from the embedded GeoNames rows (most populous first, so first match wins). */
let cityIndex: { byCountry: Map<string, LatLon>; anyCountry: Map<string, LatLon> } | null = null;
function lookupCity(name: string, iso2: string | null): LatLon | null {
    if (!cityIndex) {
        const byCountry = new Map<string, LatLon>(), anyCountry = new Map<string, LatLon>();
        const aliases: [string, string, LatLon][] = [];
        for (const row of (gazetteer as { rows: string }).rows.split("\n")) {
            const [cc, city, lat, lon] = row.split("\t");
            const key = normalizeName(city), at: LatLon = [+lat, +lon];
            if (!byCountry.has(cc + "|" + key)) byCountry.set(cc + "|" + key, at);
            if (!anyCountry.has(key)) anyCountry.set(key, at);
            // "New York City" should also answer to "New York".
            if (key.endsWith(" city")) aliases.push([cc, key.slice(0, -5), at]);
        }
        aliases.forEach(([cc, key, at]) => {
            if (!byCountry.has(cc + "|" + key)) byCountry.set(cc + "|" + key, at);
            if (!anyCountry.has(key)) anyCountry.set(key, at);
        });
        cityIndex = { byCountry, anyCountry };
    }
    const key = normalizeName(name);
    return (iso2 ? cityIndex.byCountry.get(iso2 + "|" + key) : cityIndex.anyCountry.get(key)) || null;
}

function hexToRgb(hex: string): [number, number, number] {
    const h = hex.replace("#", "");
    const full = h.length === 3 ? h.split("").map(c => c + c).join("") : h.slice(0, 6);
    const n = parseInt(full, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function mix(from: string, to: string, t: number): string {
    const a = hexToRgb(from), b = hexToRgb(to);
    const k = Math.max(0, Math.min(1, t));
    return "#" + a.map((v, i) => Math.round(v + (b[i] - v) * k).toString(16).padStart(2, "0")).join("");
}

/** Rounds up to 1, 2, 2.5 or 5 x 10^n so the block key reads cleanly. */
function niceStep(raw: number): number {
    const p = Math.pow(10, Math.floor(Math.log10(raw)));
    const f = raw / p;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
}

function svgEl<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
    const el = document.createElementNS(SVG_NS, tag);
    Object.keys(attrs).forEach(name => el.setAttribute(name, String(attrs[name])));
    return el;
}

export class Visual implements IVisual {
    private readonly host: IVisualHost;
    private readonly element: HTMLElement;
    private readonly root: HTMLElement;
    private readonly selectionManager: ISelectionManager;
    private readonly formattingSettingsService: FormattingSettingsService;
    private formattingSettings: VisualFormattingSettingsModel;
    private columns: { g: SVGGElement; x: number; y: number; point: CityPoint; label: LabelBox | null }[] = [];
    // Kept across updates (data/selection changes) and reset when the map's framing changes.
    private zoom: ZoomState = { k: 1, x: 0, y: 0 };
    private zoomFrameKey = "";
    private suppressClickUntil = 0;

    constructor(options: VisualConstructorOptions) {
        this.host = options.host;
        this.element = options.element;
        this.formattingSettingsService = new FormattingSettingsService();
        this.selectionManager = this.host.createSelectionManager();
        this.selectionManager.registerOnSelectCallback(() => this.applySelectionStyle());
        this.root = document.createElement("div");
        this.root.className = "cb-root";
        this.element.appendChild(this.root);
    }

    public update(options: VisualUpdateOptions): void {
        const dataView: DataView | undefined = options.dataViews && options.dataViews[0];
        this.formattingSettings = this.formattingSettingsService.populateFormattingSettingsModel(VisualFormattingSettingsModel, dataView);
        this.root.replaceChildren();
        this.columns = [];

        const model = dataView ? this.buildModel(dataView) : null;
        if (!model) {
            this.renderLandingPage();
            return;
        }
        this.render(model, options.viewport.width, options.viewport.height);
    }

    public getFormattingModel(): powerbi.visuals.FormattingModel {
        return this.formattingSettingsService.buildFormattingModel(this.formattingSettings);
    }

    private buildModel(dataView: DataView): CityModel | null {
        const categorical = dataView.categorical;
        const categories = (categorical && categorical.categories) || [];
        const byRole = (role: string): DataViewCategoryColumn | undefined => categories.find(c => c.source.roles && c.source.roles[role]);
        const cityColumn = byRole("city"), countryColumn = byRole("country");
        const latColumn = byRole("latitude"), lonColumn = byRole("longitude");
        if (!cityColumn && !(latColumn && lonColumn)) return null;

        const valueColumns = (categorical && categorical.values) || [];
        const sizeColumn = valueColumns.find(c => c.source.roles && c.source.roles["size"]) || null;
        const tooltipColumns = valueColumns.filter(c => c.source.roles && c.source.roles["tooltips"]);
        const highlightColumn = sizeColumn || valueColumns[0];
        const hasHighlights = !!(highlightColumn && highlightColumn.highlights);
        const rowCount = (cityColumn || latColumn).values.length;

        const points: CityPoint[] = [];
        const unmatched: string[] = [];
        let blankCityRows = 0;
        for (let i = 0; i < rowCount; i++) {
            const cityRaw = cityColumn ? cityColumn.values[i] : null;
            const countryRaw = countryColumn ? countryColumn.values[i] : null;
            const city = cityRaw === null || cityRaw === undefined ? "" : String(cityRaw).trim();
            if (cityColumn && !city) blankCityRows++;
            const iso2 = toIso2(countryRaw);
            const label = city || (countryRaw === null || countryRaw === undefined ? "" : String(countryRaw));

            let at: LatLon | null = null;
            const lat = latColumn ? Number(latColumn.values[i]) : NaN, lon = lonColumn ? Number(lonColumn.values[i]) : NaN;
            if (latColumn && lonColumn && latColumn.values[i] !== null && lonColumn.values[i] !== null && isFinite(lat) && isFinite(lon)) at = [lat, lon];
            else if (city && (iso2 || !countryColumn)) at = lookupCity(city, iso2);
            if (!at) {
                if (label) unmatched.push(countryRaw ? `${label} (${countryRaw})` : label);
                continue;
            }

            const value = sizeColumn ? sizeColumn.values[i] : null;
            const tooltips: VisualTooltipDataItem[] = [];
            [sizeColumn, ...tooltipColumns].forEach(column => {
                if (!column) return;
                const v = column.values[i];
                tooltips.push({ displayName: column.source.displayName, value: v === null || v === undefined ? "(Blank)" : valueFormatter.format(v, column.source.format) });
            });
            const builder = this.host.createSelectionIdBuilder();
            [cityColumn, countryColumn, latColumn, lonColumn].forEach(column => { if (column) builder.withCategory(column, i); });
            points.push({
                label,
                iso2,
                lat: at[0],
                lon: at[1],
                value: typeof value === "number" ? value : null,
                highlighted: !hasHighlights || (highlightColumn.highlights[i] !== null && highlightColumn.highlights[i] !== undefined),
                selectionId: builder.createSelectionId(),
                tooltips,
            });
        }
        return { rowCount, blankCityRows, points, unmatched, sizeSource: sizeColumn ? sizeColumn.source : null };
    }

    private createProjection(): GeoProjection {
        switch (this.formattingSettings.map.projection.value.value) {
            case "mercator": return geoMercator();
            case "equalEarth": return geoEqualEarth();
            default: return geoNaturalEarth1();
        }
    }

    private render(model: CityModel, width: number, height: number): void {
        const s = this.formattingSettings;
        const mapSettings = s.map, blocks = s.blocks;

        const values = model.points.map(p => p.value).filter((v): v is number => v !== null && v > 0);
        const max = values.length ? Math.max(...values) : 0;
        const blockValue = blocks.blockValue.value > 0 ? blocks.blockValue.value : max > 0 ? niceStep(max / 8) : 1;
        const blockHeight = max > 0 ? blocks.maxHeight.value / Math.ceil(max / blockValue) : 0;
        const showKey = blocks.showKey.value && max > 0;

        const svg = svgEl("svg", { "class": "cb-svg", width, height });
        svg.style.backgroundColor = mapSettings.backColor.value.value;
        svg.addEventListener("click", (event: MouseEvent) => {
            if (Date.now() < this.suppressClickUntil) {
                event.stopPropagation();
                event.preventDefault();
            }
        }, true);
        if (this.host.hostCapabilities.allowInteractions) svg.addEventListener("click", () => {
            this.selectionManager.clear().then(() => this.applySelectionStyle());
        });
        svg.addEventListener("contextmenu", (event: MouseEvent) => {
            this.selectionManager.showContextMenu({}, { x: event.clientX, y: event.clientY });
            event.preventDefault();
        });

        // Frame the map, leaving headroom so columns near the top edge stay visible.
        const shapes = SHAPES.filter(shape => !(mapSettings.hideAntarctica.value && shape.iso2 === "AQ"));
        const dataCountries = new Set(model.points.map(p => p.iso2).filter(c => c));
        const dataShapes = shapes.filter(shape => shape.iso2 && dataCountries.has(shape.iso2));
        const frame = mapSettings.zoomToData.value && dataShapes.length ? dataShapes : shapes;
        const pad = 8, keyHeight = showKey ? 28 : 0;
        const headroom = Math.min(blocks.maxHeight.value * 0.6, height / 3);
        const projection = this.createProjection().fitExtent(
            [[pad, pad + headroom], [Math.max(pad + 1, width - pad), Math.max(pad + headroom + 1, height - pad - keyHeight)]],
            { type: "FeatureCollection", features: frame.map(shape => shape.feature) });
        const path = geoPath(projection);

        const mapLayer = svgEl("g", { "class": "cb-map" });
        shapes.forEach(shape => {
            const d = path(shape.feature);
            if (!d) return;
            const highlighted = mapSettings.highlightCountries.value && shape.iso2 && dataCountries.has(shape.iso2);
            mapLayer.appendChild(svgEl("path", {
                d,
                fill: highlighted ? mapSettings.countryHighlightColor.value.value : mapSettings.landColor.value.value,
                stroke: mapSettings.borderColor.value.value,
                "stroke-width": 0.5,
                "vector-effect": "non-scaling-stroke",
            }));
        });
        svg.appendChild(mapLayer);

        // Columns stay a constant size while the map zooms, so they live in their own layer and are re-positioned.
        const columnLayer = svgEl("g", { "class": "cb-columns" });
        const placed = model.points
            .map(point => ({ point, xy: projection([point.lon, point.lat]) }))
            .filter(item => item.xy && isFinite(item.xy[0]) && isFinite(item.xy[1]))
            // North to south, so nearer (lower) columns are drawn in front.
            .sort((a, b) => a.xy[1] - b.xy[1]);
        placed.forEach(({ point, xy }) => {
            const { g, label } = this.renderColumn(point, blockValue, blockHeight, model.sizeSource);
            this.attachInteractions(g, point);
            columnLayer.appendChild(g);
            this.columns.push({ g, x: xy[0], y: xy[1], point, label });
        });
        svg.appendChild(columnLayer);

        if (showKey) svg.appendChild(this.renderKey(model.sizeSource, blockValue, height));
        this.root.appendChild(svg);

        if (model.points.length === 0) this.renderEmptyMessage(model);

        const footer = document.createElement("div");
        footer.className = "cb-footer";
        if (model.unmatched.length) {
            const note = document.createElement("div");
            note.className = "cb-unmatched";
            note.textContent = `Not placed: ${model.unmatched.slice(0, 5).join(", ")}${model.unmatched.length > 5 ? ` (+${model.unmatched.length - 5} more)` : ""}`;
            footer.appendChild(note);
        }
        const credit = document.createElement("div");
        credit.className = "cb-credit";
        credit.textContent = "Cities: GeoNames (CC BY 4.0)";
        footer.appendChild(credit);
        this.root.appendChild(footer);

        const zoomable = mapSettings.zoomEnabled.value && this.host.hostCapabilities.allowInteractions;
        const frameKey = [width, height, mapSettings.projection.value.value, mapSettings.zoomToData.value, mapSettings.hideAntarctica.value, showKey, blocks.maxHeight.value].join("|");
        if (!zoomable || frameKey !== this.zoomFrameKey) this.zoom = { k: 1, x: 0, y: 0 };
        this.zoomFrameKey = frameKey;
        this.applyZoom(mapLayer, this.zoom, width, height);
        if (zoomable) this.enableZoom(svg, mapLayer, width, height);
        this.applySelectionStyle();
    }

    /** A stack of blocks rising from (0, 0); the top block is partial for the remainder. */
    private renderColumn(point: CityPoint, blockValue: number, blockHeight: number, sizeSource: DataViewMetadataColumn | null): { g: SVGGElement; label: LabelBox | null } {
        const s = this.formattingSettings;
        const color = s.blocks.color.value.value;
        const w = Math.max(2, s.blocks.width.value);
        const dx = s.blocks.depth.value ? w * 0.45 : 0, dy = s.blocks.depth.value ? w * 0.3 : 0;
        const x0 = -(w + dx) / 2;
        const front = color, side = mix(color, "#000000", 0.28), top = mix(color, "#FFFFFF", 0.35);

        const g = svgEl("g", { "class": "cb-column" });
        g.appendChild(svgEl("ellipse", { cx: 0, cy: 0, rx: (w + dx) * 0.6, ry: (w + dx) * 0.22, "class": "cb-shadow" }));

        const value = point.value !== null && point.value > 0 ? point.value : 0;
        const count = value / blockValue;
        let y = 0;
        for (let i = 0; i < Math.ceil(count); i++) {
            const h = blockHeight * Math.min(1, count - i);
            const yTop = y - h;
            const block = svgEl("g", { "class": "cb-block" });
            block.appendChild(svgEl("rect", { x: x0, y: yTop, width: w, height: h, fill: front }));
            if (dx > 0) {
                block.appendChild(svgEl("polygon", { points: `${x0 + w},${y} ${x0 + w + dx},${y - dy} ${x0 + w + dx},${yTop - dy} ${x0 + w},${yTop}`, fill: side }));
                block.appendChild(svgEl("polygon", { points: `${x0},${yTop} ${x0 + dx},${yTop - dy} ${x0 + w + dx},${yTop - dy} ${x0 + w},${yTop}`, fill: top }));
            }
            g.appendChild(block);
            y = yTop;
        }
        if (value === 0) g.appendChild(svgEl("circle", { cx: 0, cy: 0, r: 3, fill: side, "class": "cb-dot" }));

        let label: LabelBox | null = null;
        if (s.labels.show.value) {
            const fontSize = s.labels.fontSize.value;
            const text = svgEl("text", { x: 0, y: y - dy - 4, "text-anchor": "middle", "font-size": `${fontSize}pt`, "class": "cb-label" });
            if (s.labels.showCity.value) {
                const name = svgEl("tspan", { x: 0, dy: point.value !== null ? `-${fontSize * 1.25}pt` : 0, "class": "cb-label-city" });
                name.textContent = point.label;
                text.appendChild(name);
            }
            if (point.value !== null) {
                const amount = svgEl("tspan", { x: 0, dy: s.labels.showCity.value ? `${fontSize * 1.25}pt` : 0 });
                amount.textContent = valueFormatter.format(point.value, sizeSource && sizeSource.format);
                text.appendChild(amount);
            }
            g.appendChild(text);
            // Estimated box (no layout needed): ~0.55em per character, 1.25em per line.
            const lines = Array.from(text.childNodes).map(n => n.textContent || "");
            const linePx = fontSize * 4 / 3 * 1.25;
            const width = Math.max(...lines.map(l => l.length), 1) * fontSize * 4 / 3 * 0.55;
            const bottom = y - dy - 4 + linePx * 0.3;
            label = { el: text, left: -width / 2, top: bottom - lines.length * linePx, width, height: lines.length * linePx };
        }
        return { g, label };
    }

    /** Shows labels largest value first and hides any that would overlap one already shown. */
    private declutterLabels(): void {
        const shown: { l: number; t: number; r: number; b: number }[] = [];
        [...this.columns]
            .sort((a, b) => (b.point.value || 0) - (a.point.value || 0))
            .forEach(column => {
                if (!column.label) return;
                const [cx, cy] = this.screenPosition(column);
                const box = { l: cx + column.label.left, t: cy + column.label.top, r: cx + column.label.left + column.label.width, b: cy + column.label.top + column.label.height };
                const overlaps = shown.some(o => box.l < o.r && box.r > o.l && box.t < o.b && box.b > o.t);
                column.label.el.style.display = overlaps ? "none" : "";
                if (!overlaps) shown.push(box);
            });
    }

    private screenPosition(column: { x: number; y: number }): [number, number] {
        return [column.x * this.zoom.k + this.zoom.x, column.y * this.zoom.k + this.zoom.y];
    }

    /** "[block] = 2,500 Exports ($m)" in the bottom-left corner. */
    private renderKey(sizeSource: DataViewMetadataColumn | null, blockValue: number, height: number): SVGGElement {
        const s = this.formattingSettings;
        const color = s.blocks.color.value.value;
        const g = svgEl("g", { "class": "cb-key", transform: `translate(12, ${height - 14})` });
        g.appendChild(svgEl("rect", { x: 0, y: -10, width: 10, height: 10, fill: color }));
        if (s.blocks.depth.value) {
            g.appendChild(svgEl("polygon", { points: "10,0 14.5,-3 14.5,-13 10,-10", fill: mix(color, "#000000", 0.28) }));
            g.appendChild(svgEl("polygon", { points: "0,-10 4.5,-13 14.5,-13 10,-10", fill: mix(color, "#FFFFFF", 0.35) }));
        }
        const text = svgEl("text", { x: 20, y: -1, "font-size": "9pt" });
        const format = sizeSource && sizeSource.format;
        text.textContent = `1 block = ${valueFormatter.format(blockValue, format)}${sizeSource ? " " + sizeSource.displayName : ""}`;
        g.appendChild(text);
        return g;
    }

    /** Clamps the zoom so the map always covers the viewport, scales the map and moves the columns. */
    private applyZoom(mapLayer: SVGGElement, next: ZoomState, width: number, height: number): void {
        const k = Math.max(1, Math.min(MAX_ZOOM, next.k));
        const x = Math.max(width * (1 - k), Math.min(0, next.x));
        const y = Math.max(height * (1 - k), Math.min(0, next.y));
        this.zoom = { k, x, y };
        mapLayer.setAttribute("transform", `translate(${x},${y}) scale(${k})`);
        this.columns.forEach(column => {
            const [cx, cy] = this.screenPosition(column);
            column.g.setAttribute("transform", `translate(${cx},${cy})`);
        });
        this.declutterLabels();
    }

    /** Zooms by `factor` keeping the viewport point (px, py) fixed. */
    private zoomAt(mapLayer: SVGGElement, factor: number, px: number, py: number, width: number, height: number): void {
        const { k, x, y } = this.zoom;
        const nk = Math.max(1, Math.min(MAX_ZOOM, k * factor));
        this.applyZoom(mapLayer, { k: nk, x: px - (px - x) * nk / k, y: py - (py - y) * nk / k }, width, height);
    }

    /** Mouse wheel zooms around the cursor, dragging pans, and optional +/-/reset buttons. */
    private enableZoom(svg: SVGSVGElement, mapLayer: SVGGElement, width: number, height: number): void {
        svg.classList.add("cb-zoomable");
        // Client pixels -> SVG units; the report canvas may be scaled (e.g. Fit to page).
        const toLocal = (event: MouseEvent): [number, number] => {
            const rect = svg.getBoundingClientRect();
            return [(event.clientX - rect.left) * width / (rect.width || width), (event.clientY - rect.top) * height / (rect.height || height)];
        };

        svg.addEventListener("wheel", (event: WheelEvent) => {
            event.preventDefault();
            const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? height : 1);
            const [px, py] = toLocal(event);
            this.zoomAt(mapLayer, Math.exp(-delta * 0.002), px, py, width, height);
        }, { passive: false });

        let drag: { pointerId: number; startX: number; startY: number; zoomX: number; zoomY: number; moving: boolean } | null = null;
        svg.addEventListener("pointerdown", (event: PointerEvent) => {
            if (event.button !== 0) return;
            const [px, py] = toLocal(event);
            drag = { pointerId: event.pointerId, startX: px, startY: py, zoomX: this.zoom.x, zoomY: this.zoom.y, moving: false };
        });
        svg.addEventListener("pointermove", (event: PointerEvent) => {
            if (!drag || event.pointerId !== drag.pointerId) return;
            const [px, py] = toLocal(event);
            const dx = px - drag.startX, dy = py - drag.startY;
            if (!drag.moving) {
                if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
                // Capture only once it is a drag, so plain clicks still reach the column under the pointer.
                drag.moving = true;
                svg.setPointerCapture(event.pointerId);
                svg.classList.add("cb-dragging");
                this.host.tooltipService.hide({ immediately: true, isTouchEvent: false });
            }
            this.applyZoom(mapLayer, { k: this.zoom.k, x: drag.zoomX + dx, y: drag.zoomY + dy }, width, height);
        });
        const endDrag = (event: PointerEvent) => {
            if (!drag || event.pointerId !== drag.pointerId) return;
            if (drag.moving) {
                this.suppressClickUntil = Date.now() + 300;
                if (svg.hasPointerCapture(event.pointerId)) svg.releasePointerCapture(event.pointerId);
                svg.classList.remove("cb-dragging");
            }
            drag = null;
        };
        svg.addEventListener("pointerup", endDrag);
        svg.addEventListener("pointercancel", endDrag);

        if (!this.formattingSettings.map.showZoomButtons.value) return;
        const buttons = document.createElement("div");
        buttons.className = "cb-zoom-buttons";
        const addButton = (label: string, title: string, action: () => void) => {
            const button = document.createElement("button");
            button.type = "button";
            button.textContent = label;
            button.title = title;
            button.setAttribute("aria-label", title);
            button.addEventListener("click", (event: MouseEvent) => {
                event.stopPropagation();
                action();
            });
            buttons.appendChild(button);
        };
        addButton("+", "Zoom in", () => this.zoomAt(mapLayer, 1.6, width / 2, height / 2, width, height));
        addButton("−", "Zoom out", () => this.zoomAt(mapLayer, 1 / 1.6, width / 2, height / 2, width, height));
        addButton("⟲", "Reset zoom", () => this.applyZoom(mapLayer, { k: 1, x: 0, y: 0 }, width, height));
        this.root.appendChild(buttons);
    }

    private attachInteractions(g: SVGGElement, point: CityPoint): void {
        const tooltipService = this.host.tooltipService;
        // move() also replaces the tooltip content, so it must carry the same items as show().
        const dataItems: VisualTooltipDataItem[] = [{ displayName: "City", value: point.label }, ...point.tooltips];
        const tooltipArgs = (event: MouseEvent) => {
            const rect = this.element.getBoundingClientRect();
            return { coordinates: [event.clientX - rect.left, event.clientY - rect.top], isTouchEvent: false, dataItems, identities: [point.selectionId] };
        };
        g.addEventListener("mouseenter", (event: MouseEvent) => {
            if (tooltipService.enabled()) tooltipService.show(tooltipArgs(event));
        });
        g.addEventListener("mousemove", (event: MouseEvent) => {
            if (tooltipService.enabled()) tooltipService.move(tooltipArgs(event));
        });
        g.addEventListener("mouseleave", () => tooltipService.hide({ immediately: true, isTouchEvent: false }));
        if (!this.host.hostCapabilities.allowInteractions) return;
        g.addEventListener("click", (event: MouseEvent) => {
            event.stopPropagation();
            this.selectionManager.select(point.selectionId, event.ctrlKey || event.metaKey).then(() => this.applySelectionStyle());
        });
        g.addEventListener("contextmenu", (event: MouseEvent) => {
            event.stopPropagation();
            event.preventDefault();
            this.selectionManager.showContextMenu(point.selectionId, { x: event.clientX, y: event.clientY });
        });
    }

    /** Dims columns that are neither selected here nor highlighted by another visual. */
    private applySelectionStyle(): void {
        const selected = this.selectionManager.getSelectionIds() as ISelectionId[];
        const hasSelection = selected.length > 0;
        this.columns.forEach(({ g, point }) => {
            const isSelected = hasSelection && selected.some(id => id.equals(point.selectionId));
            const dim = hasSelection ? !isSelected : !point.highlighted;
            g.setAttribute("opacity", dim ? "0.3" : "1");
            g.classList.toggle("cb-selected", isSelected);
        });
    }

    /** Explains an empty map instead of leaving the user guessing. */
    private renderEmptyMessage(model: CityModel): void {
        const box = document.createElement("div");
        box.className = "cb-empty";
        const title = document.createElement("strong");
        const text = document.createElement("p");
        if (model.rowCount === 0 || model.blankCityRows === model.rowCount) {
            // Typical right after a column is added to the model: Desktop drops the table's cached data until a refresh.
            title.textContent = "No cities to show";
            text.textContent = model.rowCount === 0
                ? "The fields returned no rows. Refresh the data (Home → Refresh) or check the filters on this page."
                : "The City field is blank. If it was just added to the model, refresh the data (Home → Refresh).";
        } else {
            title.textContent = model.rowCount === 1 ? "The city could not be placed" : `None of the ${model.rowCount} cities could be placed`;
            text.textContent = "Check that the City values are spelled as in English and the Country code is right (e.g. AU), or add Latitude and Longitude fields.";
        }
        box.appendChild(title);
        box.appendChild(text);
        this.root.appendChild(box);
    }

    private renderLandingPage(): void {
        const div = document.createElement("div");
        div.className = "cb-landing";
        const title = document.createElement("strong");
        title.textContent = "City Blocks";
        const text = document.createElement("p");
        text.textContent = "Add a City field and a Country code field (ISO alpha-2 such as AU), then a measure to Height. "
            + "Each city gets a column of stacked blocks scaled to the measure. Latitude and Longitude are optional overrides.";
        div.appendChild(title);
        div.appendChild(text);
        this.root.appendChild(div);
    }
}
