import { Fragment, useMemo, type SyntheticEvent } from "react";
import {
  Dialog,
  DialogPopup,
  Menu,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  useIsMobile,
} from "@seosoyoung/soul-ui";

import type { V3ContextMenuAction } from "./context-menu-model";

export interface V3ContextMenuTarget {
  x: number;
  y: number;
}

export function V3ContextMenu({
  target,
  actions,
  onClose,
}: {
  target: V3ContextMenuTarget | null;
  actions: readonly V3ContextMenuAction[];
  onClose(): void;
}) {
  const isMobile = useIsMobile();
  const anchor = useMemo(() => {
    if (!target || isMobile) return null;
    const { x, y } = target;
    return {
      getBoundingClientRect: () => ({
        x,
        y,
        width: 0,
        height: 0,
        top: y,
        left: x,
        right: x,
        bottom: y,
        toJSON: () => ({}),
      }),
    };
  }, [isMobile, target]);

  const select = (action: V3ContextMenuAction, event: SyntheticEvent) => {
    event.stopPropagation();
    onClose();
    void Promise.resolve(action.onSelect()).catch(() => undefined);
  };

  if (isMobile) {
    return (
      <Dialog open={target !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
        <DialogPopup bottomStickOnMobile className="max-w-sm" showCloseButton={false}>
          <div className="px-2 py-2" data-testid="v3-context-menu-mobile">
            {actions.map((action) => (
              <div key={action.label}>
                {action.separatorBefore ? <div className="my-1 border-t border-border" /> : null}
                <button
                  type="button"
                  className={`w-full rounded-md px-3 py-2 text-left text-sm hover:bg-accent disabled:pointer-events-none disabled:opacity-64${action.destructive ? " text-destructive" : ""}`}
                  disabled={action.disabled}
                  onClick={(event) => select(action, event)}
                >
                  {action.label}
                </button>
              </div>
            ))}
          </div>
        </DialogPopup>
      </Dialog>
    );
  }

  return (
    <Menu open={target !== null} onOpenChange={(open) => { if (!open) onClose(); }} modal={false}>
      <MenuPopup anchor={anchor} side="bottom" align="start" sideOffset={4}>
        {actions.map((action) => (
          <Fragment key={action.label}>
            {action.separatorBefore ? <MenuSeparator /> : null}
            <MenuItem
              disabled={action.disabled}
              variant={action.destructive ? "destructive" : "default"}
              onClick={(event) => select(action, event)}
            >
              {action.label}
            </MenuItem>
          </Fragment>
        ))}
      </MenuPopup>
    </Menu>
  );
}
