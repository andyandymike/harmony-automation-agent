"use strict";

const { randomUUID } = require("node:crypto");
const { pageView } = require("./model");
const { parseLocator, selectNodes } = require("../media/elementsLocator");
const properties = ["text","visible","enabled","checked","selected","focused"];

class ElementsController {
    constructor(bench, vscode) {
        this.bench = bench;
        this.vscode = vscode;
        this.picking = true;
        this.view = bench.state.elements = {picking:true, watches:[], steps:bench.context.workspaceState.get("elements.steps",[])};
    }

    canReuseSnapshot() {
        const b = this.bench;
        return Boolean(b.state.page?.elements && this.snapshot?.page === b.state.page && this.device === b.state.device &&
            this.snapshot.screenRevision === b.livePanel?.screenRevision && this.view.picture?.src);
    }

    async picture(page) {
        const b = this.bench;
        const capture = () => b.agent.call("screenshot",{session:b.session});
        const image = await (b.livePanel ? b.livePanel.withDeviceOperation(capture) : capture());
        return {src:b.image(image.path),capturedAt:image.capturedAt,frameId:page.frameId};
    }

    async sync() {
        const b = this.bench, view = this.view, page = b.state.page;
        view.picking = this.picking;
        if (this.device !== b.state.device) {
            this.device = b.state.device;
            view.watches = [];
            view.copied = undefined;
            this.lastPage = this.snapshot = view.picture = undefined;
        }
        if ((b.state.tool ?? b.state.mode) !== "inspect" || b.state.deviceDisconnected || !page?.elements || page === this.lastPage) return;
        this.lastPage = page;
        const changes = [];
        for (const watch of view.watches) {
            const nodes = selectNodes(page.nodes, watch.locator);
            const value = nodes.length === 1 && nodes[0].attributes[watch.property];
            const result = !page.complete ? {state:"partial"} : nodes.length !== 1 ?
                {state:"matches",count:nodes.length} : value == null ? {state:"unknown"} : {state:"value",value};
            if (JSON.stringify(result) === JSON.stringify(watch.current)) continue;
            const entry = {frameId:page.frameId,time:page.capturedAt,previous:watch.current,current:result};
            changes.push(entry);
            watch.history.unshift(entry);
            watch.history.length = Math.min(watch.history.length,20);
            watch.current = result;
        }
        if (this.picking || changes.length) {
            const screenRevision = b.livePanel?.screenRevision;
            const picture = await this.picture(page);
            if (this.picking) {
                view.picture = picture;
                this.snapshot = {page, screenRevision};
            }
            for (const entry of changes) entry.picture = picture;
        }
    }

