(() => {
    const archived = document.documentElement.hasAttribute("data-archived-report");
    const vscode = archived ? undefined : acquireVsCodeApi();
    const detail = document.getElementById("report-evidence");
    const directory = document.getElementById("step-directory");
    const lightbox = document.getElementById("report-lightbox");
    const slots = new Map(Array.from(document.querySelectorAll("[data-slot]"),
        slot => [Number(slot.dataset.slot),slot]));
    const records = Array.from(document.querySelectorAll("button[data-record]"));
    const bars = Array.from(document.querySelectorAll(".chart-bar[data-chart-step]"));
    for (const bar of bars) {
        bar.style.setProperty("--bar-height", (Number(bar.dataset.ratio) * 100) + "%");
    }
    const chart = document.querySelector(".duration-chart");
    const readout = chart?.querySelector(".chart-readout");
    const scale = chart?.querySelector(".chart-max");
    if (readout && scale) {
        let hovered;
        function updateReadout() {
            const bar = hovered || chart.querySelector(".chart-bar:focus-visible");
            readout.textContent = bar?.dataset.readout || "";
            readout.hidden = !readout.textContent;
            scale.hidden = !readout.hidden;
        }
        chart.addEventListener("pointerover", event => {
            hovered = event.pointerType === "touch" ? undefined : event.target.closest(".chart-bar");
            updateReadout();
        });
        chart.addEventListener("pointerleave", () => {
            hovered = undefined;
            updateReadout();
        });
        chart.addEventListener("focusin", event => {
            if (event.target.matches(".chart-bar:focus-visible")) hovered = undefined;
            updateReadout();
        });
        chart.addEventListener("focusout", () => queueMicrotask(updateReadout));
        chart.addEventListener("keydown", () => {
            hovered = undefined;
            queueMicrotask(updateReadout);
        });
    }
    let selected;
    let request = 0;

    function recordButton(index) {
        const selector = `button[data-record="${index}"]`;
        const previous = slots.get(index)?.previousElementSibling;
        if (previous?.matches(selector)) return previous;
        return previous?.querySelector(selector) || records.find(button => Number(button.dataset.record)===index);
    }

    function reflectSelection(index, expanded) {
        for (const button of records) {
            const current = Number(button.dataset.record)===index;
            if (current) button.setAttribute("aria-current","step");
            else button.removeAttribute("aria-current");
            button.setAttribute("aria-expanded",String(current && expanded));
        }
        for (const button of directory?.querySelectorAll("[data-jump-record]") || []) {
            const matches = Number(button.dataset.jumpRecord)===index || button.dataset.members?.split(" ").includes(String(index));
            if (matches) button.setAttribute("aria-current","step");
            else button.removeAttribute("aria-current");
        }
        const currentBar = bars.find(bar => Number(bar.dataset.chartStep)===index);
        for (const bar of bars) {
            bar.setAttribute("aria-pressed",String(bar === currentBar));
            bar.tabIndex = bar === (currentBar || bars[0]) ? 0 : -1;
        }
    }

    function select(index, {initial=false, toggleButton, jump=false}={}) {
        const slot = slots.get(index);
        if (!slot || !detail) return;
        const same = selected===index;
        const expand = !(same && toggleButton && !detail.hidden);
        const oldTop = toggleButton?.getBoundingClientRect().top;
        if (directory?.open) directory.close();
        if (lightbox?.open) lightbox.close();
        if (expand) {
            for (let group = slot.closest("details"); group; group = group.parentElement.closest("details")) group.open = true;
        }
        if (detail.parentElement!==slot) slot.append(detail);
        detail.hidden = !expand;
        reflectSelection(index,expand);
        if (jump) {
            const target = recordButton(index) || slot;
            target.focus({preventScroll:true});
            target.scrollIntoView({block:"start"});
        } else if (toggleButton && oldTop>=0 && oldTop<window.innerHeight) {
            // Moving the previous open record can shift the row under the pointer.
            const newTop = toggleButton.getBoundingClientRect().top;
            if (Math.abs(newTop-oldTop)>1) window.scrollBy(0,newTop-oldTop);
        }
        if (same) return;
        selected = index;
        detail.dataset.step = String(index);
        if (archived) {
            const template=document.getElementById("archived-record-"+index);
            detail.replaceChildren(template.content.cloneNode(true));
            prepareCrop(detail.querySelector(".report-image"));
            return;
        }
        detail.setAttribute("aria-busy","true");
        if (!initial) {
            const pending = document.createElement("p");
            pending.className = "report-label";
            pending.textContent = detail.dataset.loading;
            detail.replaceChildren(pending);
        }
        vscode.postMessage({type:"evidence",index,request:++request});
    }

    function prepareCrop(figure) {
        if (!figure?.dataset.crop) return;
        const image = figure.querySelector("img");
        const screen = figure.querySelector(".report-screen");
        const {screen:resolution,bounds,left,top,width,height} = JSON.parse(figure.dataset.crop);
        function apply() {
            if (image.naturalWidth!==resolution.width || image.naturalHeight!==resolution.height) return;
            const pct = (value,total) => (100*value/total)+"%";
            screen.style.setProperty("--crop-ratio",width+" / "+height);
            screen.style.setProperty("--image-x",pct(-left,width));
            screen.style.setProperty("--image-y",pct(-top,height));
            screen.style.setProperty("--image-width",pct(resolution.width,width));
            screen.style.setProperty("--highlight-x",pct(bounds.left-left,width));
            screen.style.setProperty("--highlight-y",pct(bounds.top-top,height));
            screen.style.setProperty("--highlight-w",pct(bounds.right-bounds.left,width));
            screen.style.setProperty("--highlight-h",pct(bounds.bottom-bounds.top,height));
            screen.dataset.mode = "crop";
            figure.querySelector(".crop-caption").hidden = false;
        }
        if (image.complete) apply();
        else image.addEventListener("load",apply,{once:true});
    }

    function setZoom(zoomed) {
        const stage = lightbox.querySelector("[data-photo-stage]");
        const toggle = lightbox.querySelector("[data-zoom]");
        stage.classList.toggle("zoomed",zoomed);
        toggle.setAttribute("aria-pressed",String(zoomed));
        toggle.textContent = zoomed ? toggle.dataset.zoomOut : toggle.dataset.zoomIn;
        if (!zoomed) stage.scrollTo(0,0);
    }

    function openImage(figure) {
        const image = figure.querySelector(".report-screen img");
        const full = lightbox.querySelector("[data-full-image]");
        full.src = image.src;
        full.alt = image.alt;
        lightbox.querySelector("[data-full-caption]").textContent =
            [image.alt, detail.querySelector(".evidence-heading h2")?.textContent || recordButton(selected)?.dataset.title].filter(Boolean).join(" · ");
        setZoom(false);
        figure.querySelector(".image-toggle").focus({preventScroll:true});
        lightbox.showModal();
    }

    function openDirectory() {
        directory.showModal();
        const current = directory.querySelector('[aria-current="step"]') || directory.querySelector("[data-jump-record]");
        current?.focus({preventScroll:true});
        current?.scrollIntoView({block:"nearest"});
    }

    function jumpToGroup(index) {
        const group=recordButton(index)?.closest(".record-group");
        if (!group) return select(index,{jump:true});
        group.open=true;
        const summary=group.querySelector("summary");
        summary.focus({preventScroll:true});
        summary.scrollIntoView({block:"start"});
    }

    const networkStats=document.getElementById("stats-network");
    networkStats?.addEventListener("click",event=>{
        const filter=event.target.closest("button[data-net-by]");
        if (!filter && !event.target.closest("[data-net-clear]")) return;
        const active=filter && filter.getAttribute("aria-pressed")!=="true" ? filter : null;
        for (const button of networkStats.querySelectorAll("[data-net-by]")) {
            button.setAttribute("aria-pressed",String(button===active));
        }
        let visible=0;
        for (const requestRow of networkStats.querySelectorAll("[data-net-source]")) {
            requestRow.hidden=Boolean(active) && requestRow.getAttribute("data-net-"+active.dataset.netBy)!==active.dataset.netValue;
            if (!requestRow.hidden) visible++;
        }
        networkStats.querySelector("[data-net-count]").textContent=String(visible);
        const clear=networkStats.querySelector("[data-net-clear]");
        if (!active && clear===document.activeElement) networkStats.querySelector("[data-net-by]")?.focus();
        clear.hidden=!active;
    });

    document.addEventListener("click",event=>{
        const target = event.target;
        const button = target.closest("button");
        if (button?.hasAttribute("data-dialog-close")) button.closest("dialog").close();
        else if (button?.hasAttribute("data-directory-open")) openDirectory();
        else if (button?.hasAttribute("data-record")) select(Number(button.dataset.record),{toggleButton:button});
        else if (button?.hasAttribute("data-jump-record")) select(Number(button.dataset.jumpRecord),{jump:true});
        else if (button?.hasAttribute("data-jump-group")) jumpToGroup(Number(button.dataset.jumpGroup));
        else if (button?.hasAttribute("data-chart-step")) select(Number(button.dataset.chartStep),{jump:true});
        else if (button?.hasAttribute("data-export-report")) vscode?.postMessage({type:"export"});
        else if (button?.hasAttribute("data-related")) vscode?.postMessage({type:"related",id:button.dataset.related});
        else if (button?.hasAttribute("data-zoom") || target.matches("[data-full-image]")) {
            setZoom(!lightbox.querySelector("[data-photo-stage]").classList.contains("zoomed"));
        } else if (target.closest(".image-toggle, .report-screen")) {
            openImage(target.closest(".report-image"));
        } else if (target.matches("dialog[open]")) {
            const bounds = target.getBoundingClientRect();
            if (event.clientX < bounds.left || event.clientX >= bounds.right ||
                event.clientY < bounds.top || event.clientY >= bounds.bottom) target.close();
        }
    });
    document.addEventListener("keydown",event=>{
        const bar = event.target.closest(".chart-bar");
        if (!bar) return;
        const ordinal = bars.indexOf(bar);
        const nav = {ArrowLeft:Math.max(0,ordinal-1),ArrowRight:Math.min(bars.length-1,ordinal+1),Home:0,End:bars.length-1};
        if (!Object.hasOwn(nav,event.key)) return;
        event.preventDefault();
        const destination = bars[nav[event.key]];
        destination.focus({preventScroll:true});
        select(Number(destination.dataset.chartStep));
    });
    lightbox?.addEventListener("close",()=>{
        if (!lightbox.open) lightbox.querySelector("[data-full-image]").removeAttribute("src");
    });
    detail?.addEventListener("toggle",event=>{
        const frame = event.target;
        if (frame.open && frame.dataset.frame && !frame.dataset.requested) {
            frame.dataset.requested = "true";
            if (archived) {
                const record=document.getElementById("archived-record-"+selected);
                const tree=document.getElementById("archived-tree-"+record.dataset[frame.dataset.frame]);
                frame.querySelector("[data-tree]").replaceChildren(tree.content.cloneNode(true));
            } else vscode.postMessage({type:"tree",index:selected,request,phase:frame.dataset.frame});
        }
    },true);
    if (!archived) window.addEventListener("message",event=>{
        const message = event.data;
        if (message?.type==="focus") select(message.index,{jump:true});
        if (!detail || !message || message.index!==selected || message.request!==request || typeof message.html!=="string") return;
        if (message.type==="evidence") {
            detail.innerHTML = message.html;
            prepareCrop(detail.querySelector(".report-image"));
            detail.removeAttribute("aria-busy");
        } else if (message.type==="tree" && ["before","after"].includes(message.phase)) {
            const tree = detail.querySelector(`[data-frame="${message.phase}"] [data-tree]`);
            if (tree) tree.innerHTML = message.html;
        }
    });
    if (detail && detail.dataset.step!=="") select(Number(detail.dataset.step),{initial:true});
})();
