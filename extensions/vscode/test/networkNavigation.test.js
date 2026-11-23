"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {randomUUID} = require("node:crypto");
const loadWebview = require("../test-support/loadWebview");
const {exampleScenario, scenarioFromRecord} = require("../src/network");

const startedAt = "2026-11-22T10:00:00.000Z";
function exchange(id, path) {
    return {
        id, path, method:"GET", status:503, source:"gateway", startedAt, durationMs:20,
        request:{method:"GET", path, url:"https://store.test"+path, headers:{}},
        response:{status:503, headers:{}, bodyState:"json", body:{retryAfter:2}},
    };
}

async function workspace() {
    const view = await loadWebview("networkView");
    const id = randomUUID(), scenario = exampleScenario();
    const rewrite = {id:"Retry header", method:"GET", match:{type:"exact", field:"path", value:"/cart"},
        action:"rewrite", edits:[{target:"responseHeader", key:"retry-after", op:"set", value:"2"}]};
    scenario.rules.unshift(rewrite);
    const source = {...exchange("source", "/cart"), ruleId:rewrite.id, ruleScenarioId:id, ruleHit:1};
    const network = {
        records:[exchange("unrelated","/stock"), source], logs:[], favorites:[],
        activeScenarioId:id, scenario, scenarioVersion:1, filterVersion:randomUUID(),
        scenarioLibrary:[{id, name:scenario.name, ruleCount:scenario.rules.length}],
        hits:scenario.rules.map(rule=>({ruleId:rule.id,count:0})),
    };
    const model = {mode:"network", devices:[], network};
    const messages = [];
    const render = () => view.networkView(model,"en");
    const click = (net, data={}) => {
        const buttons = render().match(/<button\b[^>]*>/g) || [];
        const attrs = {net,...data};
        const encoded = value=>String(value).replaceAll("&","&amp;").replaceAll('"',"&quot;");
        assert.ok(buttons.some(button=>Object.entries(attrs).every(([name,value]) =>
            button.includes('data-'+name+'="'+encoded(value)+'"'))), "Missing control: "+net+" "+(data.id || ""));
        assert.equal(view.networkClick({dataset:{net,...data}}, model, msg=>messages.push(msg), render), true);
        return render();
    };
    return {view, model, network, source, rewrite, messages, render, click};
}

function primaryTabs(markup) {
    return [...markup.matchAll(/id="network-tab-([^"]+)"[^>]*aria-selected="(true|false)"/g)]
        .map(match=>[match[1],match[2]==="true"]);
}
function assertPrimary(markup, current) {
    assert.deepEqual(primaryTabs(markup), [["requests", current==="requests"], ["mock", current==="mock"]]);
}

test("the request list exposes clear and the emptied list offers undo without clearing favorites",async()=>{
    const {network,render,click,messages}=await workspace();
    const retained=network.records[0];
    network.favorites=[{name:"Saved request",record:retained}];
    click("clearTraffic");
    assert.equal(messages.at(-1).type,"networkClearTraffic");
    network.records=[];
    network.clearedHistory="cleared-request-list";
    const empty=render();
    assert.match(empty,/Request history cleared/);
    assert.match(empty,/Favorites · 1/);
    assert.doesNotMatch(empty,/class="net-row"/);
    click("undoClearTraffic",{id:"cleared-request-list"});
    assert.equal(messages.at(-1).type,"networkUndoClearTraffic");
    assert.equal(messages.at(-1).id,"cleared-request-list");
});

