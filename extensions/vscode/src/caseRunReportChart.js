"use strict";

const textEntities = {"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"};
const escapeText = value => String(value).replace(/[&<>"']/g, character => textEntities[character]);

function renderDurationChart(rows, selected, language) {
    const records = rows.filter(row => row.kind !== "unreachedGoals");
    // Above this density individual receipts become hard to pick; the directory retains them all.
    if (!records.length || records.length > 96) return "";

    const hasTiming = row => Number.isFinite(row.elapsedMs) && row.elapsedMs >= 0;
    const timed = records.filter(hasTiming);
    if (!timed.length) return "";

    const zh = /^zh/i.test(language);
    const title = zh ? "单条记录耗时" : "Record durations";
    const formatDuration = ms => ms < 1000
        ? ms + (zh ? " 毫秒" : " ms")
        : (ms / 1000).toFixed(2) + (zh ? " 秒" : " s");
    const max = Math.max(...timed.map(row => row.elapsedMs));
    const maxLabel = (zh ? "最大 " : "Max ") + formatDuration(max);
    const receiptLabel = row => zh ? `记录 ${row.index + 1}` : `Receipt ${row.index + 1}`;
    const active = records.find(row => row.index === selected) || records[0];

    const bars = records.map(row => {
        const measured = hasTiming(row);
        const duration = measured ? formatDuration(row.elapsedMs) : (zh ? "未记录耗时" : "Duration unavailable");
        const label = [receiptLabel(row), row.title, duration].filter(Boolean).join(" · ");
        const readout = [row.title || receiptLabel(row), duration].join(" · ");
        const ratio = measured && max > 0 ? row.elapsedMs / max : 0;
        const successful = row.status === "passed" || row.status === "completed";
        const tone = row.isBlocking ? "error" : successful && row.condition !== "failed" ? "ok" : "neutral";
        return `<button type="button" class="chart-bar" data-chart-step="${escapeText(row.index)}" data-ratio="${ratio}" data-tone="${tone}" data-readout="${escapeText(readout)}"${measured ? "" : " data-untimed"} tabindex="${row === active ? 0 : -1}" aria-pressed="${row.index === selected}" aria-label="${escapeText(label)}" title="${escapeText(label)}"><span></span></button>`;
    }).join("");
    const axis = [records[0]];
    if (records.length > 1) axis.push(records.at(-1));

    return `<section class="duration-chart" aria-label="${title}">
        <header><span class="chart-title">${title}</span><span class="chart-max">${maxLabel}</span><span class="chart-readout" hidden aria-hidden="true"></span></header>
        <div class="chart-bars">${bars}</div>
        <div class="chart-axis" aria-hidden="true">${axis.map(row => `<span>${escapeText(receiptLabel(row))}</span>`).join("")}</div>
    </section>`;
}

module.exports = { renderDurationChart };
