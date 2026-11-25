// Read the rendered default before restoring a user's choice. The browser reflects
// interactive toggles in the open attribute, so the old DOM alone cannot tell us
// whether the model requested a new default.
export function restoreDisclosures(root, previous, context, libraryContext) {
    const rendered = new Map();
    for (const element of root.querySelectorAll("details[id]")) {
        const scope = element.id === "case-all-runs" ? libraryContext : context;
        const owner = element.closest("[data-disclosure-owner],[data-case-step],[data-rule-id],[data-record-id],[data-finding-id],[data-flow-id]")?.dataset;
        const ownerId = owner?.disclosureOwner ?? owner?.caseStep ?? owner?.ruleId ?? owner?.recordId ?? owner?.findingId ?? owner?.flowId;
        const defaultOpen = element.open;
        const prior = previous.get(element.id);
        if (prior && prior.scope === scope && prior.ownerId === ownerId && prior.defaultOpen === defaultOpen && prior.element.open !== defaultOpen)
            element.open = prior.element.open;
        rendered.set(element.id, {element, scope, ownerId, defaultOpen});
    }
    return rendered;
}
