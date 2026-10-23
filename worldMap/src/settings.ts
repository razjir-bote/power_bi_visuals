"use strict";

import { formattingSettings } from "powerbi-visuals-utils-formattingmodel";

import FormattingSettingsCard = formattingSettings.SimpleCard;
import FormattingSettingsSlice = formattingSettings.Slice;
import FormattingSettingsModel = formattingSettings.Model;

const projectionItems: powerbi.IEnumMember[] = [
    { value: "naturalEarth", displayName: "Natural Earth" },
    { value: "equalEarth", displayName: "Equal Earth" },
    { value: "mercator", displayName: "Mercator" },
];

/** Projection, framing and background. */
class MapCardSettings extends FormattingSettingsCard {
    projection = new formattingSettings.ItemDropdown({ name: "projection", displayName: "Projection", items: projectionItems, value: projectionItems[0] });
    hideAntarctica = new formattingSettings.ToggleSwitch({ name: "hideAntarctica", displayName: "Hide Antarctica", value: true });
    zoomToData = new formattingSettings.ToggleSwitch({ name: "zoomToData", displayName: "Zoom to countries with data", value: false });
    zoomEnabled = new formattingSettings.ToggleSwitch({ name: "zoomEnabled", displayName: "Zoom and pan (wheel, drag)", value: true });
    showZoomButtons = new formattingSettings.ToggleSwitch({ name: "showZoomButtons", displayName: "Show zoom buttons", value: true });
    backColor = new formattingSettings.ColorPicker({ name: "backColor", displayName: "Background", value: { value: "#FFFFFF" } });

    name: string = "map";
    displayName: string = "Map";
    slices: Array<FormattingSettingsSlice> = [this.projection, this.hideAntarctica, this.zoomToData, this.zoomEnabled, this.showZoomButtons, this.backColor];
}

/** Country fill colors. */
class ShadingCardSettings extends FormattingSettingsCard {
    highlightColor = new formattingSettings.ColorPicker({ name: "highlightColor", displayName: "Highlight color (no Shade by measure)", value: { value: "#1F6FB2" } });
    minColor = new formattingSettings.ColorPicker({ name: "minColor", displayName: "Lowest value", value: { value: "#DCEAF7" } });
    maxColor = new formattingSettings.ColorPicker({ name: "maxColor", displayName: "Highest value", value: { value: "#0B3C6E" } });
    diverging = new formattingSettings.ToggleSwitch({ name: "diverging", displayName: "Diverging around zero", value: false });
    midColor = new formattingSettings.ColorPicker({ name: "midColor", displayName: "Zero", value: { value: "#F4F4F4" } });
    noDataColor = new formattingSettings.ColorPicker({ name: "noDataColor", displayName: "No data", value: { value: "#E6E8EB" } });

    name: string = "shading";
    displayName: string = "Shading";
    slices: Array<FormattingSettingsSlice> = [this.highlightColor, this.minColor, this.maxColor, this.diverging, this.midColor, this.noDataColor];
}

class BorderCardSettings extends FormattingSettingsCard {
    color = new formattingSettings.ColorPicker({ name: "color", displayName: "Color", value: { value: "#FFFFFF" } });
    width = new formattingSettings.NumUpDown({ name: "width", displayName: "Width", value: 0.5 });

    name: string = "borders";
    displayName: string = "Borders";
    slices: Array<FormattingSettingsSlice> = [this.color, this.width];
}

class LegendCardSettings extends FormattingSettingsCard {
    show = new formattingSettings.ToggleSwitch({ name: "show", displayName: "Show", value: true });
    fontSize = new formattingSettings.NumUpDown({ name: "fontSize", displayName: "Text size", value: 9 });

    name: string = "legend";
    displayName: string = "Legend";
    topLevelSlice = this.show;
    slices: Array<FormattingSettingsSlice> = [this.fontSize];
}

export class VisualFormattingSettingsModel extends FormattingSettingsModel {
    map = new MapCardSettings();
    shading = new ShadingCardSettings();
    borders = new BorderCardSettings();
    legend = new LegendCardSettings();

    cards = [this.map, this.shading, this.borders, this.legend];
}
