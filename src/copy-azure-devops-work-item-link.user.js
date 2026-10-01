// ==UserScript==
// @name         Copy Azure DevOps work item link
// @namespace    https://github.com/glenncarr/userscripts
// @version      1.7.4
// @downloadURL  https://raw.githubusercontent.com/glenncarr/userscripts/main/src/copy-azure-devops-work-item-link.user.js
// @description  Adds a copy button beside the row context menu ("...") that copies the item and its related items as an HTML table; Ctrl+click copies "<id>: <title>" with the id hyperlinked; also strips work item type prefixes (Product Backlog Item, Carrier Data Release, Request, Bug) from copied work item titles.
// @match        http://tfs/*/_queries/*
// @match        http://tfs01/*/_queries/*
// @match        https://tfs/*/_queries/*
// @match        https://tfs01/*/_queries/*
// @match        http://tfs/*/_workitems/*
// @match        http://tfs01/*/_workitems/*
// @match        https://tfs/*/_workitems/*
// @match        https://tfs01/*/_workitems/*
// @run-at       document-idle
// @grant        none
// @noframes
// ==/UserScript==
// Installation: import this file into Greasemonkey or Tampermonkey. Duplicate
// the @match lines if the server is accessed through another hostname.
//
// Features
// --------
// 1. Copy button in query results
//    A small copy button is placed immediately to the left of the row context
//    menu ("..."). It follows the hovered row and lives inside that row so the
//    grid's own hover highlight keeps working, and it is absolutely positioned
//    so the grid layout is untouched.
//
//    - Click: copies the row plus every work item joined to it by a
//      "Related" link as an HTML table, one row per work item:
//        <tr><td><a href="...">16785</a>: </td><td>Title<br/></td></tr>
//      Predecessor, successor and child links are deliberately excluded.
//      Related items are ordered by Work Item Type, Commitment, Priority,
//      State (descending), Title, and ID (descending).
//    - Ctrl+click: copies the row as "<id>: <title>" (text/plain) and as
//      "<a href="...">id</a>: title" (text/html). Patch work items are copied
//      as "Patch <id>" so the link text reads "Patch 16828".
//
//    Related items are read from the work item REST API
//    ({collection}/{project}/_apis/wit/workitems/{id}?$expand=relations) because
//    the query grid only renders children once a row is expanded. If that call
//    fails, the script falls back to expanding the row in the grid, reading the
//    rendered descendants, and collapsing it back again.
//
// 2. "Copy work item title" (Shift+Alt+C) clean-up
//    Azure DevOps copies work item titles as "<type> <id>: <title>". A capturing
//    copy listener rewrites the clipboard so the type prefix is removed for
//    Product Backlog Item, Carrier Data Release, Request and Bug work items
//    (see STRIPPED_PREFIX_TEXT_PATTERN). Other types, such as Patch, are left
//    alone, and copies performed by this script itself are not rewritten.
//
// Maintenance notes
// -----------------
// - Grid rows are absolutely positioned and recycled, so rows are always read
//   from a list sorted by aria-rowindex, and row elements are re-resolved by
//   work item id between expand/collapse passes.
// - Clipboard writes prefer navigator.clipboard.write (so both text/plain and
//   text/html flavours are set) and fall back to document.execCommand('copy')
//   with a temporary selection when the async API is unavailable or rejected.
// - If the "..." button uses a different class in another Azure DevOps version,
//   add its selector to CONTEXT_MENU_SELECTORS.

