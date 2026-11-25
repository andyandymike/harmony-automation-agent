import {actionButton, escapeHtml as h} from "./ui/controls.js";
import {caseContinuationChoices,issueText} from "./caseComposition.js";

const normalized = value=>String(value || "").normalize("NFKC").toLowerCase().trim();

export function insertionMatches(items, indexed, query) {
    const text=normalized(query);
    const terms=text.split(/\s+/).filter(Boolean);
    const matches=[];
    for (const item of items) {
        const row=indexed ? {...item,...indexed.get(item.id),name:item.name} : item;
        const name=normalized(row.name);
        const metadata=normalized([row.app,row.location,...(row.tags || [])].filter(Boolean).join(" "));
        const steps=normalized(row.search);
        const ranks=terms.map(term=>name.startsWith(term)?0:name.includes(term)?1:metadata.includes(term)?2:steps.includes(term)?3:-1);
        if (!ranks.includes(-1)) matches.push({row,rank:name===text?-1:ranks.reduce((sum,current)=>sum+current,0)});
    }
    return matches.sort((a,b)=>Number(Boolean(a.row.issue))-Number(Boolean(b.row.issue)) || a.rank-b.rank).map(match=>match.row);
}

export class InlineCaseInsertion {
    constructor(root, send, render, openEditor) {
        this.root=root;
        this.send=send;
        this.render=render;
        this.openEditor=openEditor;
        document.addEventListener("pointerdown",event=>{
            const s=this.session;
            if (s && s.mode!=="description" && !s.pending && !s.row.contains(event.target)) this.close(false);
        });
    }

    words(en,zh) { return /^zh/i.test(this.language) ? zh : en; }

    row(path) {
        return path && this.root.querySelector('[data-case-step="'+CSS.escape(path)+'"]');
    }

    click(button, model, language) {
        if (button.dataset.caseInsert==="undo") {
            const review=model.caseReview;
            if (!review || model.busy) return true;
            this.undoSession=crypto.randomUUID();
            this.send({type:"caseInsert",action:"undo",session:this.undoSession,id:review.id,revision:review.revision});
            return true;
        }
        const action=button.dataset.caseInsert;
        if (!["open","edit","editRuleGroup"].includes(action)) return false;
        if (button.disabled || model.busy) return true;
        const review=model.caseReview;
        const bdd=review?.bdd || model.caseBdd;
        const steps=bdd?.steps || [];
        const path=button.dataset.path || steps.findLast(step=>step.path)?.path || "steps";
        const side=button.dataset.side || "after";
        const anchor=this.row(path);
        if (!anchor) return true;
        this.close(false);
        this.model=model;
        this.language=language;
        const target={uri:model.plan?.uri,digest:model.planDigest,id:review?.id,revision:review?.revision,path,side,
            descriptionId:button.dataset.descriptionId};
        const editGroup=action==="editRuleGroup";
        const legacy=editGroup && path==="rule-group";
        const closingStep=editGroup && button.dataset.ruleAction==="disable";
        const group=editGroup || action==="open" ? {edit:editGroup,legacy,closingStep,canClose:bdd?.ruleClosures?.[path]?.[side],
            path:legacy ? steps.find(step=>step.path)?.path || "steps" : path,side:legacy ? "before" : side} : undefined;
        this.mount(target,button,anchor,group);
        if (editGroup) this.showSearch(closingStep ? "ruleOff" : "ruleGroup");
        else if (target.descriptionId) {
            this.session.description.value=button.dataset.description || "";
            this.showDescription();
        }
        return true;
    }

