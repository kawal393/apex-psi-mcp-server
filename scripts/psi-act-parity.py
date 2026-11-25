#!/usr/bin/env python3
"""PSI-ACT/1 canonicalisation oracle for the Node implementation.

Reads a JSON array of {kind, statement} on stdin. For each one it removes the
signature and the statement's own identifier, canonicalises the rest with the
estate's RFC 8785 implementation (psi_jcs), and prints the signed bytes and
their SHA-256 digest. The Node side computes the same two values; the two must
agree byte for byte.

The PSI-ACT/1 identifier of a statement is the digest of its signed bytes, so
agreement on both numbers is what lets a Python verifier accept a statement a
Node signer produced, and the other way round.
"""
from __future__ import annotations

import hashlib
import json
import os
import sys

DEFAULT_JCS = r"D:\ApexEmpire\github-mirror\digital-gallowsapex-infrastructurecom\psi-conformance\psi_jcs.py"
ID_FIELD = {
    "mandate": "mid",
    "proposal": "pid",
    "decision": "did",
    "settlement": "sid",
    "envelope": "eid",
}


def load_jcs():
    path = os.environ.get("PSI_JCS_PATH", DEFAULT_JCS)
    if not os.path.exists(path):
        return None, path
    import importlib.util

    spec = importlib.util.spec_from_file_location("psi_jcs", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module, path


def main() -> int:
    if hasattr(sys.stdin, "reconfigure"):
        sys.stdin.reconfigure(encoding="utf-8")
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    jcs, path = load_jcs()
    if jcs is None:
        print(json.dumps({"error": "psi_jcs not found", "path": path}))
        return 2
    items = json.load(sys.stdin)
    out = []
    for item in items:
        statement = dict(item["statement"])
        kind = item["kind"]
        statement.pop("sig", None)
        statement.pop(ID_FIELD[kind], None)
        if kind == "envelope":
            statement.pop("anchor", None)
        raw = jcs.jcs_bytes(statement)
        out.append(
            {
                "name": item.get("name", kind),
                "signed_hex": raw.hex(),
                "digest": "sha256:" + hashlib.sha256(raw).hexdigest(),
            }
        )
    print(json.dumps({"results": out, "jcs_path": path}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
