# Wolog spec

The handoff spec for Wolog, a single-user workout tracker served from the apps server (`apps.marcusbailey.com/wolog/`), behind that server's login. It covers requirements, user stories, and a high-level tech stack. A build effort should be able to start from this document plus [`CONTEXT.md`](../CONTEXT.md) without re-deciding the domain.

Produced by the map [Spec the Wolog workout tracker](https://github.com/marcus-bailey/wolog/issues/1). Each section links its source decisions; see [Sources](#11-sources).

## 1. Purpose and scope

Wolog lets its owner keep several **Routines**, author an **Exercise** library, and log one **Session** of **Sets** per date. Each Session follows a **Day** suggested by the Engaged Routine's rotation. While logging, the owner sees what they did last time.

**In scope**

- Several Routines, exactly one **Engaged Routine**, switched at will.
- A user-authored Exercise library with rename and **Retire**.
- Days with ordered **Lines**, and a rotation of **Turns** per Routine.
- A suggested next Turn with override and **Skip**.
- At most one Session per date, created from a **Snapshot** of its Day.
- Sets that record **Reps**, **Weight** (lb), **Warmup**/**Working**, and an optional **Note**.
- History as a list of Sessions and Skips, plus **Last-time** while logging.
- Backups through the apps server's nightly dumps, with a restore drill.
- Deployment as Docker images on the apps server (AWS Lightsail), at `/wolog/`.

**Out of scope**

- Progress views, charts, PRs, "best Set".
- Auth, identity, and accounts as a product (the apps server's login fronts Wolog; Wolog has none of its own). Multi-user. Cloud sync.
- Native apps, installable PWA, wearables, nutrition, imported programs, social.
- An owner-facing Export or Import.
- Everything ruled out in [Decide what a Set records](https://github.com/marcus-bailey/wolog/issues/4): kg and unit settings, `bw`/`bw+N`, RPE/RIR, timed work, tempo, rest timers, supersets, drop-sets, assisted load, zero-rep Sets.

**Greenfield.** The older `wolog-api` (Express) and `wolog-ui` (React + Amplify) projects are not reused.

## 2. Glossary

[`CONTEXT.md`](../CONTEXT.md) is normative. Every capitalised domain term in this spec means what it says there. Do not use *workout* as a noun. Do not use *skip* for an omitted Exercise; omission is just absence.

## 3. Domain model

This is a logical model, not a schema. Names, keys, and storage are build decisions as long as every invariant holds.

```
Exercise ─┐
          ├─< Day Line >── Day >── Routine ──< Turn >── Day
          └─< Session Line >── Session ──> Routine, Day, Turn?
                     └─< Set
Skip ──> Routine, Day, Turn?
```

| Entity | Fields | Invariants |
| --- | --- | --- |
| **Exercise** | name, retired | Name is unique after normalisation (§4.1). Identity is stable through rename and Retire. |
| **Routine** | name, engaged | Name is unique after normalisation. Once any Routine exists, exactly one is engaged. |
| **Day** | Routine, name, ordered Day Lines | Belongs to one Routine forever. Name is unique within its Routine. |
| **Day Line** | Day, Exercise, position | The same Exercise may appear on more than one Line. |
| **Turn** | Routine, Day, position | Names a Day of the same Routine. Identity survives reordering. A Day may have several Turns. |
| **Session** | date, Routine, Day, Turn (nullable), ordered Session Lines | At most one per civil date across all Routines. Has at least one Set. Date and Routine never change. Day must belong to the Routine. |
| **Session Line** | Session, Exercise, position, ordered Sets | Own copy, not linked to the Day after the Snapshot. |
| **Set** | Reps, Weight, Warmup flag, Note | Reps is a positive integer. Weight is a non-negative decimal in lb. Warmup defaults to false (Working). Note is optional free text. |
| **Skip** | date, Routine, Day, Turn (nullable), order within date | Belongs to the Routine that was engaged when it was made. No Session on that Routine on that date. |

**Pins.** A Session or Skip pins its Routine and Day for good. Its Turn pin may dangle: removing a Turn is always allowed, and a Session or Skip whose Turn is gone is treated as holding no Turn. History always names the Day.

**Derived, never stored:** the suggestion, the cursor, Last-time, and Rest.

**Normalisation** for Exercise, Routine, and Day names: trim, collapse internal whitespace to one space, and compare case-insensitively. A name that is empty after normalisation is invalid. The stored label is the collapsed form from the last create or rename.

**Writes are post-state.** The API accepts the resulting state of a Session (Lines, Sets, Day) and validates the whole. If the result has a Set, it is the same Session. If not, the Session is gone. An illegal result is refused as a whole, and nothing is partly applied.

## 4. Requirements

### 4.1 Exercise library

Source: [How Exercises enter the library](https://github.com/marcus-bailey/wolog/issues/5).

- The library starts empty. There is no starter catalog.
- Create an Exercise from the library screen, or by typing a new name wherever a Line is added (Day editor or Session).
- Typing a name that matches a live Exercise attaches that Exercise, with no confirmation. A case-only match does not rewrite the stored name.
- Typing a name that matches a Retired Exercise is refused, and the refusal points to the Retired Exercise.
- Rename changes the label of the same identity. A rename that collides with another Exercise is refused. There is no merge.
- Retire hides an Exercise from new picks. Existing Day Lines and Session Lines remain and still take Sets. History and Last-time still attach. Un-retire restores picks. A Retired Exercise can be renamed, with the same uniqueness rule.
- Hard-delete is allowed only for an unused Exercise: one on no Day Line and no Session Line, empty Lines included. Otherwise the owner can only Retire it.
- The library lists Retired Exercises in a separate Retired section or filter. Pickers hide them.
- The library screen never adds an Exercise to a Day.

### 4.2 Routines

Sources: [How Days and Routines are authored](https://github.com/marcus-bailey/wolog/issues/10), [What happens when the Engaged Routine switches](https://github.com/marcus-bailey/wolog/issues/7).

- Create a Routine with a name only. It starts with no Days and an empty rotation. There is no wizard.
- The first Routine created is engaged automatically. Later ones are not.
- Rename is a label change. Names are unique.
- **Duplicate** a Routine under a new unique name. This copies every Day with its Lines, and the Turns in order. It copies no Sessions or Skips, does not engage the copy, and keeps no link to the original.
- **Destroy** a Routine:
  - Refused while any Session or Skip pins the Routine or one of its Days. Sessions and Skips are never cascaded.
  - Refused for the Engaged Routine while any other Routine exists. Switch first.
  - If it is the only Routine and nothing pins it, destroy is allowed and returns the app to the no-Routine first-run state.

### 4.3 Days and the rotation

Source: [How Days and Routines are authored](https://github.com/marcus-bailey/wolog/issues/10).

- Create a Day inside a Routine with a name unique within that Routine. A new Day gets one Turn at the end of the rotation.
- Rename is a label change. History shows the current name.
- A Day cannot move to another Routine. **Duplicate** it into the same Routine or another one instead. The copy gets new Lines with the same Exercises in the same order, needs a unique name, gets one Turn at the end of the target rotation, and keeps no link back.
- A Day's Lines are always editable, even after Sessions have Snapshotted the Day: add, attach, create, reorder, remove, and duplicate Exercises. A Line of a Retired Exercise stays. A new Line cannot pick a Retired Exercise.
- **Rotation:**
  - The rotation is an ordered list of Turns, and a Day may have several (A, B, A, C).
  - A Day is on the rotation while it has at least one Turn.
  - **Drop** removes all of a Day's Turns. **Put back** adds one Turn at the end. **Add Turn** adds one more at the end.
  - Turns can be reordered, and old positions are not remembered.
  - Removing a Turn is always allowed.
  - The rotation may be empty.
- **Destroy** a Day:
  - Allowed directly when no Session or Skip pins it. It removes the Day's Turns and Lines, and its Exercises stay in the library.
  - If something pins it, destroy is refused and the refusal offers Drop instead.

### 4.4 Suggestion, override, and Skip

Sources: [Map weekdays to Days](https://github.com/marcus-bailey/wolog/issues/3), as amended by [How Days and Routines are authored](https://github.com/marcus-bailey/wolog/issues/10) and [Prototype the logger and editor screens](https://github.com/marcus-bailey/wolog/issues/11).

Weekdays play no part. The suggestion is computed per Routine, on demand.

1. **Cursor:**
   - Start from the Turn of this Routine's latest-dated Session.
   - Then apply each later Skip's Turn, in date order and then in order within each date.
   - If the cursor Turn no longer exists, walk back through earlier Sessions and Skips to the latest one whose Turn still exists.
2. **Suggestion:** the next Turn after the cursor in the current order, wrapping around.
   - If there are no Sessions or Skips, or none hold a surviving Turn, suggest the first Turn.
   - If the rotation is empty, there is no suggestion.

Further rules:

- **Override:** the owner may pick any Day currently on the Engaged Routine's rotation, including the one just logged. Pickers list Days, not Turns. Picking a Day pins that Day's first Turn at or after the Turn following the cursor, wrapping around. Accepting the suggestion pins the suggested Turn.
- **Backfill** (a new Session dated before this Routine's latest Session): the pre-selection is computed as of that date. Use the latest Session strictly before that date, then this Routine's Skips on or after that Session and on or before that date. Saving a backfill never moves the live cursor.
- **Skip:**
  - Passes the current suggested Turn on the Engaged Routine. It records the date, Routine, Turn, and that Turn's Day.
  - Several Skips may share a date.
  - The date defaults to today. It may not be in the future, and it must be on or after this Routine's latest Skip date (or latest Session date when there are no Skips).
  - Refused on a date that holds a Session on this Routine.
  - Allowed before any Session exists.
  - Not offered when the rotation is empty.
- **Undo last Skip:** removes only the most recent Skip of the Engaged Routine. Nothing else undoes a Skip.
- **Skips and new Sessions:**
  - Creating a Session on a date that holds this Routine's Skips replaces those Skips, and the Session pins the suggestion as it stood before the replacement.
  - Deleting that Session later does not restore them.
  - Deleting or moving a Session does not remove later Skips, and changing a Session's Day does not rewrite them.
- **Skip gap:** a new Session on the Engaged Routine must be dated either before this Routine's latest Session date (backfill) or on or after its latest Skip date (or latest Session date when there are no Skips). The gap blocks only new Sessions. Existing Sessions in it remain editable and deletable.
- **Rest** is any date with no Session and no Skip on any Routine. It is never recorded and does not advance anything.

### 4.5 Sessions, Lines, and Sets

Source: [What can change on a Session](https://github.com/marcus-bailey/wolog/issues/6), as amended by [How Days and Routines are authored](https://github.com/marcus-bailey/wolog/issues/10).

- **Creation:**
  - A Session exists from the first saved write that contains a Set. There is no draft and no start, complete, abandon, or reopen state.
  - Opening the logger and choosing a Day saves nothing.
  - A write with no Set is not a start.
- **The first Set pins:**
  - **Date:** the civil date in the logger's date field. It defaults to the browser's local today, filled when the logger opens, and does not roll at midnight. Future dates are refused, and there is no timestamp. After creation the date is displayed, not edited.
  - **Routine:** the Engaged Routine at save. If the Engaged Routine changed since the logger opened, the save is refused and the logger reloads on the new Routine's suggestion. Only unsaved screen input is lost.
  - **Day and Turn:** a Day currently on the rotation, pinned per §4.4. An empty Day (no Lines) is still a valid Day.
- **One Session per date**, across all Routines. Opening a date that has a Session opens that Session. A second Routine cannot start on that date.
- **Snapshot:** on creation, the chosen Day's Lines are copied into new Session Lines. Then the screen's omissions, reorders, and extra Lines are applied, then the Sets. After that the Session has one list of Lines. Later Day edits never change it, and Session edits never write to the Day.
- **Always editable**, including after an Engaged Routine switch:
  - **Lines:**
    - Add or attach an Exercise as a new Line (same rules as §4.1; duplicates allowed; Retired refused). New Lines append.
    - Remove a Line only while it has no Sets. Omission is absence; there is no omitted mark, and zero overlap with the Day is allowed.
    - An empty Line stays until it is removed.
    - Creating an Exercise from a Session only adds it to the library.
  - **Sets:**
    - Add Sets to any Line. New Sets append.
    - Edit any field of a Set. Invalid values are refused; delete the Set instead.
    - Delete a Set.
    - Reorder Sets within a Line. Sets never move across Lines.
  - Saving a Set and removing its Line in the same write is refused.
- **Dissolve:** deleting the Session, or any write that leaves no Set, erases the Session even if empty Lines remain. Removing the last Set of one Line, while other Sets remain, leaves that Line empty. Logging that date again later creates a new Session.
- **Change-Day:**
  - A relabel: no new Snapshot, and Lines and Sets are untouched. It may share a write with Line and Set edits.
  - The chooser offers every Day still belonging to the Session's Routine, on or off the rotation.
  - It re-pins to the new Day's first Turn at or after the Session's old Turn position, wrapping around. If the new Day has no Turns, the Session holds no Turn.
  - Skips are never rewritten.
- **Cursor effect:** the live cursor uses this Routine's latest Session's current Turn. Changing the Day of a backfilled Session does not move it. If the rotation is empty, no new Session can start.
- No extra fields on a Session or Line. Notes live on Sets only.

### 4.6 Sets

Source: [Decide what a Set records](https://github.com/marcus-bailey/wolog/issues/4).

- **Reps:** a positive integer, required.
- **Weight:** a non-negative number in pounds, required. Fractions are allowed. `0` means no added load. The value is stored exactly as typed: no bar, bodyweight, or assisted adjustment. There is no unit setting.
- **Warmup or Working:** a mark, default Working.
- **Note:** optional free text.

### 4.7 Engaged Routine

Source: [What happens when the Engaged Routine switches](https://github.com/marcus-bailey/wolog/issues/7).

- Switch to any other Routine at any time. There is no disengage.
- Switching changes only where new work goes. It never moves, freezes, or rewrites existing Sessions or Skips.
- New Sessions (including backfill), Skips, and Undo last Skip act only on the Engaged Routine.
- The suggestion recomputes immediately from the newly Engaged Routine's own Sessions and Skips. The old Routine's cursor freezes. Returning to it resumes where it left off, as if no time had passed.
- If today already holds a Session on Routine A and the owner switches to B, today still shows A's Session. B starts on the next date.
- A Routine with an empty rotation may be engaged. The logger then says nothing is on the rotation and links to the Routine editor. No Skip is offered.
- Switches are not recorded.

### 4.8 Last-time and prefill

Source: [What last-time shows while logging](https://github.com/marcus-bailey/wolog/issues/8).

- **Which Session:**
  - For each Session Line, Last-time is the latest Session dated strictly before the Session being logged that has at least one Set of the same Exercise identity.
  - Any Routine or Day counts.
  - Sessions with no Set of that Exercise, including those with only an empty Line of it, are walked past.
  - Skips are ignored.
- **What it shows:**
  - That Session's date and how long ago it was.
  - Every Set of that Exercise, in recorded order, grouped by Line, as Weight × Reps.
  - Warmups visibly marked.
  - Notes, as described in §5.
  - Routine and Day are not shown.
  - Every Line of the Exercise in today's Session shows the same block.
- **Nothing earlier:** a quiet "No earlier Sets", with no placeholder numbers.
- **Prefill** of a new Set's inputs, which are not saved until Save:
  - If this Line already has Sets, copy Reps and Weight from the Line's previous Set.
  - Otherwise copy them from Last-time's first Working Set, or its first Set if it has no Working Set.
  - Otherwise leave the inputs empty.
  - The mark always resets to Working and the Note to blank.
- **Live:** Last-time is computed from current data. Editing or deleting past Sessions changes it immediately.

### 4.9 History

Sources: [Map weekdays to Days](https://github.com/marcus-bailey/wolog/issues/3), [Prototype the logger and editor screens](https://github.com/marcus-bailey/wolog/issues/11).

- One list of Sessions and Skips, newest first, across all Routines.
- A Session row shows its date, Routine, and Day (current names).
- A Skip row shows its date, Routine, and the skipped Day. It reads as a pass, not as a Session.
- Tapping a Session opens it in the logger for editing.
- Rest dates are not listed.

## 5. Screens

Source: [Prototype the logger and editor screens](https://github.com/marcus-bailey/wolog/issues/11). This section is normative. The throwaway prototype (branch [`prototype/logger-and-editor-screens`](https://github.com/marcus-bailey/wolog/tree/prototype/logger-and-editor-screens), `prototypes/logger-and-editors.prototype.html`, view `#b`) is a **non-normative** visual reference. Where the two differ, this spec wins.

**Navigation.** A menu drawer (☰) with **Today**, **History**, **Routines**, and **Sign out** (the apps server's sign-out). Under the heading "Engaged Routine", the drawer lists every Routine and marks the engaged one (●); tapping another Routine switches to it. Nothing on the logging screen switches Routines.

**First run.** With no Routine, Today points the owner to create one.

**Today, before a Session.**

- An **Up next** card shows the Routine name, the Turn position ("Turn 3 of 4"), and the suggested Day in large type.
- Actions: **Start ‹Day›**, **Pick another Day** (Days on the rotation), **Skip it**, and **Undo last Skip** when one exists.
- After an override, the card notes what was suggested.
- The rotation itself is not shown while logging.
- Start only opens the Lines. Nothing is saved until the first Set.

**Today, logging (Focus layout).** One Line at a time:

- A chip strip across the top, one chip per Line with its Set count, plus **+ Line**.
- Then, for the current Line:
  - the Exercise name
  - the **Last-time card**
  - today's Sets as chips, with Warmups tinted; tapping a chip opens an edit sheet with Delete
  - large **Weight** (−5 / +5) and **Reps** (−1 / +1) steppers, with directly editable values and prefill per §4.8
  - a Warmup toggle, an optional Note field, and a large **Save Set N** button
  - Previous and Next Line, plus **Remove Line** while the Line has no Sets
- Change-Day and Delete Session are reachable from this screen.

**Last-time card.**

- Sits above the inputs and shows the date, how long ago, and the Sets grouped by Line with Warmups marked.
- Notes are collapsed to a dot per Set, and the header shows a count ("· 2 Notes"). Tapping the card expands all Notes under their Sets, and tapping again collapses them. Collapsed, the card stays the same size however many Notes there are.
- Today's Sets show a Note as a dot too; the full Note is in the edit sheet.

**History.** A separate screen, per §4.9.

**Routines.**

- **Routines list:** each Routine, with the engaged one marked, an **Engage** action on each other Routine, and Create.
- **Routine detail:**
  - **Rotation:** numbered Turns with ↑ / ↓ / ✕, the next Turn marked, and "Add a Turn for…" a Day.
  - **Days**, each expandable:
    - its Lines with ↑ / ↓ / ✕, plus add or create an Exercise by name
    - Drop from rotation or Put back
    - Duplicate to… a Routine
    - Destroy (refusals explain why and offer Drop)
  - Create Day at the bottom.
  - Rename, Duplicate, and Destroy for the Routine.
- **Exercise library:** list, create, rename, Retire / Un-retire, delete if unused, and a Retired filter. It is reached from Routines or the drawer; the build may place it.

## 6. User stories

The actor is always the owner. Acceptance criteria are the referenced requirement bullets; each story only adds what is specific to it.

**Library (LIB)**

- **LIB-1** As the owner, I can create an Exercise from the library or by typing a new name on a Line. *Accept:* §4.1. A live name attaches. A Retired name is refused with a pointer to it.
- **LIB-2** I can rename an Exercise. *Accept:* collisions are refused. History and Last-time follow the identity.
- **LIB-3** I can Retire and Un-retire an Exercise. *Accept:* it is hidden from pickers but its Lines still log. It is listed under Retired.
- **LIB-4** I can delete an Exercise I never used. *Accept:* refused if it is on any Day Line or Session Line.

**Routines (RTN)**

- **RTN-1** I can create a Routine with just a name. *Accept:* the first one is engaged automatically. Names are unique.
- **RTN-2** I can rename a Routine.
- **RTN-3** I can duplicate a Routine to start a new block. *Accept:* Days, Lines, and Turns are copied. No Sessions or Skips. Not engaged.
- **RTN-4** I can destroy a Routine nothing points at. *Accept:* §4.2 refusals.
- **RTN-5** I can switch the Engaged Routine from the drawer or the Routines list. *Accept:* §4.7.

**Days and rotation (DAY)**

- **DAY-1** I can create, rename, and destroy Days in a Routine. *Accept:* unique per Routine. A new Day gets a Turn at the end. Destroy is refused if pinned, with Drop offered.
- **DAY-2** I can add, create, reorder, and remove Lines on a Day at any time. *Accept:* past Sessions are unchanged.
- **DAY-3** I can shape the rotation: add Turns (repeats allowed), reorder, remove, drop a Day, and put it back. *Accept:* §4.3. Additions go to the end.
- **DAY-4** I can duplicate a Day into this or another Routine.

**Today (TDY)**

- **TDY-1** As I open Today, I see the suggested Day for the Engaged Routine. *Accept:* §4.4 cursor and suggestion. "Turn n of N" is shown.
- **TDY-2** I can pick a different Day. *Accept:* only Days on the rotation. The next suggestion advances from what I logged.
- **TDY-3** I can Skip the suggested Day and undo the last Skip. *Accept:* §4.4 date rules. Multiple Skips per date are allowed.
- **TDY-4** I can log a past date (backfill). *Accept:* pre-selection is computed as of that date. The live cursor is unchanged. The Skip gap is enforced.
- **TDY-5** With an empty rotation, Today tells me so and links to the Routine.

**Logging (LOG)**

- **LOG-1** I can start a Session by saving its first Set. *Accept:* the Snapshot is taken and date, Routine, Day, and Turn are pinned. Same-date Skips are replaced.
- **LOG-2** I can save a Set with Weight, Reps, Warmup, and an optional Note. *Accept:* §4.6 validation. Prefill per §4.8.
- **LOG-3** I can edit, reorder within a Line, and delete Sets.
- **LOG-4** I can add Lines (including new Exercises and repeats) and remove empty Lines.
- **LOG-5** I can change the Session's Day. *Accept:* Lines and Sets are untouched. Turn re-pinned. Skips untouched.
- **LOG-6** I can delete a Session, and a Session with no Sets left disappears.
- **LOG-7** I see Last-time above the inputs on every Line. *Accept:* §4.8 and §5 card behaviour.
- **LOG-8** If I switched Routines elsewhere before my first Set, the save is refused and the logger reloads.

**History (HST)**

- **HST-1** I can browse all Sessions and Skips, newest first. *Accept:* §4.9.
- **HST-2** I can open any past Session and edit it.

**Operations (OPS)**

- **OPS-1** I can deploy any commit on main to the apps server with one command, and roll back by naming an earlier commit. *Accept:* §8.
- **OPS-2** My data is in the apps server's nightly dumps, and I can restore it. *Accept:* §9 restore drill passes.

## 7. Non-functional requirements

- **One user, behind the apps server's login.** Wolog has no sign-in, accounts, roles, or login state of its own. The apps server's login (Cognito + oauth2-proxy) checks every request first. When the API answers `401`, the SPA sends the browser to sign in and back to the same page; unsaved screen input may be lost, as with a switch race.
- **Phone-first.** Every screen works one-handed on a phone at the gym, with large tap targets on the logger. Desktop works but needs no special layout.
- **Dates are civil dates** from the browser's local calendar. No timestamps on domain records and no time zones in the model.
- **Pounds only.** Weight is shown and entered in lb.
- **Refusals explain themselves.** Every refused action (uniqueness, pins, Skip gap, switch race, invalid Set) gets a plain message saying why, and an alternative where §4 names one.
- **Consistency.** Each write is a single transaction. Invariants in §3 are enforced in the API and, where practical, by database constraints, never only in the SPA.
- **Typed code.** The SPA is TypeScript with no implicit `any`. The API uses typed request and response models.

## 8. Tech stack and deployment

Sources: [Name the SPA, API, and database](https://github.com/marcus-bailey/wolog/issues/2) (research note on branch `research/name-the-spa-api-and-database`, `docs/research/spa-api-database.md`) for the stack. The runtime follows the apps server ([`marcus-bailey/apps-server`](https://github.com/marcus-bailey/apps-server)), like the todo and groceries apps; this replaces the earlier home Kubernetes target.

| Layer | Choice |
| --- | --- |
| SPA | React + TypeScript, built with Vite to static files, served by nginx |
| API | FastAPI (Python), JSON, OpenAPI schema, one Uvicorn process per container |
| Database | A `wolog` database and user on the apps server's shared Postgres 17 (`apps-postgres`) |
| Migrations | Alembic, run before the API serves |
| Runtime | Docker Compose on the apps server (AWS Lightsail), images from GitHub's container registry |

```
Browser ──► apps-nginx :443 (login) ──┬─ /wolog/       ──► wolog-frontend (nginx, static SPA)
                                      ├─ /wolog/api/   ──► wolog-backend (FastAPI) ──► apps-postgres
                                      └─ /wolog/health ──► wolog-backend
                                                              apps-postgres ◄── apps-backup ──► S3 (nightly)
```

- **Two Wolog containers:** the SPA and the API. The database is the apps server's shared Postgres, never in the API image. Both containers join the server's `apps-edge` network, the API also `apps-db`, and neither publishes a port.
- **Path prefix:** the SPA and API work under `/wolog/`. The apps server's nginx strips the prefix and routes `/wolog/api/` to the API and everything else to the SPA, so production is same-origin and CORS is needed only in development. The nginx location lives in the apps-server repo; API locations answer `401` rather than redirecting.
- **Images:** CI builds both images on every commit to main and pushes them to GitHub's container registry, tagged `sha-<commit>`.
- **Deploy:** one script, run on the Mac, copies the compose file to the server and starts the given commit's images, defaulting to the latest on main. Naming an earlier commit rolls back. Secrets live only in the server's `.env` next to the compose file.
- **Migrations** run before the API serves. No `create_all` at startup.
- **One API container** is enough.

## 9. Backup and restore

Backups belong to the apps server, not to Wolog.

- **Backup:** the apps server's backup job dumps every database on `apps-postgres` nightly (03:30 Phoenix time) with `pg_dump -Fc` to S3 and keeps 30 days. Wolog's database is included as soon as it exists. Wolog ships no backup job of its own.
- **Restore:** follow the apps server README's restore runbook: restore the `wolog` dump into a scratch database, check it, then swap it in with the API stopped.
- **Restore drill**, required at first deploy and after every Postgres major-version upgrade: run a backup, restore the `wolog` dump into a scratch database, and confirm the latest Session is present.
- There is no owner-facing Export or Import, and no backup banner.

## 10. Definition of done for the build

The build that follows this spec is done when:

1. Every story in §6 meets its acceptance criteria, and every rule in §4 has an automated test at the API level. That includes the suggestion and cursor walk-back, the Skip gap, Turn re-pinning, Last-time walk-back, and post-state writes.
2. Every refusal in §4 is enforced by the API, not only hidden in the SPA.
3. The logger is usable on a phone for a full Session without zooming.
4. Both images deploy to the apps server with the deploy script, with migrations-before-serve, the shared Postgres, and same-origin routing under `/wolog/` behind the login.
5. The apps server's nightly backup includes the `wolog` database, and the restore drill has passed.
6. Domain terms in code, API, and UI copy match [`CONTEXT.md`](../CONTEXT.md).

## 11. Sources

Each decision on the map and where it lands in this spec:

| Decision | Sections |
| --- | --- |
| [Name the SPA, API, and database](https://github.com/marcus-bailey/wolog/issues/2) | §8 |
| [Map weekdays to Days](https://github.com/marcus-bailey/wolog/issues/3) | §4.4, §4.9 |
| [Decide what a Set records](https://github.com/marcus-bailey/wolog/issues/4) | §1, §4.6 |
| [How Exercises enter the library](https://github.com/marcus-bailey/wolog/issues/5) | §4.1 |
| [What can change on a Session](https://github.com/marcus-bailey/wolog/issues/6) | §3, §4.5 |
| [What happens when the Engaged Routine switches](https://github.com/marcus-bailey/wolog/issues/7) | §4.2, §4.7 |
| [What last-time shows while logging](https://github.com/marcus-bailey/wolog/issues/8) | §4.8 |
| [How Days and Routines are authored](https://github.com/marcus-bailey/wolog/issues/10) | §4.2, §4.3, §4.4 |
| [Prototype the logger and editor screens](https://github.com/marcus-bailey/wolog/issues/11) | §4.4, §4.9, §5 |
| [How Wolog data is backed up and restored](https://github.com/marcus-bailey/wolog/issues/12) | §9 (superseded by the apps-server move) |
| Move Wolog to the apps server (2026-11-26, following todo and groceries) | §1, §5, §6, §7, §8, §9, §10 |
| [Write the handoff spec](https://github.com/marcus-bailey/wolog/issues/9) | this document's shape |
