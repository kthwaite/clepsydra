# Base Filter Editor Design

## Goal

Deepen Base filter authoring behind one `BaseFilterEditor` module. Callers describe the filter value, available properties, copy, diagnostics location, and change destination. The module owns recursive traversal, immutable mutation, row identity, diagnostic paths, and focus routing.

This is a behavior-preserving interface refactor. Existing persisted `BaseFilter` values, authored AST shapes, controls, focus behavior, and validation semantics remain unchanged.

## Scope

This feature will:

- replace the public `MembershipEditor` module with `BaseFilterEditor`;
- migrate root membership, saved-view, embed-local, and create-dialog callers;
- make `FilterGroupEditor` a private recursive implementation;
- remove root snapshots, `FilterPath`, positions, and node mutation callbacks from caller-facing interfaces;
- centralize immutable add, replace, remove, move, and wrap operations inside the module;
- centralize nested diagnostic-path construction and focus-target registration;
- preserve stable row identity across controlled immutable updates;
- retain pure internal tree tests and public editor behavior tests.

This feature will not:

- change the generated `BaseFilter` schema or server validation;
- canonicalize or migrate stored filter ASTs;
- change filter meaning, supported fields, operators, or value controls;
- change semantic limits for embed filters;
- add a public controller hook, command interface, or compatibility export;
- redesign Base membership, saved views, embeds, or the create dialog.

## Current callers

Four callers author the same optional `BaseFilter`:

| Caller | Value | Diagnostic root | Focus integration |
| --- | --- | --- | --- |
| `BaseDefinitionWorkspace` | root membership filter | `filter` | workspace focus registry |
| `ViewDefinitionEditor` | saved-view filter | `views[index].filter` | workspace focus registry |
| `BaseEmbedInspector` | embed-local filter | `filter` | outer diagnostic region only |
| `CreateBaseDialog` | initial membership filter | none | none |

`FilterGroupEditor` is exported today but has one production consumer: `MembershipEditor`. Its recursive interface exposes root-tree and path mechanics that belong to the authoring implementation.

## Public module interface

The clean-cutover public module is `BaseFilterEditor`:

```ts
interface BaseFilterEditorProps {
  value: BaseFilter | undefined;
  properties: DraftProperty[];
  onChange: (value: BaseFilter | undefined) => void;
  label?: string;
  diagnostics?: BaseDiagnostic[];
  diagnosticRoot?: string;
  registerFocus?: RegisterFocusTarget;
}
```

The interface invariants are binding:

- `undefined` means **All pages**;
- `onChange` receives the complete next root exactly once per committed authoring action;
- `diagnosticRoot` defaults to `filter`;
- `registerFocus` is optional; absence performs no external registration;
- callers never supply a root snapshot, node path, child position, or node-level mutation callback.

No `MembershipEditor` alias or re-export remains after migration.

## Module structure

`BaseFilterEditor.tsx` is the public seam. Its implementation owns the controlled draft, root actions, and private recursive node editor.

A private pure tree module owns:

- path traversal;
- replacement at a node;
- removal and empty-ancestor collapse;
- child append;
- sibling move;
- node wrapping;
- immutable allocation of only the traversed branches.

The path representation may remain the existing string-and-index form internally. It is implementation knowledge, not part of the public module interface.

`FilterComparisonEditor`, `TagConditionEditor`, seed vocabulary, and ordered-row identity remain internal collaborators. They receive node-scoped bindings from the implementation rather than root snapshots and mutation mechanics from callers.

The module exposes no public controller hook. A hook or context may exist privately when it reduces prop surface inside the implementation.

## Data flow

1. A caller passes its controlled `BaseFilter | undefined`.
2. `BaseFilterEditor` synchronizes its interaction draft with the controlled value.
3. A private node editor issues one node-scoped operation.
4. The pure tree implementation applies that operation to the current root.
5. `BaseFilterEditor` updates its draft immediately.
6. `BaseFilterEditor` calls the caller's `onChange` once with the complete next root.
7. A later controlled-value update reconciles row identities through the existing identified-row behavior.

Node-scoped operations are:

- replace current node;
- remove current node;
- append a seeded child;
- move current node among siblings;
- wrap current node in `all`, `any`, or `not`.

Leaf modules do not reconstruct roots.

## AST preservation

The refactor preserves exact authored representation, not merely equivalent meaning:

- child order remains stable;
- add actions use the existing condition, tag, `all`, `any`, and `not` seeds;
- removing the root returns `undefined`;
- removing a sole child collapses every newly empty ancestor;
- moving swaps the same siblings with the same boundary behavior;
- compact tag and alias conditions retain their existing encodings;
- advanced or unsupported conditions remain visible without normalization;
- unsupported fields, operators, and values remain editable;
- scalar, array, numeric, relation, and value-less operator transitions remain unchanged;
- freeform `in` values retain blur/Enter commit timing.

Malformed internal paths retain the current silent no-op behavior. They do not throw or rewrite the root.

## Diagnostics and focus

Callers know only where their filter lives. The module knows how controls below that root are addressed.

The implementation derives validator-compatible descendant paths such as:

```text
filter.all[0].field
views[1].filter.not.value
```

The same path is used for diagnostic matching and optional external focus registration.

When a registrar is supplied, the module registers exact native-control targets for field, operator, and value controls. Existing prefix/subtree diagnostic behavior for compact tag conditions remains unchanged. When no registrar is supplied, authoring remains fully functional and no no-op callback is required.

View selection and outer workspace section routing remain caller responsibilities because they locate the module itself. Traversal and focus below the module seam remain implementation responsibilities.

## Caller migration

All four callers import `BaseFilterEditor` and pass only the public interface. The migration removes:

- the `MembershipEditor` file and symbol;
- the exported `FilterGroupEditor` interface;
- caller-supplied no-op focus registrars;
- production imports of internal path and tree-mutation helpers outside the filter-authoring module;
- obsolete tests that assert the old prop structure.

There is no compatibility layer.

## Testing

TDD begins by changing the public behavior tests before production migration.

Public `BaseFilterEditor` tests cover:

- All pages and every seed action;
- exact nested add, move, wrap, replace, and remove ASTs;
- empty-root and empty-ancestor collapse;
- exact compact-tag representations;
- field/operator capability controls and unsupported wire values;
- scalar, array, numeric, relation, and value-less transitions;
- controlled-value replacement and stable interaction behavior;
- exact nested diagnostic paths and native-control focus;
- keyboard activation and movement.

Private pure tree tests cover:

- immutable replacement and removal;
- nested `not`, `all`, and `any` traversal;
- malformed branches and indices as no-ops;
- path-root operations;
- sibling move boundaries;
- source-tree immutability.

Caller tests retain these integration contracts:

- root workspace draft mutation and diagnostic routing;
- saved-view AND semantics and selected-view focus;
- embed filter reset/preservation and semantic-limit diagnostics;
- create-dialog submission with an authored filter.

Browser verification exercises nested group creation, wrapping, movement, removal, and diagnostic focus in the running Base definition surface.

## Completion criteria

TSK-0102 is complete when `BaseFilterEditor` is the only public Base filter-authoring module; all four callers use its small interface; root/path mutation and nested focus mechanics are private implementation knowledge; exact AST and authoring behavior remain stable; obsolete symbols and tests are removed; UI typecheck, lint, focused tests, and the controlled full suite pass; and the running Base authoring surface passes browser verification.