    mount(target, trigger, anchor, group) {
        const w=(en,zh)=>this.words(en,zh);
        const row=document.createElement("li");
        row.className="case-inline-insert";
        const label=anchor.querySelector(":scope > .case-sort-content .case-bdd-text")?.textContent.trim();
        const position=target.side==="before" ? w("Insert before","在此步之前插入") : w("Insert after","在此步之后插入");
        const supplement=caseContinuationChoices(this.model,target.path,target.side,w).find(item=>item.destination==="current");
        const choice=(kind,text,reason)=>`<button class="case-insert-kind" type="button" data-insert-kind="${kind}"${reason ?
            ` disabled data-unavailable title="${h(reason)}"` : ""}>${h(text)}</button>`;
        const name=trigger.dataset.path ? [position,label].filter(Boolean).join(" · ") : w("Insert step","插入步骤");
        row.innerHTML=`<div class="case-inline-kinds" role="group" aria-label="${h(name)}">
            ${choice("description",w("Write a step description","写步骤描述"))}
            ${choice("check",w("Insert a check","插入验证"))}
            ${supplement ? choice("supplement",supplement.label,supplement.reason) : ""}
            ${choice("reuse",w("Reference a case","引用已有用例"))}
            ${group && !group.edit ? choice("ruleGroup",w("Enable rule group","启用规则组"))+
                (group.canClose ? choice("ruleOff",w("Turn off rule group","关闭规则组")) : "") : ""}
        </div>
        <div class="case-inline-description" hidden>
            <label for="case-inline-description">${w("Step description","步骤描述")}</label>
            <textarea id="case-inline-description" rows="2" maxlength="1200"
                placeholder="${w("Confirm the language is English, then return to Settings","确认语言仍为 English，然后回到设置页")}"></textarea>
            <div class="toolbar">
                ${actionButton(target.descriptionId ? w("Apply","应用修改") : w("Add step","添加步骤"),{primary:true,attrs:{"data-insert-description":""}})}
                ${actionButton(w("Cancel","取消"),{quiet:true,attrs:{"data-insert-back":"close"}})}
            </div>
        </div>
        <div class="case-inline-search" hidden>
            <div class="case-inline-insert-line">
                <input id="case-inline-search" class="vscode-textfield" type="text" autocomplete="off" spellcheck="false" role="combobox"
                    aria-autocomplete="list" aria-expanded="true" aria-controls="case-inline-options">
                ${actionButton(w("Back","返回"),{quiet:true,attrs:{"data-insert-back":"kind"}})}
            </div>
            <ul id="case-inline-options" role="listbox"></ul>
            <p class="case-inline-empty" role="status" hidden></p>
            ${group?.edit ? `<div class="case-inline-rule-group" hidden>
                <p class="case-inline-rule-note"></p>
                ${group.legacy ? actionButton(w("Remove rule group","移除规则组"),{quiet:true,attrs:{"data-insert-remove-group":""}}) : ""}
            </div>` : ""}
        </div>
        <div id="case-inline-preview" hidden>
            <div class="case-inline-source"></div>
            ${actionButton(w("Back to results","返回搜索结果"),{quiet:true,attrs:{"data-insert-back":"search"}})}
        </div>
        <p class="case-inline-status" role="status" hidden></p>`;
        const input=row.querySelector("input"), options=row.querySelector("ul");
        const s=this.session={session:crypto.randomUUID(),target,trigger,row,input,options,mode:"kind",hits:[],
            kinds:row.querySelector(".case-inline-kinds"),searchPane:row.querySelector(".case-inline-search"),
            description:row.querySelector("textarea"),descriptionPane:row.querySelector(".case-inline-description"),
            status:row.querySelector(".case-inline-status"),empty:row.querySelector(".case-inline-empty"),
            preview:row.querySelector("#case-inline-preview"),source:row.querySelector(".case-inline-source"),indexed:new Map(),
            group,ruleLists:new Map(),groupActions:row.querySelector(".case-inline-rule-group"),groupNote:row.querySelector(".case-inline-rule-note"),
            searchBack:row.querySelector('.case-inline-search [data-insert-back]')};
        this.attach(anchor);
        s.kinds.querySelector("button").focus({preventScroll:true});
        row.scrollIntoView({block:"nearest",inline:"nearest"});
        for (const field of [input,s.description]) {
            field.addEventListener("compositionstart",()=>{s.composing=true;});
            field.addEventListener("compositionend",()=>{
                s.composing=false;
                if (field===input) {
                    s.selectedId=undefined;
                    this.search();
                } else this.update();
                if (s.deferred) {
                    s.deferred=false;
                    this.render();
                }
            });
        }
        s.description.addEventListener("input",event=>{if (!event.isComposing) this.update();});
        input.addEventListener("input",event=>{
            if (event.isComposing || s.composing) return;
            s.selectedId=undefined;
            this.search();
        });
        row.addEventListener("keydown",event=>this.keys(event));
        row.addEventListener("focusout",event=>{
            if (row.contains(event.relatedTarget)) return;
            queueMicrotask(()=>{
                if (this.session===s && s.mode!=="description" && !s.pending && row.isConnected && document.hasFocus() && !row.contains(document.activeElement))
                    this.close(false);
            });
        });
        options.addEventListener("mousedown",event=>event.preventDefault());
        row.addEventListener("click",event=>{
            if (s.pending) return;
            const control=event.target.closest("button,[data-source]");
            if (!control) return;
            const {insertKind,insertBack,source,insertChoice}=control.dataset;
            if (insertKind==="supplement" && supplement && !supplement.reason && this.sameTarget(this.model)) {
                this.close(false);
                this.send(supplement.message);
                return;
            }
            if (insertKind==="check") {
                s.pending=true;
                this.update();
                this.request("step",{kind:"check"});
                return;
            }
            if (["reuse","ruleGroup","ruleOff"].includes(insertKind)) return this.showSearch(insertKind);
            if (insertBack==="search") return this.showSearch();
            if (insertKind==="description") return this.showDescription();
            if (insertBack==="kind") return this.showKinds();
            if (insertBack==="close") return this.close(true);
            if (control.hasAttribute("data-insert-description")) return this.saveDescription();
            if (insertChoice==="reference") return this.apply();
            if (insertChoice==="ruleGroup") return this.applyRuleGroup();
            if (insertChoice==="ruleOff") return this.applyRuleGroup({disable:true});
            if (control.hasAttribute("data-insert-remove-group")) return this.applyRuleGroup({remove:true});
            if (source) return this.requestPreview(source);
        });
    }

