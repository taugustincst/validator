# eCW Security Settings Validator

Checks the security settings (user permissions) configured in **eClinicalWorks (eCW)** against
the **baseline spreadsheet** that says what each user or role is supposed to have. It shows you
what each document contains, pairs the users and settings, and reports every discrepancy as a
concrete action: what to remove in eCW, what to grant, what to review.

Plain Node.js (≥ 20), **no dependencies**: it reads and writes `.xlsx` itself. Nothing leaves the
machine.

```
ecw-validate validate --baseline baseline.xlsx --actual ecw-export.xlsx --out report.xlsx
```

```
eCW security settings validation — FAIL
  baseline:   baseline.xlsx [Permissions; grid, settings down / users across; roles expanded to users]
  eCW export: ecw-export.xlsx [Security Settings; one row per user + setting]
  users: 9 in baseline, 9 in eCW, 8 in both
  settings: 30 in baseline, 31 in eCW, 30 in both
  compared 240 user/setting pairs: 235 match
  findings: 3 high, 4 medium, 2 low, 6 info

  Check how the files were read:
   ! eCW export: sheet "Security Settings": values other than yes/no were kept as levels and compared as text: "view only"×1

  What to do, per user:
   cnguyen
     REMOVE  Rx > Prescribe medications
   efoster
     REMOVE  Admin > Security settings
   bpatel
     GRANT   Progress Notes > Lock progress notes
   gkim
     GRANT   Billing > Post payments
   dlee
     REVIEW  Orders > Order labs: eCW has view only, baseline wants Y
   ijones — expected by the baseline but not in eCW — create the user, or retire the baseline row
   ztemp — not in the baseline but holds grants in eCW — add to the baseline or remove the user

report written to report.xlsx
```

## Run it

```bash
git clone https://github.com/taugustincst/validator
cd validator
npm test                       # 28 tests, a few seconds
npm start                      # web UI at http://127.0.0.1:8787
```

On Windows, double-click **`start-validator.cmd`** (on macOS/Linux, `./start-validator.sh`): it
checks that Node.js is installed, starts the local web UI and opens it in your browser. Node.js LTS
is at <https://nodejs.org>; nothing else is needed. `npm link` puts `ecw-validate` on your PATH;
otherwise use `node bin/ecw-validate.js`.

## The web UI

1. **Drop the baseline.** The page immediately shows how it was read: which sheet, whether it was
   understood as a grid or a list, every user and setting it found, the values seen, any warnings,
   and the raw rows with the detected header row highlighted. If it read the wrong sheet or column,
   fix it under *Reading options* and the preview updates.
2. **Drop the eCW export.** Same preview.
3. **Validate.** A verdict, then four views:
   - **What to do** — per user: REMOVE (excess access), GRANT (missing access), REVIEW (level
     mismatches, settings the baseline does not cover), and users that exist on only one side.
   - **Findings** — every discrepancy, sortable and filterable, worst first.
   - **Side by side** — pick any user and see every setting with what the baseline says next to
     what eCW says, colour-coded; toggle *only differences*.
   - **By setting** and **Matches** — where problems concentrate, and which names were paired by
     alias or by bare name rather than exactly (so you can check them).
4. **Download** the Excel report, the findings as CSV, or the whole result as JSON.

## The two inputs

**The eCW export (what users actually have).** In eCW go to *Admin → Security Settings* (or
*Reports → User Security Settings*), pick the users, and *Print / Export* to Excel. Save as `.xlsx`
or `.csv`. The typical export is one row per user and setting, with a title block above the header
and the user name printed once per block; all of that is handled:

| User Name | Category | Security Setting | Value |
|---|---|---|---|
| JDOE | Patient | Delete patient | No |
| | Patient | Merge patients | No |
| | Progress Notes | Lock progress notes | Yes |
| ASMITH | Patient | Delete patient | Yes |

An export with one tab per user is merged with `--sheet all` (or *Sheet → all sheets* in the UI).

