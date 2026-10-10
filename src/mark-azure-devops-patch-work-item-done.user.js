// ==UserScript==
// @name         Mark Azure DevOps Patch work item Done
// @namespace    https://github.com/glenncarr/userscripts
// @version      1.3.1
// @downloadURL  https://raw.githubusercontent.com/glenncarr/userscripts/main/src/mark-azure-devops-patch-work-item-done.user.js
// @description  Adds a button to top-level Patch rows in query results that sets the Patch and its Related Dev Complete Bugs / Product Backlog Items to Done without saving, so "Save Items" saves them all.
// @match        http://tfs/*/_queries/*
// @match        http://tfs01/*/_queries/*
// @match        https://tfs/*/_queries/*
// @match        https://tfs01/*/_queries/*
// @run-at       document-idle
// @grant        none
// @inject-into  page
// @noframes
// ==/UserScript==
// Installation: import this file into Greasemonkey or Tampermonkey. Duplicate
// the @match lines if the server is accessed through another hostname.
//
// Features
// --------
// A small check-mark button is placed to the left of the row context menu
// ("...") on hovered top-level (aria-level 1) Patch rows in query results. If
// the "Copy Azure DevOps work item link" script's copy button is visible, the
// check-mark button is placed to the left of it.
//
// The button is only enabled when:
// - the Patch state is "QA Complete" or "Posted / QA Complete" (see
//   PATCH_REQUIRED_STATES), so it is disabled for a Patch that is already
//   Done, and
// - every Related Bug or Product Backlog Item (see RELATED_WORK_ITEM_TYPES) is
//   "Dev Complete" (see RELATED_REQUIRED_STATE) or already Done.
// Otherwise it is shown in the theme's warning color (amber) instead of the
// success color (green), its tooltip explains why (listing any blocking
// related work items), and clicking it does nothing. The check uses the work
// items as currently shown in the grid, including unsaved edits, and loads
// them in the background the first time a Patch is hovered.
//
// Click: sets System.State to "Done" on the Patch and on every Related Bug or
// Product Backlog Item that is not already Done (predecessor, successor,
// parent, child and other link types are ignored). Nothing is saved; the
// rows become dirty in the grid so a single "Save Items" click saves them all.
//
// Work items that are not in the query results are skipped, because the grid's
// "Save Items" only saves dirty work items present in the results. Work items
// whose state cannot transition to Done are also skipped. Skipped items are
// listed in the tooltip shown after the click.
//
// Maintenance notes
// -----------------
// - Uses the page's own AMD modules (requires @inject-into page). The query
//   result grid instance is read from the grid element's jQuery
//   "tfsEnhancements" data; its store's WorkItemManager is the same one the grid
//   uses to track dirty work items and to save them.
// - Verified against Azure DevOps Server 2022 (Dev17.M153).