    attach(anchor) {
        const s=this.session;
        const {row,target}=s;
        if (target.side==="before") anchor.before(row);
        else anchor.after(row);
        anchor.closest(".case-bdd")?.classList.add("case-inserting");
    }

    sync(model, surface) {
        this.model=model;
        this.showRequestedEditor();
        this.focusResult();
        const s=this.session;
        if (!s) return;
        const target=s.target;
        const sameSurface=surface==="case" || surface==="case-review";
        const sameTarget=this.sameTarget(model);
        if (!sameSurface || model.plan?.uri!==target.uri || (!sameTarget && !s.pending)) return this.close(false);
        if (!s.row.isConnected && sameTarget) {
            const anchor=this.row(target.path);
            if (!anchor) return this.close(false);
            this.attach(anchor);
            this.update();
        }
    }

    sameTarget(model) {
        const target=this.session.target, review=model.caseReview;
        return model.plan?.uri===target.uri &&
            (target.id ? review?.id===target.id && review.revision===target.revision : !review && model.planDigest===target.digest);
    }

    deferRender(model,surface) {
        const s=this.session;
        if (!s?.composing || !["case","case-review"].includes(surface) || !this.sameTarget(model)) return false;
        s.deferred=true;
        return true;
    }

    search() {
        const s=this.session;
        if (!s || s.pending) return;
        const list=s.ruleLists.get(s.searchKind);
        if (!list?.failed) this.status("");
        if (s.searchKind!=="reuse") {
            if (!list) {
                s.ruleLists.set(s.searchKind,{loading:true});
                this.request(s.searchKind==="ruleOff" ? "ruleClosures" : "ruleGroups",this.ruleTarget());
            }
        } else if (!s.indexing && !s.indexReady) {
            s.indexing=true;
            this.request("index");
        }
        this.update();
    }

    request(action, options) {
        const s=this.session;
        this.send({type:"caseInsert",action,session:s.session,...s.target,...options});
    }

