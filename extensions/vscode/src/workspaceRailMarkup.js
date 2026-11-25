"use strict";

function workspaceRailMarkup(icon) {
    return `<section id="live-task-pane" hidden>
            <details id="ai-assistant" hidden><summary>${icon("chat")}<strong id="task-heading"></strong><span id="assistant-status"></span></summary>
                <form id="task-form"><label id="goal-label" for="task-goal"></label>
                    <div class="task-compose"><textarea id="task-goal" rows="2"></textarea>
                        <div class="task-actions"><button type="button" id="task-read" class="rail-link">${icon("read")}<span></span></button>
                            <button type="submit" id="task-run" class="rail-button"><span></span>${icon("arrow")}</button>
                            <button type="button" id="task-stop" class="rail-button" hidden>${icon("stop")}<span></span></button></div>
                    </div>
                </form>
                <section id="task-output" aria-labelledby="result-title" hidden>
                    <header><h3 id="result-title"></h3><span id="task-status" role="status"></span></header>
                    <p id="result-goal"></p><ol id="task-steps"></ol>
                    <details id="task-evidence" hidden><summary></summary><div></div><section></section></details><p id="task-save-scope" hidden></p>
                    <p id="task-answer"></p><button class="rail-button" id="task-provider-settings" type="button" hidden></button>
                    <button class="rail-button" id="task-save" type="button" hidden><span></span>${icon("arrow")}</button>
                </section>
            </details>
    </section>`;
}

module.exports = { workspaceRailMarkup };