(function () {
    'use strict';

    const ROW_SELECTOR = '.grid-row[role="row"]';
    const GRID_SELECTOR = '.query-result-grid';
    const TITLE_LINK_SELECTOR = 'a.work-item-title-link';
    const CONTEXT_MENU_SELECTORS = [
        '.grid-context-menu',
        '.work-item-context-menu',
        '.menu-item.bowtie-ellipsis',
        '.bowtie-ellipsis',
        '[aria-label="More actions"]',
        '[aria-label="More commands"]',
    ].join(',');
    const COPY_BUTTON_SELECTOR =
        '.copy-azure-devops-work-item-link-button.is-visible';
    const BUTTON_CLASS = 'mark-azure-devops-patch-work-item-done-button';
    const STYLE_ID = 'mark-azure-devops-patch-work-item-done-style';
    const BUTTON_SIZE = 20;
    const BUTTON_GAP = 2;
    const POLL_INTERVAL = 100;
    const PATCH_WORK_ITEM_TYPE = 'patch';
    const WORK_ITEM_TYPE_CELL_INDEX = 3;
    const DONE_STATE = 'Done';
    const STATE_FIELD = 'System.State';
    const TITLE_FIELD = 'System.Title';
    const WORK_ITEM_TYPE_FIELD = 'System.WorkItemType';
    const RELATED_LINK_TYPE = 'System.LinkTypes.Related';
    const RELATED_WORK_ITEM_TYPES = new Set(['bug', 'product backlog item']);
    const RELATED_REQUIRED_STATE = 'Dev Complete';
    const PATCH_REQUIRED_STATES = ['QA Complete', 'Posted / QA Complete'];
    const BUTTON_LABEL = 'Set Patch and related work items to Done (not saved)';
    const LOG_PREFIX = '[mark-azure-devops-patch-work-item-done]';
    const STYLE_TEXT = `
.${BUTTON_CLASS} {
    position: absolute;
    z-index: 10;
    display: none;
    align-items: center;
    justify-content: center;
    width: ${BUTTON_SIZE}px;
    height: ${BUTTON_SIZE}px;
    padding: 0;
    border: none;
    border-radius: 50%;
    background: transparent;
    color: var(--status-success-foreground, #107c10);
    font-size: 14px;
    line-height: 1;
    cursor: pointer;
}

.${BUTTON_CLASS} .bowtie-icon {
    font-size: 14px;
    font-weight: bold;
}

.${BUTTON_CLASS}.is-visible {
    display: inline-flex;
}

.${BUTTON_CLASS}:hover {
    background: rgba(128, 128, 128, 0.35);
}

.${BUTTON_CLASS}.is-busy {
    cursor: progress;
    opacity: 0.5;
}

.${BUTTON_CLASS}.is-disabled {
    color: var(--status-warning-foreground, #d67f3c);
    cursor: not-allowed;
}

.${BUTTON_CLASS}.is-disabled:hover {
    background: transparent;
}

.${BUTTON_CLASS}.is-done {
    color: var(--status-success-foreground, #107c10);
}

.${BUTTON_CLASS}.is-error {
    color: var(--status-error-foreground, #a4262c);
}

.${BUTTON_CLASS}-tooltip {
    position: fixed;
    z-index: 10000;
    display: none;
    width: max-content;
    max-width: 280px;
    padding: 6px 8px;
    border: 1px solid #c8c8c8;
    background: #f5f5f5;
    color: #1e1e1e;
    font-family: "Segoe UI", sans-serif;
    font-size: 12px;
    line-height: 16px;
    white-space: pre-line;
    pointer-events: none;
}

.${BUTTON_CLASS}-tooltip.is-visible {
    display: block;
}

.${BUTTON_CLASS}-tooltip.is-summary {
    max-width: none;
    white-space: pre;
}
`;

    function ensureStyles() {
        if (!document.head || document.getElementById(STYLE_ID)) {
            return;
        }

        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = STYLE_TEXT;
        document.head.appendChild(style);
    }

    function getTitleLink(row) {
        return row.querySelector(TITLE_LINK_SELECTOR);
    }

    function getRowWorkItemId(row) {
        const href = getTitleLink(row)?.getAttribute('href') || '';
        const match = href.match(/\/edit\/(\d+)/);
        return match ? Number(match[1]) : null;
    }

    function getRowLevel(row) {
        const level = Number.parseInt(row.getAttribute('aria-level') || '', 10);
        return Number.isNaN(level) ? 1 : level;
    }

    function normalizeType(workItemType) {
        return String(workItemType ?? '')
            .replace(/\s+/g, ' ')
            .trim()
            .toLowerCase();
    }

    function isPatchType(workItemType) {
        return normalizeType(workItemType) === PATCH_WORK_ITEM_TYPE;
    }

    function getRowWorkItemType(row) {
        const iconType = row
            .querySelector('.work-item-type-icon[aria-label]')
            ?.getAttribute('aria-label');
        if (iconType) {
            return iconType;
        }

        const cell = row.querySelectorAll('[role="gridcell"]')[
            WORK_ITEM_TYPE_CELL_INDEX
        ];
        return cell ? cell.textContent || '' : '';
    }

    function isTopLevelPatchRow(row) {
        return (
            getRowLevel(row) === 1 &&
            getRowWorkItemId(row) !== null &&
            isPatchType(getRowWorkItemType(row))
        );
    }

    function getQueryResultGrid(row) {
        const element = row.closest(GRID_SELECTOR);
        const jQuery = window.jQuery;
        if (!element || typeof jQuery !== 'function') {
            return null;
        }

        const enhancements = jQuery(element).data('tfsEnhancements');
        const candidates = Array.isArray(enhancements)
            ? enhancements
            : Object.values(enhancements || {});
        return (
            candidates.find(
                (candidate) =>
                    candidate &&
                    typeof candidate.getUnfilteredWorkItemIds === 'function',
            ) || null
        );
    }

    function getWorkItemManager(grid) {
        const amdRequire = window.require;
        if (typeof amdRequire !== 'function') {
            throw new Error('Azure DevOps module loader not found.');
        }

        const { WorkItemManager } = amdRequire(
            'WorkItemTracking/Scripts/OM/WorkItemManager',
        );
        let store = grid?._store;
        if (!store) {
            const { WorkItemStore } = amdRequire(
                'WorkItemTracking/Scripts/TFS.WorkItemTracking',
            );
            const { TfsContext } = amdRequire(
                'Presentation/Scripts/TFS/TFS.Host.TfsContext',
            );
            const { ProjectCollection } = amdRequire(
                'Presentation/Scripts/TFS/TFS.OM.Common',
            );
            store = ProjectCollection.getConnection(
                TfsContext.getDefault(),
            ).getService(WorkItemStore);
        }

        return WorkItemManager.get(store);
    }

    function getWorkItems(manager, ids) {
        if (ids.length === 0) {
            return Promise.resolve([]);
        }

        return new Promise((resolve, reject) => {
            manager.beginGetWorkItems(ids, resolve, reject);
        });
    }

    function getRelatedWorkItemIds(workItem) {
        const ids = [];
        workItem.getLinks().forEach((link) => {
            if (
                typeof link.getTargetId !== 'function' ||
                link.isRemoved?.()
            ) {
                return;
            }

            const linkTypeEnd = link.getLinkTypeEnd?.();
            const referenceName = String(
                linkTypeEnd?.linkType?.referenceName ||
                    linkTypeEnd?.immutableName ||
                    '',
            );
            if (
                referenceName !== RELATED_LINK_TYPE &&
                !referenceName.startsWith(`${RELATED_LINK_TYPE}-`)
            ) {
                return;
            }

            const id = Number(link.getTargetId());
            if (id > 0 && id !== workItem.id && !ids.includes(id)) {
                ids.push(id);
            }
        });

        return ids;
    }

    function describe(workItem) {
        const type = String(workItem.getFieldValue(WORK_ITEM_TYPE_FIELD) || '');
        const label = isPatchType(type)
            ? `Patch ${workItem.id}`
            : String(workItem.id);
        return `${label}: ${workItem.getFieldValue(TITLE_FIELD) || ''}`;
    }

    function canTransitionToDone(workItem) {
        const allowed = workItem.getField(STATE_FIELD)?.getAllowedValues?.();
        return (
            !Array.isArray(allowed) ||
            allowed.length === 0 ||
            allowed.includes(DONE_STATE)
        );
    }

    function getState(workItem) {
        return String(workItem.getFieldValue(STATE_FIELD) || '');
    }

    function isQualifiedRelatedWorkItem(workItem) {
        return RELATED_WORK_ITEM_TYPES.has(
            normalizeType(workItem.getFieldValue(WORK_ITEM_TYPE_FIELD)),
        );
    }

    // Returns a warning explaining why the Patch cannot be set to Done, or null.
    function getPatchWarning(patch, related) {
        const patchState = getState(patch);
        if (patchState === DONE_STATE) {
            return '\u26A0 Patch is already Done.';
        }

        if (!PATCH_REQUIRED_STATES.includes(patchState)) {
            return `\u26A0 Patch state is "${patchState}". It must be ${PATCH_REQUIRED_STATES.map(
                (requiredState) => `"${requiredState}"`,
            ).join(' or ')} before it can be set to Done.`;
        }

        const blockers = related.filter(
            (workItem) =>
                isQualifiedRelatedWorkItem(workItem) &&
                getState(workItem) !== RELATED_REQUIRED_STATE &&
                getState(workItem) !== DONE_STATE,
        );
        if (blockers.length > 0) {
            return [
                `\u26A0 Related Bugs and Product Backlog Items must be "${RELATED_REQUIRED_STATE}" before the Patch can be set to Done:`,
                ...blockers.map(
                    (workItem) =>
                        `${describe(workItem)} (${getState(workItem)})`,
                ),
            ].join('\n');
        }

        return null;
    }

    const LOAD_RETRY_DELAY = 30000;
    const pendingLoads = new Set();
    const loadFailures = new Map();

    function hasRecentLoadFailure(id) {
        const failedAt = loadFailures.get(id);
        if (failedAt === undefined) {
            return false;
        }

        if (Date.now() - failedAt > LOAD_RETRY_DELAY) {
            loadFailures.delete(id);
            return false;
        }

        return true;
    }

    function requestWorkItems(manager, ids) {
        const missing = ids.filter(
            (id) => !manager.getWorkItem(id) && !pendingLoads.has(id),
        );
        if (missing.length === 0) {
            return;
        }

        missing.forEach((id) => pendingLoads.add(id));
        manager.beginGetWorkItems(
            missing,
            () => missing.forEach((id) => pendingLoads.delete(id)),
            (error) => {
                console.error(
                    `${LOG_PREFIX} Failed to load work items ${missing.join(
                        ', ',
                    )}.`,
                    error,
                );
                missing.forEach((id) => {
                    pendingLoads.delete(id);
                    loadFailures.set(id, Date.now());
                });
            },
        );
    }

    // Evaluates the Patch from work items cached by the WorkItemManager (the
    // same objects the grid shows, including unsaved edits), loading missing
    // ones in the background. Returns undefined while work items are loading.
    function getRowPatchWarning(row) {
        let manager;
        try {
            manager = getWorkItemManager(getQueryResultGrid(row));
        } catch (error) {
            return `\u26A0 ${error?.message || error}`;
        }

        const patchId = getRowWorkItemId(row);
        const patch = manager.getWorkItem(patchId);
        if (!patch) {
            if (hasRecentLoadFailure(patchId)) {
                return `\u26A0 Could not load Patch ${patchId}.`;
            }

            requestWorkItems(manager, [patchId]);
            return undefined;
        }

        const relatedIds = getRelatedWorkItemIds(patch);
        const failedIds = relatedIds.filter(hasRecentLoadFailure);
        if (failedIds.length > 0) {
            return `\u26A0 Could not load related work items: ${failedIds.join(
                ', ',
            )}.`;
        }

        const related = relatedIds.map((id) => manager.getWorkItem(id));
        if (related.some((workItem) => !workItem)) {
            requestWorkItems(manager, relatedIds);
            return undefined;
        }

        return getPatchWarning(patch, related);
    }

    async function markPatchDone(row) {
        const patchId = getRowWorkItemId(row);
        if (patchId === null) {
            return null;
        }

        const grid = getQueryResultGrid(row);
        const manager = getWorkItemManager(grid);
        const resultIds = grid
            ? new Set(grid.getUnfilteredWorkItemIds().map(Number))
            : null;

        const [patch] = await getWorkItems(manager, [patchId]);
        const related = (
            await getWorkItems(manager, getRelatedWorkItemIds(patch))
        ).filter(Boolean);

        // Re-check in case anything changed since the button was enabled.
        const warning = getPatchWarning(patch, related);
        if (warning) {
            throw new Error(warning);
        }

        const summary = {
            changed: [],
            alreadyDone: [],
            ignoredType: [],
            notInResults: [],
            notAllowed: [],
            invalid: [],
        };

        [patch, ...related].forEach((workItem) => {
            if (workItem !== patch) {
                if (!isQualifiedRelatedWorkItem(workItem)) {
                    summary.ignoredType.push(workItem);
                    return;
                }

                if (getState(workItem) === DONE_STATE) {
                    summary.alreadyDone.push(workItem);
                    return;
                }
            }

            if (resultIds && !resultIds.has(workItem.id)) {
                summary.notInResults.push(workItem);
                return;
            }

            if (!canTransitionToDone(workItem)) {
                summary.notAllowed.push(workItem);
                return;
            }

            workItem.setFieldValue(STATE_FIELD, DONE_STATE);
            summary.changed.push(workItem);
            if (!workItem.isValid()) {
                summary.invalid.push(workItem);
            }
        });

        return summary;
    }

    function buildSummaryText(summary) {
        const sections = [];
        const addSection = (heading, workItems) => {
            if (workItems.length > 0) {
                sections.push(
                    [heading, ...workItems.map(describe)].join('\n'),
                );
            }
        };

        addSection(
            'Set to Done (click "Save Items" to save):',
            summary.changed,
        );
        if (summary.changed.length === 0) {
            sections.push('Nothing to change.');
        }
        addSection('Already Done:', summary.alreadyDone);
        addSection(
            'Skipped (not a Bug or Product Backlog Item):',
            summary.ignoredType,
        );
        addSection(
            'Skipped (not in query results, so "Save Items" would not save them):',
            summary.notInResults,
        );
        addSection('Skipped (Done is not an allowed state):', summary.notAllowed);
        addSection('Invalid after change (check before saving):', summary.invalid);

        return sections.join('\n\n');
    }

    let tooltip = null;
    let tooltipMouseMoveListener = null;

    function getTooltip() {
        if (tooltip) {
            return tooltip;
        }

        tooltip = document.createElement('div');
        tooltip.className = `${BUTTON_CLASS}-tooltip`;
        tooltip.setAttribute('role', 'tooltip');
        document.body.appendChild(tooltip);
        return tooltip;
    }

    function hideTooltip() {
        if (tooltipMouseMoveListener) {
            document.removeEventListener('mousemove', tooltipMouseMoveListener);
            tooltipMouseMoveListener = null;
        }

        if (tooltip) {
            tooltip.classList.remove('is-visible');
        }
    }

    function showTooltip(anchor, text, isSummary = false) {
        hideTooltip();
        const element = getTooltip();
        const rect = anchor.getBoundingClientRect();
        element.textContent = text;
        element.classList.toggle('is-summary', isSummary);
        element.classList.add('is-visible');
        element.style.left = `${Math.max(
            4,
            Math.min(rect.left, window.innerWidth - element.offsetWidth - 4),
        )}px`;
        element.style.top = `${Math.min(
            rect.bottom + 4,
            window.innerHeight - element.offsetHeight - 4,
        )}px`;

        if (isSummary) {
            tooltipMouseMoveListener = hideTooltip;
            document.addEventListener('mousemove', tooltipMouseMoveListener, {
                once: true,
            });
        }
    }

    function flashResult(button, className) {
        button.classList.add(className);
        window.setTimeout(() => button.classList.remove(className), 1500);
    }

    let button = null;
    let currentRow = null;
    let currentWarning = null;
    let hoveredRow = null;
    let busy = false;

    function getButtonTooltipText() {
        return currentWarning || BUTTON_LABEL;
    }

    function showButtonTooltip() {
        showTooltip(getButton(), getButtonTooltipText());
    }

    async function onButtonClick() {
        const row = currentRow;
        if (!row || busy || currentWarning) {
            return;
        }

        busy = true;
        const clickedButton = getButton();
        clickedButton.classList.add('is-busy');
        try {
            const summary = await markPatchDone(row);
            if (!summary) {
                return;
            }

            flashResult(
                clickedButton,
                summary.invalid.length > 0 ? 'is-error' : 'is-done',
            );
            showTooltip(clickedButton, buildSummaryText(summary), true);
        } catch (error) {
            console.error(`${LOG_PREFIX} Failed to set work items to Done.`, error);
            flashResult(clickedButton, 'is-error');
            showTooltip(
                clickedButton,
                `Failed to set work items to Done:\n${
                    error?.message || error
                }`,
                true,
            );
        } finally {
            busy = false;
            clickedButton.classList.remove('is-busy');
        }
    }

    function getButton() {
        if (button) {
            return button;
        }

        button = document.createElement('button');
        button.type = 'button';
        button.className = BUTTON_CLASS;
        button.setAttribute('aria-label', BUTTON_LABEL);
        const icon = document.createElement('span');
        icon.className = 'bowtie-icon bowtie-check';
        icon.setAttribute('aria-hidden', 'true');
        button.appendChild(icon);
        button.addEventListener('mousedown', (event) => {
            event.preventDefault();
            event.stopPropagation();
        });
        button.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            onButtonClick();
        });
        button.addEventListener('mouseenter', showButtonTooltip);
        button.addEventListener('mouseleave', () => {
            if (!tooltipMouseMoveListener) {
                hideTooltip();
            }
        });
        button.addEventListener('focus', showButtonTooltip);
        button.addEventListener('blur', hideTooltip);

        return button;
    }

    function findVisibleContextMenu(scope = document) {
        for (const menu of scope.querySelectorAll(CONTEXT_MENU_SELECTORS)) {
            if (!menu.closest(ROW_SELECTOR) || menu.offsetParent === null) {
                continue;
            }

            const rect = menu.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
                return { menu, rect };
            }
        }

        return null;
    }

    function findAnchor() {
        if (hoveredRow && hoveredRow.isConnected) {
            const hoveredMenu = findVisibleContextMenu(hoveredRow);
            if (hoveredMenu) {
                return hoveredMenu;
            }

            // The "..." is only rendered for the selected row, so mirror its
            // horizontal position onto the hovered row.
            const selectedMenu = findVisibleContextMenu();
            if (selectedMenu) {
                const rowRect = hoveredRow.getBoundingClientRect();
                return {
                    menu: selectedMenu.menu,
                    rect: new DOMRect(
                        selectedMenu.rect.left,
                        rowRect.top +
                            rowRect.height / 2 -
                            selectedMenu.rect.height / 2,
                        selectedMenu.rect.width,
                        selectedMenu.rect.height,
                    ),
                    row: hoveredRow,
                };
            }

            return null;
        }

        return findVisibleContextMenu();
    }

    function updateButton() {
        const doneButton = getButton();
        if (busy) {
            return;
        }

        const anchor = findAnchor();
        const row =
            anchor?.row || anchor?.menu.closest(ROW_SELECTOR) || null;

        if (!anchor || !row || !isTopLevelPatchRow(row)) {
            currentRow = null;
            currentWarning = null;
            doneButton.classList.remove('is-visible');
            return;
        }

        currentRow = row;
        const rowWarning = getRowPatchWarning(row);
        const warning =
            rowWarning === undefined
                ? 'Checking Patch and related work items\u2026'
                : rowWarning;
        const warningChanged = warning !== currentWarning;
        currentWarning = warning;
        doneButton.classList.toggle('is-disabled', Boolean(warning));
        doneButton.setAttribute('aria-disabled', String(Boolean(warning)));
        doneButton.setAttribute('aria-label', getButtonTooltipText());
        if (
            warningChanged &&
            doneButton.matches(':hover') &&
            !tooltipMouseMoveListener
        ) {
            showButtonTooltip();
        }

        // Living inside the row keeps the grid's own :hover styling working.
        if (doneButton.parentElement !== row) {
            if (window.getComputedStyle(row).position === 'static') {
                row.style.position = 'relative';
            }
            row.appendChild(doneButton);
        }

        const rowRect = row.getBoundingClientRect();
        const copyButton = row.querySelector(COPY_BUTTON_SELECTOR);
        const rightEdge = copyButton
            ? copyButton.getBoundingClientRect().left
            : anchor.rect.left;
        doneButton.style.left = `${
            rightEdge - rowRect.left - BUTTON_SIZE - BUTTON_GAP
        }px`;
        doneButton.style.top = `${
            anchor.rect.top -
            rowRect.top +
            anchor.rect.height / 2 -
            BUTTON_SIZE / 2
        }px`;
        doneButton.classList.add('is-visible');
    }

    ensureStyles();
    updateButton();
    window.setInterval(updateButton, POLL_INTERVAL);
    window.addEventListener('scroll', updateButton, true);
    window.addEventListener('resize', updateButton);
    document.addEventListener(
        'mouseover',
        (event) => {
            const target = event.target;
            if (!(target instanceof Element)) {
                return;
            }

            hoveredRow = target.closest(ROW_SELECTOR);
            updateButton();
        },
        true,
    );
    document.addEventListener('mouseleave', (event) => {
        if (event.target === document || event.target === document.body) {
            hoveredRow = null;
            updateButton();
        }
    });
})();
