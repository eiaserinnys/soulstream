#!/usr/bin/env python3
"""상자 안 payload의 캐시·gh·lock·관측·권한·파일 case 모음."""

from __future__ import annotations

import os
import socket
import stat

from isolation_harness_payload_common import emit, err_name, head, read_status, run, tcp, write_file

IMPORT_SNIPPET = (
    "import('is-number').then(() => console.log('ok'))"
    ".catch((e) => {console.error(e.code); process.exit(1);});"
)


def case_cache(args: dict) -> None:
    project = args["project"]
    store = os.environ.get("npm_config_store_dir", "")
    install = run(
        ["pnpm", *args["pnpm_args"], "--reporter=silent"],
        cwd=project, timeout=args.get("timeout", 300),
    )
    emit(
        "cache_install",
        rc=install["rc"],
        err=head(install["err"], 400) if install["rc"] != 0 else "",
        store_dir_matches=store == args["expected_store"],
    )
    imported = run(["node", "--input-type=module", "-e", IMPORT_SNIPPET], cwd=project, timeout=60)
    emit("cache_import", rc=imported["rc"], err=head(imported["err"]) if imported["rc"] else "")
    emit("playwright_cache_write",
         **write_file(os.path.expanduser("~/.cache/ms-playwright/harness-write-probe"), "x"))


def case_gh(args: dict) -> None:
    result = run(["gh", "api", "user", "--jq", ".login"], timeout=60)
    emit(
        "gh_api_user",
        rc=result["rc"],
        login_present=len(result["out"].strip()) > 0,
        err=head(result["err"]) if result["rc"] != 0 else "",
    )


def case_locks(args: dict) -> None:
    facts = {}
    for path in args["paths"]:
        try:
            info = os.lstat(path)
            facts[path] = {
                "exists": True,
                "regular": stat.S_ISREG(info.st_mode),
                "size": info.st_size,
                "ino": info.st_ino,
                "mode": oct(stat.S_IMODE(info.st_mode)),
                "readable_writable": os.access(path, os.R_OK | os.W_OK),
            }
        except OSError as exc:
            facts[path] = {"exists": False, "errno": err_name(exc)}
    try:
        with open("/proc/locks", "rb") as handle:
            proc_locks = {"ok": True, "bytes": len(handle.read(4096))}
    except OSError as exc:
        proc_locks = {"ok": False, "errno": err_name(exc)}
    emit("locks", files=facts, proc_locks=proc_locks)


def case_observe(args: dict) -> None:
    seen = []
    for entry in os.listdir("/proc"):
        if not entry.isdigit():
            continue
        try:
            with open("/proc/%s/comm" % entry, encoding="ascii", errors="replace") as handle:
                seen.append({"pid": int(entry), "comm": handle.read().strip()[:32]})
        except OSError:
            continue
    host_pids = set(int(value) for value in args["host_pids"])
    visible = sorted(host_pids.intersection(entry["pid"] for entry in seen))
    http = tcp("127.0.0.1", int(args["haniel_port"]), timeout=3.0)
    pm2_logs = args["pm2_logs"]
    try:
        names = sorted(os.listdir(pm2_logs))[:5]
        readable = 0
        for name in names:
            path = os.path.join(pm2_logs, name)
            if os.path.isfile(path):
                with open(path, "rb") as handle:
                    readable += 1 if handle.read(64) else 0
        pm2_read = {"ok": True, "names": names, "readable": readable}
    except OSError as exc:
        pm2_read = {"ok": False, "errno": err_name(exc)}
    pm2_write = write_file(os.path.join(pm2_logs, "harness-write-probe"), "x")
    try:
        pm2_parent = sorted(os.listdir(os.path.expanduser("~/.pm2")))[:10]
    except OSError as exc:
        pm2_parent = ["errno:" + err_name(exc)]
    try:
        prod_names = sorted(os.listdir(args["prod_logs"]))[:5]
    except OSError as exc:
        prod_names = ["errno:" + err_name(exc)]
    emit(
        "observe",
        process_count=len(seen),
        comm_sample=sorted(entry["comm"] for entry in seen)[:10],
        visible_host_pids=visible,
        haniel_direct=http,
        pm2_logs=pm2_read,
        pm2_logs_write=pm2_write,
        pm2_parent=pm2_parent,
        prod_log_names=prod_names,
    )


def case_privilege(args: dict) -> None:
    """권한 축: capability·nft 변경·namespace 재진입을 상자 안에서 확인한다."""
    nft = run(["/usr/sbin/nft", "add", "table", "inet", "harness_probe"], timeout=30)
    nsenter = run(["/usr/bin/nsenter", "-t", "1", "-n", "/usr/bin/true"], timeout=30)
    setns_attempt: dict = {}
    try:
        fd = os.open("/proc/1/ns/net", os.O_RDONLY)
        try:
            setns_fn = getattr(os, "setns", None)
            if setns_fn is None:
                setns_attempt = {"errno": "NO_SETNS"}
            else:
                setns_fn(fd, getattr(os, "CLONE_NEWNET", 0x40000000))
                setns_attempt = {"ok": True}
        finally:
            os.close(fd)
    except OSError as exc:
        setns_attempt = {"ok": False, "errno": err_name(exc)}
    try:
        with open("/proc/1/status", encoding="ascii", errors="replace") as handle:
            proc1 = {"ok": True, "bytes": len(handle.read(200))}
    except OSError as exc:
        proc1 = {"ok": False, "errno": err_name(exc)}
    emit(
        "privilege",
        uid=os.getuid(),
        gid=os.getgid(),
        status=read_status(),
        nft_add={"rc": nft["rc"], "err": head(nft["err"]) if nft["rc"] != 0 else ""},
        nsenter={"rc": nsenter["rc"], "err": head(nsenter["err"]) if nsenter["rc"] != 0 else ""},
        setns=setns_attempt,
        proc1=proc1,
    )


def case_files(args: dict) -> None:
    results = {}
    for op in args["ops"]:
        ident = op["id"]
        path = op["path"]
        mode = op["mode"]
        if mode == "read":
            try:
                with open(path, "rb") as handle:
                    results[ident] = {"ok": True, "bytes": len(handle.read())}
            except OSError as exc:
                results[ident] = {"ok": False, "errno": err_name(exc)}
        elif mode == "write":
            results[ident] = write_file(path, "harness")
        elif mode == "list":
            try:
                results[ident] = {"ok": True, "count": len(os.listdir(path))}
            except OSError as exc:
                results[ident] = {"ok": False, "errno": err_name(exc)}
        elif mode == "lstat":
            try:
                info = os.lstat(path)
                results[ident] = {
                    "ok": True,
                    "kind": "file" if stat.S_ISREG(info.st_mode) else
                            "dir" if stat.S_ISDIR(info.st_mode) else
                            "socket" if stat.S_ISSOCK(info.st_mode) else "other",
                    "size": info.st_size,
                    "mode": oct(stat.S_IMODE(info.st_mode)),
                    "uid": info.st_uid,
                }
            except OSError as exc:
                results[ident] = {"ok": False, "errno": err_name(exc)}
        elif mode == "connect":
            sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            try:
                sock.connect(path)
                results[ident] = {"ok": True}
            except OSError as exc:
                results[ident] = {"ok": False, "errno": err_name(exc)}
            finally:
                sock.close()
        else:
            results[ident] = {"ok": False, "errno": "UNKNOWN_MODE"}
    emit("files", results=results)


__all__ = ["case_cache", "case_gh", "case_locks", "case_observe", "case_privilege",
           "case_files"]