    keys(event) {
        const s=this.session;
        if (!s || s.composing || event.isComposing || event.keyCode===229) return;
        if (event.key==="Escape") {
            event.preventDefault();
            event.stopPropagation();
            if (s.pending) return;
            if (s.mode==="preview") this.showSearch();
            else if (s.mode==="search" && !s.group?.edit) this.showKinds();
            else this.close(true);
            return;
        }
        if (s.mode==="kind" && ["ArrowDown","ArrowUp"].includes(event.key)) {
            const choices = Array.from(s.kinds.querySelectorAll("button:enabled"));
            const index = choices.indexOf(event.target);
            if (index<0) return;
            event.preventDefault();
            choices[(index + (event.key==="ArrowDown" ? 1 : -1) + choices.length) % choices.length].focus();
            return;
        }
        if (event.target===s.description && event.key==="Enter" && !event.shiftKey) {
            event.preventDefault();
            this.saveDescription();
            return;
        }
        if (event.target!==s.input || s.pending) return;
        if (event.key==="Enter") {
            event.preventDefault();
            this.requestPreview(s.selectedId);
        } else if (event.key==="ArrowDown" || event.key==="ArrowUp") {
            const available=s.hits.filter(item=>!item.blocked);
            if (!available.length) return;
            event.preventDefault();
            const index=available.findIndex(item=>item.id===s.selectedId);
            const next=Math.min(available.length-1,Math.max(0,index+(event.key==="ArrowDown"?1:-1)));
            s.selectedId=available[next].id;
            this.update();
        }
    }

    showKinds() {
        const s=this.session;
        s.mode="kind";
        this.status("");
        this.update();
        s.kinds.querySelector('[data-insert-kind="'+s.searchKind+'"]').focus({preventScroll:true});
    }

    showDescription() {
        const s=this.session;
        s.mode="description";
        this.update();
        s.description.focus({preventScroll:true});
        s.row.scrollIntoView({block:"nearest",inline:"nearest"});
    }

    saveDescription() {
        const s=this.session, description=s.description.value.trim();
        if (s.pending || this.model.busy || !description) return;
        s.pending=true;
        this.update();
        this.request("describe",{description});
    }

    showSearch(kind=this.session.searchKind) {
        const s=this.session, w=(en,zh)=>this.words(en,zh);
        if (s.searchKind!==kind) {
            s.input.value="";
            s.selectedId=undefined;
        }
        s.searchKind=kind;
        s.mode="search";
        if (s.ruleLists.get(kind)?.failed) s.ruleLists.delete(kind);
        const rules=kind!=="reuse", off=kind==="ruleOff";
        s.input.placeholder=off ? w("Search enabled rule groups","搜索已启用的规则组") :
            rules ? w("Search rule group names","搜索规则组名称") : w("Search cases, steps, or tags","搜索用例、步骤或标签");
        s.input.setAttribute("aria-label",off ? w("Choose a rule group to turn off","选择要关闭的规则组") :
            rules ? w("Find a rule group","查找规则组") : w("Find a case to reuse","查找要复用的用例"));
        s.options.setAttribute("aria-label",off ? w("Enabled rule groups","已启用的规则组") :
            rules ? w("Rule groups","规则组") : w("Cases to reuse","可复用的用例"));
        s.searchBack.dataset.insertBack=s.group?.edit ? "close" : "kind";
        s.searchBack.textContent=s.group?.edit ? w("Cancel","取消") : w("Back","返回");
        this.search();
        s.input.focus({preventScroll:true});
        s.row.scrollIntoView({block:"nearest",inline:"nearest"});
    }

    ruleCount(enabled) {
        return this.words(`${enabled} enabled ${enabled===1 ? "rule" : "rules"}`,`${enabled} 条已启用规则`);
    }

    ruleTarget() {
        const {path,side,edit,legacy,closingStep}=this.session.group;
        return {path,side,ruleEdit:edit ? legacy ? "legacy" : closingStep ? "close" : "step" : undefined};
    }

    applyRuleGroup({disable=false,remove=false}={}) {
        const s=this.session;
        const option=s.previewData;
        if (s.pending || this.model.busy || (!remove && (!option?.id || option.current || option.blocked || !disable && !option.digest))) return;
        s.pending=true;
        this.status("");
        this.update();
        this.request("applyRuleGroup",{...this.ruleTarget(),disable,remove,groupId:option?.id,groupDigest:option?.digest});
    }