(function () {
    'use strict';

    const ROW_SELECTOR = '.grid-row[role="row"]';
    const TITLE_LINK_SELECTOR = 'a.work-item-title-link';
    const CONTEXT_MENU_SELECTORS = [
        '.grid-context-menu',
        '.work-item-context-menu',
        '.menu-item.bowtie-ellipsis',
        '.bowtie-ellipsis',
        '[aria-label="More actions"]',
        '[aria-label="More commands"]',
    ].join(',');
    const COPY_BUTTON_CLASS = 'copy-azure-devops-work-item-link-button';
    const STYLE_ID = 'copy-azure-devops-work-item-link-style';
    const BUTTON_SIZE = 20;
    const BUTTON_GAP = 2;
    const POLL_INTERVAL = 100;
    const TREE_ICON_SELECTOR = '.grid-tree-icon';
    const COLLAPSED_ICON_CLASS = 'bowtie-chevron-right';
    const EXPANDED_ICON_CLASS = 'bowtie-chevron-down';
    const LINK_COLOR = '#106ebe';
    const PATCH_WORK_ITEM_TYPE = 'patch';
    const WORK_ITEM_TYPE_CELL_INDEX = 3;
    const STRIPPED_PREFIX_TEXT_PATTERN =
        /(^|\n)\s*(?:Product Backlog Item|Carrier Data Release|Request|Bug)\s+(?=\d+)/g;
    const STRIPPED_PREFIX_HTML_PATTERN =
        /(>)\s*(?:Product Backlog Item|Carrier Data Release|Request|Bug)\s+(\d+)/g;
    const RELATED_LINK_TYPES = new Set(['System.LinkTypes.Related']);
    const RELATED_ITEM_FIELD_REFERENCES = [
        'System.Title',
        'System.WorkItemType',
        'Microsoft.VSTS.Common.Priority',
        'System.State',
    ];
    const SORT_COLLATOR = new Intl.Collator(undefined, {
        numeric: true,
        sensitivity: 'base',
    });
    const EXPAND_POLL_INTERVAL = 60;
    const EXPAND_TIMEOUT = 2000;
    const MAX_EXPAND_PASSES = 50;
    const STYLE_TEXT = `
.${COPY_BUTTON_CLASS} {
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
    color: inherit;
    font-size: 12px;
    line-height: 1;
    cursor: pointer;
}

.${COPY_BUTTON_CLASS}.is-visible {
    display: inline-flex;
}

.${COPY_BUTTON_CLASS}:hover {
    background: rgba(128, 128, 128, 0.35);
}

.${COPY_BUTTON_CLASS}.is-copied {
    color: #107c10;
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

    function getWorkItemUrl(row, titleLink) {
        const href = titleLink?.getAttribute('href');
        if (href) {
            return new URL(href, window.location.href).href;
        }

        const id = getWorkItemId(row, null);
        if (!id) {
            return null;
        }

        const match = window.location.pathname.match(
            /^(.*?)\/_(?:queries|workitems)\b/i,
        );
        if (!match) {
            return null;
        }

        return `${window.location.origin}${match[1]}/_workitems/edit/${id}`;
    }

    function getApiBaseUrl(url) {
        const match = String(url || '').match(
            /^(https?:\/\/[^/]+(?:\/[^/]+)*?)\/_workitems\//i,
        );
        if (match) {
            return match[1];
        }

        const pathMatch = window.location.pathname.match(
            /^(.*?)\/_(?:queries|workitems)\b/i,
        );
        return pathMatch
            ? `${window.location.origin}${pathMatch[1]}`
            : null;
    }

    async function fetchJson(url) {
        const response = await fetch(url, {
            credentials: 'include',
            headers: { Accept: 'application/json' },
        });
        if (!response.ok) {
            throw new Error(`Request failed: ${response.status}`);
        }

        return response.json();
    }

    async function fetchRelatedWorkItemIds(baseUrl, id) {
        const data = await fetchJson(
            `${baseUrl}/_apis/wit/workitems/${id}?$expand=relations&api-version=1.0`,
        );
        const relations = Array.isArray(data?.relations) ? data.relations : [];
        const ids = [];

        relations.forEach((relation) => {
            if (!RELATED_LINK_TYPES.has(relation?.rel)) {
                return;
            }

            const relatedId = String(relation.url || '').match(/\/(\d+)$/);
            if (relatedId && !ids.includes(relatedId[1])) {
                ids.push(relatedId[1]);
            }
        });

        return ids;
    }

    const commitmentFieldReferences = new Map();

    async function fetchCommitmentFieldReference(baseUrl) {
        if (commitmentFieldReferences.has(baseUrl)) {
            return commitmentFieldReferences.get(baseUrl);
        }

        const promise = fetchJson(
            `${baseUrl}/_apis/wit/fields?api-version=1.0`,
        )
            .then((data) => {
                const field = (Array.isArray(data?.value) ? data.value : []).find(
                    (candidate) =>
                        String(candidate?.name || '').toLowerCase() ===
                        'commitment',
                );
                return field?.referenceName || null;
            })
            .catch(() => null);
        commitmentFieldReferences.set(baseUrl, promise);
        return promise;
    }

    async function fetchWorkItemFields(baseUrl, ids) {
        if (ids.length === 0) {
            return new Map();
        }

        const commitmentFieldReference = await fetchCommitmentFieldReference(
            baseUrl,
        );
        const fieldReferences = [...RELATED_ITEM_FIELD_REFERENCES];
        if (commitmentFieldReference) {
            fieldReferences.push(commitmentFieldReference);
        }
        const data = await fetchJson(
            `${baseUrl}/_apis/wit/workitems?ids=${ids.join(
                ',',
            )}&fields=${fieldReferences.join(',')}&api-version=1.0`,
        );
        const fieldsById = new Map();

        (Array.isArray(data?.value) ? data.value : []).forEach((workItem) => {
            fieldsById.set(String(workItem?.id), {
                title: String(workItem?.fields?.['System.Title'] ?? ''),
                workItemType: String(
                    workItem?.fields?.['System.WorkItemType'] ?? '',
                ),
                commitment: String(
                    workItem?.fields?.[commitmentFieldReference] ?? '',
                ),
                priority: String(
                    workItem?.fields?.['Microsoft.VSTS.Common.Priority'] ?? '',
                ),
                state: String(workItem?.fields?.['System.State'] ?? ''),
            });
        });

        return fieldsById;
    }

    function compareSortValues(left, right, descending = false) {
        const leftValue = String(left || '').trim();
        const rightValue = String(right || '').trim();
        if (leftValue === rightValue) {
            return 0;
        }

        if (!leftValue) {
            return 1;
        }

        if (!rightValue) {
            return -1;
        }

        const comparison = SORT_COLLATOR.compare(leftValue, rightValue);
        return descending ? -comparison : comparison;
    }

    function compareRelatedWorkItems(left, right) {
        const comparisons = [
            [left.workItemType, right.workItemType, false],
            [left.commitment, right.commitment, false],
            [left.priority, right.priority, false],
            [left.state, right.state, true],
            [left.title, right.title, false],
            [left.id, right.id, true],
        ];

        for (const [leftValue, rightValue, descending] of comparisons) {
            const comparison = compareSortValues(
                leftValue,
                rightValue,
                descending,
            );
            if (comparison !== 0) {
                return comparison;
            }
        }

        return 0;
    }

    async function fetchWorkItemTreeEntries(rootEntry) {
        const baseUrl = getApiBaseUrl(rootEntry.url);
        if (!baseUrl) {
            return null;
        }

        const relatedIds = await fetchRelatedWorkItemIds(baseUrl, rootEntry.id);
        const fieldsById = await fetchWorkItemFields(baseUrl, relatedIds);

        return [
            rootEntry,
            ...relatedIds
                .map((id) => {
                    const fields = fieldsById.get(id);
                    return {
                        id,
                        url: `${baseUrl}/_workitems/edit/${id}`,
                        title: fields?.title || '',
                        isPatch: isPatchType(fields?.workItemType),
                        workItemType: fields?.workItemType || '',
                        commitment: fields?.commitment || '',
                        priority: fields?.priority || '',
                        state: fields?.state || '',
                    };
                })
                .sort(compareRelatedWorkItems),
        ];
    }

    function getWorkItemId(row, url) {
        const fromUrl = url && url.match(/\/edit\/(\d+)/);
        if (fromUrl) {
            return fromUrl[1];
        }

        const attributeId =
            row.getAttribute('data-id') ||
            row.getAttribute('data-work-item-id');
        if (attributeId && /^\d+$/.test(attributeId)) {
            return attributeId;
        }

        for (const cell of row.querySelectorAll('[role="gridcell"]')) {
            const text = (cell.textContent || '').trim();
            if (/^\d+$/.test(text)) {
                return text;
            }
        }

        return null;
    }

    function getWorkItemTitle(titleLink) {
        if (!titleLink) {
            return '';
        }

        const clone = titleLink.cloneNode(true);
        clone.querySelectorAll('sup').forEach((sup) => sup.remove());
        const text = (clone.textContent || '').replace(/\s+/g, ' ').trim();

        return text || (titleLink.getAttribute('title') || '').trim();
    }

    function escapeHtml(text) {
        return String(text)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function wait(milliseconds) {
        return new Promise((resolve) => {
            window.setTimeout(resolve, milliseconds);
        });
    }

    function dispatchClick(element) {
        ['mousedown', 'mouseup', 'click'].forEach((eventType) => {
            element.dispatchEvent(
                new MouseEvent(eventType, {
                    bubbles: true,
                    cancelable: true,
                    view: window,
                }),
            );
        });
    }

    function getRowLevel(row) {
        const level = Number.parseInt(row.getAttribute('aria-level') || '', 10);
        return Number.isNaN(level) ? 1 : level;
    }

    function getAllRows() {
        const rows = Array.from(document.querySelectorAll(ROW_SELECTOR));

        // Rows are absolutely positioned and recycled, so DOM order can differ
        // from display order.
        const indexed = rows.map((row) => ({
            row,
            index: Number.parseInt(row.getAttribute('aria-rowindex') || '', 10),
        }));

        return indexed.every(({ index }) => !Number.isNaN(index))
            ? indexed.sort((left, right) => left.index - right.index).map(
                  ({ row }) => row,
              )
            : rows;
    }

    function getSubtreeRows(row) {
        const rows = getAllRows();
        const startIndex = rows.indexOf(row);
        if (startIndex === -1) {
            return [row];
        }

        const baseLevel = getRowLevel(row);
        const subtree = [row];

        for (let index = startIndex + 1; index < rows.length; index += 1) {
            if (getRowLevel(rows[index]) <= baseLevel) {
                break;
            }

            subtree.push(rows[index]);
        }

        return subtree;
    }

    function findRowByWorkItemId(rows, id) {
        return (
            rows.find(
                (candidate) =>
                    getWorkItemId(
                        candidate,
                        getWorkItemUrl(candidate, getTitleLink(candidate)),
                    ) === id,
            ) || null
        );
    }

    function makeRowResolver(row) {
        const id = getWorkItemId(row, getWorkItemUrl(row, getTitleLink(row)));

        // The grid recycles row elements, so re-find the row by id each pass.
        return () =>
            row.isConnected ? row : findRowByWorkItemId(getAllRows(), id);
    }

    function getTreeToggle(row) {
        const icon = row.querySelector(TREE_ICON_SELECTOR);
        if (!icon) {
            return null;
        }

        const ariaExpanded = row.getAttribute('aria-expanded');
        if (
            icon.classList.contains(COLLAPSED_ICON_CLASS) ||
            ariaExpanded === 'false'
        ) {
            return { icon, expanded: false };
        }

        if (
            icon.classList.contains(EXPANDED_ICON_CLASS) ||
            ariaExpanded === 'true'
        ) {
            return { icon, expanded: true };
        }

        return null;
    }

    async function waitForSubtreeChange(getRow, previousCount) {
        const deadline = Date.now() + EXPAND_TIMEOUT;

        while (Date.now() < deadline) {
            await wait(EXPAND_POLL_INTERVAL);
            const row = getRow();
            if (!row) {
                return;
            }

            if (getSubtreeRows(row).length !== previousCount) {
                await wait(EXPAND_POLL_INTERVAL);
                return;
            }
        }
    }

    async function expandSubtree(getRow) {
        const expandedIds = new Set();

        for (let pass = 0; pass < MAX_EXPAND_PASSES; pass += 1) {
            const row = getRow();
            if (!row) {
                break;
            }

            const subtree = getSubtreeRows(row);
            const next = subtree
                .map((candidate) => ({
                    candidate,
                    toggle: getTreeToggle(candidate),
                }))
                .find(({ toggle }) => toggle && !toggle.expanded);
            if (!next) {
                break;
            }

            const id = getWorkItemId(
                next.candidate,
                getWorkItemUrl(next.candidate, getTitleLink(next.candidate)),
            );
            dispatchClick(next.toggle.icon);
            if (id) {
                expandedIds.add(id);
            }

            await waitForSubtreeChange(getRow, subtree.length);
        }

        return expandedIds;
    }

    async function restoreExpandStates(getRow, expandedIds) {
        // Collapse deepest first so ancestors stay rendered while restoring.
        const ids = [...expandedIds].reverse();

        for (const id of ids) {
            const row = getRow();
            if (!row) {
                return;
            }

            const target = findRowByWorkItemId(getSubtreeRows(row), id);
            const toggle = target ? getTreeToggle(target) : null;
            if (toggle && toggle.expanded) {
                dispatchClick(toggle.icon);
                await wait(EXPAND_POLL_INTERVAL);
            }
        }
    }

    function isPatchType(workItemType) {
        return (
            String(workItemType ?? '')
                .replace(/\s+/g, ' ')
                .trim()
                .toLowerCase() === PATCH_WORK_ITEM_TYPE
        );
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

    function getEntryLabel(entry) {
        return entry.isPatch ? `Patch ${entry.id}` : entry.id;
    }

    function getRowEntry(row) {
        const titleLink = getTitleLink(row);
        const url = getWorkItemUrl(row, titleLink);
        const id = getWorkItemId(row, url);

        if (!id || !url) {
            return null;
        }

        return {
            id,
            url,
            title: getWorkItemTitle(titleLink),
            isPatch: isPatchType(getRowWorkItemType(row)),
        };
    }

    function buildTableHtml(entries) {
        const rows = entries
            .map(
                (entry) =>
                    `<tr><td><a href="${escapeHtml(
                        entry.url,
                    )}" style="color:${LINK_COLOR}" target="_blank">${escapeHtml(
                        getEntryLabel(entry),
                    )}</a>: </td><td>${escapeHtml(entry.title)}<br/></td></tr>`,
            )
            .join('');

        return `<table><tbody>${rows}</tbody></table>`;
    }

    let scriptOwnedCopy = false;

    function stripPrefixFromText(text) {
        return String(text).replace(STRIPPED_PREFIX_TEXT_PATTERN, '$1');
    }

    function stripPrefixFromHtml(html) {
        return String(html).replace(STRIPPED_PREFIX_HTML_PATTERN, '$1$2');
    }

    function getSelectionHtml(selection) {
        const container = document.createElement('div');
        for (let index = 0; index < selection.rangeCount; index += 1) {
            container.appendChild(
                selection.getRangeAt(index).cloneContents(),
            );
        }

        return container.innerHTML;
    }

    function stripWorkItemTypePrefix(event) {
        if (scriptOwnedCopy || !event.clipboardData) {
            return;
        }

        const selection = window.getSelection();
        if (!selection || selection.rangeCount === 0) {
            return;
        }

        const plainText = selection.toString();
        const strippedText = stripPrefixFromText(plainText);
        if (strippedText === plainText) {
            return;
        }

        event.clipboardData.setData('text/plain', strippedText);
        event.clipboardData.setData(
            'text/html',
            stripPrefixFromHtml(getSelectionHtml(selection)),
        );
        event.preventDefault();
    }

    function copyWithExecCommand(plainText, htmlText) {
        const onCopy = (event) => {
            event.clipboardData.setData('text/plain', plainText);
            event.clipboardData.setData('text/html', htmlText);
            event.preventDefault();
        };

        scriptOwnedCopy = true;
        document.addEventListener('copy', onCopy, true);
        try {
            // A non-empty selection is required for execCommand('copy').
            const holder = document.createElement('span');
            holder.textContent = plainText;
            holder.style.position = 'fixed';
            holder.style.opacity = '0';
            document.body.appendChild(holder);

            const range = document.createRange();
            range.selectNodeContents(holder);
            const selection = window.getSelection();
            selection.removeAllRanges();
            selection.addRange(range);

            const copied = document.execCommand('copy');
            selection.removeAllRanges();
            holder.remove();
            return copied;
        } finally {
            scriptOwnedCopy = false;
            document.removeEventListener('copy', onCopy, true);
        }
    }

    async function writeClipboard(plainText, htmlText) {
        if (navigator.clipboard && typeof window.ClipboardItem === 'function') {
            try {
                await navigator.clipboard.write([
                    new window.ClipboardItem({
                        'text/plain': new Blob([plainText], {
                            type: 'text/plain',
                        }),
                        'text/html': new Blob([htmlText], {
                            type: 'text/html',
                        }),
                    }),
                ]);
                return true;
            } catch {
                // Fall through to the synchronous path.
            }
        }

        return copyWithExecCommand(plainText, htmlText);
    }

    function flashCopied(button) {
        button.classList.add('is-copied');
        window.setTimeout(() => button.classList.remove('is-copied'), 1000);
    }

    async function copyWorkItemLink(row, button) {
        const entry = getRowEntry(row);
        if (!entry) {
            return;
        }

        const plainText = `${getEntryLabel(entry)}: ${entry.title}`;
        const htmlText = `<a href="${escapeHtml(entry.url)}">${escapeHtml(
            getEntryLabel(entry),
        )}</a>: ${escapeHtml(entry.title)}`;

        if (await writeClipboard(plainText, htmlText)) {
            flashCopied(button);
        }
    }

    async function copyWorkItemTree(row, button) {
        const rootEntry = getRowEntry(row);
        if (!rootEntry) {
            return;
        }

        let entries = null;
        try {
            entries = await fetchWorkItemTreeEntries(rootEntry);
        } catch {
            entries = null;
        }

        if (!entries || entries.length <= 1) {
            entries = await collectRenderedTreeEntries(row);
        }

        if (entries.length === 0) {
            return;
        }

        const plainText = entries
            .map((entry) => `${getEntryLabel(entry)}: ${entry.title}`)
            .join('\n');

        if (await writeClipboard(plainText, buildTableHtml(entries))) {
            flashCopied(button);
        }
    }

    async function collectRenderedTreeEntries(row) {
        const getRow = makeRowResolver(row);
        const expandedIds = await expandSubtree(getRow);

        try {
            const expandedRow = getRow();
            return (expandedRow ? getSubtreeRows(expandedRow) : [])
                .map(getRowEntry)
                .filter((entry) => entry !== null);
        } finally {
            await restoreExpandStates(getRow, expandedIds);
        }
    }

    let copyButton = null;
    let currentRow = null;
    let hoveredRow = null;

    function getCopyButton() {
        if (copyButton) {
            return copyButton;
        }

        copyButton = document.createElement('button');
        copyButton.type = 'button';
        copyButton.className = COPY_BUTTON_CLASS;
        copyButton.title =
            'Copy related work items as a table (Ctrl+click: copy work item link)';
        copyButton.setAttribute('aria-label', 'Copy work item link');
        copyButton.textContent = '\u29C9';
        copyButton.addEventListener('mousedown', (event) => {
            event.preventDefault();
            event.stopPropagation();
        });
        copyButton.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            if (!currentRow) {
                return;
            }

            if (event.ctrlKey) {
                copyWorkItemLink(currentRow, copyButton);
            } else {
                copyWorkItemTree(currentRow, copyButton);
            }
        });

        return copyButton;
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

    function updateCopyButton() {
        const button = getCopyButton();
        const anchor = findAnchor();
        const row =
            anchor?.row || anchor?.menu.closest(ROW_SELECTOR) || null;

        if (
            !anchor ||
            !row ||
            !getTitleLink(row) ||
            !isPatchType(getRowWorkItemType(row))
        ) {
            currentRow = null;
            button.classList.remove('is-visible');
            return;
        }

        currentRow = row;

        // Living inside the row keeps the grid's own :hover styling working.
        if (button.parentElement !== row) {
            if (window.getComputedStyle(row).position === 'static') {
                row.style.position = 'relative';
            }
            row.appendChild(button);
        }

        const rowRect = row.getBoundingClientRect();
        const { rect } = anchor;
        button.style.left = `${
            rect.left - rowRect.left - BUTTON_SIZE - BUTTON_GAP
        }px`;
        button.style.top = `${
            rect.top - rowRect.top + rect.height / 2 - BUTTON_SIZE / 2
        }px`;
        button.classList.add('is-visible');
    }

    ensureStyles();
    updateCopyButton();
    window.setInterval(updateCopyButton, POLL_INTERVAL);
    window.addEventListener('scroll', updateCopyButton, true);
    window.addEventListener('resize', updateCopyButton);
    document.addEventListener(
        'mouseover',
        (event) => {
            const target = event.target;
            if (!(target instanceof Element)) {
                return;
            }

            hoveredRow = target.closest(ROW_SELECTOR);
            updateCopyButton();
        },
        true,
    );
    document.addEventListener('mouseleave', (event) => {
        if (event.target === document || event.target === document.body) {
            hoveredRow = null;
            updateCopyButton();
        }
    });
    document.addEventListener('copy', stripWorkItemTypePrefix, true);
})();