**The baseline (what users should have).** Whatever your practice already keeps, as long as it is
a spreadsheet. Two shapes are recognised:

*A grid* — settings down, users (or roles) across, `Y`/`N`, `Yes`/`No`, `✓`, `X` or blank in the
cells. An optional Category column, or section-heading rows with no values, groups the settings.
The grid can also be the other way round (users down, settings across).

| Category | Security Setting | Provider | Front Desk | Nurse | Biller | Practice Admin |
|---|---|---|---|---|---|---|
| Patient | Delete patient | N | N | N | N | Y |
| Progress Notes | Lock progress notes | Y | N | N | N | N |

*A list* — one row per user and setting, like the eCW export.

**Roles.** If the grid's columns are roles rather than people, add a second sheet named `Users`
(or `Roles`, `Mapping`, `Staff`…) with a `User` column and a `Role` column. Each role's settings are
expanded to its users before the comparison. Users whose role has no column, and columns that are
not roles, are pointed out.

## How names and values are matched

Accuracy depends on pairing the right user with the right user and the right setting with the
right setting. The validator does this in three steps and tells you which one applied:

1. **Exact**, ignoring case, punctuation and repeated spaces: `JDOE` = `jdoe`,
   `Progress Notes > Lock` = `Progress notes: Lock`.
2. **Aliases** you supply, for names the two documents simply spell differently
   (`--aliases names.csv`, or drop the file in the UI). Two columns, baseline name then eCW name,
   with an optional first column `user` or `setting`:
   ```
   user,jdoe,"Doe, John"
   setting,Notes > Lock,Progress Notes > Lock progress note
   ```
3. **By bare name**, when one document has categories and the other does not: `Lock progress notes`
   pairs with `Progress Notes > Lock progress notes` if that name is unique on both sides.
   Listed under *Matches* so it can be checked; switch off with `--no-match-by-name`.

Anything still unmatched is reported with its closest candidate (*"closest eCW user: JSMITH2"*),
but it is **never** paired automatically: a wrong guess would hide a real discrepancy. If the
suggestion is right, add it to the aliases file.

**Values.** `Y`, `Yes`, `True`, `1`, `X`, `✓`, `Allow`, `Granted`, `Enabled`, `Full` all mean
granted; `N`, `No`, `False`, `0`, blank, `-`, `Deny`, `None`, `N/A` mean not granted. Anything else
(`Read Only`, `View`) is kept as a level and compared as text, and the reading warnings say so.
In a grid a blank cell means "not granted"; `--blank-is-unknown` makes it "not stated" instead.

## What the findings mean

| Type | Severity | Meaning |
|---|---|---|
| Excess access | **High** | eCW grants it, the baseline does not. Remove it in eCW, or approve it in the baseline. |
| User not in baseline | **High** (Low if they hold no grants) | eCW has a user the baseline never mentions; every grant they hold is unreviewed. |
| Missing access | Medium | The baseline grants it, eCW does not. |
| Different level | Medium | Both set, to different levels (e.g. `View Only` vs `Y`). |
| User not in eCW | Medium | The baseline expects a user eCW does not list: not set up, deactivated, or spelled differently. |
| Setting not in baseline | Low (Info if not granted) | eCW lists a setting the baseline does not cover. Decide and add it to the baseline. |
| Setting not in eCW | Low | The baseline names a setting the export does not have: renamed in eCW, or a baseline typo. |

The run **passes** when there are no High or Medium findings. The CLI exits `1` on a failing run
(`--fail-on high|medium|low|none` changes the threshold), so it can gate a scheduled audit.

## The Excel report

`--out report.xlsx` (or *Download report* in the UI) writes seven sheets:

- **Summary** — verdict, how each file was read, counts, and any reading warnings.
- **Actions** — per user: remove / grant / review, plus the user's baseline role.
- **Findings** — one row per discrepancy with expected and actual values, colour-coded, filterable,
  with the source row numbers in both files.
- **Side by side** — every setting × every user; a cell reads `N → Y (Yes)` where they differ and
  is coloured by outcome.
