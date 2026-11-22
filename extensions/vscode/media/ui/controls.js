const entities = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const escape = value => String(value ?? "").replace(/[&<>"']/g, character => entities[character]);
export { escape as escapeHtml };

// The view supplies its own dispatch attributes. Model values and translated
// labels enter as plain text and are escaped exactly once by the component.
export function actionButton(label, { attrs = {}, primary = false, disabled = false, quiet = false, className = "" } = {}) {
    const variant = primary ? "primary" : "secondary";
    const classes = ["button", quiet ? "" : "vscode-button " + variant, className].filter(Boolean).join(" ");
    const attributes = Object.entries(attrs)
        .filter(([name, value]) => value != null && /^(?:id|title|tabindex|(?:data|aria)-[a-z][a-z0-9-]*)$/.test(name))
        .map(([name, value]) => ` ${name}="${escape(value)}"`).join("");
    return `<button type="button" class="${escape(classes)}"${attributes}${disabled ? " disabled" : ""}>${escape(label)}</button>`;
}
