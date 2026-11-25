(() => {
    const exported=document.body.hasAttribute("data-exported");
    const vscode=exported ? undefined : acquireVsCodeApi();
    const el=id=>document.getElementById(id);
    const zh=document.documentElement.lang.toLowerCase().startsWith("zh");
    const content=el("overview-content"),range=el("range"),dialog=el("scope-dialog"),options=el("pick-options");
    let applied,selected=[],filter,previous="",choices="",ticket;
    const checks=()=>[...options.querySelectorAll("input")];
    function showFilter(ids,caption,jump) {
        const allowed=ids && new Set(ids);
        const records=content.querySelectorAll("[data-record-id]");
        let count=0;
        for (const row of records) {
            row.hidden=Boolean(allowed && !allowed.has(row.dataset.recordId));
            if (!row.hidden) count++;
        }
        if (!el("list-heading")) return;
        el("record-count").textContent=count;
        el("drill-caption").textContent=caption||"";
        el("drill-caption").hidden=!allowed;
        el("clear-drill").hidden=!allowed;
        if (jump) {
            el("list-heading").focus({preventScroll:true});
            el("list-heading").scrollIntoView({block:"start"});
        }
    }
    content.addEventListener("click",event=>{
        const button=event.target.closest("button");
        if (!button) return;
        if (button.dataset.openRun) vscode?.postMessage({type:"report",id:button.dataset.openRun});
        else if (button.id==="clear-drill") {
            filter=undefined;showFilter(undefined,"",true);
        } else if (button.hasAttribute("data-ids")) {
            filter={ids:JSON.parse(button.dataset.ids),caption:button.dataset.caption};
            showFilter(filter.ids,filter.caption,true);
        }
    });
    if (exported) return;
    range.disabled=true;
    const exportButton=el("export-overview");
    exportButton.addEventListener("click",()=>vscode.postMessage({type:"export",ticket}));
    function updateCount() {
        const count=checks().filter(box=>box.checked).length;
        el("pick-count").textContent=zh ? "已选 "+count+" 条" : count+" selected";
        el("pick-apply").disabled=count===0;
    }
    function openPicker() {
        options.innerHTML=choices;
        const chosen=new Set(selected);
        for (const box of checks()) box.checked=chosen.has(box.value);
        updateCount();
        dialog.showModal();
    }
    function scope(type,ids) {
        applied=type;
        filter=undefined;
        exportButton.disabled=true;
        content.setAttribute("aria-busy","true");
        vscode.postMessage({type:"scope",scope:type,ids});
    }
    range.addEventListener("change",()=>{
        if (range.value==="custom") {range.value=applied;openPicker();}
        else scope(range.value);
    });
    el("edit-selection").addEventListener("click",openPicker);
    el("pick-cancel").addEventListener("click",()=>dialog.close());
    for (const [id,on] of [["pick-all",true],["pick-none",false]]) el(id).addEventListener("click",()=>{
        for (const box of checks()) box.checked=on;
        updateCount();
    });
    options.addEventListener("change",updateCount);
    el("pick-apply").addEventListener("click",()=>{
        const ids=checks().filter(box=>box.checked).map(box=>box.value);
        dialog.close();scope("custom",ids);
    });
    window.addEventListener("message",({data})=>{
        if (data?.type!=="overview" || (applied && data.scope!==applied)) return;
        applied=data.scope;
        ticket=data.ticket;
        exportButton.disabled=false;
        choices=data.choices;
        selected=data.selected;
        range.value=applied;
        range.disabled=false;
        el("edit-selection").hidden=applied!=="custom";
        if (previous!==data.content) {
            content.innerHTML=data.content;
            previous=data.content;
        }
        showFilter(filter?.ids,filter?.caption,false);
        content.removeAttribute("aria-busy");
    });
    vscode.postMessage({type:"ready"});
})();
