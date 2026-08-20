# Wolog

A single-user workout tracker: named Routines, an Exercise library, and dated Sessions of Sets.

## Language

**Routine**:
A named plan with an ordered rotation of Days. The rotation may be empty while Days still belong to it off-rotation. Several Routines can exist; one is the Engaged Routine.
_Avoid_: Workout, program, split (as the name of the whole plan)

**Day**:
A named slot that belongs to one Routine, holding an ordered list of Lines. It may sit on that Routine's rotation or be off it until it is put back or destroyed. A Day is not a calendar weekday.
_Avoid_: Workout (as the name of the slot)

**Rest**:
A calendar date with no Session and no Skips. Rest is not a Day and does not advance the Routine.
_Avoid_: Rest day (as a Day), off day (as a slot)

**Skip**:
A dated pass of the then-suggested Day on a Routine, with no Session on that Routine that date. Several Skips may share a date and a Routine; a date cannot hold both Skips and a Session for the same Routine. Skip belongs to the Engaged Routine at skip time.
_Avoid_: Rest (as a pass), skipped Day (as a Day)

**Exercise**:
A reusable named movement in the user's library, with a stable identity and a unique name (trimmed, internal whitespace collapsed, compared case-insensitively). The user authors the library; there is no starter catalog.
_Avoid_: Movement, lift (as the identity of the thing)

**Retire**:
A mark on an Exercise that hides it from new picks until it is Un-retired. The identity remains, so history and last-time still attach.
_Avoid_: delete, archive, hide (as a second kind of thing)

**Session**:
A dated record of work performed against a Day of one Routine, as ordered Lines of Sets. The first Set pins calendar date, Routine, and Day — date and Routine do not change; Day may; at most one Session per date; none without a Set.
_Avoid_: Workout, log (as the name of the dated record), timestamp (as the date)

**Line**:
An ordered appearance of an Exercise on a Day or on a Session. The same Exercise may appear as more than one Line. Sets belong to a Session Line.
_Avoid_: slot (as the Exercise appearance), appearance, position, item

**Set**:
One recorded effort on a Session Line, with Reps, Weight, a mark of Warmup or Working, and an optional Note.
_Avoid_: Effort, bout

**Reps**:
How many times the movement was completed on a Set. A positive integer. There is no Set if nothing was completed.
_Avoid_: repetitions, count (as the field)

**Warmup**:
A mark on a Set. The default is Working, not Warmup.
_Avoid_: feeder, backoff, top (as kinds of Set)

**Working**:
The default mark on a Set.
_Avoid_: work set (as a second kind of thing), top set (as a kind)

**Note**:
Optional free text on a Set for how that Set was performed.
_Avoid_: comment, memo, RPE (as the Note)

**Weight**:
The load on a Set, in pounds. A non-negative number; fractions are allowed. Zero means no added load. The number is what was typed; the product does not add a bar, a bodyweight, or a negative (assisted) load.
_Avoid_: BW, bw+N, load (as a second field), kilogram

**Engaged Routine**:
The one Routine the user is currently running. Logging always uses this Routine until they switch. Engagement is sticky; it is not a calendar week.
_Avoid_: Active program, current workout, weekly assignment

**Snapshot**:
The copy of a Day's Lines taken when the first Set of a Session is saved. After that the Session has one list of Lines; later Day edits do not change it. Snapshot is that copy-on-create, not a second stored planned list.
_Avoid_: Template, live link
