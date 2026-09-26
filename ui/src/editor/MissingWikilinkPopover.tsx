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
  type FocusEvent as ReactFocusEvent,
  type ReactNode,
  type Ref,
  useCallback,
  useId,
  useRef,
  useState,
} from "react";
import { Tick } from "#/components/codex/Tick";
import { cn } from "#/lib/cn";
import { FOCUS_RING_NATIVE } from "#/lib/focusRing";

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
  const suppressNextFocusOpenRef = useRef(false);
  const targetId = useId();
  const descriptionId = useId();
  const child = Children.only(children) as ReactElement<TriggerProps>;
  const childRef = child.props.ref;

  function suppressRestoredFocusOpen() {
    suppressNextFocusOpenRef.current = true;
    window.requestAnimationFrame(() => {
      suppressNextFocusOpenRef.current = false;
    });
  }

  const { refs, floatingStyles, context } = useFloating({
    open,
    onOpenChange(nextOpen) {
      if (!nextOpen && open) suppressRestoredFocusOpen();
      setOpen(nextOpen);
    },
    placement: "top-start",
    strategy: "fixed",
    middleware: [offset(6), flip(), shift({ padding: 8 })],
    whileElementsMounted: autoUpdate,
  });

  const hover = useHover(context, { handleClose: safePolygon() });
  const focus = useFocus(context);
  const dismiss = useDismiss(context);
  const role = useRole(context, { role: "dialog" });
  const { getReferenceProps, getFloatingProps } = useInteractions([
    hover,
    focus,
    dismiss,
    role,
  ]);

  const referenceProps = getReferenceProps(child.props) as TriggerProps;

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
        ...referenceProps,
        ref: setReference,
        onFocus(event: ReactFocusEvent<HTMLElement>) {
          if (suppressNextFocusOpenRef.current) {
            suppressNextFocusOpenRef.current = false;
            child.props.onFocus?.(event);
            return;
          }
          referenceProps.onFocus?.(event);
        },
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
              className="z-50 flex w-[272px] flex-col gap-1.5 rounded-2xl bg-raise p-4 text-[14px] text-ink shadow-lg"
              {...getFloatingProps({
                "aria-labelledby": targetId,
                "aria-describedby": descriptionId,
              })}
            >
              <p className="flex items-center gap-2.5">
                <Tick variant="faint" />
                <span className="font-serif text-[18px] italic text-mute">
                  Missing page
                </span>
              </p>
              <p id={targetId} className="pl-[17px] font-medium text-ink">
                {target}
              </p>
              <p id={descriptionId} className="pl-[17px] text-[13px] text-mute">
                Page does not exist.
              </p>
              {!readOnly ? (
                <button
                  type="button"
                  disabled={creating}
                  className={cn(
                    "mt-2 ml-[17px] inline-flex h-8 cursor-pointer items-center self-start rounded-full bg-accent px-3.5 text-[13px] font-medium text-raise hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-45",
                    FOCUS_RING_NATIVE,
                  )}
                  onClick={async () => {
                    if (await onCreate()) {
                      suppressRestoredFocusOpen();
                      setOpen(false);
                    }
                  }}
                >
                  {creating ? "Creating…" : "Create page"}
                </button>
              ) : null}
              {error ? (
                <p role="alert" className="pl-[17px] text-[13px] text-hot">
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