    requestPreview(id) {
        const s=this.session;
        const item=s.hits.find(item=>item.id===id);
        if (!item || item.blocked || s.pending) return;
        s.mode="preview";
        s.selectedId=id;
        s.previewData=undefined;
        this.status("");
        if (s.searchKind!=="reuse") s.previewData=item;
        else {
            s.previewRequest=(s.previewRequest || 0)+1;
            this.request("preview",{sourceId:id,request:s.previewRequest});
        }
        this.update();
        s.preview.querySelector("[data-insert-back]").focus({preventScroll:true});
    }

    apply() {
        const s=this.session, source=s.previewData;
        if (!source?.digest || source.issue || s.pending) return;
        s.pending=true;
        this.status(this.words("Adding to the draft…","正在加入草稿…"));
        this.update();
        this.request("apply",{sourceId:source.id,sourceDigest:source.digest});
    }

    status(message) {
        const s=this.session;
        s.status.textContent=message;
        s.status.hidden=!message;
    }

    update() {
        const s=this.session;
        if (!s || s.composing || !s.row.isConnected) return;
        const w=(en,zh)=>this.words(en,zh);
        s.kinds.hidden=s.mode!=="kind";
        s.searchPane.hidden=s.mode!=="search";
        s.preview.hidden=s.mode!=="preview";
        s.descriptionPane.hidden=s.mode!=="description";
        s.description.readOnly=Boolean(s.pending);
        s.descriptionPane.querySelector("[data-insert-description]").disabled=Boolean(s.pending || !s.description.value.trim());
        s.row.setAttribute("aria-busy",String(Boolean(s.pending)));
        s.kinds.querySelectorAll("button").forEach(button=>button.disabled=Boolean(s.pending) || button.hasAttribute("data-unavailable"));
        s.preview.querySelector("[data-insert-back]").disabled=Boolean(s.pending);
        s.searchBack.disabled=s.input.readOnly=Boolean(s.pending);
        if (s.mode==="preview") this.drawPreview();
        if (s.mode==="search") this.drawSearch(w);
    }

    drawSearch(w) {
        const s=this.session;
        const rules=s.searchKind!=="reuse", off=s.searchKind==="ruleOff";
        const list=s.ruleLists.get(s.searchKind);
        const items=rules ? list?.options || [] :
            this.model.cases.filter(item=>s.indexed.has(item.id) && !s.indexed.get(item.id).issue);
        if (s.groupActions) {
            s.groupActions.hidden=!rules;
            const remove=s.groupActions.querySelector("button");
            if (remove) remove.disabled=Boolean(s.pending);
            const name=list?.current;
            s.groupNote.textContent=name ? off ? w(`Current target · ${name}`,`关闭对象 · ${name}`) :
                w(`Current snapshot · ${name}`,`当前快照 · ${name}`) : "";
            s.groupNote.hidden=!name;
        }
        s.hits=insertionMatches(items,rules ? undefined : s.indexed,s.input.value);
        if (!s.hits.some(item=>!item.blocked && item.id===s.selectedId)) s.selectedId=s.hits.find(item=>!item.blocked)?.id;
        const blockedLabels={
            active:w("Already enabled here","此处已启用"),
            possible:w("May already be enabled here","到此处时可能已启用"),
            later:w("Overlaps another enable step","与另一条启用步骤重叠"),
        };
        s.options.innerHTML=s.hits.map((item,index)=>{
            const detail=blockedLabels[item.blocked] || (rules ?
                [item.current ? w("Current","当前") : "", off ? "" : this.ruleCount(item.enabled)].filter(Boolean).join(" · ") :
                item.steps===undefined ? "" : w(item.steps+" steps",item.steps+" 步"));
            return `<li id="case-inline-choice-${index}" role="option" data-source="${h(item.id)}"
                aria-selected="${item.id===s.selectedId}"${item.blocked ? ' aria-disabled="true"' : ""}>
                <strong>${h(item.name)}</strong>${detail?`<small>${h(detail)}</small>`:""}</li>`;
        }).join("");
        const selected=s.options.querySelector('[aria-selected="true"]');
        if (selected) {
            s.input.setAttribute("aria-activedescendant",selected.id);
            const scroller=s.options, box=selected.getBoundingClientRect(), viewing=scroller.getBoundingClientRect();
            if (box.top<viewing.top) scroller.scrollTop+=box.top-viewing.top;
            if (box.bottom>viewing.bottom) scroller.scrollTop+=box.bottom-viewing.bottom;
        } else s.input.removeAttribute("aria-activedescendant");
        if (rules) {
            const guidance=off ? w("No rule groups are enabled at this position.","此位置没有已启用的规则组。") :
                w("Create or import a group with enabled rules in Network → Mock & rewrite.",
                    "请在「网络调试 → 模拟与改写」新建或导入带有已启用规则的规则组。");
            s.empty.textContent=list?.loading ? w("Reading rule groups…","正在读取规则组…") :
                items.length ? w("No matching rule groups","未找到匹配的规则组") : list?.options ? guidance : "";
        } else {
            s.empty.textContent=!s.indexReady ? w("Reading cases…","正在读取用例…") : items.length ?
                w("No matching cases","没有匹配的用例") : w("No saved cases available to reuse","没有可复用的用例");
        }
        s.empty.hidden=Boolean(s.hits.length || !s.empty.textContent);
    }

