// ==UserScript==
// @name         Collapse Azure DevOps query items
// @namespace    https://github.com/glenncarr/userscripts
// @version      1.0.0
// @description  Collapse expanded top-level work items when an Azure DevOps query result is first rendered.
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

    let activeGrid = null;
    let initialCollapseComplete = false;
    let processing = false;
    let scheduled = false;

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

            const clicks = await collapseExpandedTopLevelRows(grid);
            await wait(CLICK_SETTLE_DELAY);

            if (grid !== activeGrid || grid !== findGrid()) {
                scheduleProcessing(0);
                return;
            }

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
            activeGrid = grid;
            initialCollapseComplete = false;
            scheduleProcessing();
            return;
        }

        if (!grid || !initialCollapseComplete) {
            scheduleProcessing();
            return;
        }

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
        scheduleProcessing(0);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start, { once: true });
    } else {
        start();
    }
})();
