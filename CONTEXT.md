# Clepsydra

Clepsydra organises planned work as tasks on a project-oriented board.

## Language

**Task**:
A page-backed unit of planned work tracked on the Task Board. A Task may belong to a Project and a Cycle.
_Avoid_: Tasking, work item

**Todo**:
A Markdown checkbox item, whether open, done, or cancelled.
_Avoid_: Markdown task, checkbox task

**Checklist Item**:
A Todo contained in a Task's checklist.
_Avoid_: Check, Markdown task

**Project**:
A scope that groups related tasks.
_Avoid_: Operation, op

**Cycle**:
An optional, time-bounded planning interval with a goal. A cycle may be planned, active, or closed.
_Avoid_: Sprint, cadence window

**Backlog**:
The collection of tasks that are not assigned to a cycle.
_Avoid_: No cycle, unscheduled

**Blocked**:
A task that cannot proceed until its blocker is resolved.
_Avoid_: Hold, on hold

**Inbox**:
The workflow stage for tasks that have not yet been assessed.
_Avoid_: Intake

**Ready**:
The workflow stage for assessed tasks that are ready to begin.
_Avoid_: Triage

**In Progress**:
The workflow stage for tasks currently being worked on.
_Avoid_: Field, in-field

**Review**:
The workflow stage for tasks awaiting review before completion.
_Avoid_: QA / seal

**Done**:
The workflow stage for completed tasks.
_Avoid_: Sealed, closed

**Assignee**:
The person responsible for a task.
_Avoid_: Operator, OPR

**Priority**:
A task's relative urgency: P0 Critical, P1 High, P2 Medium, or P3 Low.
_Avoid_: Normal

**Description**:
Prose that explains what a task is and why it matters.
_Avoid_: Brief

**Related Page**:
A vault page associated with a task.
_Avoid_: Dossier link

**Code**:
The stable identifier of a Task or Cycle: two short words and a five-character tail (e.g. `TSK-brave-finch-7q3zd`). A code never changes once minted; any unique prefix of it addresses the same page.
_Avoid_: TSK number, sequential code, ticket number

**Conflict Copy**:
A sibling page holding the version of a page that lost an automatic merge after the same page was edited on two devices. It remains until the user reconciles or discards it.
_Avoid_: conflicted file, merge artifact
