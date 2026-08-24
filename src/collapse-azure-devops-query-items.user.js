// ==UserScript==
// @name         Collapse Azure DevOps query items
// @namespace    https://github.com/glenncarr/userscripts
// @version      1.2.8
// @downloadURL  https://raw.githubusercontent.com/glenncarr/userscripts/main/src/collapse-azure-devops-query-items.user.js
// @description  Collapse expanded top-level work items when Azure DevOps query results first render or Run query is selected.
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
    const EXCLUDED_PATCH_DESCENDANT_WORK_ITEM_TYPE = 'tkc product release';

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

    function getGridWorkItemType(provider, workItemId) {
        const rowData = getCollectionValue(provider?._pageData, workItemId);
        if (!rowData || typeof rowData !== 'object') {
            return null;
        }

        return getNormalizedTitleText(rowData[1]);
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
        return (text || '').replace(/\s+/g, ' ').trim().toLowerCase();
    }

    function getNormalizedRowTextFromCell(row, index) {
        const cell = row.querySelectorAll('[role="gridcell"]')[index];
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
        return getNormalizedRowTextFromCell(row, 3);
    }

    function isPatchTopLevelRow(row) {
        return getRowWorkItemType(row) === PATCH_WORK_ITEM_TYPE_TEXT;
    }

    function isExcludedPatchDescendantTypeRow(row) {
        return (
            getRowWorkItemType(row) === EXCLUDED_PATCH_DESCENDANT_WORK_ITEM_TYPE
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

            if (workItemType !== EXCLUDED_PATCH_DESCENDANT_WORK_ITEM_TYPE) {
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

    function captureExcludedCountsByTopLevelRow(grid) {
        return captureGridExcludedCounts(grid) || captureRenderedExcludedCounts(grid);
    }

    function getGridCountState(grid) {
        let state = gridCountStates.get(grid);
        if (!state) {
            state = {
                renderedFallbackCounts: {},
                excludedCounts: {},
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
        excludedFallbackCounts = null,
    ) {
        const state = getGridCountState(grid);
        if (renderedFallbackCounts) {
            state.renderedFallbackCounts = renderedFallbackCounts;
        } else {
            refreshRenderedFallbackCounts(grid, state);
        }

        if (excludedFallbackCounts) {
            state.excludedCounts = excludedFallbackCounts;
        } else {
            refreshExcludedCounts(grid, state);
        }

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
            let excludedCount = 0;
            const dataIndex = getRowDataIndex(row, gridId);
            if (
                isPatchTopLevelRow(row) &&
                dataIndex !== null &&
                Object.prototype.hasOwnProperty.call(
                    state.excludedCounts,
                    dataIndex,
                )
            ) {
                excludedCount = state.excludedCounts[dataIndex];
            } else if (isPatchTopLevelRow(row)) {
                excludedCount = getRenderedExcludedPatchDescendantCount(row);
            }
            const adjustedCollapsedChildrenCount =
                collapsedChildrenCount === null
                    ? null
                    : Math.max(0, collapsedChildrenCount - excludedCount);
            const nextCount =
                adjustedCollapsedChildrenCount === null
                    ? unknownCountToken
                    : adjustedCollapsedChildrenCount;
            const previousCount = renderedTitleCounts.get(titleLink);
            if (previousCount === nextCount) {
                return;
            }

            const titleText = titleLink.getAttribute('title') || titleLink.textContent || '';
            titleLink.setAttribute('title', titleText);

            if (adjustedCollapsedChildrenCount === null) {
                titleLink.textContent = titleText;
            } else {
                titleLink.textContent =
                    adjustedCollapsedChildrenCount > 0
                        ? `${titleText} (${adjustedCollapsedChildrenCount})`
                        : titleText;
            }

            renderedTitleCounts.set(titleLink, nextCount);
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
            activeGrid = null;
            initialCollapseComplete = false;
            return;
        }

        if (grid !== activeGrid) {
            activeGrid = grid;
            initialCollapseComplete = false;
        }

        if (initialCollapseComplete) {
            return;
        }

        processing = true;

        try {
            const hasInitialRows = await waitForInitialRows(grid);

            if (!hasInitialRows || grid !== findGrid()) {
                scheduleProcessing(0);
                return;
            }

            const renderedFallbackCounts = captureRenderedFallbackCounts(grid);
            const excludedFallbackCounts = captureExcludedCountsByTopLevelRow(grid);
            const clicks = await collapseExpandedTopLevelRows(grid);
            await wait(CLICK_SETTLE_DELAY);

            if (grid !== activeGrid || grid !== findGrid()) {
                scheduleProcessing(0);
                return;
            }

            updateTopLevelTitleCounts(
                grid,
                renderedFallbackCounts,
                excludedFallbackCounts,
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
            activeGrid = grid;
            initialCollapseComplete = false;
            scheduleProcessing();
            return;
        }

        if (!grid || !initialCollapseComplete) {
            scheduleProcessing();
            return;
        }

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

        observer.observe(document.documentElement, {
            childList: true,
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
