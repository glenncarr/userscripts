// ==UserScript==
// @name         New Azure DevOps child task
// @namespace    https://github.com/glenncarr/userscripts
// @version      1.0.0
// @downloadURL  https://raw.githubusercontent.com/glenncarr/userscripts/main/src/new-azure-devops-child-task.user.js
// @description  Adds New Dev Task and New Review Task below New item in the Add link menu, prefilling a new child Task for confirmation.
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
// @inject-into  page
// @noframes
// ==/UserScript==
// Uses the native Add link workflow; the user still confirms with OK.
// Verified against Azure DevOps Server 2022 (Dev17.M153).

(function () {
    'use strict';

    const ITEM_ATTRIBUTE = 'data-new-child-task';
    const LOG_PREFIX = '[new-azure-devops-child-task]';
    const TIMEOUT = 10000;
    let preparing = false;

    function waitFor(read, description) {
        const started = Date.now();
        return new Promise((resolve, reject) => {
            function check() {
                try {
                    const result = read();
                    if (result) {
                        resolve(result);
                    } else if (Date.now() - started >= TIMEOUT) {
                        reject(new Error(`Timed out waiting for ${description}.`));
                    } else {
                        window.setTimeout(check, 50);
                    }
                } catch (error) {
                    reject(error);
                }
            }
            check();
        });
    }

    function getTaskCombo(dialog) {
        const element = dialog.querySelector('#work-item-types');
        const $ = window.jQuery;
        const combo = element && $ && $(element).data('tfsEnhancements')
            ?.find((control) => typeof control.setText === 'function');
        return combo;
    }

    async function prepareTask(nativeItem, title) {
        if (preparing) {
            return;
        }
        preparing = true;
        try {
            const previousDialogs = new Set(document.querySelectorAll('.link-dialog'));
            nativeItem.click();
            const dialog = await waitFor(
                () => [...document.querySelectorAll('.link-dialog')].find(
                    (element) => !previousDialogs.has(element)
                        && element.querySelector('#dialog-label'),
                ),
                'the new linked work item dialog',
            );
            const linkType = await waitFor(
                () => dialog.querySelector('.ms-ComboBox input[role="combobox"]'),
                'the link type selector',
            );
            if (linkType.value !== 'Child') {
                const toggle = linkType.closest('.ms-ComboBox')
                    .querySelector('.ms-ComboBox-CaretDown-button');
                if (!toggle) {
                    throw new Error('The link type dropdown button was not found.');
                }
                toggle.click();
                const childOption = await waitFor(
                    () => [...document.querySelectorAll('[role="option"]')].find(
                        (option) => option.textContent.trim() === 'Child'
                            && option.closest('[role="listbox"]'),
                    ),
                    'the Child link type option',
                );
                childOption.click();
            }
            await waitFor(() => linkType.value === 'Child', 'the Child link type');
            const combo = await waitFor(() => {
                const control = getTaskCombo(dialog);
                return control && control.getBehavior().getDataSource().getItems().length
                    ? control : null;
            }, 'the available work item types');
            if (!combo.getBehavior().getDataSource().getItems().includes('Task')) {
                throw new Error('Task is not an available work item type for this item.');
            }
            combo.setText('Task', true);
            const input = dialog.querySelector('#dialog-label');
            if (!input) {
                throw new Error('The new work item title field was not found.');
            }
            input.value = title;
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
            await waitFor(
                () => combo.getText() === 'Task'
                    && linkType.value === 'Child' && input.value === title,
                'the child Task fields to be populated',
            );
            input.focus();
            input.select();
        } catch (error) {
            console.error(`${LOG_PREFIX} Failed to prepare the child Task.`, error);
            window.alert(
                `Could not prepare the ${title} Task: ${error.message}\n\n`
                + 'Nothing was submitted. Check the Add link fields before confirming.',
            );
        } finally {
            preparing = false;
        }
    }

    function onMenuKeyDown(event) {
        const list = event.currentTarget;
        const items = [...list.querySelectorAll('button[role="menuitem"]')].filter(
            (item) => !item.disabled && item.getAttribute('aria-disabled') !== 'true',
        );
        const index = items.indexOf(document.activeElement);
        if (index < 0) {
            return;
        }
        let nextIndex;
        switch (event.key) {
            case 'ArrowDown':
                nextIndex = (index + 1) % items.length;
                break;
            case 'ArrowUp':
                nextIndex = (index + items.length - 1) % items.length;
                break;
            case 'Home':
                nextIndex = 0;
                break;
            case 'End':
                nextIndex = items.length - 1;
                break;
            case 'Enter':
            case ' ':
                if (items[index].closest(`[${ITEM_ATTRIBUTE}]`)) {
                    event.preventDefault();
                    event.stopPropagation();
                    items[index].click();
                }
                return;
            default:
                return;
        }
        event.preventDefault();
        event.stopPropagation();
        items[nextIndex].focus();
    }

    function addMenuItems() {
        for (const list of document.querySelectorAll('.ms-ContextualMenu-list')) {
            if (list.querySelector(`[${ITEM_ATTRIBUTE}]`)) {
                continue;
            }
            const items = [...list.querySelectorAll('button[role="menuitem"]')];
            const nativeItem = items.find(
                (item) => item.getAttribute('aria-label') === 'New item',
            );
            if (!nativeItem || !items.some(
                (item) => item.getAttribute('aria-label') === 'Existing item',
            ) || nativeItem.getAttribute('aria-disabled') === 'true') {
                continue;
            }
            const template = nativeItem.closest('li');
            if (!template || template.parentElement !== list) {
                continue;
            }
            // Fabric's FocusZone does not register the cloned menu buttons.
            list.addEventListener('keydown', onMenuKeyDown, true);
            let previousItem = template;
            for (const title of ['Dev', 'Review']) {
                const row = template.cloneNode(true);
                const button = row.querySelector('button[role="menuitem"]');
                const text = button.querySelector('.ms-ContextualMenu-itemText');
                if (!text) {
                    console.error(`${LOG_PREFIX} The native menu item label was not found.`);
                    break;
                }
                const label = `New ${title} Task`;
                row.setAttribute(ITEM_ATTRIBUTE, title);
                button.name = label;
                button.setAttribute('aria-label', label);
                button.tabIndex = -1;
                text.textContent = label;
                button.addEventListener('click', (event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    void prepareTask(nativeItem, title);
                });
                previousItem.after(row);
                previousItem = row;
            }
            const updatedItems = list.querySelectorAll('button[role="menuitem"]');
            updatedItems.forEach((item, index) => {
                item.setAttribute('aria-posinset', String(index + 1));
                item.setAttribute('aria-setsize', String(updatedItems.length));
            });
        }
    }

    const observer = new MutationObserver(addMenuItems);
    observer.observe(document.body, { childList: true, subtree: true });
    addMenuItems();
})();
