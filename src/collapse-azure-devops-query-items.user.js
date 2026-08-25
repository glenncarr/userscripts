// ==UserScript==
// @name         Collapse Azure DevOps query items
// @namespace    https://github.com/glenncarr/userscripts
// @version      1.2.24
// @downloadURL  https://raw.githubusercontent.com/glenncarr/userscripts/main/src/collapse-azure-devops-query-items.user.js
// @description  Collapse expanded top-level work items and style placeholder Patch items in Azure DevOps query results.
// @match        http://tfs/*/_queries/*
// @match        http://tfs01/*/_queries/*
// @match        https://tfs/*/_queries/*
// @match        https://tfs01/*/_queries/*
// @match        http://tfs/*/_workitems/*
// @match        http://tfs01/*/_workitems/*
// @match        https://tfs/*/_workitems/*
// @match        https://tfs01/*/_workitems/*
// @run-at       document-start
// @grant        none
// @noframes
// ==/UserScript==
// Installation: import this file into Greasemonkey or Tampermonkey. Duplicate
// the @match lines if the server is accessed through another hostname.

(function () {
    'use strict';

    const GRID_SELECTOR = '.query-result-grid[role="treegrid"]';
    const TOP_LEVEL_ROW_SELECTOR = '.grid-row[role="row"][aria-level="1"]';
    const EXPANDED_ICON_SELECTOR = '.grid-tree-icon.bowtie-chevron-down';
    const COLLAPSE_ALL_SELECTOR =
        '.grid-header-column[role="columnheader"][aria-label="Collapse all"] .collapse-icon';
    const INITIAL_RENDER_TIMEOUT = 30000;
    const RENDER_SETTLE_DELAY = 120;
    const CLICK_SETTLE_DELAY = 80;
    const MAX_COLLAPSE_CLICKS = 1000;
    const PATCH_WORK_ITEM_TYPE_TEXT = 'patch';
    const EXCLUDED_PATCH_DESCENDANT_WORK_ITEM_TYPES = new Set([
        'tkc product release',
        'patch',
    ]);
    const WORK_ITEM_TYPE_CELL_INDEX = 3;
    const TITLE_CELL_INDEX = 4;
    const COMMITMENT_CELL_INDEX = 8;
    const GRIDO_WORK_ITEM_TYPE_DATA_INDEX = 1;
    const GRIDO_COMMITMENT_DATA_INDEX = 6;
    const GRIDO_WORK_ITEM_TYPE_FIELD = 'System.WorkItemType';
    const GRIDO_COMMITMENT_FIELD = 'Custom.Commitment';
    const PLACEHOLDER_COMMITMENT_TEXT = '20xx (placeholder)';
    const PLACEHOLDER_PRESENTATION_CLASS =
        'collapse-azure-devops-query-items-placeholder';
    const PLACEHOLDER_STYLE_ID =
        'collapse-azure-devops-query-items-placeholder-style';
    const PLACEHOLDER_STYLE_TEXT = `
${GRID_SELECTOR} .${PLACEHOLDER_PRESENTATION_CLASS},
${GRID_SELECTOR} .${PLACEHOLDER_PRESENTATION_CLASS} * {
    color: gray !important;
    font-style: italic !important;
}
`;
    const SUPERSCRIPT_COUNT_CLASS =
        'collapse-azure-devops-query-items-count-superscript';
    const SUPERSCRIPT_STYLE_ID =
        'collapse-azure-devops-query-items-superscript-style';
    const SUPERSCRIPT_STYLE_TEXT = `
:root {
    --collapse-azure-devops-query-items-superscript-color: #222222;
}

${GRID_SELECTOR} .${SUPERSCRIPT_COUNT_CLASS} {
    font-size: 0.75em !important;
    vertical-align: super !important;
    margin-left: 0.2em !important;
    color: var(--collapse-azure-devops-query-items-superscript-color) !important;
    font-weight: 700 !important;
    background-color: #ffffff !important;
    border: 1px solid #111111 !important;
    border-radius: 999px !important;
    padding: 0 0.24em !important;
    line-height: 1.15 !important;
    text-shadow: none !important;
}

@media (prefers-color-scheme: dark) {
    :root {
        --collapse-azure-devops-query-items-superscript-color: #e0e0e0;
    }

    ${GRID_SELECTOR} .${SUPERSCRIPT_COUNT_CLASS} {
        background-color: #121212 !important;
        border-color: #f5f5f5 !important;
    }
}
`;

    let activeGrid = null;
    let initialCollapseComplete = false;
    let processing = false;
    let scheduled = false;
    let pendingRunQueryRefresh = false;
    let pendingResultSignature = null;
    let pendingRenderedEventSeen = false;
    let pendingGridEventBound = null;
    const renderedTitleCounts = new WeakMap();
    const gridCountStates = new WeakMap();
    const unknownCountToken = Symbol('unknown-count');

    function isQueryRoute() {
        const path = window.location.pathname.toLowerCase();
        return path.includes('/_queries/') || path.includes('/_workitems/');
    }

    function findGrid() {
        if (!isQueryRoute()) {
            return null;
        }

        return document.querySelector(GRID_SELECTOR);
    }

    function getTopLevelRows(grid) {
        return Array.from(grid.querySelectorAll(TOP_LEVEL_ROW_SELECTOR));
    }

    function getExpandedIcon(grid) {
        return grid.querySelector(
            `${TOP_LEVEL_ROW_SELECTOR}[aria-expanded="true"] ${EXPANDED_ICON_SELECTOR}`,
        );
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

    function wait(milliseconds) {
        return new Promise((resolve) => {
            window.setTimeout(resolve, milliseconds);
        });
    }

    async function waitForInitialRows(grid) {
        const deadline = Date.now() + INITIAL_RENDER_TIMEOUT;
        let previousRowCount = 0;
        let stableSamples = 0;

        while (Date.now() < deadline && grid.isConnected) {
            const rowCount = getTopLevelRows(grid).length;

            if (rowCount > 0) {
                stableSamples =
                    rowCount === previousRowCount ? stableSamples + 1 : 0;
                previousRowCount = rowCount;

                if (stableSamples >= 2) {
                    return true;
                }
            } else {
                previousRowCount = 0;
                stableSamples = 0;
            }

            await wait(RENDER_SETTLE_DELAY);
        }

        return false;
    }

    function getCollapseAllControl(grid) {
        return grid.querySelector(COLLAPSE_ALL_SELECTOR);
    }

    function getGridEnhancements(grid) {
        const jq = window.jQuery;
        if (typeof jq !== 'function') {
            return null;
        }

        return jq(grid).data('tfs-enhancements') || null;
    }

    function getEnhancementCandidates(enhancements) {
        if (!enhancements || typeof enhancements !== 'object') {
            return [];
        }

        if (Array.isArray(enhancements)) {
            return enhancements;
        }

        return [enhancements, ...Object.values(enhancements)];
    }

    function findExpandStates(grid) {
        const enhancements = getGridEnhancements(grid);
        if (!enhancements) {
            return null;
        }

        for (const candidate of getEnhancementCandidates(enhancements)) {
            if (
                candidate &&
                typeof candidate === 'object' &&
                candidate._expandStates &&
                typeof candidate._expandStates === 'object'
            ) {
                return candidate._expandStates;
            }
        }

        return null;
    }

    function findGridDataProvider(grid) {
        const enhancements = getGridEnhancements(grid);
        if (!enhancements) {
            return null;
        }

        for (const candidate of getEnhancementCandidates(enhancements)) {
            if (
                candidate &&
                typeof candidate === 'object' &&
                candidate._workItems &&
                candidate._parentWorkItemIds &&
                candidate._pageData
            ) {
                return candidate;
            }
        }

        return null;
    }

    function findGridWorkItemDataProvider(grid) {
        const enhancements = getGridEnhancements(grid);
        if (!enhancements) {
            return null;
        }

        for (const candidate of getEnhancementCandidates(enhancements)) {
            if (
                candidate &&
                typeof candidate === 'object' &&
                candidate._workItems &&
                candidate._pageData
            ) {
                return candidate;
            }
        }

        return null;
    }

    function getCollectionValue(collection, key) {
        if (!collection) {
            return undefined;
        }

        if (collection instanceof Map) {
            const value = collection.get(key);
            return value === undefined
                ? collection.get(String(key))
                : value;
        }

        if (Object.prototype.hasOwnProperty.call(collection, key)) {
            return collection[key];
        }

        const stringKey = String(key);
        return Object.prototype.hasOwnProperty.call(collection, stringKey)
            ? collection[stringKey]
            : undefined;
    }

    function getGridWorkItemEntries(provider) {
        const workItems = provider?._workItems;
        if (Array.isArray(workItems)) {
            return workItems
                .map((workItemId, dataIndex) => ({ dataIndex, workItemId }))
                .filter(
                    ({ workItemId }) =>
                        workItemId !== undefined && workItemId !== null,
                );
        }

        if (workItems instanceof Map) {
            const entries = [];
            for (const [key, workItemId] of workItems) {
                const dataIndex = Number.parseInt(key, 10);
                if (
                    Number.isInteger(dataIndex) &&
                    workItemId !== undefined &&
                    workItemId !== null
                ) {
                    entries.push({ dataIndex, workItemId });
                }
            }
            return entries;
        }

        if (!workItems || typeof workItems !== 'object') {
            return [];
        }

        return Object.keys(workItems)
            .map((key) => ({
                dataIndex: Number.parseInt(key, 10),
                workItemId: workItems[key],
            }))
            .filter(
                ({ dataIndex, workItemId }) =>
                    Number.isInteger(dataIndex) &&
                    workItemId !== undefined &&
                    workItemId !== null,
            );
    }

    function getGridWorkItemData(provider, workItemId, dataIndex = null) {
        const pageData = provider?._pageData;
        if (!pageData) {
            return null;
        }

        let rowData;
        if (workItemId !== undefined && workItemId !== null) {
            rowData = getCollectionValue(pageData, workItemId);
        }

        if (
            rowData === undefined &&
            dataIndex !== null &&
            dataIndex !== undefined
        ) {
            rowData = getCollectionValue(pageData, dataIndex);
        }

        return rowData && typeof rowData === 'object' ? rowData : null;
    }

    function getGridPageDataValue(rowData, dataIndex, fieldName) {
        if (!rowData || typeof rowData !== 'object') {
            return undefined;
        }

        if (Array.isArray(rowData)) {
            return rowData[dataIndex];
        }

        const valueByIndex = getCollectionValue(rowData, dataIndex);
        if (valueByIndex !== undefined) {
            return valueByIndex;
        }

        return getCollectionValue(rowData, fieldName);
    }

    function getParentWorkItemId(provider, dataIndex, workItemId) {
        const parentWorkItemIds = provider?._parentWorkItemIds;
        const parentByIndex = getCollectionValue(parentWorkItemIds, dataIndex);
        if (parentByIndex !== undefined) {
            return parentByIndex;
        }

        return getCollectionValue(parentWorkItemIds, workItemId);
    }

    function normalizeWorkItemId(workItemId) {
        if (
            workItemId === undefined ||
            workItemId === null ||
            workItemId === ''
        ) {
            return null;
        }

        return String(workItemId);
    }

    function getGridWorkItemType(provider, workItemId, dataIndex = null) {
        const rowData = getGridWorkItemData(provider, workItemId, dataIndex);
        if (!rowData) {
            return null;
        }

        return getNormalizedTitleText(
            getGridPageDataValue(
                rowData,
                GRIDO_WORK_ITEM_TYPE_DATA_INDEX,
                GRIDO_WORK_ITEM_TYPE_FIELD,
            ),
        );
    }

    function getGridWorkItemCommitment(
        provider,
        workItemId,
        dataIndex = null,
    ) {
        const rowData = getGridWorkItemData(provider, workItemId, dataIndex);
        if (!rowData) {
            return '';
        }

        return normalizeCommitmentText(
            getGridPageDataValue(
                rowData,
                GRIDO_COMMITMENT_DATA_INDEX,
                GRIDO_COMMITMENT_FIELD,
            ),
        );
    }

    function getRowDataIndex(row, gridId) {
        const jq = window.jQuery;
        if (typeof jq === 'function') {
            const rowInfo = jq(row).data('grid-row-info');
            if (rowInfo && Number.isInteger(rowInfo.dataIndex)) {
                return rowInfo.dataIndex;
            }
        }

        if (gridId && row.id.startsWith(`row_${gridId}_`)) {
            const suffix = row.id.slice(`row_${gridId}_`.length);
            const parsedFromId = Number.parseInt(suffix, 10);
            if (!Number.isNaN(parsedFromId)) {
                return parsedFromId;
            }
        }

        return null;
    }

    function getRowWorkItemId(provider, row, gridId) {
        const dataIndex = getRowDataIndex(row, gridId);
        if (dataIndex !== null) {
            const workItemId = getCollectionValue(
                provider?._workItems,
                dataIndex,
            );
            if (workItemId !== undefined && workItemId !== null) {
                return workItemId;
            }
        }

        return (
            row.getAttribute('data-id') ||
            row.getAttribute('data-work-item-id') ||
            null
        );
    }

    function getRenderedDescendantCount(row) {
        let count = 0;
        let current = row.nextElementSibling;

        while (current && current.matches('.grid-row[role="row"]')) {
            const level = Number.parseInt(
                current.getAttribute('aria-level') || '',
                10,
            );

            if (Number.isNaN(level) || level <= 1) {
                break;
            }

            count += 1;
            current = current.nextElementSibling;
        }

        return count;
    }

    function getNormalizedTitleText(text) {
        return String(text ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
    }

    function normalizeCommitmentText(text) {
        return String(text ?? '').replace(/\s+/g, ' ').trim();
    }

    function getRowCell(row, index) {
        return row.querySelectorAll('[role="gridcell"]')[index] || null;
    }

    function getNormalizedRowTextFromCell(row, index) {
        const cell = getRowCell(row, index);
        if (!cell) {
            return '';
        }

        return getNormalizedTitleText(cell.textContent || '');
    }

    function getRowWorkItemType(row) {
        const iconType = getNormalizedTitleText(
            row.querySelector('.work-item-type-icon[aria-label]')?.getAttribute(
                'aria-label',
            ) || '',
        );
        if (iconType) {
            return iconType;
        }

        // In this grid, Work Item Type is currently the 4th cell (index 3).
        return getNormalizedRowTextFromCell(row, WORK_ITEM_TYPE_CELL_INDEX);
    }

    function getRowCommitment(row) {
        const cell = getRowCell(row, COMMITMENT_CELL_INDEX);
        if (!cell) {
            return '';
        }

        return normalizeCommitmentText(cell.textContent || '');
    }

    function getRowTitlePresentation(row) {
        const titleCell = getRowCell(row, TITLE_CELL_INDEX);
        const titleLink =
            titleCell?.querySelector('a.work-item-title-link') ||
            row.querySelector('a.work-item-title-link');

        return { titleCell, titleLink };
    }

    function isPlaceholderCommitment(commitment) {
        return (
            normalizeCommitmentText(commitment).toLowerCase() ===
            PLACEHOLDER_COMMITMENT_TEXT
        );
    }

    function getGridRowWorkItemType(grid, row, provider) {
        const rowType = getRowWorkItemType(row);
        if (rowType) {
            return rowType;
        }

        const gridId = grid.id || '';
        const dataIndex = getRowDataIndex(row, gridId);
        const workItemId = getRowWorkItemId(provider, row, gridId);
        return getGridWorkItemType(provider, workItemId, dataIndex) || '';
    }

    function getGridRowCommitment(grid, row, provider) {
        const rowCommitment = getRowCommitment(row);
        if (rowCommitment) {
            return rowCommitment;
        }

        const gridId = grid.id || '';
        const dataIndex = getRowDataIndex(row, gridId);
        const workItemId = getRowWorkItemId(provider, row, gridId);
        return getGridWorkItemCommitment(provider, workItemId, dataIndex);
    }

    function isPlaceholderPatchRow(grid, row, provider) {
        return (
            getGridRowWorkItemType(grid, row, provider) ===
                PATCH_WORK_ITEM_TYPE_TEXT &&
            isPlaceholderCommitment(getGridRowCommitment(grid, row, provider))
        );
    }

    function ensurePlaceholderStyles() {
        if (!document.head) {
            return;
        }

        if (document.getElementById(PLACEHOLDER_STYLE_ID)) {
            return;
        }

        const style = document.createElement('style');
        style.id = PLACEHOLDER_STYLE_ID;
        style.textContent = PLACEHOLDER_STYLE_TEXT;
        document.head.appendChild(style);
    }

    function ensureSuperscriptStyles() {
        if (!document.head) {
            return;
        }

        if (document.getElementById(SUPERSCRIPT_STYLE_ID)) {
            return;
        }

        const style = document.createElement('style');
        style.id = SUPERSCRIPT_STYLE_ID;
        style.textContent = SUPERSCRIPT_STYLE_TEXT;
        document.head.appendChild(style);
    }

    function clearPlaceholderStyles(grid) {
        if (!grid) {
            return;
        }

        grid.querySelectorAll(`.${PLACEHOLDER_PRESENTATION_CLASS}`).forEach(
            (element) => element.classList.remove(PLACEHOLDER_PRESENTATION_CLASS),
        );
    }

    function updatePlaceholderStyles(grid) {
        if (!grid) {
            return;
        }

        ensurePlaceholderStyles();
        const provider = findGridWorkItemDataProvider(grid);

        grid.querySelectorAll('.grid-row[role="row"]').forEach((row) => {
            const shouldStyle = isPlaceholderPatchRow(grid, row, provider);
            const { titleCell, titleLink } = getRowTitlePresentation(row);

            row.classList.toggle(
                PLACEHOLDER_PRESENTATION_CLASS,
                shouldStyle,
            );
            row.querySelectorAll(
                `.${PLACEHOLDER_PRESENTATION_CLASS}`,
            ).forEach((element) => {
                if (element !== titleCell && element !== titleLink) {
                    element.classList.remove(PLACEHOLDER_PRESENTATION_CLASS);
                }
            });

            if (titleCell) {
                titleCell.classList.toggle(
                    PLACEHOLDER_PRESENTATION_CLASS,
                    shouldStyle,
                );
            }
            if (titleLink) {
                titleLink.classList.toggle(
                    PLACEHOLDER_PRESENTATION_CLASS,
                    shouldStyle,
                );
            }
        });
    }

    function isPatchTopLevelRow(row) {
        return getRowWorkItemType(row) === PATCH_WORK_ITEM_TYPE_TEXT;
    }

    function isExcludedPatchDescendantTypeRow(row) {
        return EXCLUDED_PATCH_DESCENDANT_WORK_ITEM_TYPES.has(
            getRowWorkItemType(row),
        );
    }

    function getRenderedExcludedPatchDescendantCount(topLevelRow) {
        if (!isPatchTopLevelRow(topLevelRow)) {
            return 0;
        }

        let excludedCount = 0;
        let current = topLevelRow.nextElementSibling;

        while (current && current.matches('.grid-row[role="row"]')) {
            const level = Number.parseInt(
                current.getAttribute('aria-level') || '',
                10,
            );

            if (Number.isNaN(level) || level <= 1) {
                break;
            }

            if (isExcludedPatchDescendantTypeRow(current)) {
                excludedCount += 1;
            }

            current = current.nextElementSibling;
        }

        return excludedCount;
    }

    function resolveCollapsedDescendantCount(
        row,
        expandStates,
        gridId,
        renderedFallbackCounts,
    ) {
        const dataIndex = getRowDataIndex(row, gridId);
        if (
            expandStates &&
            dataIndex !== null &&
            Object.prototype.hasOwnProperty.call(expandStates, dataIndex)
        ) {
            const rawCount = expandStates[dataIndex];
            if (typeof rawCount === 'number' && Number.isFinite(rawCount)) {
                return Math.abs(rawCount);
            }
        }

        if (
            renderedFallbackCounts &&
            dataIndex !== null &&
            Object.prototype.hasOwnProperty.call(renderedFallbackCounts, dataIndex)
        ) {
            return renderedFallbackCounts[dataIndex];
        }

        const rowExpanded = row.getAttribute('aria-expanded');
        if (rowExpanded === 'false') {
            return getRenderedDescendantCount(row);
        }

        return null;
    }

    function captureRenderedFallbackCounts(grid) {
        const gridId = grid.id || '';
        const fallbackCounts = {};

        getTopLevelRows(grid).forEach((row) => {
            const dataIndex = getRowDataIndex(row, gridId);
            if (dataIndex === null) {
                return;
            }

            fallbackCounts[dataIndex] = getRenderedDescendantCount(row);
        });

        return fallbackCounts;
    }

    function captureRenderedExcludedCounts(grid) {
        const gridId = grid.id || '';
        const excludedCounts = {};

        getTopLevelRows(grid).forEach((row) => {
            const dataIndex = getRowDataIndex(row, gridId);
            if (dataIndex === null) {
                return;
            }

            excludedCounts[dataIndex] =
                getRenderedExcludedPatchDescendantCount(row);
        });

        return excludedCounts;
    }

    function findTopLevelAncestorId(
        provider,
        dataIndex,
        workItemId,
        topLevelById,
        workItemIdByIndex,
        dataIndexByWorkItemId,
    ) {
        let parentWorkItemId = getParentWorkItemId(
            provider,
            dataIndex,
            workItemId,
        );
        const visitedIds = new Set();

        while (parentWorkItemId !== undefined && parentWorkItemId !== null) {
            const normalizedParentId = normalizeWorkItemId(parentWorkItemId);
            if (
                normalizedParentId === null ||
                visitedIds.has(normalizedParentId)
            ) {
                return null;
            }

            if (topLevelById.has(normalizedParentId)) {
                return normalizedParentId;
            }

            visitedIds.add(normalizedParentId);
            const parentDataIndex = dataIndexByWorkItemId.get(
                normalizedParentId,
            );
            if (parentDataIndex === undefined) {
                return null;
            }

            const parentId = workItemIdByIndex.get(parentDataIndex);
            parentWorkItemId = getParentWorkItemId(
                provider,
                parentDataIndex,
                parentId,
            );
        }

        return null;
    }

    function captureGridExcludedCounts(grid) {
        const provider = findGridDataProvider(grid);
        if (!provider) {
            return null;
        }

        const workItemEntries = getGridWorkItemEntries(provider);
        const topLevelRows = getTopLevelRows(grid);
        if (workItemEntries.length === 0 || topLevelRows.length === 0) {
            return null;
        }

        const workItemIdByIndex = new Map();
        const dataIndexByWorkItemId = new Map();
        workItemEntries.forEach(({ dataIndex, workItemId }) => {
            const normalizedWorkItemId = normalizeWorkItemId(workItemId);
            if (normalizedWorkItemId === null) {
                return;
            }

            workItemIdByIndex.set(dataIndex, workItemId);
            dataIndexByWorkItemId.set(normalizedWorkItemId, dataIndex);
        });

        const gridId = grid.id || '';
        const topLevelById = new Map();
        const topLevelIds = new Set();
        const countsByDataIndex = {};
        let allTopLevelRowsMapped = true;

        topLevelRows.forEach((row) => {
            const dataIndex = getRowDataIndex(row, gridId);
            const workItemId = workItemIdByIndex.get(dataIndex);
            const normalizedWorkItemId = normalizeWorkItemId(workItemId);
            if (dataIndex === null || normalizedWorkItemId === null) {
                allTopLevelRowsMapped = false;
                return;
            }

            topLevelIds.add(normalizedWorkItemId);
            const gridType = getGridWorkItemType(provider, workItemId);
            const rowType = getRowWorkItemType(row);
            const isPatch =
                rowType === PATCH_WORK_ITEM_TYPE_TEXT ||
                (!rowType && gridType === PATCH_WORK_ITEM_TYPE_TEXT);
            if (isPatch) {
                topLevelById.set(normalizedWorkItemId, dataIndex);
                countsByDataIndex[dataIndex] = 0;
            }
        });

        if (!allTopLevelRowsMapped) {
            return null;
        }

        for (const { dataIndex, workItemId } of workItemEntries) {
            const workItemType = getGridWorkItemType(provider, workItemId);
            if (workItemType === null) {
                return null;
            }

            if (!EXCLUDED_PATCH_DESCENDANT_WORK_ITEM_TYPES.has(workItemType)) {
                continue;
            }

            const parentWorkItemId = getParentWorkItemId(
                provider,
                dataIndex,
                workItemId,
            );
            const normalizedWorkItemId = normalizeWorkItemId(workItemId);
            if (
                parentWorkItemId === undefined &&
                !topLevelIds.has(normalizedWorkItemId)
            ) {
                return null;
            }

            if (topLevelIds.has(normalizedWorkItemId)) {
                continue;
            }

            const topLevelId = findTopLevelAncestorId(
                provider,
                dataIndex,
                workItemId,
                topLevelById,
                workItemIdByIndex,
                dataIndexByWorkItemId,
            );
            if (topLevelId === null) {
                continue;
            }

            const topLevelDataIndex = topLevelById.get(topLevelId);
            countsByDataIndex[topLevelDataIndex] += 1;
        }

        return countsByDataIndex;
    }

    function categorizeDescendantType(workItemType) {
        if (workItemType === PATCH_WORK_ITEM_TYPE_TEXT) {
            return 'patch';
        }
        if (workItemType === 'tkc product release') {
            return 'tkc';
        }
        return 'other';
    }

    function buildDescendantCountsByType(grid) {
        const gridId = grid.id || '';
        const topLevelRows = getTopLevelRows(grid);
        const countsByDataIndex = {};
        const validatedDataIndices = new Set();

        topLevelRows.forEach((row) => {
            const dataIndex = getRowDataIndex(row, gridId);
            if (dataIndex === null) {
                return;
            }

            countsByDataIndex[dataIndex] = {
                other: 0,
                patch: 0,
                tkc: 0,
            };
        });

        const provider = findGridDataProvider(grid);
        if (!provider) {
            return null;
        }

        const workItemEntries = getGridWorkItemEntries(provider);
        if (workItemEntries.length === 0) {
            return null;
        }

        const workItemIdByIndex = new Map();
        const dataIndexByWorkItemId = new Map();
        workItemEntries.forEach(({ dataIndex, workItemId }) => {
            const normalizedWorkItemId = normalizeWorkItemId(workItemId);
            if (normalizedWorkItemId === null) {
                return;
            }

            workItemIdByIndex.set(dataIndex, workItemId);
            dataIndexByWorkItemId.set(normalizedWorkItemId, dataIndex);
        });

        const topLevelById = new Map();
        const topLevelIds = new Set();
        let allTopLevelRowsMapped = true;

        topLevelRows.forEach((row) => {
            const dataIndex = getRowDataIndex(row, gridId);
            const workItemId = workItemIdByIndex.get(dataIndex);
            const normalizedWorkItemId = normalizeWorkItemId(workItemId);
            if (dataIndex === null || normalizedWorkItemId === null) {
                allTopLevelRowsMapped = false;
                return;
            }

            topLevelIds.add(normalizedWorkItemId);
            topLevelById.set(normalizedWorkItemId, dataIndex);
            validatedDataIndices.add(dataIndex);
        });

        if (!allTopLevelRowsMapped) {
            return null;
        }

        for (const { dataIndex, workItemId } of workItemEntries) {
            const workItemType = getGridWorkItemType(provider, workItemId, dataIndex);
            if (workItemType === null) {
                return null;
            }

            const normalizedWorkItemId = normalizeWorkItemId(workItemId);
            if (topLevelIds.has(normalizedWorkItemId)) {
                continue;
            }

            const topLevelId = findTopLevelAncestorId(
                provider,
                dataIndex,
                workItemId,
                topLevelById,
                workItemIdByIndex,
                dataIndexByWorkItemId,
            );
            if (topLevelId === null) {
                continue;
            }

            const topLevelDataIndex = topLevelById.get(topLevelId);
            if (Object.prototype.hasOwnProperty.call(countsByDataIndex, topLevelDataIndex)) {
                const category = categorizeDescendantType(workItemType);
                countsByDataIndex[topLevelDataIndex][category] += 1;
            }
        }

        return validatedDataIndices.size === Object.keys(countsByDataIndex).length
            ? countsByDataIndex
            : null;
    }

    function buildDescendantCountsByTypeRenderedFallback(grid) {
        const gridId = grid.id || '';
        const topLevelRows = getTopLevelRows(grid);
        const countsByDataIndex = {};

        topLevelRows.forEach((row) => {
            const dataIndex = getRowDataIndex(row, gridId);
            if (dataIndex === null) {
                return;
            }

            countsByDataIndex[dataIndex] = {
                other: 0,
                patch: 0,
                tkc: 0,
            };

            const descendantRows = row.parentElement
                ? Array.from(row.parentElement.querySelectorAll('.grid-row[role="row"]'))
                : [];
            let foundEnd = false;

            for (const descendantRow of descendantRows) {
                if (descendantRow === row) {
                    foundEnd = true;
                    continue;
                }

                if (!foundEnd) {
                    continue;
                }

                const level = parseInt(
                    descendantRow.getAttribute('aria-level') || '0',
                    10,
                );
                if (level <= 1) {
                    break;
                }

                const rowType = getRowWorkItemType(descendantRow);
                const category = categorizeDescendantType(rowType || 'other');
                countsByDataIndex[dataIndex][category] += 1;
            }
        });

        return countsByDataIndex;
    }

    function captureDescendantCountsByType(grid) {
        const gridCounts = buildDescendantCountsByType(grid);
        if (gridCounts !== null) {
            return gridCounts;
        }

        return buildDescendantCountsByTypeRenderedFallback(grid);
    }

    function getGridCountState(grid) {
        let state = gridCountStates.get(grid);
        if (!state) {
            state = {
                renderedFallbackCounts: {},
                descendantCountsByType: {},
            };
            gridCountStates.set(grid, state);
        }

        return state;
    }

    function refreshRenderedFallbackCounts(grid, state) {
        const capturedCounts = captureRenderedFallbackCounts(grid);
        const gridId = grid.id || '';

        getTopLevelRows(grid).forEach((row) => {
            const dataIndex = getRowDataIndex(row, gridId);
            if (dataIndex === null) {
                return;
            }

            if (
                row.getAttribute('aria-expanded') === 'true' ||
                !Object.prototype.hasOwnProperty.call(
                    state.renderedFallbackCounts,
                    dataIndex,
                )
            ) {
                state.renderedFallbackCounts[dataIndex] =
                    capturedCounts[dataIndex] || 0;
            }
        });
    }

    function refreshExcludedCounts(grid, state) {
        const gridCounts = captureGridExcludedCounts(grid);
        if (gridCounts) {
            state.excludedCounts = gridCounts;
            return;
        }

        const renderedCounts = captureRenderedExcludedCounts(grid);
        const gridId = grid.id || '';
        getTopLevelRows(grid).forEach((row) => {
            const dataIndex = getRowDataIndex(row, gridId);
            if (
                dataIndex === null ||
                !isPatchTopLevelRow(row) ||
                (row.getAttribute('aria-expanded') !== 'true' &&
                    renderedCounts[dataIndex] === 0 &&
                    Object.prototype.hasOwnProperty.call(
                        state.excludedCounts,
                        dataIndex,
                    ))
            ) {
                return;
            }

            state.excludedCounts[dataIndex] = renderedCounts[dataIndex] || 0;
        });
    }

    function updateTopLevelTitleCounts(
        grid,
        renderedFallbackCounts = null,
        descendantCountsByType = null,
    ) {
        const state = getGridCountState(grid);
        if (renderedFallbackCounts) {
            state.renderedFallbackCounts = renderedFallbackCounts;
        } else {
            refreshRenderedFallbackCounts(grid, state);
        }

        if (descendantCountsByType) {
            state.descendantCountsByType = descendantCountsByType;
        } else {
            const capturedCounts = captureDescendantCountsByType(grid);
            if (capturedCounts) {
                state.descendantCountsByType = capturedCounts;
            }
        }

        ensureSuperscriptStyles();

        const expandStates = findExpandStates(grid);
        const gridId = grid.id || '';

        getTopLevelRows(grid).forEach((row) => {
            const titleLink = row.querySelector('a.work-item-title-link');
            if (!titleLink) {
                return;
            }

            const collapsedChildrenCount = resolveCollapsedDescendantCount(
                row,
                expandStates,
                gridId,
                state.renderedFallbackCounts,
            );
            const dataIndex = getRowDataIndex(row, gridId);
            let otherCount = 0;
            let patchCount = 0;
            let tkcCount = 0;

            if (
                dataIndex !== null &&
                Object.prototype.hasOwnProperty.call(
                    state.descendantCountsByType,
                    dataIndex,
                )
            ) {
                const counts = state.descendantCountsByType[dataIndex];
                otherCount = counts.other || 0;
                patchCount = counts.patch || 0;
                tkcCount = counts.tkc || 0;
            }

            const countTuple =
                collapsedChildrenCount === null
                    ? unknownCountToken
                    : { other: otherCount, patch: patchCount, tkc: tkcCount };

            const previousCount = renderedTitleCounts.get(titleLink);
            if (previousCount === countTuple) {
                return;
            }

            if (
                previousCount !== undefined &&
                previousCount !== unknownCountToken &&
                countTuple !== unknownCountToken &&
                previousCount.other === countTuple.other &&
                previousCount.patch === countTuple.patch &&
                previousCount.tkc === countTuple.tkc
            ) {
                return;
            }

            const titleText = titleLink.getAttribute('title') || titleLink.textContent || '';
            titleLink.setAttribute('title', titleText);

            // Remove any existing superscript
            titleLink.querySelectorAll(`.${SUPERSCRIPT_COUNT_CLASS}`).forEach(
                (sup) => sup.remove(),
            );

            // Clear and rebuild title content
            titleLink.textContent = titleText;

            // Add count as superscript if needed
            if (
                countTuple !== unknownCountToken &&
                (countTuple.other > 0 || countTuple.patch > 0 || countTuple.tkc > 0)
            ) {
                const sup = document.createElement('sup');
                sup.className = SUPERSCRIPT_COUNT_CLASS;
                sup.textContent =
                    '(' +
                    String(countTuple.other) +
                    '/' +
                    String(countTuple.patch) +
                    '/' +
                    String(countTuple.tkc) +
                    ')';
                titleLink.appendChild(sup);
            }

            renderedTitleCounts.set(titleLink, countTuple);
        });
    }

    function selectFirstTopLevelRow(grid) {
        const firstRow = getTopLevelRows(grid)[0];

        if (!firstRow) {
            return false;
        }

        const titleCell = firstRow
            .querySelector('a.work-item-title-link')
            ?.closest('[role="gridcell"]');
        const selectableCell =
            titleCell || firstRow.querySelector('[role="gridcell"]');

        if (!selectableCell) {
            return false;
        }

        dispatchClick(selectableCell);
        return true;
    }

    async function collapseExpandedTopLevelRows(grid) {
        const collapseAllControl = getCollapseAllControl(grid);

        if (collapseAllControl) {
            dispatchClick(collapseAllControl);
            return 1;
        }

        let clicks = 0;

        while (clicks < MAX_COLLAPSE_CLICKS) {
            const icon = getExpandedIcon(grid);

            if (!icon) {
                return clicks;
            }

            dispatchClick(icon);
            clicks += 1;
            await wait(CLICK_SETTLE_DELAY);
        }

        return clicks;
    }

    function scheduleProcessing(delay = 50) {
        if (scheduled) {
            return;
        }

        scheduled = true;
        window.setTimeout(() => {
            scheduled = false;
            processGrid();
        }, delay);
    }

    function normalizeMenuItemLabel(text) {
        return (text || '').replace(/\s+/g, ' ').trim().toLowerCase();
    }

    function shouldArmRunQueryRefresh(target) {
        if (!(target instanceof Element)) {
            return false;
        }

        const menuItem = target.closest('button[role="menuitem"]');
        if (!menuItem) {
            return false;
        }

        const label = normalizeMenuItemLabel(menuItem.getAttribute('aria-label'));
        if (label.endsWith('run query')) {
            return true;
        }

        return normalizeMenuItemLabel(menuItem.textContent).endsWith('run query');
    }

    function getResultSignature(grid) {
        const firstRow = grid.querySelector(TOP_LEVEL_ROW_SELECTOR);
        if (!firstRow) {
            return 'rows:0';
        }

        const key = firstRow.getAttribute('data-id') || firstRow.id || '';
        const text = (
            firstRow.querySelector('a.work-item-title-link')?.getAttribute('title') ||
            firstRow.querySelector('a.work-item-title-link')?.textContent ||
            ''
        ).trim();
        return `rows:${getTopLevelRows(grid).length}|first:${key}|text:${text}`;
    }

    function clearPendingRenderedHandler() {
        if (!pendingGridEventBound) {
            return;
        }

        const jq = window.jQuery;
        if (typeof jq === 'function') {
            jq(pendingGridEventBound).off('.collapseRunQueryRefresh');
        }

        pendingGridEventBound = null;
    }

    function completePendingRunQueryRefresh() {
        if (!pendingRunQueryRefresh) {
            return;
        }

        clearPendingRenderedHandler();
        pendingRunQueryRefresh = false;
        pendingResultSignature = null;
        pendingRenderedEventSeen = false;
        initialCollapseComplete = false;
        scheduleProcessing(0);
    }

    function armPendingRunQueryRefresh() {
        const grid = findGrid();
        pendingRunQueryRefresh = true;
        pendingRenderedEventSeen = false;
        pendingResultSignature = grid ? getResultSignature(grid) : null;
        clearPendingRenderedHandler();

        const jq = window.jQuery;
        if (grid && typeof jq === 'function') {
            pendingGridEventBound = grid;
            jq(grid).one('queryResultsRendered.collapseRunQueryRefresh', () => {
                pendingRenderedEventSeen = true;
                completePendingRunQueryRefresh();
            });
        }
    }

    async function processGrid() {
        if (processing) {
            return;
        }

        const grid = findGrid();

        if (!grid) {
            clearPlaceholderStyles(activeGrid);
            activeGrid = null;
            initialCollapseComplete = false;
            return;
        }

        if (grid !== activeGrid) {
            clearPlaceholderStyles(activeGrid);
            activeGrid = grid;
            initialCollapseComplete = false;
        }

        if (initialCollapseComplete) {
            updatePlaceholderStyles(grid);
            return;
        }

        processing = true;

        try {
            const hasInitialRows = await waitForInitialRows(grid);

            if (!hasInitialRows || grid !== findGrid()) {
                scheduleProcessing(0);
                return;
            }

            updatePlaceholderStyles(grid);
            const renderedFallbackCounts = captureRenderedFallbackCounts(grid);
            const descendantCountsByType = captureDescendantCountsByType(grid);
            const clicks = await collapseExpandedTopLevelRows(grid);
            await wait(CLICK_SETTLE_DELAY);

            if (grid !== activeGrid || grid !== findGrid()) {
                scheduleProcessing(0);
                return;
            }

            updatePlaceholderStyles(grid);
            updateTopLevelTitleCounts(
                grid,
                renderedFallbackCounts,
                descendantCountsByType,
            );
            selectFirstTopLevelRow(grid);
            initialCollapseComplete = !getExpandedIcon(grid);

            if (!initialCollapseComplete) {
                console.warn(
                    '[Collapse Azure DevOps query items] Could not collapse all expanded rows after',
                    clicks,
                    'clicks.',
                );
                scheduleProcessing(500);
            }
        } finally {
            processing = false;

            if (grid !== activeGrid || grid !== findGrid()) {
                scheduleProcessing(0);
            }
        }
    }

    const observer = new MutationObserver(() => {
        const grid = findGrid();

        if (grid !== activeGrid) {
            if (pendingRunQueryRefresh) {
                clearPendingRenderedHandler();
                pendingRunQueryRefresh = false;
                pendingResultSignature = null;
                pendingRenderedEventSeen = false;
            }
            clearPlaceholderStyles(activeGrid);
            activeGrid = grid;
            initialCollapseComplete = false;
            updatePlaceholderStyles(grid);
            scheduleProcessing();
            return;
        }

        if (!grid || !initialCollapseComplete) {
            updatePlaceholderStyles(grid);
            scheduleProcessing();
            return;
        }

        updatePlaceholderStyles(grid);

        if (pendingRunQueryRefresh) {
            const gridChanged = grid !== pendingGridEventBound;
            const rowsCleared = getTopLevelRows(grid).length === 0;
            const signatureChanged =
                pendingResultSignature !== null &&
                getResultSignature(grid) !== pendingResultSignature;

            if (
                !pendingRenderedEventSeen &&
                !gridChanged &&
                !rowsCleared &&
                !signatureChanged
            ) {
                return;
            }

            completePendingRunQueryRefresh();
            return;
        }

        updateTopLevelTitleCounts(grid);

        if (getTopLevelRows(grid).length === 0) {
            initialCollapseComplete = false;
            scheduleProcessing();
        }
    });

    function start() {
        if (!document.documentElement) {
            return;
        }

        ensurePlaceholderStyles();
        observer.observe(document.documentElement, {
            childList: true,
            attributes: true,
            attributeFilter: [
                'aria-expanded',
                'aria-label',
                'aria-level',
                'aria-rowindex',
                'class',
                'data-id',
                'data-index',
                'data-row-index',
                'data-work-item-id',
                'id',
                'title',
            ],
            characterData: true,
            subtree: true,
        });
        document.addEventListener(
            'click',
            (event) => {
                if (shouldArmRunQueryRefresh(event.target)) {
                    armPendingRunQueryRefresh();
                }
            },
            true,
        );
        scheduleProcessing(0);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start, { once: true });
    } else {
        start();
    }
})();
