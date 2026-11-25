"use strict";

const assert=require("node:assert/strict");
const test=require("node:test");
const {pageView}=require("../src/model");
const {ElementsController}=require("../src/elementsController");
const {parseLocator,selectNodes,suggestLocator,hitsAt}=require("../media/elementsLocator");

function frame(id,enabled=true,complete=true) {
    const ref=n=>n+"~"+id, base={bundleName:"test",visible:true};
    const bounds=(left,top,right,bottom)=>({left,top,right,bottom});
    const nodes=[
        {ref:ref("root"),id:"root",type:"Page",bounds:bounds(0,0,200,400)},
        {ref:ref("header"),parent:ref("root"),id:"header",type:"Row",bounds:bounds(0,0,200,100)},
        {ref:ref("a"),parent:ref("header"),text:"Cancel",type:"Button",enabled:true,clickable:true,bounds:bounds(0,0,100,100)},
        {ref:ref("dialog"),parent:ref("root"),id:"dialog",type:"Dialog",bounds:bounds(0,100,200,400)},
        {ref:ref("b"),parent:ref("dialog"),text:"Cancel",type:"Button",enabled,clickable:true,bounds:bounds(0,100,100,200)},
    ];
    return pageView({frameId:id,capturedAt:new Date().toISOString(),quality:{complete},nodes:nodes.map(n=>({...base,...n}))},{elements:true});
}
test("picture hit testing, ancestor-scoped suggestions and partial observations",()=>{
    const page=frame("1"),node=hitsAt(page.nodes,{x:48,y:130})[0];
    assert.equal(node.ref,"b~1");
    assert.equal(selectNodes(page.nodes,parseLocator({text:"Cancel"})).length,2);
    const locator=suggestLocator(page.nodes,node);
    assert.deepEqual(selectNodes(page.nodes,locator),[node]);
    assert.equal(locator.within.id,"dialog");
    assert.equal(selectNodes(frame("2").nodes,locator)[0].ref,"b~2");
    assert.throws(()=>parseLocator({ref:"b~1"}));
    assert.throws(()=>parseLocator({within:{}}));
    assert.throws(()=>parseLocator({textPrefix:""}));
    assert.deepEqual(hitsAt(page.nodes,{x:201,y:200}),[]);
});
test("the same verified locator adds native steps and checks, watches a changed value and captures only changes",async()=>{
    const clip=[], calls=[], writes=[], collected=[];
    const b={state:{mode:"inspect",device:"fixture",page:frame("1")},language:"zh-CN",
        context:{workspaceState:{get:(_k,v)=>v,update:async()=>{}}},text:{stalePage:"stale",uniqueTarget:"multiple"},
        session:"test",image:s=>s,agent:{call:async(cmd)=>{calls.push(cmd);return {path:"image"+calls.length}}},setPlan:async()=>{}};
    const v={env:{clipboard:{writeText:async s=>clip.push(s)}},window:{showSaveDialog:async()=>({})},
        workspace:{fs:{writeFile:async(_,data)=>writes.push(JSON.parse(data))}}};
    const ctrl=new ElementsController(b,v);
    ctrl.picking=false;
    await ctrl.sync();
    const locator=parseLocator({text:"Cancel",within:{id:"dialog"}});
    const msg={frameId:"1",locator,property:"enabled"};
    for(const type of ["elementCopy","elementWatch","elementStep","elementAssert"]) await ctrl.handle({...msg,type});
    assert.deepEqual(JSON.parse(clip[0]),locator);
    assert.deepEqual(ctrl.view.copied,{frameId:"1",key:JSON.stringify(locator)});
    for(const expression of [{text:"Cancel"},{id:"no-such-control"}]) {
        await ctrl.handle({...msg,locator:expression,type:"elementCopy"});
        assert.deepEqual(JSON.parse(clip.at(-1)),expression);
        assert.equal(ctrl.view.copied.key,JSON.stringify(expression));
    }
    await assert.rejects(ctrl.handle({...msg,locator:{text:"Cancel"},type:"elementStep"}),/multiple/);
    await assert.rejects(ctrl.handle({...msg,frameId:"0",type:"elementStep"}),/stale/);
    b.state.page=frame("2",false);
    await ctrl.sync();
    const watch=b.state.elements.watches[0], change=watch.history[0];
    assert.equal(watch.current.value,false);assert.equal(change.previous.value,true);assert.equal(change.picture.frameId,"2");
    b.state.page=frame("3",false);
    await ctrl.sync();
    assert.equal(watch.history.length,1);assert.equal(calls.length,1);
    b.state.page=frame("4",false,false);
    await ctrl.sync();assert.equal(watch.current.state,"partial");
    await assert.rejects(ctrl.handle({...msg,frameId:"4",type:"elementAssert"}),/multiple/);
    await ctrl.handle({type:"elementCopySelected",frameId:"4",refs:["root~4","dialog~4"]});
    assert.deepEqual(JSON.parse(clip.at(-1)),b.state.page.nodes.filter(n=>["root~4","dialog~4"].includes(n.ref)).map(n=>n.selector));
    const revision=ctrl.view.stepsRevision;
    await ctrl.handle({type:"elementRemoveSelected",revision,indices:[1,0]});
    assert.deepEqual(ctrl.view.steps,[]);
    await ctrl.handle({type:"elementUndoRemoval",revision:ctrl.view.stepsRevision});
    assert.equal(ctrl.view.steps.length,2);
    await ctrl.handle({type:"elementSave"});
    assert.deepEqual(writes[0],{version:"1",steps:[{command:"press",input:{target:locator}},{assert:{selector:locator,property:"enabled",equals:true}}]});
    assert.equal(ctrl.view.steps.length,0);
});

