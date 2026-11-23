"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const loadWebview = require("../test-support/loadWebview");

test("shared actions preserve delegated attributes and native disabled state and escape model values", async () => {
    const {actionButton} = await loadWebview("ui/controls");
    const html = actionButton('Edit <rule>', {disabled:true, attrs:{
        "data-net":"studio-edit", "data-id":'A&B"', "data-index":0, "aria-pressed":false, title:undefined,
    }});
    assert.equal(html, '<button type="button" class="button vscode-button secondary" data-net="studio-edit" data-id="A&amp;B&quot;" data-index="0" aria-pressed="false" disabled>Edit &lt;rule&gt;</button>');
    assert.match(actionButton("Save", {primary:true}), /class="button vscode-button primary"/);
    assert.match(actionButton("Clear", {quiet:true, className:"net-text-action"}), /class="button net-text-action"/);
});
