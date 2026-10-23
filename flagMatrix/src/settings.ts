"use strict";

import { formattingSettings } from "powerbi-visuals-utils-formattingmodel";

import FormattingSettingsCard = formattingSettings.SimpleCard;
import FormattingSettingsSlice = formattingSettings.Slice;
import FormattingSettingsModel = formattingSettings.Model;

/** Column header row: image + column name. */
class HeaderCardSettings extends FormattingSettingsCard {
    imageHeight = new formattingSettings.NumUpDown({ name: "imageHeight", displayName: "Image height (px)", value: 18 });
    fontSize = new formattingSettings.NumUpDown({ name: "fontSize", displayName: "Text size", value: 11 });
    fontColor = new formattingSettings.ColorPicker({ name: "fontColor", displayName: "Text color", value: { value: "#1F3A5F" } });
    backColor = new formattingSettings.ColorPicker({ name: "backColor", displayName: "Background", value: { value: "#FFFFFF" } });

    name: string = "header";
    displayName: string = "Column headers";
    slices: Array<FormattingSettingsSlice> = [this.imageHeight, this.fontSize, this.fontColor, this.backColor];
}

/** Rows-field item rows (e.g. exporter names). */
class RowGroupCardSettings extends FormattingSettingsCard {
    fontSize = new formattingSettings.NumUpDown({ name: "fontSize", displayName: "Text size", value: 11 });
    fontColor = new formattingSettings.ColorPicker({ name: "fontColor", displayName: "Text color", value: { value: "#1F3A5F" } });
    backColor = new formattingSettings.ColorPicker({ name: "backColor", displayName: "Background", value: { value: "#E9EEF5" } });

    name: string = "rowGroups";
    displayName: string = "Row groups";
    slices: Array<FormattingSettingsSlice> = [this.fontSize, this.fontColor, this.backColor];
}

/** Value cells and measure labels. */
class CellCardSettings extends FormattingSettingsCard {
    fontSize = new formattingSettings.NumUpDown({ name: "fontSize", displayName: "Text size", value: 11 });
    fontColor = new formattingSettings.ColorPicker({ name: "fontColor", displayName: "Text color", value: { value: "#252423" } });
    bandColor = new formattingSettings.ColorPicker({ name: "bandColor", displayName: "Alternate row color", value: { value: "#F6F8FB" } });
    negativeColor = new formattingSettings.ColorPicker({ name: "negativeColor", displayName: "Negative values color", value: { value: "#252423" } });
    columnWidth = new formattingSettings.NumUpDown({ name: "columnWidth", displayName: "Min column width (px)", value: 96 });

    name: string = "cells";
    displayName: string = "Values";
    slices: Array<FormattingSettingsSlice> = [this.fontSize, this.fontColor, this.bandColor, this.negativeColor, this.columnWidth];
}

export class VisualFormattingSettingsModel extends FormattingSettingsModel {
    header = new HeaderCardSettings();
    rowGroups = new RowGroupCardSettings();
    cells = new CellCardSettings();

    cards = [this.header, this.rowGroups, this.cells];
}
