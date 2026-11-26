import { useState, type FormEvent } from "react";
import { Button } from "@seosoyoung/soul-ui";
import { nodeGitErrorText, nodeGitRequestErrorOf, putNodeGitIdentity, type NodeGitRequestError } from "../../lib/node-git-api";
import { busyButtonClassName } from "../config/busy-button";
import { SettingFieldWidget } from "../config/SettingFieldWidget";
import { SettingsGroupBox } from "../config/SettingsListDetail";
import { gitTextField } from "./git-field";
import type { NodeGitSectionProps } from "./NodeGitPanel";

const NAME_FIELD = gitTextField("name", "이름");
const EMAIL_FIELD = gitTextField("email", "이메일");

function FieldError({ error }: { error: NodeGitRequestError | null }) {
  return error ? <p role="alert" data-v3-selectable-content="true" className="text-xs text-destructive-foreground">{nodeGitErrorText(error)}</p> : null;
}

export function GitIdentitySection({ nodeId, request, snapshot, onSnapshot }: NodeGitSectionProps) {
  const [name, setName] = useState(snapshot.identity.name ?? "");
  const [email, setEmail] = useState(snapshot.identity.email ?? "");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<NodeGitRequestError | null>(null);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setSaved(false);
    setError(null);
    try {
      onSnapshot(await putNodeGitIdentity(request, nodeId, { name, email }));
      setSaved(true);
    } catch (caught) {
      setError(nodeGitRequestErrorOf(caught));
    } finally {
      setBusy(false);
    }
  };

  return <SettingsGroupBox title="Git 사용자">
    <form onSubmit={(event) => { void save(event); }}>
      <SettingFieldWidget field={NAME_FIELD} value={name} onChange={setName} statusSlot={<FieldError error={error?.field === "name" ? error : null} />} />
      <SettingFieldWidget field={EMAIL_FIELD} value={email} onChange={setEmail} statusSlot={<div className="flex flex-wrap items-center gap-2">
        <Button type="submit" size="sm" aria-disabled={busy || undefined} className={busyButtonClassName}>저장</Button>
        {saved ? <span role="status" className="text-xs text-muted-foreground">저장했습니다</span> : null}
        <FieldError error={error && error.field !== "name" ? error : null} />
      </div>} />
    </form>
  </SettingsGroupBox>;
}