test("the workspace names the activity, group controls and saved group in both languages", async () => {
    const {view, model, network, click} = await workspace();
    const savedName = "Checkout 场景 A";
    network.scenario.name = network.scenarioLibrary[0].name = savedName;
    click("mock");
    for (const [lang, tab, create, disable, enable, exportGroup] of [
        ["zh-CN","模拟与改写","新建规则组","停用规则组","启用规则组","导出规则组"],
        ["en","Mock &amp; rewrite","New rule group","Disable rule group","Enable rule group","Export rule group"],
    ]) {
        network.scenario.paused = false;
        const markup = view.networkView(model,lang);
        for (const label of [tab,create,disable,exportGroup,savedName]) assert.ok(markup.includes(label),label);
        assert.doesNotMatch(markup.replaceAll(savedName,"").replace(/<[^>]+>/g,""),/场景|\bscenarios?\b/i);
        network.scenario.paused = true;
        assert.ok(view.networkView(model,lang).includes(enable));
    }
});

test("the scenario owns its rule list and editors under the same primary tab", async () => {
    const {render, click, rewrite, network} = await workspace();
    const last = {...rewrite,id:"Fallback header"};
    network.scenario.rules.push(last);
    assertPrimary(render(),"requests");
    const overview = click("mock");
    assertPrimary(overview,"mock");
    const priority = [...overview.matchAll(/<button\b[^>]*data-net="(sceneRule|editSequence)"[^>]*data-id="([^"]+)"/g)]
        .map(match=>match[2]);
    assert.deepEqual(priority,network.scenario.rules.map(rule=>rule.id));
    const editor = click("sceneRule",{id:rewrite.id});
    assertPrimary(editor,"mock");
    assert.ok(editor.includes('value="'+rewrite.id+'"'));
    assert.match(editor,/class="sc-rule-list"/);
    assert.ok(editor.includes(last.id));
    const collapsed = click("sceneRule",{id:rewrite.id});
    assertPrimary(collapsed,"mock");
    assert.match(collapsed,/class="sc-rule-list"/);
    assert.doesNotMatch(collapsed,/id="ns-id"/);
});

test("a request matched by a response sequence opens its matching sequence editor", async () => {
    const {source, network, click, render} = await workspace();
    source.ruleId = network.scenario.rules.find(rule=>rule.steps).id;
    const editor = click("matchedRule",{id:source.id});
    assertPrimary(editor,"mock");
    assert.match(editor,/id="scenario-editor-title"/);
    assert.match(editor,/value="\/items"/);
    assertPrimary(click("returnExchange",{id:source.id}),"requests");
    assert.match(render(),/data-id="source" aria-selected="true"/);
});

test("group management opens the batch editor and the group heading resumes its parked draft", async () => {
    const {view, model, network, click, render} = await workspace();
    const chinese = () => view.networkView(model,"zh-CN");
    const title = markup => markup.match(/<header class="sc-title">([\s\S]*?)<\/header>/)[1];
    const first = network.scenario.rules.find(rule=>rule.steps);
    network.scenario.rules.push({...first,id:"Second sequence",path:"/second"});
    click("mock");
    const overview = chinese();
    assert.doesNotMatch(title(overview),/data-net="edit"/);
    assert.match(overview,/<details id="sc-management"><summary>管理规则组<\/summary>\s*<div><button[^>]+data-net="edit"[^>]*>批量编辑顺序响应<\/button>/);
    click("edit");
    assert.match(chinese(),/编辑顺序响应/);
    assert.match(render(),/id="ne-rule"[\s\S]*?Second sequence<\/option>/);
    view.networkInput({id:"ne-0-path",dataset:{ne:"path",row:"0"},value:"/unsaved"},render);
    click("sequenceOverview");
    assert.match(title(chinese()),/data-net="edit"[^>]*>继续编辑草稿<\/button>/);
    assert.match(click("edit"),/id="ne-0-path"[^>]*value="\/unsaved"/);
    click("sequenceOverview");
    assert.match(click("editSequence",{id:"Second sequence"}),/id="ne-1-path"[^>]*value="\/second"/);
    click("cancel");
    assert.doesNotMatch(title(chinese()),/继续编辑草稿/);
});

