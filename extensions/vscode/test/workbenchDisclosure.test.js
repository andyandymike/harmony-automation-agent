"use strict";

const {test} = require("node:test");
const assert = require("node:assert/strict");
const loadWebview = require("../test-support/loadWebview");

test("refresh keeps manual disclosure choices on the same item while honoring changing model defaults",async()=>{
    const {restoreDisclosures} = await loadWebview("ui/disclosures");
    const details = (id,open,caseStep) => ({id,open,closest:()=>caseStep && {dataset:{caseStep}}});
    let state = new Map();
    const render = (items,context="case-a",library="tests") => {
        const root = {querySelectorAll:selector=>{
            assert.equal(selector,"details[id]");
            return items;
        }};
        state = restoreDisclosures(root,state,context,library);
    };
    const timing = details("timeout",false,"steps[0]");
    const debug = details("debug",true);
    const all = details("case-all-runs",false);
    render([timing,debug,all]);
    assert.equal(timing.open,false);
    assert.equal(debug.open,true);
    timing.open = all.open = true;
    debug.open = false;
    const timingAgain = details("timeout",false,"steps[0]");
    const debugAgain = details("debug",true);
    const allAgain = details("case-all-runs",false);
    render([timingAgain,debugAgain,allAgain]);
    assert.deepEqual([timingAgain.open,debugAgain.open,allAgain.open],[true,false,true]);
    // New data can explicitly close a section that was previously open by default.
    debugAgain.open = true;
    const newDefault = details("debug",false);
    const otherRow = details("timeout",false,"steps[1]");
    render([newDefault,otherRow,details("case-all-runs",false)]);
    assert.equal(newDefault.open,false);
    assert.equal(otherRow.open,false);
    otherRow.open = true;
    const otherCase = details("timeout",false,"steps[1]");
    const sameLibrary = details("case-all-runs",false);
    render([otherCase,sameLibrary],"case-b");
    assert.equal(otherCase.open,false);
    assert.equal(sameLibrary.open,true);
    const newLibrary = details("case-all-runs",false);
    render([newLibrary],"other-tab","other-library");
    assert.equal(newLibrary.open,false);
});

test("tree arrows collapse ordinary branches and navigate visible relatives when filtering keeps them open",async()=>{
    const {treeKeydown} = await loadWebview("ui/treeNavigation");
    let focused, toggled;
    const item=(ref,parent,expanded,toggle)=>({
        dataset:{ref,nodeParent:parent},closest(){return this;},
        getAttribute:key=>key==="aria-expanded" ? expanded : null,
        querySelector:selector=>selector==="[data-tree-toggle]" && toggle,
        click:()=>{focused=ref;},
    });
    const top=item("top",undefined,"true",false);
    const filtered=item("nested","top","true",false);
    const leaf=item("child","nested",null,false);
    const branch=item("ordinary","top","true",true);
    const root={querySelectorAll:()=>[top,filtered,leaf,branch]};
    const press=(target,key)=>treeKeydown({target,key,preventDefault(){}},root,false,row=>{toggled=row.dataset.ref;});
    press(filtered,"ArrowLeft");
    assert.equal(focused,"top");
    press(filtered,"ArrowRight");
    assert.equal(focused,"child");
    assert.equal(toggled,undefined);
    press(branch,"ArrowLeft");
    assert.equal(toggled,"ordinary");
    press(leaf,"ArrowLeft");
    assert.equal(focused,"nested");
});
