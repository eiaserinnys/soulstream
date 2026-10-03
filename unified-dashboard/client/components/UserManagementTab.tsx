import { useEffect, useMemo, useRef, useState } from "react";
import { Edit, Plus, Trash2 } from "lucide-react";
import {
  Badge,
  Button,
  Checkbox,
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  Input,
  ScrollArea,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  cn,
} from "@seosoyoung/soul-ui";

interface DashboardUser {
  email: string;
  displayName: string | null;
  isAdmin: boolean;
  allowedFolderIds: string[];
  createdAt: string;
  createdBy: string | null;
}

interface FolderSummary {
  id: string;
  name: string;
  parentFolderId?: string | null;
}

interface UsersResponse {
  users: DashboardUser[];
  folders: FolderSummary[];
}

interface UserFormState {
  email: string;
  displayName: string;
  isAdmin: boolean;
  allowedFolderIds: string[];
}

const EMPTY_FORM: UserFormState = {
  email: "",
  displayName: "",
  isAdmin: false,
  allowedFolderIds: [],
};

export function UserManagementTab({ request = fetch, initialEditor }: { initialEditor?: "create" | "edit"; request?: typeof fetch } = {}) {
  const initializedEditor = useRef(false);
  const saveInFlight = useRef(false);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [users, setUsers] = useState<DashboardUser[]>([]);
  const [folders, setFolders] = useState<FolderSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingEmail, setEditingEmail] = useState<string | null>(null);
  const [form, setForm] = useState<UserFormState>(EMPTY_FORM);

  const folderById = useMemo(
    () => new Map(folders.map((folder) => [folder.id, folder])),
    [folders],
  );

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await request("/api/admin/users", { credentials: "same-origin" });
      if (!res.ok) throw new Error(await readError(res));
      const data = (await res.json()) as UsersResponse;
      setUsers(data.users ?? []);
      setFolders(data.folders ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "사용자 목록을 불러오지 못했습니다");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const openCreate = () => {
    setEditorError(null);
    setEditingEmail(null);
    setForm(EMPTY_FORM);
    setEditorOpen(true);
  };

  const openEdit = (user: DashboardUser) => {
    setEditorError(null);
    setEditingEmail(user.email);
    setForm({
      email: user.email,
      displayName: user.displayName ?? "",
      isAdmin: user.isAdmin,
      allowedFolderIds: user.allowedFolderIds,
    });
    setEditorOpen(true);
  };

  useEffect(() => { if (!initialEditor || loading || initializedEditor.current || (initialEditor === "edit" && !users[0])) return; initializedEditor.current=true; if (initialEditor === "create") openCreate(); else if (users[0]) openEdit(users[0]); }, [initialEditor, loading, users]);

  const save = async () => {
    if (saveInFlight.current || !form.email.trim()) return;
    saveInFlight.current = true;
    setSaving(true);
    setEditorError(null);
    try {
      const body = {
        email: form.email.trim(),
        displayName: form.displayName.trim() || null,
        isAdmin: form.isAdmin,
        allowedFolderIds: form.allowedFolderIds,
      };
      const url = editingEmail
        ? `/api/admin/users/${encodeURIComponent(editingEmail)}`
        : "/api/admin/users";
      const res = await request(url, {
        method: editingEmail ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(editingEmail ? {
          displayName: body.displayName,
          isAdmin: body.isAdmin,
          allowedFolderIds: body.allowedFolderIds,
        } : body),
      });
      if (!res.ok) throw new Error(await readError(res));
      setEditorOpen(false);
      await load();
    } catch (err) {
      setEditorError(err instanceof Error ? err.message : "저장하지 못했습니다");
    } finally {
      saveInFlight.current = false;
      setSaving(false);
    }
  };

  const remove = async (user: DashboardUser) => {
    if (!confirmUserRemoval(user.email)) return;
    setError(null);
    const res = await request(`/api/admin/users/${encodeURIComponent(user.email)}`, {
      method: "DELETE",
      credentials: "same-origin",
    });
    if (!res.ok) {
      setError(await readError(res));
      return;
    }
    await load();
  };

  const toggleFolder = (folderId: string) => {
    setForm((current) => {
      const next = new Set(current.allowedFolderIds);
      if (next.has(folderId)) next.delete(folderId);
      else next.add(folderId);
      return { ...current, allowedFolderIds: Array.from(next) };
    });
  };

  return (
    <div className="flex min-h-[420px] flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold">사용자</h3>
          <p className="text-xs text-muted-foreground">대시보드 로그인과 폴더 접근 권한</p>
        </div>
        <Button size="sm" className="gap-1.5" onClick={openCreate}>
          <Plus className="h-4 w-4" />
          추가
        </Button>
      </div>

      {error && (
        <div className="rounded border border-accent-red/40 bg-accent-red/10 px-3 py-2 text-sm text-accent-red">
          {error}
        </div>
      )}

      <div
        data-testid="user-management-table-scroll"
        className="overflow-x-auto rounded border border-border"
      >
        <Table className="min-w-[720px]">
          <TableHeader>
            <TableRow>
              <TableHead>이메일</TableHead>
              <TableHead className="w-24">권한</TableHead>
              <TableHead>폴더</TableHead>
              <TableHead className="w-24 text-right">작업</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow>
                <TableCell colSpan={4} className="h-24 text-center text-muted-foreground">
                  불러오는 중...
                </TableCell>
              </TableRow>
            ) : users.length === 0 ? (
              <TableRow>
                <TableCell colSpan={4} className="h-24 text-center text-muted-foreground">
                  등록된 사용자가 없습니다
                </TableCell>
              </TableRow>
            ) : users.map((user) => (
              <TableRow key={user.email}>
                <TableCell>
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">{user.email}</div>
                    {user.displayName && (
                      <div className="truncate text-xs text-muted-foreground">{user.displayName}</div>
                    )}
                  </div>
                </TableCell>
                <TableCell>
                  <Badge variant={user.isAdmin ? "default" : "secondary"} size="sm">
                    {user.isAdmin ? "admin" : "user"}
                  </Badge>
                </TableCell>
                <TableCell>
                  <FolderBadges user={user} folderById={folderById} />
                </TableCell>
                <TableCell>
                  <div className="flex justify-end gap-1">
                    <Button variant="ghost" size="icon" title="Edit user" onClick={() => openEdit(user)}>
                      <Edit className="h-4 w-4" />
                    </Button>
                    <Button variant="ghost" size="icon" title="Delete user" onClick={() => void remove(user)}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <Dialog open={editorOpen} onOpenChange={(next) => { if (!saveInFlight.current) setEditorOpen(next); }}>
        <DialogPopup className="approved-dialog max-w-xl" closeProps={{ disabled: saving }}>
          <DialogHeader>
            <DialogTitle>{editingEmail ? "사용자 편집" : "사용자 추가"}</DialogTitle>
            <DialogDescription>이메일과 폴더 권한을 설정합니다.</DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="space-y-4">
              {editorError && <div role="alert" className="text-sm text-accent-red">{editorError}</div>}
              <label className="block space-y-1.5">
                <span className="text-sm font-medium text-muted-foreground">이메일</span>
                <Input
                  value={form.email}
                  autoFocus
                  disabled={saving || editingEmail !== null}
                  onChange={(event) => setForm((current) => ({ ...current, email: event.target.value }))}
                />
              </label>
              <label className="block space-y-1.5">
                <span className="text-sm font-medium text-muted-foreground">이름</span>
                <Input
                  disabled={saving}
                  value={form.displayName}
                  onChange={(event) => setForm((current) => ({ ...current, displayName: event.target.value }))}
                />
              </label>
              <div className="flex items-center justify-between rounded border border-border px-3 py-2">
                <span className="text-sm font-medium">Admin</span>
                <Switch
                  disabled={saving}
                  checked={form.isAdmin}
                  onCheckedChange={(checked) => setForm((current) => ({ ...current, isAdmin: Boolean(checked) }))}
                />
              </div>
              <div className={cn("space-y-2", form.isAdmin && "opacity-50")}>
                <div className="text-sm font-medium text-muted-foreground">폴더</div>
                <p className="text-sm text-muted-foreground">{form.isAdmin ? "관리자는 전체 폴더에 접근할 수 있습니다." : form.allowedFolderIds.length === 0 ? "선택한 폴더가 없으면 전체 폴더에 접근할 수 있습니다." : "선택한 폴더에만 접근할 수 있습니다."}</p>
                <ScrollArea className="h-48 rounded border border-border">
                  <div className="space-y-1 p-2">
                    {folders.map((folder) => (
                      <label
                        key={folder.id}
                        className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-muted/40"
                      >
                        <Checkbox
                          checked={form.allowedFolderIds.includes(folder.id)}
                          disabled={saving || form.isAdmin}
                          onCheckedChange={() => toggleFolder(folder.id)}
                        />
                        <span className="min-w-0 truncate">{folder.name}</span>
                      </label>
                    ))}
                    {folders.length === 0 && (
                      <div className="py-8 text-center text-sm text-muted-foreground">폴더가 없습니다</div>
                    )}
                  </div>
                </ScrollArea>
              </div>
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button variant="outline" size="sm" disabled={saving} onClick={() => { if (!saveInFlight.current) setEditorOpen(false); }}>
              취소
            </Button>
            <Button size="sm" disabled={saving || !form.email.trim()} onClick={() => void save()}>
              {saving ? "저장 중..." : "저장"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </div>
  );
}

function FolderBadges({
  user,
  folderById,
}: {
  user: DashboardUser;
  folderById: Map<string, FolderSummary>;
}) {
  if (user.isAdmin || user.allowedFolderIds.length === 0) {
    return <span className="text-xs text-muted-foreground">전체</span>;
  }
  return (
    <div className="flex flex-wrap gap-1">
      {user.allowedFolderIds.map((folderId) => {
        const folder = folderById.get(folderId);
        return (
          <Badge key={folderId} variant={folder ? "secondary" : "outline"} size="sm">
            {folder?.name ?? "삭제된 폴더"}
          </Badge>
        );
      })}
    </div>
  );
}

async function readError(res: Response): Promise<string> {
  const data = await res.json().catch(() => null) as { detail?: unknown } | null;
  if (typeof data?.detail === "string") return data.detail;
  return `HTTP ${res.status}`;
}

export function confirmUserRemoval(email: string) { return window.confirm(`${email} 사용자를 삭제할까요?`); }