test("a disabled sequence test shows the next prerequisite next to its button", async () => {
    const {view, model, network, click} = await workspace();
    const rule = network.scenario.rules.find(rule=>rule.steps);
    click("mock");
    for (const [running,paused,enabled,hint] of [
        [false,false,true,"先启动网关"], [true,true,true,"先启用规则组"],
        [false,true,true,"先启用规则组"], [true,false,false,"先启用这条规则"], [true,false,true,""]
    ]) {
        network.running=running;
        network.scenario.paused=paused;
        rule.enabled=enabled;
        const markup = view.networkView(model,"zh-CN");
        const action = markup.match(/<span class="sc-test-action">([\s\S]*?)<\/span>/)[1];
        if (hint) {
            const [,id] = action.match(/aria-describedby="([^"]+)" disabled>发送测试请求<\/button>/);
            assert.ok(action.includes('<small id="'+id+'" class="sc-caption">'+hint+'</small>'));
        } else {
            assert.doesNotMatch(action,/disabled|aria-describedby|<small/);
            assert.match(action,/>发送测试请求<\/button>/);
        }
    }
});

test("an empty scenario can start either a rewrite or a sequence directly from its overview", async () => {
    const {network, click, messages, render} = await workspace();
    network.scenario.rules = [];
    network.hits = [];
    network.scenarioLibrary[0].ruleCount = 0;
    click("mock");
    const rewrite = click("sceneNewRule");
    assertPrimary(rewrite,"mock");
    assert.match(rewrite,/id="ns-pattern"/);
    click("parentScene");
    const sequence = click("sceneNewSequence");
    assertPrimary(sequence,"mock");
    assert.match(sequence,/id="ne-0-path"/);
    assert.match(sequence,/id="ne-0-0-status"[^>]*value="200"/);
    click("apply");
    const [save] = messages;
    assert.equal(save.type,"networkApply");
    assert.equal(save.scenarioId,network.activeScenarioId);
    assert.equal(save.scenario.rules.length,1);
    assert.equal(save.scenario.rules[0].steps[0].response.status,200);
    network.scenario = save.scenario;
    network.scenarioReceipt = {type:save.type,revision:save.revision};
    render();
});

test("creating from a request uses a focused draft and saves only to the selected rule group", async () => {
    const {view, network, source, click, render, messages} = await workspace();
    const destination=randomUUID();
    const other={id:destination,scenario:{version:1,name:"Checkout responses",rules:[]},version:14};
    network.scenarioLibrary.push({id:destination,name:other.scenario.name,ruleCount:0});
    const composer=click("createRule",{id:source.id});
    assertPrimary(composer,"mock");
    assert.match(composer,/Create rule from request/);
    assert.match(composer,/Which requests match\?[\s\S]*?<code>\/cart<\/code>/);
    assert.match(composer,/What happens on a match\?[\s\S]*?Return a mock response[\s\S]*?Rewrite fields/);
    assert.match(composer,/Save to rule group[\s\S]*?Checkout responses/);
    assert.match(composer,/data-net="studio-apply" disabled/);
    assert.doesNotMatch(composer,/class="sc-workspace"|class="ns-gateway"|id="ns-edit-0-key"|data-net="native"/);
    const input=(key,value)=>view.networkInput({id:"ns-"+key,dataset:{ns:key},value},render,message=>messages.push(message));
    input("action","local");
    assert.match(render(),/id="ns-responseStatus"[^>]+value="503"/);
    assert.match(render(),/Response body[\s\S]*?<details id="ns-compose-response-options">/);
    input("id","Simulated retry");
    input("destination",destination);
    assert.deepEqual(messages,[{type:"networkScenarioBrowse",id:destination}]);
    assert.match(render(),/data-net="studio-apply" disabled/);
    network.viewedGroup=other;
    assert.match(render(),/id="ns-id"[^>]+value="Simulated retry"/);
    click("studio-preview");
    assert.equal(messages[1].scenarioId,destination);
    assert.equal(messages[1].seedId,source.id);
    assert.equal(messages[1].originalRule,null);
    network.operation={type:messages[1].type,revision:messages[1].revision,preview:{total:1,matchedIds:[source.id],examples:[]}};
    assert.match(render(),/History preview/);
    click("studio-apply");
    const save=messages[2];
    assert.equal(save.type,"networkUpsertRule");
    assert.equal(save.scenarioId,destination);
    assert.equal(save.originalRule,null);
    assert.equal(save.rule.action,"local");
    other.scenario.rules.push(save.rule);
    network.operation={type:save.type,revision:save.revision};
    const saved=render();
    assert.match(saved,/Rule saved to “Checkout responses”/);
    assert.match(saved,/data-net="sceneRule" data-id="Simulated retry"/);
    assert.doesNotMatch(saved,/id="ns-compose-title"/);
    assert.notEqual(network.activeScenarioId,destination);
    assertPrimary(click("returnExchange",{id:source.id}),"requests");
});

