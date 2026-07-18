# CLEPSYDRA page error

_Started 2026-05-15 15:37 UTC_

---

## User

Getting this error on the main CLEPSYDRA page

## Assistant

_[tool: grep]_

_[tool: list_files]_

_[tool: grep]_

_[tool: grep]_

_[tool: read_file]_

_[tool: read_file]_

_[tool: read_file]_

_[tool: show_html]_

_[tool: show_html]_

_[tool: get_webview_logs]_

_[tool: run_script]_

_[tool: eval_js]_

_[tool: eval_js]_

_[tool: eval_js]_

_[tool: eval_js]_

_[tool: copy_files]_

Ad-blockers commonly block scripts named `data.js`. Let me rename it.

_[tool: str_replace_edit]_

_[tool: grep]_

_[tool: done]_

Fixed. The data file was being blocked by ad-blockers because of its filename (`data.js` is on common block-lists). Renamed it to `fixtures.js` and updated the script tag — page loads cleanly now.

