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

/** Base map: projection, framing, zoom and colors. */
class MapCardSettings extends FormattingSettingsCard {
    projection = new formattingSettings.ItemDropdown({ name: "projection", displayName: "Projection", items: projectionItems, value: projectionItems[0] });
    hideAntarctica = new formattingSettings.ToggleSwitch({ name: "hideAntarctica", displayName: "Hide Antarctica", value: true });
    zoomToData = new formattingSettings.ToggleSwitch({ name: "zoomToData", displayName: "Zoom to countries with cities", value: false });
    zoomEnabled = new formattingSettings.ToggleSwitch({ name: "zoomEnabled", displayName: "Zoom and pan (wheel, drag)", value: true });
    showZoomButtons = new formattingSettings.ToggleSwitch({ name: "showZoomButtons", displayName: "Show zoom buttons", value: true });
    landColor = new formattingSettings.ColorPicker({ name: "landColor", displayName: "Land", value: { value: "#E6E8EB" } });
    highlightCountries = new formattingSettings.ToggleSwitch({ name: "highlightCountries", displayName: "Highlight countries with cities", value: true });
    countryHighlightColor = new formattingSettings.ColorPicker({ name: "countryHighlightColor", displayName: "Country highlight", value: { value: "#D3E2F1" } });
    borderColor = new formattingSettings.ColorPicker({ name: "borderColor", displayName: "Borders", value: { value: "#FFFFFF" } });
    backColor = new formattingSettings.ColorPicker({ name: "backColor", displayName: "Background", value: { value: "#FFFFFF" } });

    name: string = "map";
    displayName: string = "Map";
    slices: Array<FormattingSettingsSlice> = [this.projection, this.hideAntarctica, this.zoomToData, this.zoomEnabled, this.showZoomButtons,
        this.landColor, this.highlightCountries, this.countryHighlightColor, this.borderColor, this.backColor];
}

/** The stacked block columns. */
class BlocksCardSettings extends FormattingSettingsCard {
    color = new formattingSettings.ColorPicker({ name: "color", displayName: "Color", value: { value: "#1F6FB2" } });
    maxHeight = new formattingSettings.NumUpDown({ name: "maxHeight", displayName: "Tallest column (px)", value: 140 });
    width = new formattingSettings.NumUpDown({ name: "width", displayName: "Block width (px)", value: 14 });
    blockValue = new formattingSettings.NumUpDown({ name: "blockValue", displayName: "Value per block (0 = auto)", value: 0 });
    depth = new formattingSettings.ToggleSwitch({ name: "depth", displayName: "3D blocks", value: true });
    showKey = new formattingSettings.ToggleSwitch({ name: "showKey", displayName: "Show block key", value: true });

    name: string = "blocks";
    displayName: string = "Blocks";
    slices: Array<FormattingSettingsSlice> = [this.color, this.maxHeight, this.width, this.blockValue, this.depth, this.showKey];
}

class LabelsCardSettings extends FormattingSettingsCard {
    show = new formattingSettings.ToggleSwitch({ name: "show", displayName: "Show", value: true });
    showCity = new formattingSettings.ToggleSwitch({ name: "showCity", displayName: "Include city name", value: true });
    fontSize = new formattingSettings.NumUpDown({ name: "fontSize", displayName: "Text size", value: 8 });

    name: string = "labels";
    displayName: string = "Labels";
    topLevelSlice = this.show;
    slices: Array<FormattingSettingsSlice> = [this.showCity, this.fontSize];
}

export class VisualFormattingSettingsModel extends FormattingSettingsModel {
    map = new MapCardSettings();
    blocks = new BlocksCardSettings();
    labels = new LabelsCardSettings();

    cards = [this.map, this.blocks, this.labels];
}