test("a rule preview received while composing a resend stays with its edited rule", async () => {
    const {source, network, view, click, messages, render} = await workspace();
    const rule = click("matchedRule",{id:source.id});
    assert.match(rule,/id="ns-edit-0-value"/);
    view.networkInput({id:"ns-edit-0-value",dataset:{ns:"value",index:"0"},value:"11"},render);
    click("studio-preview");
    const [preview] = messages;
    assert.equal(preview.type,"networkPreviewRule");
    assert.equal(preview.rule.edits[0].value,"11");
    click("requests");
    assert.match(click("resend",{id:source.id}),/id="ns-path"/);
    view.networkInput({id:"ns-path",dataset:{ns:"path"},value:"/manual-replay"},render);
    network.operation = {type:preview.type,revision:preview.revision,preview:{total:1,matchedIds:[source.id],examples:[]}};
    assert.doesNotMatch(render(),/class="ns-preview"/);
    const restored = click("mock");
    assertPrimary(restored,"mock");
    assert.match(restored,/id="ns-edit-0-value"[^>]*value="11"/);
    assert.match(restored,/class="ns-preview"/);
    const resend = click("requests");
    assertPrimary(resend,"requests");
    assert.match(resend,/id="ns-path"[^>]*value="\/manual-replay"/);
    assert.doesNotMatch(resend,/class="ns-preview"/);
    assert.equal(messages.length,1);
});

test("a request context action uses the row under the pointer even when another exchange is selected",async()=>{
    const {view,model,click,render,messages}=await workspace();
    assert.match(render(),/data-id="source" aria-selected="true"/);
    const items=view.requestMenuItems({dataset:{recordId:"unrelated"}},model,"en",msg=>messages.push(msg),render);
    items.find(item=>item?.label==="Edit & resend").run();
    assert.match(render(),/data-id="unrelated" aria-selected="true"/);
    assert.match(render(),/id="ns-path"[^>]+value="\/stock"/);
    click("closeResend");
    items.find(item=>item?.label==="Favorite request").run();
    assert.deepEqual(messages,[{type:"networkSaveFavorite",id:"unrelated",remove:false}]);
});

test("right click on the request details and a retained JSON field exposes targeted actions",async()=>{
    const {view,model,render,messages,source}=await workspace();
    assert.match(render(),/class="net-detail" data-item-actions="request"/);
    const send=message=>messages.push(message);
    const items=view.requestMenuItems({dataset:{recordId:source.id,recordDetail:"true"}},model,"en",send,render);
    items.find(item=>item?.label==="Copy request URL").run();
    assert.deepEqual(messages,[{type:"networkCopyRetained",id:source.id,text:source.request.url}]);
    items.find(item=>item?.label==="View request").run();
    assert.match(render(),/id="network-detail-tab-request"[^>]*aria-selected="true"/s);
    items.find(item=>item?.label==="Filter by this path").run();
    assert.match(render(),/value="path:\/cart"/);
    const field=view.requestFieldMenuItems({dataset:{id:source.id,target:"responseJson",ref:'["retryAfter"]',fieldLabel:"retryAfter"}},
        model,"en",send,render);
    field.find(item=>item.label==="Copy field value").run();
    assert.deepEqual(messages[1],{type:"networkCopyRetained",id:source.id,text:"2"});
    field.find(item=>item.label==="Create rule for this field").run();
    assert.match(render(),/retryAfter/);
});