- **Users**, **Settings** — where the discrepancies concentrate.
- **Matches** — names paired by alias or bare name.

`--out findings.csv` or `--out result.json` write those formats instead; `--json` prints the full
result to stdout.

## Checking how a file was read

```
ecw-validate inspect ecw-export.xlsx
```
```
ecw-export.xlsx: 1 sheet(s)
  • Security Settings: 282 rows × 4 cols; header on row 4: "User Name", "Category", "Security Setting", "Value"

read as: sheet "Security Settings" — one row per user + setting
  278 records, 9 users, 31 settings
  users: AGARCIA, BPATEL, CNGUYEN, …
  values: N×176, Y×101, view only×1
  ! sheet "Security Settings": values other than yes/no were kept as levels …

  first records:
    row    5  AGARCIA   Patient > View patient demographics   Y (cell: "Yes")
```

Warnings cover: rows skipped because they had no user above them, columns with values but no
header, duplicated user/setting pairs (the last one wins), non-yes/no values, other sheets that
also contain permission data, and role-mapping gaps. The same information appears in the UI
preview and on the report's Summary sheet.

## CLI reference

```
ecw-validate validate --baseline <file> --actual <file> [--out report.xlsx]
    --sheet NAME|all              sheet to read (default: first with permission data; "all" merges every sheet)
    --layout long|matrix          force a layout
    --orientation permissions-down|users-down
    --user-col / --permission-col / --value-col / --category-col NAME
    --roles-sheet NAME            user → role sheet in the baseline
    --blank-is-unknown            a blank grid cell is "not stated" rather than "not granted"
    (prefix any of the above with --baseline- or --actual- for one file only)
    --aliases FILE                names that differ between the documents (see above)
    --no-match-by-name            do not pair settings by bare name
    --ignore-users a,b*           --only-users a,b*      --ignore-settings "Labs > *"
    --no-unknown-settings         hide eCW settings the baseline does not cover
    --include-ok                  list matching pairs too
    --json | --quiet | --limit N  output control
    --fail-on high|medium|low|none   exit-code threshold (default medium)
ecw-validate inspect <file> [reading options]   how the file is read
ecw-validate serve [--port N] [--host H] [--open]  the web UI
ecw-validate example [dir]                     write a sample baseline + eCW export
```

As a library:

```js
import { validate, inspect, buildReport } from 'ecw-security-validator';
const { result, meta } = validate('baseline.xlsx', 'ecw-export.xlsx', { compare: { ignoreUsers: 'test*' } });
result.actions      // [{ user, remove: [...], grant: [...], review: [...], status }]
result.detail       // [{ user, inBaseline, inEcw, role, settings: [{ permission, expected, actual, type }] }]
result.findings     // [{ severity, type, user, permission, expected, actual, note, suggestion }]
fs.writeFileSync('report.xlsx', buildReport(result, meta));
```

## Try it

```bash
npm run examples     # writes examples/baseline.xlsx and examples/ecw-export.xlsx
npm run demo         # validates them → examples/report.xlsx (exit code 1: it has planted findings)
```

## Layout

```
bin/ecw-validate.js     CLI
src/xlsx.js             .xlsx / .csv reader and .xlsx writer (ZIP + XML, no dependencies)
src/parse.js            spreadsheet → permission records: header/layout detection, values, roles, warnings
src/validate.js         matching (exact / alias / by name, suggestions), findings, actions, side-by-side detail
src/report.js           Excel report, terminal summary, CSV
src/index.js            validate(), inspect(), loadAliases()
src/server.js           local HTTP server for the web UI
web/index.html          the web UI (single file)
examples/               sample generator
test/                   node --test suite (also run on Windows and Linux in GitHub Actions)
```

## Limitations

- Legacy `.xls` (Excel 97–2003) is not read; save as `.xlsx` or `.csv` first.
- eCW's report formats vary by version and module. If a file is read wrongly, the preview shows
  it; pick the sheet, layout or column names explicitly.
- The validator compares the documents you give it; it does not connect to eCW.