    async handle(message) {
        const b = this.bench, v = this.vscode, state = b.state, view = this.view;
        if ((state.tool ?? state.mode) !== "inspect" || !state.device) return;
        if (state.deviceDisconnected && ["elementMode","elementSample"].includes(message.type)) return;
        if (state.draft && !["elementMode","elementSample","elementCopy","elementWatch","elementUnwatch","elementCopySelected","elementUnwatchSelected"].includes(message.type)) return;
        if (message.type === "elementMode") {
            if (this.picking === (message.picking === true)) return;
            this.picking = view.picking = message.picking === true;
            if (this.picking && !this.canReuseSnapshot()) {
                await b.observe();
            }
            return;
        }
        if (message.type === "elementSample") {
            if (!this.picking && view.watches.length) {
                const result = await b.agent.call("start",{session:b.session,device:state.device,max_nodes:5000,compact:false});
                state.page = pageView(result.observation,{elements:true});
            }
            return;
        }
        if (message.type === "elementUnwatch" || message.type === "elementUnwatchSelected") {
            const ids=new Set(message.type==="elementUnwatch" ? [message.id] : Array.isArray(message.ids) ? message.ids : []);
            view.watches=view.watches.filter(watch=>!ids.has(watch.id));
            return;
        }
        if (["elementRemove","elementRemoveSelected","elementUndoRemoval"].includes(message.type)) {
            const revision=view.stepsRevision || 0;
            if (message.type!=="elementRemove" && message.revision!==revision) return;
            const steps=[...view.steps];
            let removed;
            if (message.type==="elementUndoRemoval") {
                if (!view.removedSteps?.length) return;
                for (const {index,step} of view.removedSteps) steps.splice(index,0,step);
            } else {
                const indices=message.type==="elementRemove" ? [message.index] :
                    Array.isArray(message.indices) ? [...new Set(message.indices)] : [];
                if (!indices.length || indices.some(index=>!Number.isInteger(index) || !steps[index])) return;
                removed=indices.sort((a,b)=>a-b).map(index=>({index,step:steps[index]}));
                for (const index of indices.toReversed()) steps.splice(index,1);
            }
            await b.context.workspaceState.update("elements.steps",steps);
            Object.assign(view,{steps,removedSteps:removed,stepsRevision:revision+1});
            return;
        }
        if (message.type === "elementSave") {
            if (!view.steps.length) return;
            const folder = v.workspace.workspaceFolders?.[0];
            const uri = await v.window.showSaveDialog({filters:{JSON:["json"]},
                defaultUri:folder && v.Uri.joinPath(folder.uri,"inspected-controls.plan.json")});
            if (!uri) return;
            await v.workspace.fs.writeFile(uri,Buffer.from(JSON.stringify({version:"1",steps:view.steps},null,2)+"\n"));
            await b.setPlan(uri);
            state.tool = "recordings";
            await b.context.workspaceState.update("elements.steps",[]);
            Object.assign(view,{steps:[],removedSteps:undefined,stepsRevision:(view.stepsRevision || 0)+1});
            return;
        }
        const page = state.page;
        if (!page?.elements || page.frameId !== message.frameId) throw new Error(b.text.stalePage);
        if (message.type === "elementCopySelected") {
            const refs=[...new Set(Array.isArray(message.refs) ? message.refs : [])];
            const nodes=new Map(page.nodes.map(node=>[node.ref,node]));
            if (!refs.length || refs.some(ref=>!nodes.get(ref)?.selector)) throw new Error(b.text.stalePage);
            const locators=refs.map(ref=>parseLocator(nodes.get(ref).selector));
            await v.env.clipboard.writeText(JSON.stringify(locators,null,2));
            view.copiedSelection={frameId:page.frameId,count:locators.length};
            return;
        }
        const locator = parseLocator(message.locator);
        if (message.type === "elementCopy") {
            await v.env.clipboard.writeText(JSON.stringify(locator,null,2));
            view.copied = {frameId:page.frameId,key:JSON.stringify(locator)};
            return;
        }
        const matches = selectNodes(page.nodes,locator);
        if (!page.complete || matches.length !== 1) throw new Error(b.text.uniqueTarget);
        const node=matches[0], property=message.property, value=node.attributes[property];
        if (message.type === "elementWatch" || message.type === "elementAssert") {
            if (!properties.includes(property) || value == null) throw new Error(b.text.invalidObservation);
            if (message.type === "elementWatch") {
                if (!view.watches.some(w=>w.property === property && JSON.stringify(w.locator) === JSON.stringify(locator))) {
                    view.watches.push({id:randomUUID(),label:node.label,locator,property,current:{state:"value",value},history:[]});
                }
                return;
            }
            view.steps.push({assert:{selector:locator,property,equals:value}});
        } else if (message.type === "elementStep") {
            if (!node.pressable) throw new Error(b.text.chooseElement);
            view.steps.push({command:"press",input:{target:locator}});
        } else return;
        await b.context.workspaceState.update("elements.steps",view.steps);
        view.removedSteps=undefined;
        view.stepsRevision=(view.stepsRevision || 0)+1;
    }
}

module.exports = {ElementsController};
