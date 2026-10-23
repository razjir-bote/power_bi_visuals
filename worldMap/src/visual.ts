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
import "./../style/visual.less";

import VisualConstructorOptions = powerbi.extensibility.visual.VisualConstructorOptions;
import VisualUpdateOptions = powerbi.extensibility.visual.VisualUpdateOptions;
import IVisual = powerbi.extensibility.visual.IVisual;
import IVisualHost = powerbi.extensibility.visual.IVisualHost;
import ISelectionManager = powerbi.extensibility.ISelectionManager;
import ISelectionId = powerbi.visuals.ISelectionId;
import DataView = powerbi.DataView;
import DataViewMetadataColumn = powerbi.DataViewMetadataColumn;
import VisualTooltipDataItem = powerbi.extensibility.VisualTooltipDataItem;
import PrimitiveValue = powerbi.PrimitiveValue;

import { VisualFormattingSettingsModel } from "./settings";

isoCountries.registerLocale(enLocale);

const SVG_NS = "http://www.w3.org/2000/svg";

/** A country shape from the embedded Natural Earth 1:50m data (world-atlas). */
interface CountryShape {
    iso2: string | null;
    name: string;
    feature: Feature<Geometry>;
}

/** One row of the Country field with its measure values. */
interface DataPoint {
    label: string;
    value: number | null;
    highlighted: boolean;
    selectionId: ISelectionId;
    tooltips: VisualTooltipDataItem[];
}

/** Pan/zoom applied to the country layer: translate(x, y) scale(k). */
interface ZoomState {
    k: number;
    x: number;
    y: number;
}

const MAX_ZOOM = 24;
const DRAG_THRESHOLD_PX = 4;

interface MapModel {
    points: Map<string, DataPoint>;
    unmatched: string[];
    colorSource: DataViewMetadataColumn | null;
    hasHighlights: boolean;
}

// world-atlas keys shapes by ISO 3166-1 numeric code; a few disputed areas have no code.
const NAME_TO_ISO2: Record<string, string> = { "Kosovo": "XK" };

