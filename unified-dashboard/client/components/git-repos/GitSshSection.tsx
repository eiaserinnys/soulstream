import { useEffect, useRef, useState, type FormEvent } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@seosoyoung/soul-ui";
import type { NodeGitSshCheckResult } from "../../../../packages/wire-schema/generated/typescript/index";
import {
  checkNodeGitSsh,
  createNodeGitSshKey,
  nodeGitErrorText,
  nodeGitRequestErrorOf,
  SSH_CHECK_REASON_TEXT,
  type NodeGitRequestError,
} from "../../lib/node-git-api";
import { V3ErrorNotice } from "../../v3/V3ErrorNotice";
import { busyButtonClassName } from "../config/busy-button";
import { SettingFieldWidget } from "../config/SettingFieldWidget";
import { SettingsAlert, SettingsGroupBox } from "../config/SettingsListDetail";
import { gitTextField } from "./git-field";
import type { NodeGitSectionProps } from "./NodeGitPanel";

const DEFAULT_HOST = "github.com";
const COPIED_MS = 2000;

export function GitSshSection(props: NodeGitSectionProps) {
  const { ssh } = props.snapshot;
  const [justCreated, setJustCreated] = useState(false);
  return <SettingsGroupBox title="SSH 키">
    {ssh.state === "ready" && ssh.public_key !== null ? <ReadyKey {...props} publicKey={ssh.public_key} keyPath={ssh.key_path} focusCopy={justCreated} />
      : ssh.state === "missing" ? <MissingKey {...props} onCreated={() => setJustCreated(true)} />
        : <SettingsAlert>공개키 파일(id_ed25519.pub)이 없습니다.</SettingsAlert>}
  </SettingsGroupBox>;
}

function MissingKey({ nodeId, request, onSnapshot, onCreated }: NodeGitSectionProps & { onCreated(): void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<NodeGitRequestError | null>(null);
  const create = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      onSnapshot(await createNodeGitSshKey(request, nodeId));
      onCreated();
    } catch (caught) {
      setError(nodeGitRequestErrorOf(caught));
    } finally {
      setBusy(false);
    }
  };
  return <div className="space-y-2">
    <Button type="button" size="sm" aria-disabled={busy || undefined} className={busyButtonClassName} onClick={() => { void create(); }}>SSH 키 만들기</Button>
    {error ? <V3ErrorNotice message={nodeGitErrorText(error)} detail={error.message} /> : null}
  </div>;
}

function ReadyKey({ nodeId, request, publicKey, keyPath, focusCopy }: NodeGitSectionProps & { publicKey: string; keyPath: string; focusCopy: boolean }) {
  const copyRef = useRef<HTMLButtonElement>(null);
  const [copied, setCopied] = useState(false);
  const [host, setHost] = useState(DEFAULT_HOST);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<NodeGitSshCheckResult | null>(null);
  const [error, setError] = useState<NodeGitRequestError | null>(null);

  // 눌렀던 「SSH 키 만들기」가 사라지므로 만든 직후에는 초점을 복사 단추로 보낸다.
  useEffect(() => {
    if (focusCopy) copyRef.current?.focus();
  }, [focusCopy]);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copied]);

  const check = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setResult(null);
    setError(null);
    try {
      setResult(await checkNodeGitSsh(request, nodeId, host));
    } catch (caught) {
      setError(nodeGitRequestErrorOf(caught));
    } finally {
      setBusy(false);
    }
  };

  return <div className="space-y-4">
    <SettingFieldWidget
      field={gitTextField("public_key", "공개키", keyPath)}
      value={publicKey}
      onChange={() => undefined}
      controlSlot={<div className="min-w-0 space-y-2">
        <p data-v3-selectable-content="true" className="break-all text-sm">{publicKey}</p>
        <Button ref={copyRef} type="button" variant="outline" size="sm" onClick={() => {
          void navigator.clipboard?.writeText(publicKey).then(() => setCopied(true)).catch(() => undefined);
        }}>
          {copied ? <><Check className="size-4" aria-hidden="true" /> 복사됨</> : <><Copy className="size-4" aria-hidden="true" /> 복사</>}
        </Button>
      </div>}
    />
    <form onSubmit={(event) => { void check(event); }}>
      <SettingFieldWidget
        field={gitTextField("host", "호스트")}
        value={host}
        onChange={setHost}
        statusSlot={<div className="flex flex-wrap items-center gap-2">
          <Button type="submit" size="sm" variant="outline" aria-disabled={busy || undefined} className={busyButtonClassName}>연결 확인</Button>
          {result?.ok ? <span role="status" className="inline-flex items-center gap-1 break-keep text-xs text-muted-foreground"><Check className="size-4" aria-hidden="true" /> 연결됨</span> : null}
        </div>}
      />
    </form>
    {result?.ok ? <details className="text-xs text-muted-foreground">
      <summary className="cursor-pointer">기술 상세</summary>
      <pre data-v3-selectable-content="true" className="mt-1 whitespace-pre-wrap break-words">{result.output}</pre>
    </details> : null}
    {result && !result.ok ? <V3ErrorNotice message={result.reason === "connected" ? "연결을 확인하지 못했습니다." : SSH_CHECK_REASON_TEXT[result.reason]} detail={result.output} /> : null}
    {error ? <V3ErrorNotice message={nodeGitErrorText(error)} detail={error.message} /> : null}
  </div>;
}
