# userscripts

Userscripts for [Greasemonkey](https://www.greasespot.net/) / [Violentmonkey](https://violentmonkey.github.io/) that improve Azure DevOps workflows.

## Installation

1. Install a userscript manager:
   - **Chrome / Edge:** [Violentmonkey](https://chromewebstore.google.com/detail/violentmonkey/jinjaccalgkegednnccohejagnlnfdag)
   - **Firefox:** [Violentmonkey](https://addons.mozilla.org/firefox/addon/violentmonkey/) or [Greasemonkey](https://addons.mozilla.org/firefox/addon/greasemonkey/) (Greasemonkey isn't available for Chrome)
2. Click an **Install** link below; your userscript manager will prompt you to install it.
3. Make sure scripts are enabled:
   - The userscript manager extension is turned on, and each installed script is enabled in its dashboard.
   - **Chrome / Edge:** open the extension's details page (`chrome://extensions` or `edge://extensions`) and turn on **Allow User Scripts**. On older browser versions, turn on **Developer mode** instead.
   - Reload the Azure DevOps page after installing or enabling a script.

## Scripts

| Script | Description | Install |
| --- | --- | --- |
| Collapse Azure DevOps query items | In query results: collapses all expanded top-level rows and selects the first one; adds a `(related/predecessors/successors)` link count to each top-level Patch title; and shows Patches with a `20xx (placeholder)` Commitment in gray italics. | [Install](https://github.com/glenncarr/userscripts/raw/refs/heads/main/src/collapse-azure-devops-query-items.user.js) |
| Copy Azure DevOps work item link | Adds a copy button to query result rows that copies the work item and its Related items as linked lines (`ID: Title`). Makes **Copy as HTML** / Ctrl+C copy the selected items in the same format, and removes the type prefix (e.g. "Bug", "Product Backlog Item") from **Copy work item title**. | [Install](https://github.com/glenncarr/userscripts/raw/refs/heads/main/src/copy-azure-devops-work-item-link.user.js) |
| Mark Azure DevOps Patch work item Done | Adds a check-mark button to top-level Patch rows in query results. When the Patch is QA Complete and all its Related Bugs / PBIs are Dev Complete, it sets them all to **Done** without saving, so a single **Save Items** saves them. Works on multiple selected Patches. | [Install](https://github.com/glenncarr/userscripts/raw/refs/heads/main/src/mark-azure-devops-patch-work-item-done.user.js) |
| New Azure DevOps child task | Adds **New Dev Task** and **New Review Task** below **New item** in the work item's **Add link** menu, in query views and standalone work items. Opens the native dialog with link type **Child**, work item type **Task**, and title **Dev** or **Review** prefilled; confirm with **OK**. | [Install](https://github.com/glenncarr/userscripts/raw/refs/heads/main/src/new-azure-devops-child-task.user.js) |
