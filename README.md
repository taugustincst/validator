# eCW Security Settings Validator

Checks the security settings (user permissions) configured in **eClinicalWorks (eCW)** against
the **baseline spreadsheet** that says what each user or role is supposed to have, and reports
every discrepancy: access eCW grants that the baseline does not, access the baseline requires that
eCW lacks, users missing on either side, and settings the two documents disagree about.

Plain Node.js (≥ 20), **no dependencies**: it reads and writes `.xlsx` itself. Nothing leaves the
machine.

```
ecw-validate validate --baseline baseline.xlsx --actual ecw-export.xlsx --out report.xlsx
```

```
eCW security settings validation — FAIL
  baseline: baseline.xlsx [Permissions, matrix (permissions-down), roles expanded to users]
  eCW export: ecw-export.xlsx [Security Settings, long (one row per user + setting)]
  users: 9 in baseline, 9 in eCW, 8 in both
  settings: 30 in baseline, 31 in eCW, 30 in both
  compared 240 user/setting pairs: 235 match
  findings: 3 high, 4 medium, 2 low, 6 info

  HIGH   Excess access            cnguyen  Rx > Prescribe medications            [expected N | eCW Y (Yes)]
  HIGH   Excess access            efoster  Admin > Security settings             [expected N | eCW Y (Yes)]
  HIGH   User not in baseline     ztemp                                          [expected — | eCW 30 settings (3 granted)]
  MEDIUM Missing access           bpatel   Progress Notes > Lock progress notes  [expected Y | eCW N (No)]
  MEDIUM Different level          dlee     Orders > Order labs                   [expected Y | eCW view only]
  MEDIUM Missing access           gkim     Billing > Post payments               [expected Y | eCW N (No)]
  MEDIUM User not in eCW          ijones                                         [expected 30 settings (8 granted) | eCW —]
  LOW    Setting not in baseline  agarcia  Telehealth > Start video visit        [expected — | eCW Y (Yes)]
  …
report written to report.xlsx
```

## Install

```bash
git clone https://github.com/taugustincst/validator
cd validator
npm link          # optional: puts `ecw-validate` on your PATH; otherwise use `node bin/ecw-validate.js`
npm test
```

## The two inputs

**1. The eCW export (what users actually have).** In eCW go to *Admin → Security Settings*
(or *Reports → User Security Settings*), pick the users, and *Print / Export* to Excel. Save it as
`.xlsx` or `.csv`. The typical export is one row per user and setting, with a title block above the
header and the user name printed once per block:

| User Name | Category | Security Setting | Value |
|---|---|---|---|
| JDOE | Patient | Delete patient | No |
| | Patient | Merge patients | No |
| | Progress Notes | Lock progress notes | Yes |
| ASMITH | Patient | Delete patient | Yes |

**2. The baseline (what users should have).** Whatever your practice already keeps, as long as it
is a spreadsheet. Two shapes are recognised:

*A grid* — settings down, users (or roles) across, `Y`/`N`, `Yes`/`No`, `✓`, `X` or blank in the cells.
An optional Category column, or section-heading rows with no values, groups the settings:

| Category | Security Setting | Provider | Front Desk | Nurse | Biller | Practice Admin |
|---|---|---|---|---|---|---|
| Patient | Delete patient | N | N | N | N | Y |
| Progress Notes | Lock progress notes | Y | N | N | N | N |

The grid can also be the other way round (users down, settings across).

*A list* — one row per user and setting, like the eCW export.

**Roles.** If the grid's columns are roles rather than people, add a second sheet named `Users`
(or `Roles`, `Mapping`, `Staff`…) with a `User` column and a `Role` column. Each role's settings are
expanded to its users before the comparison. The report says when this happened.

Column names are detected from the header row (`User`, `User Name`, `Login`, `Staff`…;
`Security Setting`, `Permission`, `Item`…; `Value`, `Access`, `Allowed`…; `Category`, `Module`,
`Section`…). When a file uses other names, say so with `--user-col`, `--permission-col`,
`--value-col`, `--category-col`, `--layout` and `--orientation` (prefix with `--baseline-` or
`--actual-` to apply to one file only). `ecw-validate inspect <file>` shows how a file is read.

Users and settings are matched case-insensitively, ignoring punctuation and repeated spaces, so
`JDOE` matches `jdoe` and `Progress Notes > Lock` matches `Progress notes: Lock`.

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

## The report

`--out report.xlsx` writes a workbook with three sheets: **Summary** (verdict, files, counts by
severity and type), **Findings** (one row per discrepancy with expected vs. actual values, colour
coded, filterable, with the source row numbers in both files) and **Users** (findings per user).
`--out findings.csv` or `--out result.json` write those formats instead; `--json` prints the full
result to stdout.

## Web UI

```bash
npm start            # or: ecw-validate serve --port 8787
```

Open <http://127.0.0.1:8787>, drop the two files in, click *Validate*, filter and sort the
findings, download the report. The page talks only to this local process; it binds to loopback
unless you pass `--host`.

## CLI reference

```
ecw-validate validate --baseline <file> --actual <file> [--out report.xlsx]
    --sheet NAME                  sheet to read (default: first sheet with permission data)
    --layout long|matrix          force a layout
    --orientation permissions-down|users-down
    --user-col / --permission-col / --value-col / --category-col NAME
    --roles-sheet NAME            user → role sheet in the baseline
    --blank-is-unknown            a blank grid cell is "not stated" rather than "not granted"
    (prefix any of the above with --baseline- or --actual- for one file only)
    --ignore-users a,b*           --only-users a,b*      --ignore-settings "Labs > *"
    --no-unknown-settings         hide eCW settings the baseline does not cover
    --include-ok                  list matching pairs too
    --json | --quiet | --limit N  output control
    --fail-on high|medium|low|none   exit-code threshold (default medium)
ecw-validate inspect <file>       how the file is read: sheets, layout, users, settings, values
ecw-validate serve [--port N]     the web UI
ecw-validate example [dir]        write a sample baseline + eCW export (examples/)
```

Use it as a library too:

```js
import { validate, buildReport } from 'ecw-security-validator';
const { result, meta } = validate('baseline.xlsx', 'ecw-export.xlsx', { compare: { ignoreUsers: 'test*' } });
if (!result.pass) fs.writeFileSync('report.xlsx', buildReport(result, meta));
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
src/parse.js            spreadsheet → permission records: layout detection, value normalisation, role expansion
src/validate.js         the comparison and its finding types
src/report.js           Excel report, terminal summary, CSV
src/server.js           local HTTP server for the web UI
web/index.html          the web UI (single file)
examples/               sample generator
test/                   node --test suite
```

## Limitations

- Legacy `.xls` (Excel 97–2003) is not read; save as `.xlsx` or `.csv` first.
- eCW's own report formats vary by version and module. If a file is read wrongly, run
  `ecw-validate inspect` on it and pass the column names explicitly.
- The validator compares the documents you give it; it does not connect to eCW.
