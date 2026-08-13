import {
  autoUpdate,
  FloatingFocusManager,
  FloatingPortal,
  flip,
  offset,
  safePolygon,
  shift,
  useDismiss,
  useFloating,
  useFocus,
  useHover,
  useInteractions,
  useRole,
} from "@floating-ui/react";
import {
  Children,
  cloneElement,
  type HTMLAttributes,
  type MutableRefObject,
  type ReactElement,
  type ReactNode,
  type Ref,
  useCallback,
  useEffect,
  useId,
  useState,
} from "react";

export type MissingWikilinkPopoverProps = {
  target: string;
  readOnly: boolean;
  creating: boolean;
  error: string | null;
  onCreate: () => Promise<boolean>;
  children: ReactNode;
};

type TriggerProps = HTMLAttributes<HTMLElement> & {
  ref?: Ref<HTMLElement>;
};

export function MissingWikilinkPopover({
  target,
  readOnly,
  creating,
  error,
  onCreate,
  children,
}: MissingWikilinkPopoverProps) {
  const [open, setOpen] = useState(false);
  const [suppressFocusOpen, setSuppressFocusOpen] = useState(false);
  const targetId = useId();
  const descriptionId = useId();
  const child = Children.only(children) as ReactElement<TriggerProps>;
  const childRef = child.props.ref;

  const { refs, floatingStyles, context } = useFloating({
    open,
    onOpenChange(nextOpen) {
      setSuppressFocusOpen(!nextOpen);
      setOpen(nextOpen);
    },
    placement: "top-start",
    strategy: "fixed",
    middleware: [offset(6), flip(), shift({ padding: 8 })],
    whileElementsMounted: autoUpdate,
  });

  const hover = useHover(context, { handleClose: safePolygon() });
  const focus = useFocus(context, { enabled: !suppressFocusOpen });
  const dismiss = useDismiss(context);
  const role = useRole(context, { role: "dialog" });
  const { getReferenceProps, getFloatingProps } = useInteractions([
    hover,
    focus,
    dismiss,
    role,
  ]);

  useEffect(() => {
    if (open || !suppressFocusOpen) return;
    const frame = window.requestAnimationFrame(() => setSuppressFocusOpen(false));
    return () => window.cancelAnimationFrame(frame);
  }, [open, suppressFocusOpen]);

  const setReference = useCallback(
    (node: HTMLElement | null) => {
      refs.setReference(node);
      if (typeof childRef === "function") {
        childRef(node);
      } else if (childRef) {
        (childRef as MutableRefObject<HTMLElement | null>).current = node;
      }
    },
    [childRef, refs],
  );

  return (
    <>
      {cloneElement(child, {
        ...getReferenceProps(child.props),
        ref: setReference,
      })}
      {open ? (
        <FloatingPortal>
          <FloatingFocusManager
            context={context}
            initialFocus={-1}
            modal={false}
            order={["reference", "content"]}
          >
            <div
              ref={refs.setFloating}
              style={floatingStyles}
              contentEditable={false}
              className="z-50 w-64 border border-ink bg-paper p-3 shadow-[4px_4px_0_0_var(--color-ink)]"
              {...getFloatingProps({
                "aria-labelledby": targetId,
                "aria-describedby": descriptionId,
              })}
            >
              <p className="cl-cap text-[9px] text-ink-mute">Missing page</p>
              <p id={targetId} className="mt-1 font-medium text-ink">
                {target}
              </p>
              <p id={descriptionId} className="mt-1 text-xs text-ink-mute">
                Page does not exist.
              </p>
              {!readOnly ? (
                <button
                  type="button"
                  disabled={creating}
                  className="cl-mono mt-3 cursor-pointer border border-ink bg-paper-2 px-2 py-1 text-[10px] text-ink hover:bg-paper-edge hover:text-accent disabled:cursor-not-allowed disabled:text-ink-mute"
                  onClick={async () => {
                    if (await onCreate()) {
                      setSuppressFocusOpen(true);
                      setOpen(false);
                    }
                  }}
                >
                  {creating ? "Creating…" : "Create page"}
                </button>
              ) : null}
              {error ? (
                <p role="alert" className="mt-2 text-xs text-danger">
                  {error}
                </p>
              ) : null}
            </div>
          </FloatingFocusManager>
        </FloatingPortal>
      ) : null}
    </>
  );
}