for (const [action, parent] of [["createRule","mock"], ["fieldRule","mock"], ["resend","requests"], ["matchedRule","mock"]]) {
    test(action+" opens from a scoped request and returns to it with the same URL filter", async () => {
        const {view, network, source, rewrite, click, render, messages} = await workspace();
        const start = Date.parse(startedAt);
        network.range = {start:start-5,end:start+100};
        network.stepLabel = "steps[4]";
        network.returnTo = "run";
        render();
        view.networkInput({id:"net-filter", dataset:{}, value:"path:cart"},render);
        network.records.push(exchange("newer","/cart"));
        const origin = render();
        assert.match(origin,/data-id="source" aria-selected="true"/);
        assert.doesNotMatch(origin,/data-net="select" data-id="unrelated"/);
        const editor = click(action, {id:source.id,...(action==="fieldRule" && {target:"responseJson",ref:'["retryAfter"]'})});
        assertPrimary(editor,parent);
        if (action==="fieldRule") assert.match(editor,/retryAfter/);
        if (action==="createRule") {
            view.networkInput({id:"ns-id",dataset:{ns:"id"},value:"Draft from timeline"},render);
            click("returnExchange",{id:source.id});
            assert.match(click("createRule",{id:source.id}),/id="ns-id"[^>]+value="Draft from timeline"/);
            assertPrimary(click("cancelRuleDraft",{id:source.id}),"requests");
            assert.doesNotMatch(click("createRule",{id:source.id}),/Draft from timeline/);
        }
        if (action==="resend") {
            assert.match(editor,/data-net="studio-send"/);
            assert.match(editor,/data-id="source" aria-selected="true"/);
            assert.match(editor,/value="path:cart"/);
        }
        if (action==="matchedRule") assert.ok(editor.includes('value="'+rewrite.id+'"'));
        const result = action==="resend" ? click("closeResend") : click("returnExchange",{id:source.id});
        assertPrimary(result,"requests");
        assert.match(result,/data-id="source" aria-selected="true"/);
        assert.match(result,/value="path:cart"/);
        assert.match(result,/steps\[4\]/);
        assert.doesNotMatch(result,/data-net="select" data-id="unrelated"/);
        assert.deepEqual(messages,[]);
    });
}

test("a response sequence drafted from a request has a route back to that exchange", async () => {
    const {model, source, network, click, render, messages} = await workspace();
    click("from",{id:source.id});
    assert.equal(messages.length,1);
    assert.equal(messages[0].type,"networkFrom");
    assert.equal(messages[0].id,source.id);
    const rule = scenarioFromRecord(source).rules[0];
    const scenario = {...network.scenario,rules:[rule,...network.scenario.rules]};
    model.networkDraft = {revision:randomUUID(),scenario,focusRuleId:rule.id,sourceId:source.id,
        scenarioId:network.activeScenarioId,scenarioVersion:network.scenarioVersion};
    const editor = render();
    assertPrimary(editor,"mock");
    assert.match(editor,/id="scenario-editor-title"/);
    network.records.push(exchange("later","/other"));
    const result = click("returnExchange",{id:source.id});
    assertPrimary(result,"requests");
    assert.match(result,/data-id="source" aria-selected="true"/);
    assert.equal(messages.length,1);
});

test("an exploration receipt opens its network window before network state is loaded", async () => {
    const view = await loadWebview("networkView"), messages = [];
    const handled = view.networkClick({dataset:{net:"explorationStep",id:"inspect-cart",receipt:"2"}},
        {mode:"exploration"}, msg=>messages.push(msg), ()=>{});
    assert.equal(handled,true);
    assert.deepEqual(messages,[{type:"networkExplorationStep",id:"inspect-cart",index:2}]);
});