    drawPreview() {
        const s=this.session, source=s.previewData;
        const w=(en,zh)=>this.words(en,zh);
        if (!source) {
            s.source.textContent=w("Reading the selected case…","正在读取所选用例…");
            s.previewHtml=undefined;
            return;
        }
        const list=steps=>`<ul>${steps.map(step=>`<li><span>${h(step.role)}</span> ${h(step.text)}
            ${step.details?`<small>${h(step.details)}</small>`:""}</li>`).join("")}</ul>`;
        const rules=s.searchKind!=="reuse", off=s.searchKind==="ruleOff";
        const steps=source.preview || [];
        const disabled=Boolean(s.pending || source.issue || rules && source.current);
        const label=!rules ? w("Insert reference","插入引用") : s.group.edit ? w("Apply","应用修改") :
            off ? w("Insert turn-off step","插入关闭步骤") : w("Insert enable step","插入启用步骤");
        const ruleDetails=off ? `<p class="case-inline-rule-note">${w("Turns off this rule group at this step.","执行到此步骤时关闭这组规则。")}</p>` :
            rules ? `<p class="case-inline-rule-note">${h(this.ruleCount(source.enabled))}</p>
            <p class="case-inline-rule-note">${s.group.legacy ? w("Enabled before the case runs.","在用例运行前启用。") :
                w("Enables the rule group at this step.","执行到此步骤时启用规则组。")}</p>` : "";
        const title=off ? w("Turn off rule group ","关闭规则组 ")+source.name : source.name;
        const html=`<h3>${h(title)}</h3>
            ${source.issue ? `<p class="case-composition-warning">${h(issueText(source.issue,w))}</p>` : ""}
            ${ruleDetails}
            ${steps.length ? `<details id="case-inline-step-preview" class="case-inline-summary"><summary>${w("Preview steps","预览步骤")}</summary>
                <div>${list(steps)}</div></details>` : ""}
            <div class="toolbar">
                ${actionButton(label,{primary:true,disabled,attrs:{"data-insert-choice":off ? "ruleOff" : rules ? "ruleGroup" : "reference"}})}</div>`;
        if (html!==s.previewHtml) {
            s.previewHtml=html;
            const open=s.source.querySelector("details")?.open;
            s.source.innerHTML=html;
            const details=s.source.querySelector("details");
            if (details && open) details.open=true;
        }
    }

