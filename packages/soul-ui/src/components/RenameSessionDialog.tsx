import { useTranslation } from "react-i18next";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";

export function RenameSessionDialog({
  open,
  input,
  onOpenChange,
  onInputChange,
  onSubmit,
}: {
  open: boolean;
  input: string;
  onOpenChange(open: boolean): void;
  onInputChange(value: string): void;
  onSubmit(): void;
}) {
  const { t } = useTranslation();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{t("ui.session.renameTitle")}</DialogTitle>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit();
          }}
        >
          <DialogPanel>
            <Input
              autoFocus
              placeholder={t("ui.session.renamePlaceholder")}
              value={input}
              onChange={(event) => onInputChange(event.target.value)}
            />
          </DialogPanel>
          <DialogFooter variant="bare">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t("ui.common.cancel")}
            </Button>
            <Button type="submit">{t("ui.session.renameSubmit")}</Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
