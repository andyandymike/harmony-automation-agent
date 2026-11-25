"use strict";

const { workspaceRailMarkup } = require("./workspaceRailMarkup");

const paths = {
    operate: '<path d="m5 3 13 10-7 1-3 6z"/>',
    back: '<path d="m10 5-7 7 7 7M4 12h16"/>',
    home: '<path d="m3 11 9-7 9 7M6 10v10h12V10"/>',
    recents: '<rect x="7" y="7" width="13" height="13" rx="2"/><path d="M16 4H6a2 2 0 0 0-2 2v10"/>',
    keyboard: '<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M7 10h1m3 0h1m3 0h2M7 14h1m3 0h6"/>',
    power: '<path d="M12 3v8m5-5.2a8 8 0 1 1-10 0"/>',
    read: '<path d="M3 4h12a3 3 0 0 1 3 3v4M3 4v14h7m4-4 2 2 5-5"/>',
    inspect: '<path d="M9 4H4v5m11-5h5v5M4 15v5h5m11-5v5h-5"/><rect x="8" y="8" width="8" height="8" rx="1"/>',
    record: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="3" fill="currentColor" stroke="none"/>',
    arrow: '<path d="M4 12h15m-6-6 6 6-6 6"/>',
    right: '<path d="m9 6 6 6-6 6"/>',
    folder: '<path d="M3 7V5h6l2 2h9v3M3 9h18l-3 10H3z"/>',
    history: '<path d="M3 10a8.7 8.7 0 1 1 .8 6M3 4v6h6m3-3v5l3 2"/>',
    chat: '<path d="M4 5h16v12H9l-5 4zm4 4h8m-8 4h5"/>',
    stop: '<rect x="6" y="6" width="12" height="12" rx="1"/>',
    expand: '<path d="M4 10V4h6m10 10v6h-6M4 4l6 6m10 10-6-6"/>',
};

function icon(name) {
    return `<svg class="live-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]}</svg>`;
}

function liveDeviceMarkup() {
    return `<section id="live-preview" aria-labelledby="live-title">
        <header class="live-monitor-head"><div class="live-monitor-name">${icon("inspect")}<h2 id="live-title" tabindex="-1"></h2></div>
            <div class="live-monitor-state"><span id="status" role="status"></span>
                <button type="button" id="preview-zoom" aria-expanded="false" aria-controls="stage">${icon("expand")}<span></span></button>
            </div>
        </header>
        <div id="element-view-modes" role="group" hidden>
            <button type="button" id="element-operate-mode" aria-pressed="false" aria-controls="stage">${icon("operate")}<span></span></button>
            <button type="button" id="element-pick-mode" aria-pressed="false" aria-controls="stage">${icon("inspect")}<span></span></button>
        </div>
        <div class="preview-action-bar">
            <div id="case-pick-controls" hidden>
                <span id="case-pick-instructions"></span>
                <button type="button" id="case-pick-exit"></button>
            </div>
            <p id="recording-notice" role="status" hidden></p>
            <div class="preview-actions" id="preview-actions">
                <button type="button" id="record" hidden><i class="record-start-icon" aria-hidden="true">${icon("record")}</i><i class="record-stop-icon" aria-hidden="true">${icon("stop")}</i><span></span></button>
                <button type="button" id="preview-connection" aria-controls="stage">${icon("power")}<span></span></button>
            </div>
        </div>
        <div id="phone-controls" hidden>
            <div class="phone-actions">
                <div id="phone-navigation" role="group">
                    <button type="button" id="back">${icon("back")}<span></span></button>
                    <button type="button" id="home">${icon("home")}<span></span></button>
                    <button type="button" id="recents">${icon("recents")}<span></span></button>
                </div>
                <button type="button" id="phone-keyboard" aria-expanded="false" aria-controls="phone-text-form">${icon("keyboard")}<span></span></button>
            </div>
            <p id="gesture-help" hidden></p>
            <form id="phone-text-form" hidden>
                <input id="phone-text" type="text" maxlength="4096" autocomplete="off" spellcheck="false" aria-describedby="phone-text-help">
                <button type="submit" id="phone-text-send"></button>
                <p id="phone-text-help"></p>
            </form>
        </div>
        <div id="stage"><canvas id="screen" hidden></canvas>
            <div id="element-picker" hidden><img id="element-photo" hidden alt=""><canvas id="element-overlay" tabindex="-1" aria-describedby="gesture-help"></canvas>
                <span id="element-picker-message" role="status"></span></div>
            <div id="empty" role="status">
                <svg class="connect-drawing" width="96" height="102" viewBox="0 0 96 102" fill="none" aria-hidden="true">
                    <g stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
                        <rect x="19" y="5" width="39" height="66" rx="6"/><path d="M32 11h12m-10 54h8"/>
                        <path d="M34 77h9v7h-9zm4.5 7v3a6 6 0 0 0 6 6h21a6 6 0 0 0 6-6V67m-3-1v-9h6v9z"/>
                    </g>
                </svg>
                <strong id="empty-title"></strong><p id="empty-detail"></p>
            </div>
        </div>
        <footer class="live-monitor-foot">
            <div class="live-monitor-bar"><span id="last-tap"></span><span id="size"></span></div>
        </footer>
        <p id="feedback" role="status" hidden></p>
    </section>`;
}

function phoneTaskMarkup() {
    return workspaceRailMarkup(icon);
}

module.exports = { liveDeviceMarkup, phoneTaskMarkup };