test("locator verification names the actual match independently of workflow or device actions",async t=>{
    const controls = new Map();
    function byId(id) {
        if (!controls.has(id)) controls.set(id,{
            dataset:{},querySelector:()=>({}),setAttribute(){},removeAttribute(){},getContext:()=>({clearRect(){}})
        });
        return controls.get(id);
    }
    global.document={getElementById:byId,querySelector:()=>null};
    global.acquireVsCodeApi=()=>({postMessage(){}});
    t.after(()=>{delete global.document;delete global.acquireVsCodeApi;});
    const ui=await require("../test-support/loadWebview")("elements");
    const page=frame("inspected");
    const model={tool:"inspect",device:"fixture",devices:["fixture"],page,elements:{picking:true,watches:[],steps:[]}};
    ui.updateElements(model,"zh-CN",{stationModeGroup:"画面交互方式"});
    const selected=page.nodes.find(n=>n.ref==="b~inspected");
    const markup=ui.elementControls(selected);
    assert.match(markup,/data-el="copy"[^>]*>复制定位器/);
    assert.ok(markup.indexOf('data-el="copy"') < markup.indexOf("<details"));
    assert.match(markup,/1 个匹配 · .*Cancel · 当前选中控件/);
    const change=locator=>{
        ui.elementInput({id:"el-locator",value:JSON.stringify(locator)});
        return byId("el-locator-result").textContent;
    };
    assert.match(change({id:"header"}),/1 个匹配 · .*header.* · 其他控件/);
    assert.match(change({text:"Cancel"}),/2 个匹配 · .* · 包含当前选中控件/);
    assert.match(change({id:"missing"}),/当前快照未匹配到控件/);
    page.complete=false;
    assert.match(change({id:"header"}),/控件树不完整/);
    ui.elementInput({id:"el-locator",value:"{"});
    assert.match(byId("el-locator-result").textContent,/定位器无效/);
});

test("selected watches and draft steps inspect their snapshot targets without operating the device",async t=>{
    global.acquireVsCodeApi=()=>({postMessage:()=>assert.fail("Preview should not operate the device")});
    t.after(()=>{delete global.acquireVsCodeApi;});
    const load=require("../test-support/loadWebview"), ui=await load("elements");
    const {listSelectionClick,listSelectionChange}=await load("ui/listSelection");
    const control={querySelector:()=>({}),setAttribute(){},removeAttribute(){},getContext:()=>({clearRect(){}})};
    global.document={getElementById:()=>control,querySelector:()=>null};
    t.after(()=>{delete global.document;});
    const page=frame("inspect-batch");
    const watches=["header","dialog"].map(id=>({id,label:id,locator:{id},property:"visible",current:{state:"value",value:true},history:[]}));
    const steps=[{assert:{selector:{id:"header"},property:"visible",equals:true}},{command:"press",input:{target:{id:"missing"}}}];
    const model={tool:"inspect",device:"fixture",devices:["fixture"],page,elements:{picking:true,watches,steps}};
    ui.updateElements(model,"en",{stationModeGroup:"Tools"});
    const focused=[];
    const render=()=>ui.elementsFooter(node=>focused.push(node?.id));
    const start=listName=>listSelectionClick({dataset:{listName,listAction:"start"}},()=>assert.fail(),render);
    const check=(listPick,value,checked)=>listSelectionChange({dataset:{listPick},value,checked},render);
    render();
    start("element-watches");
    check("element-watches","dialog",true);
    assert.match(render(),/el-watch-locator[^]*?dialog/);
    check("element-watches","header",true);
    check("element-watches","header",false);
    assert.deepEqual(focused,["dialog","header","dialog"]);
    start("element-steps");
    check("element-steps","0",true);
    check("element-steps","1",true);
    assert.deepEqual(focused.slice(-2),["header",undefined]);
    assert.equal(model.elements.steps.length,2);
});
