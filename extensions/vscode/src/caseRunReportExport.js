"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { randomBytes } = require("node:crypto");
const { renderReport, renderTree, standaloneReportDocument } = require("./caseRunReportView");

async function buildStandaloneReport({run,rows,related,readEvidence,readFrame,language,title}) {
    const media=path.join(__dirname,"..","media");
    const [disclosures,layout,js]=await Promise.all(["ui/disclosure.css","caseRunReport.css","caseRunReport.js"]
        .map(name=>fs.readFile(path.join(media,name),"utf8")));
    const css=disclosures+"\n"+layout;
    const frameIds=new Map();
    for (const row of rows) {
        for (const frame of [row.before,row.after]) {
            if (frame && !frameIds.has(frame)) frameIds.set(frame,frameIds.size);
        }
    }
    const templates=[];
    const frames=[...frameIds];
    // Inspecting a frozen frame can start a local CLI process. Bound the fan-out even on long runs.
    for (let at=0;at<frames.length;at+=3) {
        const batch=await Promise.all(frames.slice(at,at+3).map(async ([frame,id])=>{
            const html=renderTree(await readFrame(frame),language);
            return `<template id="archived-tree-${id}">${html}</template>`;
        }));
        templates.push(...batch);
    }
    for (const row of rows) {
        const refs=["before","after"].filter(phase=>frameIds.has(row[phase]))
            .map(phase=>` data-${phase}="${frameIds.get(row[phase])}"`).join("");
        templates.push(`<template id="archived-record-${row.index}"${refs}>${await readEvidence(row)}</template>`);
    }
    const body=renderReport(run,rows,run.outline.focusIndex,related,language,{standalone:true});
    return standaloneReportDocument(language,title,body,templates.join(""),{css,js,nonce:randomBytes(18).toString("base64")});
}

module.exports = { buildStandaloneReport };