    receive(message) {
        if (message.action==="undo" && message.session===this.undoSession) {
            this.undoSession=undefined;
            if (message.path) {
                this.result=message;
                this.focusResult();
            }
            return;
        }
        const s=this.session;
        if (!s || message.session!==s.session) return;
        if (message.action==="step") {
            s.pending=false;
            if (message.editor) {
                this.close(false);
                this.requestedEditor=message.editor;
                this.showRequestedEditor();
                return;
            }
        }
        if (message.action==="index") {
            for (const entry of message.entries || []) if (s.searchKind!=="reuse" || s.previewData?.id!==entry.id)
                s.indexed.set(entry.id,entry);
            if (message.indexed || message.error) {
                s.indexReady=true;
                s.indexing=false;
            }
            if (s.mode!=="search" || s.searchKind!=="reuse") return;
        }
        if (message.action==="preview" &&
            (message.request!==s.previewRequest || s.mode!=="preview" || s.searchKind!=="reuse")) return;
        const listKind=message.action==="ruleGroups" ? "ruleGroup" : message.action==="ruleClosures" ? "ruleOff" : undefined;
        if (listKind) {
            s.ruleLists.set(listKind,message.ruleGroups || {failed:true});
            if (s.mode!=="search" || s.searchKind!==listKind) return;
        } else if (message.ruleGroups) s.ruleLists.set(s.searchKind,message.ruleGroups);
        if (["apply","describe","applyRuleGroup"].includes(message.action)) {
            s.pending=false;
            if (message.path) {
                this.close(false);
                this.result=message;
                this.focusResult();
                return;
            }
        }
        if (message.source) {
            const source=message.source;
            const {name,app,issue}=source;
            s.indexed.set(source.id,{...s.indexed.get(source.id),name,app,issue});
            s.previewData=source;
            if (message.action==="apply") s.mode="preview";
        }
        if (message.error) {
            if (message.action==="preview") this.showSearch();
            this.status(message.error);
        } else if (message.action==="apply") this.status(message.changed ?
            this.words("The source changed. Review it before inserting.","来源刚更新，请核对新版本后再插入。") : "");
        else if (message.action==="applyRuleGroup" && message.changed) {
            this.showSearch();
            this.status(this.words("The rule group library changed. Select a group from the updated list.","规则组库已更新，请重新选择。"));
        }
        this.update();
        if ((s.mode==="preview" && message.source) ||
            (s.mode==="search" && listKind && message.ruleGroups))
            s.row.scrollIntoView({block:"nearest",inline:"nearest"});
    }

    showRequestedEditor() {
        const edit=this.requestedEditor;
        const review=this.model?.caseReview;
        if (!edit || this.model.busy || !review) return;
        this.requestedEditor=undefined;
        if (edit.id===review.id && edit.revision===review.revision) this.openEditor(edit);
    }

    focusResult() {
        const result=this.result;
        if (!result || (result.id && (this.model.caseReview?.id!==result.id ||
            this.model.caseReview.revision!==result.revision))) return;
        this.result=undefined;
        const row=this.row(result.path);
        if (!row) return;
        for (let branch=row.closest("details");branch;branch=branch.parentElement.closest("details")) branch.open=true;
        const focus=row.querySelector(':scope > .case-sort-content :is(summary,.case-step-name,[data-case-insert="editRuleGroup"])') || row;
        if (focus===row) focus.tabIndex=-1;
        row.scrollIntoView({block:"nearest",inline:"nearest"});
        focus.focus({preventScroll:true});
    }

    close(restore) {
        const s=this.session;
        if (!s) return;
        if (s.indexing) this.request("cancel");
        const list=s.row.closest(".case-bdd");
        s.row.remove();
        list?.classList.remove("case-inserting");
        this.session=undefined;
        if (restore) {
            const row=this.row(s.target.path);
            const trigger=s.trigger.isConnected && !s.trigger.closest("[hidden]") ? s.trigger : undefined;
            (trigger || row?.querySelector(':scope > [data-item-menu-trigger], :scope > .case-sort-content [data-case-insert="editRuleGroup"]'))?.focus({preventScroll:true});
        }
    }

    refocusDescription() {
        if (this.session?.mode!=="description") return false;
        this.status(this.words("Apply or cancel this description before saving the case.","请先添加或取消这条描述，再保存用例。"));
        this.session.description.focus();
        return true;
    }
}
