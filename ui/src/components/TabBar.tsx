import { X } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { type TabDescriptor, useWorkspaceStore } from "#/store/workspace";

export function TabBar() {
  const tabs = useWorkspaceStore((s) => s.tabs);
  const activeTabId = useWorkspaceStore((s) => s.activeTabId);
  const activateTab = useWorkspaceStore((s) => s.activateTab);
  const closeTab = useWorkspaceStore((s) => s.closeTab);
  const closeOtherTabs = useWorkspaceStore((s) => s.closeOtherTabs);
  const moveTab = useWorkspaceStore((s) => s.moveTab);

  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dropTarget, setDropTarget] = useState<number | null>(null);
  const [contextMenu, setContextMenu] = useState<{
    tabId: string;
    x: number;
    y: number;
  } | null>(null);
  const contextRef = useRef<HTMLDivElement>(null);

  const handleDragStart = useCallback((e: React.DragEvent, index: number) => {
    setDragIndex(index);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", String(index));
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent, index: number) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDropTarget(index);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent, toIndex: number) => {
      e.preventDefault();
      if (dragIndex !== null && dragIndex !== toIndex) {
        moveTab(dragIndex, toIndex);
      }
      setDragIndex(null);
      setDropTarget(null);
    },
    [dragIndex, moveTab],
  );

  const handleDragEnd = useCallback(() => {
    setDragIndex(null);
    setDropTarget(null);
  }, []);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent, tab: TabDescriptor) => {
      // Middle-click to close
      if (e.button === 1) {
        e.preventDefault();
        closeTab(tab.id);
      }
    },
    [closeTab],
  );

  const handleContextMenu = useCallback(
    (e: React.MouseEvent, tabId: string) => {
      e.preventDefault();
      setContextMenu({ tabId, x: e.clientX, y: e.clientY });

      function dismiss() {
        setContextMenu(null);
        document.removeEventListener("click", dismiss);
      }
      requestAnimationFrame(() => {
        document.addEventListener("click", dismiss);
      });
    },
    [],
  );

  if (tabs.length === 0) return null;

  return (
    <>
      <div className="flex items-end border-b border-border bg-card overflow-x-auto">
        {tabs.map((tab, index) => {
          const isActive = tab.id === activeTabId;
          const isDragging = dragIndex === index;
          const isDropTarget = dropTarget === index && dragIndex !== index;

          return (
            <button
              key={tab.id}
              type="button"
              draggable
              onClick={() => activateTab(tab.id)}
              onMouseDown={(e) => handleMouseDown(e, tab)}
              onContextMenu={(e) => handleContextMenu(e, tab.id)}
              onDragStart={(e) => handleDragStart(e, index)}
              onDragOver={(e) => handleDragOver(e, index)}
              onDrop={(e) => handleDrop(e, index)}
              onDragEnd={handleDragEnd}
              className={[
                "group flex items-center gap-1.5 px-3 py-1.5 text-xs uppercase tracking-wider select-none",
                "border-t-2 border-r border-r-border/50 last:border-r-0",
                isActive
                  ? "border-t-foreground border-x border-x-border bg-background"
                  : "border-t-transparent bg-card hover:bg-accent",
                isDragging ? "opacity-50" : "",
                isDropTarget ? "border-l-2 border-l-foreground" : "",
              ].join(" ")}
            >
              <span className="truncate max-w-40">{tab.label}</span>
              <span
                role="button"
                tabIndex={-1}
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(tab.id);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.stopPropagation();
                    closeTab(tab.id);
                  }
                }}
                className="ml-1 p-0.5 opacity-0 transition-colors group-hover:opacity-100 hover:bg-foreground/10"
              >
                <X className="h-3 w-3" />
              </span>
            </button>
          );
        })}
      </div>

      {contextMenu && (
        <div
          ref={contextRef}
          className="fixed z-50 border border-border bg-background shadow-[4px_4px_0_0] shadow-border"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <button
            type="button"
            className="block w-full px-4 py-1.5 text-left text-xs hover:bg-accent"
            onClick={() => {
              closeTab(contextMenu.tabId);
              setContextMenu(null);
            }}
          >
            Close
          </button>
          <button
            type="button"
            className="block w-full px-4 py-1.5 text-left text-xs hover:bg-accent"
            onClick={() => {
              closeOtherTabs(contextMenu.tabId);
              setContextMenu(null);
            }}
          >
            Close Others
          </button>
        </div>
      )}
    </>
  );
}
