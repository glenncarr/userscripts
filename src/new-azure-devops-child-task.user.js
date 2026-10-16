// ==UserScript==
// @name         New Azure DevOps child task
// @namespace    https://github.com/glenncarr/userscripts
// @version      1.0
// @downloadURL  https://raw.githubusercontent.com/glenncarr/userscripts/main/src/new-azure-devops-child-task.user.js
// @description  Adds Dev/Review child Task shortcuts to Add link; Ctrl+click immediately saves the Task assigned to the current user without a dialog.
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
// Normal clicks prefill the native Add link dialog for confirmation.
// Ctrl+click saves an assigned child Task, then invokes the parent's Refresh command.
// Verified against Azure DevOps Server 2022 (Dev17.M153).

(function () {
    'use strict';

    const ITEM_ATTRIBUTE = 'data-new-child-task';
    const LOG_PREFIX = '[new-azure-devops-child-task]';
    const TIMEOUT = 10000;
    let preparing = false;
    let linkButton = null;
    let ctrlHeld = false;
    let hintId = 0;

    function updateTaskLabels(held) {
        ctrlHeld = held;
        for (const row of document.querySelectorAll(`[${ITEM_ATTRIBUTE}]`)) {
            const title = row.getAttribute(ITEM_ATTRIBUTE);
            const button = row.querySelector('button[role="menuitem"]');
            const text = button.querySelector('.ms-ContextualMenu-itemText');
            const label = held
                ? `Create ${title} Task - assigned to you`
                : `New ${title} Task`;
            if (text.textContent !== label) {
                text.textContent = label;
                button.name = label;
                button.setAttribute('aria-label', label);
            }
        }
    }

    document.addEventListener('keydown', (event) => updateTaskLabels(event.ctrlKey), true);
    document.addEventListener('keyup', (event) => updateTaskLabels(event.ctrlKey), true);
    window.addEventListener('blur', () => updateTaskLabels(false));
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            updateTaskLabels(false);
        }
    });

    document.addEventListener('click', (event) => {
        updateTaskLabels(event.ctrlKey);
        const button = event.target.closest?.('button.add-new-item-component-button');
        if (button) {
            linkButton = button;
        }
    }, true);

    function getParentWorkItem() {
        const forms = [...document.querySelectorAll('.work-item-form')].filter(
            (form) => form.getClientRects().length > 0,
        );
        const form = linkButton?.isConnected
            ? linkButton.closest('.work-item-form')
            : forms.length === 1 ? forms[0] : null;
        const parent = form && window.jQuery(form).data('tfsEnhancements')
            ?.find((control) => control._workItem)?._workItem;
        if (!parent || !Number.isInteger(parent.id) || parent.id <= 0) {
            throw new Error('Open a saved parent work item before creating a child Task.');
        }
        return parent;
    }

    function showStatus(message, url) {
        let status = document.getElementById('new-child-task-status');
        if (!status) {
            status = document.createElement('div');
            status.id = 'new-child-task-status';
            status.setAttribute('role', 'status');
            status.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:1000;'
                + 'max-width:440px;padding:12px;border:1px solid #888;'
                + 'background:var(--background-color,#fff);'
                + 'color:var(--text-primary-color,#222);box-shadow:0 2px 8px #888;';
            document.body.appendChild(status);
        }
        const text = document.createElement(url ? 'a' : 'span');
        text.textContent = message;
        if (url) {
            text.href = url;
            text.target = '_blank';
            text.rel = 'noopener';
        }
        const close = document.createElement('button');
        close.textContent = 'Dismiss';
        close.style.cssText = 'margin-left:12px;padding:4px 8px;'
            + 'color:inherit;background:transparent;border:1px solid currentColor;'
            + 'border-radius:2px;font:inherit;cursor:pointer;';
        close.addEventListener('click', () => status.remove());
        status.replaceChildren(text, close);
    }

    function refreshParent(parent) {
        const form = [...document.querySelectorAll('.work-item-form')].find(
            (element) => window.jQuery(element).data('tfsEnhancements')
                ?.some((control) => control._workItem === parent),
        );
        // Do not refresh a different item if the user navigated during the save.
        if (!form) {
            return;
        }
        const refresh = form.querySelector('[command="refresh-work-item"]');
        if (!refresh || refresh.getAttribute('aria-disabled') === 'true'
            || refresh.classList.contains('disabled')) {
            throw new Error('The parent work item Refresh command is unavailable.');
        }
        refresh.click();
    }

    async function saveTask(title, nativeItem) {
        if (preparing) {
            return;
        }
        preparing = true;
        try {
            const parent = getParentWorkItem();
            const identity = parent.store.getTfsContext().currentIdentity;
            if (!identity?.uniqueName) {
                throw new Error('The signed-in user identity could not be determined.');
            }
            const { WorkItemLink } = window.require(
                'WorkItemTracking/Scripts/TFS.WorkItemTracking',
            );
            const parentLink = parent.store.findLinkType('System.LinkTypes.Hierarchy')
                ?.reverseEnd;
            if (!parentLink) {
                throw new Error('The Parent/Child link type is not available.');
            }
            // Dismiss the menu without invoking its dialog-opening command.
            nativeItem.dispatchEvent(new KeyboardEvent('keydown', {
                key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true,
            }));
            showStatus(`Creating ${title} Task...`);
            const type = await new Promise((resolve, reject) => {
                parent.project.beginGetWorkItemType('Task', resolve, reject);
            });
            const task = type.create();
            for (const [field, value] of [
                ['System.Title', title],
                ['System.AssignedTo', identity.uniqueName],
                ['System.AreaPath', parent.getFieldValue('System.AreaPath')],
                ['System.IterationPath', parent.getFieldValue('System.IterationPath')],
            ]) {
                if (!task.setFieldValue(field, value)) {
                    throw new Error(`Could not set ${field} on the new Task.`);
                }
            }
            task.addLink(WorkItemLink.create(task, parentLink, parent.id));
            await new Promise((resolve, reject) => task.beginSave(resolve, reject));
            if (!Number.isInteger(task.id) || task.id <= 0) {
                throw new Error('The save returned no Task ID. Check the parent before retrying.');
            }
            const context = parent.store.getTfsContext();
            const url = new URL(
                `${context.contextData.collection.relativeUri}`
                + `${encodeURIComponent(parent.project.name)}/_workitems/edit/${task.id}`,
                window.location.origin,
            );
            const message =
                `Created ${title} Task ${task.id}, assigned to ${identity.displayName}.`;
            showStatus(message, url.href);
            try {
                refreshParent(parent);
            } catch (error) {
                console.error(`${LOG_PREFIX} Task saved, but parent refresh failed.`, error);
                showStatus(
                    `${message} Automatic refresh failed: ${error.message || String(error)} `
                    + 'Refresh the parent manually; do not create the Task again.',
                    url.href,
                );
            }
        } catch (error) {
            console.error(`${LOG_PREFIX} Failed to save the child Task.`, error);
            showStatus(
                `Could not create the ${title} Task: ${error.message || String(error)}. `
                + 'Check the parent before retrying; the server may have processed the save.',
            );
        } finally {
            preparing = false;
        }
    }

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
                    items[index].dispatchEvent(new MouseEvent('click', {
                        bubbles: true, ctrlKey: event.ctrlKey,
                    }));
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
            list.style.width = 'min(280px, calc(100vw - 32px))';
            const hint = document.createElement('li');
            hint.setAttribute('role', 'presentation');
            const separator = document.createElement('div');
            separator.setAttribute('role', 'separator');
            separator.style.cssText = 'border-top:1px solid currentColor;margin-top:4px;';
            const heading = document.createElement('span');
            heading.textContent = 'Task shortcuts';
            heading.style.cssText = 'display:block;padding:8px 12px 0;font-weight:600;';
            const note = document.createElement('span');
            note.id = `new-child-task-hint-${++hintId}`;
            note.setAttribute('role', 'note');
            note.textContent = 'Ctrl+click either task to create immediately, assigned to you';
            note.style.cssText = 'display:block;padding:4px 12px 8px;font-size:12px;'
                + 'line-height:18px;white-space:normal;overflow-wrap:break-word;'
                + 'box-sizing:border-box;max-width:100%;color:inherit;';
            hint.append(separator, heading, note);
            template.after(hint);
            let previousItem = hint;
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
                button.setAttribute('aria-describedby', note.id);
                button.title = 'Click to prefill the dialog; Ctrl+click to save assigned to you.';
                button.tabIndex = -1;
                text.textContent = label;
                button.addEventListener('click', (event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    if (event.ctrlKey) {
                        void saveTask(title, nativeItem);
                    } else {
                        void prepareTask(nativeItem, title);
                    }
                });
                previousItem.after(row);
                previousItem = row;
            }
            updateTaskLabels(ctrlHeld);
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