const SHAPES: CountryShape[] = (() => {
    const topology = worldTopology as unknown as Topology<{ countries: GeometryCollection<{ name: string }> }>;
    const collection = feature(topology, topology.objects.countries) as FeatureCollection<Geometry, { name: string }>;
    return collection.features.map(f => ({
        iso2: (f.id !== undefined ? isoCountries.numericToAlpha2(f.id) : undefined) || NAME_TO_ISO2[f.properties.name] || null,
        name: f.properties.name,
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

let instanceCount = 0;

export class Visual implements IVisual {
    private readonly instanceId = ++instanceCount;
    private readonly host: IVisualHost;
    private readonly element: HTMLElement;
    private readonly root: HTMLElement;
    private readonly selectionManager: ISelectionManager;
    private readonly formattingSettingsService: FormattingSettingsService;
    private formattingSettings: VisualFormattingSettingsModel;
    private paths: { path: SVGPathElement; point: DataPoint | null }[] = [];
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
        this.root.className = "wm-root";
        this.element.appendChild(this.root);
    }

    public update(options: VisualUpdateOptions): void {
        const dataView: DataView | undefined = options.dataViews && options.dataViews[0];
        this.formattingSettings = this.formattingSettingsService.populateFormattingSettingsModel(VisualFormattingSettingsModel, dataView);
        this.root.replaceChildren();
        this.paths = [];

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

    private buildModel(dataView: DataView): MapModel | null {
        const categorical = dataView.categorical;
        const category = categorical && categorical.categories && categorical.categories[0];
        if (!category) return null;
        const valueColumns = categorical.values || [];
        const colorColumn = valueColumns.find(c => c.source.roles && c.source.roles["color"]) || null;
        const tooltipColumns = valueColumns.filter(c => c.source.roles && c.source.roles["tooltips"]);
        const hasHighlights = !!(colorColumn ? colorColumn.highlights : valueColumns.length && valueColumns[0].highlights);
        const highlightColumn = colorColumn || valueColumns[0];

        const points = new Map<string, DataPoint>();
        const unmatched: string[] = [];
        category.values.forEach((raw, i) => {
            const label = raw === null || raw === undefined ? "" : valueFormatter.format(raw, category.source.format);
            const iso2 = toIso2(raw);
            if (!iso2) {
                if (label) unmatched.push(label);
                return;
            }
            const value = colorColumn ? colorColumn.values[i] : null;
            const tooltips: VisualTooltipDataItem[] = [];
            [colorColumn, ...tooltipColumns].forEach(column => {
                if (!column) return;
                const v = column.values[i];
                tooltips.push({ displayName: column.source.displayName, value: v === null || v === undefined ? "(Blank)" : valueFormatter.format(v, column.source.format) });
            });
            points.set(iso2, {
                label,
                value: typeof value === "number" ? value : null,
                highlighted: !hasHighlights || (highlightColumn.highlights[i] !== null && highlightColumn.highlights[i] !== undefined),
                selectionId: this.host.createSelectionIdBuilder().withCategory(category, i).createSelectionId(),
                tooltips,
            });
        });
        return { points, unmatched, colorSource: colorColumn ? colorColumn.source : null, hasHighlights };
    }

    private createProjection(): GeoProjection {
        switch (this.formattingSettings.map.projection.value.value) {
            case "mercator": return geoMercator();
            case "equalEarth": return geoEqualEarth();
            default: return geoNaturalEarth1();
        }
    }

    private render(model: MapModel, width: number, height: number): void {
        const s = this.formattingSettings;
        const shading = s.shading;
        const values = Array.from(model.points.values()).map(p => p.value).filter((v): v is number => v !== null);
        const min = values.length ? Math.min(...values) : 0;
        const max = values.length ? Math.max(...values) : 0;
        const absMax = Math.max(Math.abs(min), Math.abs(max)) || 1;
        const diverging = shading.diverging.value;
        const fillFor = (point: DataPoint | null): string => {
            if (!point) return shading.noDataColor.value.value;
            if (!model.colorSource) return shading.highlightColor.value.value;
            if (point.value === null) return shading.noDataColor.value.value;
            if (diverging) {
                return point.value < 0
                    ? mix(shading.midColor.value.value, shading.minColor.value.value, -point.value / absMax)
                    : mix(shading.midColor.value.value, shading.maxColor.value.value, point.value / absMax);
            }
            return max === min ? shading.maxColor.value.value : mix(shading.minColor.value.value, shading.maxColor.value.value, (point.value - min) / (max - min));
        };

        const showLegend = s.legend.show.value && model.colorSource !== null && values.length > 0;
        const legendHeight = showLegend ? s.legend.fontSize.value * 1.4 + 22 : 0;
        const svg = document.createElementNS(SVG_NS, "svg");
        svg.setAttribute("class", "wm-svg");
        svg.setAttribute("width", String(width));
        svg.setAttribute("height", String(height));
        svg.style.backgroundColor = s.map.backColor.value.value;
        // The click that ends a drag must not select a country or clear the selection.
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

        const shapes = SHAPES.filter(shape => !(s.map.hideAntarctica.value && shape.iso2 === "AQ"));
        const dataShapes = shapes.filter(shape => shape.iso2 && model.points.has(shape.iso2));
        const frame = s.map.zoomToData.value && dataShapes.length ? dataShapes : shapes;
        const pad = 8;
        const projection = this.createProjection().fitExtent(
            [[pad, pad], [Math.max(pad + 1, width - pad), Math.max(pad + 1, height - pad - legendHeight)]],
            { type: "FeatureCollection", features: frame.map(shape => shape.feature) });
        const path = geoPath(projection);

        const group = document.createElementNS(SVG_NS, "g");
        // Draw countries with data last so their borders sit on top.
        const ordered = [...shapes.filter(shape => !dataShapes.includes(shape)), ...dataShapes];
        ordered.forEach(shape => {
            const d = path(shape.feature);
            if (!d) return;
            const point = shape.iso2 ? model.points.get(shape.iso2) || null : null;
            const el = document.createElementNS(SVG_NS, "path");
            el.setAttribute("d", d);
            el.setAttribute("class", point ? "wm-country wm-has-data" : "wm-country");
            el.setAttribute("fill", fillFor(point));
            el.setAttribute("stroke", s.borders.color.value.value);
            el.setAttribute("stroke-width", String(s.borders.width.value));
            el.setAttribute("vector-effect", "non-scaling-stroke");
            this.attachInteractions(el, shape, point);
            group.appendChild(el);
            this.paths.push({ path: el, point });
        });
        svg.appendChild(group);

        if (showLegend) svg.appendChild(this.renderLegend(model, min, max, absMax, height));
        this.root.appendChild(svg);

        const zoomable = s.map.zoomEnabled.value && this.host.hostCapabilities.allowInteractions;
        const frameKey = [width, height, s.map.projection.value.value, s.map.zoomToData.value, s.map.hideAntarctica.value, showLegend].join("|");
        if (!zoomable || frameKey !== this.zoomFrameKey) this.zoom = { k: 1, x: 0, y: 0 };
        this.zoomFrameKey = frameKey;
        this.applyZoom(group, this.zoom, width, height);
        if (zoomable) this.enableZoom(svg, group, width, height);

        if (model.unmatched.length) {
            const note = document.createElement("div");
            note.className = "wm-unmatched";
            note.textContent = `Not on map: ${model.unmatched.slice(0, 5).join(", ")}${model.unmatched.length > 5 ? ` (+${model.unmatched.length - 5} more)` : ""}`;
            this.root.appendChild(note);
        }
        this.applySelectionStyle();
    }

    /** Clamps the zoom so the map always covers the viewport, then applies it to the country layer. */
    private applyZoom(group: SVGGElement, next: ZoomState, width: number, height: number): void {
        const k = Math.max(1, Math.min(MAX_ZOOM, next.k));
        const x = Math.max(width * (1 - k), Math.min(0, next.x));
        const y = Math.max(height * (1 - k), Math.min(0, next.y));
        this.zoom = { k, x, y };
        group.setAttribute("transform", `translate(${x},${y}) scale(${k})`);
    }

    /** Zooms by `factor` keeping the viewport point (px, py) fixed. */
    private zoomAt(group: SVGGElement, factor: number, px: number, py: number, width: number, height: number): void {
        const { k, x, y } = this.zoom;
        const nk = Math.max(1, Math.min(MAX_ZOOM, k * factor));
        this.applyZoom(group, { k: nk, x: px - (px - x) * nk / k, y: py - (py - y) * nk / k }, width, height);
    }

    /** Mouse wheel zooms around the cursor, dragging pans, and optional +/-/reset buttons. */
    private enableZoom(svg: SVGSVGElement, group: SVGGElement, width: number, height: number): void {
        svg.classList.add("wm-zoomable");
        // Client pixels -> SVG units; the report canvas may be scaled (e.g. Fit to page).
        const toLocal = (event: MouseEvent): [number, number] => {
            const rect = svg.getBoundingClientRect();
            return [(event.clientX - rect.left) * width / (rect.width || width), (event.clientY - rect.top) * height / (rect.height || height)];
        };

        svg.addEventListener("wheel", (event: WheelEvent) => {
            event.preventDefault();
            const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? height : 1);
            const [px, py] = toLocal(event);
            this.zoomAt(group, Math.exp(-delta * 0.002), px, py, width, height);
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
                // Capture only once it is a drag, so plain clicks still reach the country under the pointer.
                drag.moving = true;
                svg.setPointerCapture(event.pointerId);
                svg.classList.add("wm-dragging");
                this.host.tooltipService.hide({ immediately: true, isTouchEvent: false });
            }
            this.applyZoom(group, { k: this.zoom.k, x: drag.zoomX + dx, y: drag.zoomY + dy }, width, height);
        });
        const endDrag = (event: PointerEvent) => {
            if (!drag || event.pointerId !== drag.pointerId) return;
            if (drag.moving) {
                this.suppressClickUntil = Date.now() + 300;
                if (svg.hasPointerCapture(event.pointerId)) svg.releasePointerCapture(event.pointerId);
                svg.classList.remove("wm-dragging");
            }
            drag = null;
        };
        svg.addEventListener("pointerup", endDrag);
        svg.addEventListener("pointercancel", endDrag);

        if (!this.formattingSettings.map.showZoomButtons.value) return;
        const buttons = document.createElement("div");
        buttons.className = "wm-zoom-buttons";
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
        addButton("+", "Zoom in", () => this.zoomAt(group, 1.6, width / 2, height / 2, width, height));
        addButton("−", "Zoom out", () => this.zoomAt(group, 1 / 1.6, width / 2, height / 2, width, height));
        addButton("⟲", "Reset zoom", () => this.applyZoom(group, { k: 1, x: 0, y: 0 }, width, height));
        this.root.appendChild(buttons);
    }

    private renderLegend(model: MapModel, min: number, max: number, absMax: number, height: number): SVGGElement {
        const s = this.formattingSettings;
        const shading = s.shading;
        const fontSize = s.legend.fontSize.value;
        const barWidth = 160, barHeight = 8, x = 10;
        const y = height - barHeight - fontSize * 1.4 - 10;
        const diverging = shading.diverging.value;
        const low = diverging ? Math.min(-absMax, min) : min;
        const high = diverging ? Math.max(absMax, max) : max;

        const g = document.createElementNS(SVG_NS, "g");
        g.setAttribute("class", "wm-legend");
        const defs = document.createElementNS(SVG_NS, "defs");
        const gradient = document.createElementNS(SVG_NS, "linearGradient");
        const gradientId = `wm-gradient-${this.instanceId}`;
        gradient.setAttribute("id", gradientId);
        const stops = diverging
            ? [[0, shading.minColor.value.value], [50, shading.midColor.value.value], [100, shading.maxColor.value.value]]
            : [[0, shading.minColor.value.value], [100, shading.maxColor.value.value]];
        stops.forEach(([offset, color]) => {
            const stop = document.createElementNS(SVG_NS, "stop");
            stop.setAttribute("offset", `${offset}%`);
            stop.setAttribute("stop-color", String(color));
            gradient.appendChild(stop);
        });
        defs.appendChild(gradient);
        g.appendChild(defs);

        const title = document.createElementNS(SVG_NS, "text");
        title.setAttribute("x", String(x));
        title.setAttribute("y", String(y - 4));
        title.setAttribute("font-size", `${fontSize}pt`);
        title.textContent = model.colorSource.displayName;
        g.appendChild(title);

        const bar = document.createElementNS(SVG_NS, "rect");
        bar.setAttribute("x", String(x));
        bar.setAttribute("y", String(y));
        bar.setAttribute("width", String(barWidth));
        bar.setAttribute("height", String(barHeight));
        bar.setAttribute("fill", `url(#${gradientId})`);
        g.appendChild(bar);

        const format = model.colorSource.format;
        [[low, x, "start"], [high, x + barWidth, "end"]].forEach(([value, lx, anchor]) => {
            const label = document.createElementNS(SVG_NS, "text");
            label.setAttribute("x", String(lx));
            label.setAttribute("y", String(y + barHeight + fontSize * 1.4 + 2));
            label.setAttribute("text-anchor", String(anchor));
            label.setAttribute("font-size", `${fontSize}pt`);
            label.textContent = valueFormatter.format(value as number, format);
            g.appendChild(label);
        });
        return g;
    }

    private attachInteractions(el: SVGPathElement, shape: CountryShape, point: DataPoint | null): void {
        const tooltipService = this.host.tooltipService;
        // move() also replaces the tooltip content, so it must carry the same items as show(); passing none blanks it.
        const dataItems: VisualTooltipDataItem[] = [{ displayName: "Country", value: point ? point.label : shape.name }, ...(point ? point.tooltips : [])];
        const identities = point ? [point.selectionId] : [];
        const tooltipArgs = (event: MouseEvent) => {
            const rect = this.element.getBoundingClientRect();
            return { coordinates: [event.clientX - rect.left, event.clientY - rect.top], isTouchEvent: false, dataItems, identities };
        };
        el.addEventListener("mouseenter", (event: MouseEvent) => {
            if (tooltipService.enabled()) tooltipService.show(tooltipArgs(event));
        });
        el.addEventListener("mousemove", (event: MouseEvent) => {
            if (tooltipService.enabled()) tooltipService.move(tooltipArgs(event));
        });
        el.addEventListener("mouseleave", () => tooltipService.hide({ immediately: true, isTouchEvent: false }));
        if (!point || !this.host.hostCapabilities.allowInteractions) return;
        el.addEventListener("click", (event: MouseEvent) => {
            event.stopPropagation();
            this.selectionManager.select(point.selectionId, event.ctrlKey || event.metaKey).then(() => this.applySelectionStyle());
        });
        el.addEventListener("contextmenu", (event: MouseEvent) => {
            event.stopPropagation();
            event.preventDefault();
            this.selectionManager.showContextMenu(point.selectionId, { x: event.clientX, y: event.clientY });
        });
    }

    /** Dims countries that are neither selected here nor highlighted by another visual. */
    private applySelectionStyle(): void {
        const selected = this.selectionManager.getSelectionIds() as ISelectionId[];
        const hasSelection = selected.length > 0;
        this.paths.forEach(({ path, point }) => {
            if (!point) return;
            const isSelected = hasSelection && selected.some(id => id.equals(point.selectionId));
            const dim = hasSelection ? !isSelected : !point.highlighted;
            path.setAttribute("fill-opacity", dim ? "0.35" : "1");
            path.classList.toggle("wm-selected", isSelected);
        });
    }

    private renderLandingPage(): void {
        const div = document.createElement("div");
        div.className = "wm-landing";
        const title = document.createElement("strong");
        title.textContent = "World Map";
        const text = document.createElement("p");
        text.textContent = "Add a country field (ISO alpha-2 code such as AU, alpha-3, numeric code or English name) to Country. "
            + "Optionally add a measure to Shade by for a color gradient, and more measures to Tooltips.";
        div.appendChild(title);
        div.appendChild(text);
        this.root.appendChild(div);
    }
}
